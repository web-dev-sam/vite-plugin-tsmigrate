<script setup lang="ts">
import type { Maintainability, MaintainabilityDriver } from "../../../src/shared/types.ts";
import type { DepthRow, Mode, Readouts } from "../graph/render.ts";
import Checkbox from "../ui/Checkbox.vue";
import Collapsible from "../ui/Collapsible.vue";
import Dot from "../ui/Dot.vue";
import Field from "../ui/Field.vue";
import ProgressBar from "../ui/ProgressBar.vue";
import Select from "../ui/Select.vue";
import StatRow from "../ui/StatRow.vue";
import Tooltip from "../ui/Tooltip.vue";
import TextInput from "../ui/TextInput.vue";

/**
 * The fixed left panel: title + diagnostics header, LoC-weighted progress bar,
 * the typed/errors/files-edges readouts, search, colour mode,
 * the view-filter checkboxes (incl. the TS-swap), the clickable depth table
 * and the blame-by-author rollup. All readouts are computed by the renderer
 * over the shown set and passed in; every control is a two-way model. Titles
 * are carried over from the prototype verbatim for parity.
 */
defineProps<{
  readouts: Readouts | null;
  header: { complete: boolean; appUrl: string | null };
  /** `false` disables the content-search bar (ripgrep binary not found). */
  ripgrep: boolean;
  /** Whole-graph maintainability score (over the full module graph). */
  maintainability: Maintainability | null;
  /** The driver whose per-node contribution the graph is highlighting (null = none). */
  activeDriver: MaintainabilityDriver | null;
}>();
const emit = defineEmits<{
  depthClick: [height: number];
  focusNode: [id: string];
  driverClick: [driver: MaintainabilityDriver];
}>();

const mode = defineModel<Mode>("mode", { required: true });
const onlyRed = defineModel<boolean>("onlyRed", { required: true });
const showRings = defineModel<boolean>("showRings", { required: true });
const showBlame = defineModel<boolean>("showBlame", { required: true });
const includeTs = defineModel<boolean>("includeTs", { required: true });
const showLinks = defineModel<boolean>("showLinks", { required: true });
const highlightLinks = defineModel<boolean>("highlightLinks", { required: true });
const search = defineModel<string>("search", { required: true });
const contentSearch = defineModel<string>("contentSearch", { required: true });
const blameGreen = defineModel<boolean>("blameGreen", { required: true });
const blameRed = defineModel<boolean>("blameRed", { required: true });

const modeOptions: readonly { value: Mode; label: string }[] = [
  { value: "strict", label: "strict — red if any subtree file is red" },
  { value: "naive", label: "naive — red only if the file itself is red" },
];

const fmt = (n: number) => n.toLocaleString();

function depthLabel(d: DepthRow): string {
  return d.height === 0 ? "depth 0 (leaves)" : `depth ${d.height}`;
}
function depthTitle(d: DepthRow): string {
  const hops = `${d.height} hop${d.height === 1 ? "" : "s"}`;
  const leaf = d.height === 0 ? " (imports no other shown component)" : "";
  return (
    `Depth ${d.height}: longest import path to a leaf is ${hops}${leaf}. ` +
    `${d.pct.toFixed(0)}% of the LoC at this depth is typed ` +
    `(${d.green}/${d.total} files). Click to isolate this depth.`
  );
}

const pct = (n: number) => (n * 100).toFixed(0);

const dirOf = (f: string): string => f.slice(0, f.lastIndexOf("/") + 1);
const baseOf = (f: string): string => f.slice(f.lastIndexOf("/") + 1);
// Tooltip text after the (purple) filename — one string so the formatter can't
// wedge stray whitespace between the segments.
function hotspotMeta(h: Maintainability["hotspots"][number]): string {
  return (
    ` · ${h.loc} LoC · imports ${h.fanOut} · imported by ${h.fanIn}` +
    ` · instability ${h.instability.toFixed(2)} · blast radius ${pct(h.blastRadius)}% of the codebase` +
    `${h.inCycle ? " · in a cycle" : ""}. Click to isolate its dependents.`
  );
}

// Score grade: green from 80, amber from 50, else red — mirrors the node palette.
function scoreTone(score: number): string {
  if (score >= 80) {
    return "text-green";
  }
  return score >= 50 ? "text-warn" : "text-red";
}
</script>

<template>
  <aside
    class="fixed inset-y-4 left-4 w-[380px] overflow-y-auto rounded-xl border border-border/70 bg-panel/85 p-5 text-sm text-fg shadow-2xl shadow-black/40 backdrop-blur-md"
  >
    <header class="mb-4">
      <h1 class="text-base font-semibold tracking-tight">Vue typing progress</h1>

      <!-- Diagnostics header — analysis progress + live app link. -->
      <p class="mt-1 text-xs text-muted">
        <span :class="header.complete ? 'text-green' : 'text-muted'">
          {{ header.complete ? "complete" : "analyzing…" }}
        </span>
        <template v-if="header.appUrl">
          ·
          <a :href="header.appUrl" target="_blank" class="text-accent hover:underline">app</a>
        </template>
      </p>
    </header>

    <Collapsible v-if="maintainability" title="maintainability" flush :default-open="false">
      <template #actions>
        <Tooltip
          content="How maintainable the codebase is, from 0 to 100. 100 means every change stays small and local; lower means changes tend to ripple across many files. Measured over the full module graph — see docs/maintainability-score.md."
        >
          <span
            class="text-2xl font-semibold tabular-nums"
            :class="scoreTone(maintainability.score)"
          >
            {{ maintainability.score }}<span class="text-sm font-normal text-muted">/100</span>
          </span>
        </Tooltip>
      </template>

      <!-- Overhead drivers: excess coupling | change blast | type errors. -->
      <Tooltip
        content="What makes a change cost more than just reading the file: too many imports, ripple from files that lots of code depends on, and type errors. The bar shows how much each one adds."
      >
        <div class="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-border/60">
          <div
            class="bg-accent"
            :style="{ width: pct(maintainability.drivers.comprehension) + '%' }"
          />
          <div class="bg-purple" :style="{ width: pct(maintainability.drivers.blast) + '%' }" />
          <div class="bg-red" :style="{ width: pct(maintainability.drivers.types) + '%' }" />
        </div>
      </Tooltip>

      <div class="mt-3 space-y-1.5">
        <Tooltip
          content="Files that import too many other modules. A handful of imports is fine; this only counts files that pull in far more than usual — and importing stable things like icons barely counts."
        >
          <StatRow
            class="-mx-1 cursor-pointer rounded px-1 transition-colors hover:bg-border/40"
            :class="{ 'bg-border/60': activeDriver === 'comprehension' }"
            @click="emit('driverClick', 'comprehension')"
          >
            <template #label>
              <span class="inline-block size-2 rounded-full bg-accent" />excess coupling
            </template>
            {{ pct(maintainability.drivers.comprehension) }}%
          </StatRow>
        </Tooltip>
        <Tooltip
          content="Ripple risk: files that change often and that much of the codebase depends on. Change one and you have to re-check everything downstream. Files that rarely change don't count, no matter how many import them."
        >
          <StatRow
            class="-mx-1 cursor-pointer rounded px-1 transition-colors hover:bg-border/40"
            :class="{ 'bg-border/60': activeDriver === 'blast' }"
            @click="emit('driverClick', 'blast')"
          >
            <template #label>
              <span class="inline-block size-2 rounded-full bg-purple" />change blast
            </template>
            {{ pct(maintainability.drivers.blast) }}%
          </StatRow>
        </Tooltip>
        <Tooltip
          v-if="maintainability.typeHealth !== null"
          content="Files that have type errors, counted more heavily the more widely they're imported — a bad type in a core file hurts far more than one in a rarely-used leaf."
        >
          <StatRow
            class="-mx-1 cursor-pointer rounded px-1 transition-colors hover:bg-border/40"
            :class="{ 'bg-border/60': activeDriver === 'types' }"
            @click="emit('driverClick', 'types')"
          >
            <template #label>
              <span class="inline-block size-2 rounded-full bg-red" />type errors
            </template>
            {{ pct(maintainability.drivers.types) }}%
          </StatRow>
        </Tooltip>
        <div
          v-if="maintainability.cycleLoc > 0 || maintainability.typeHealth !== null"
          class="border-t border-border/60"
        />
        <Tooltip
          v-if="maintainability.cycleLoc > 0"
          content="Code stuck in import cycles: files that import each other in a loop, so you can't read, test, or change one on its own."
        >
          <StatRow>
            <template #label><span class="text-red">↻</span>in cycles</template>
            {{ pct(maintainability.cycleLoc) }}% LoC
          </StatRow>
        </Tooltip>
        <Tooltip
          v-if="maintainability.typeHealth !== null"
          content="How much of the codebase, by lines of code, is free of type errors — the migration's headline progress and the biggest lever on the score."
        >
          <StatRow>
            <template #label><Dot tone="green" />typed</template>
            {{ (maintainability.typeHealth * 100).toFixed(1) }}% LoC
          </StatRow>
        </Tooltip>
      </div>

      <!-- Highest-cost files: click a row to open its source. -->
      <div v-if="maintainability.hotspots.length" class="mt-3">
        <div
          class="mb-1 flex items-center justify-between px-2 text-xs font-medium tracking-wide text-muted uppercase"
        >
          <span>hotspots</span>
          <Tooltip
            content="Blast radius: how much of the codebase depends on this file, directly or indirectly. 40% means a change here could ripple to about 40% of all the code."
          >
            <span>blast radius</span>
          </Tooltip>
        </div>
        <table class="w-full border-collapse text-xs">
          <tbody>
            <Tooltip
              v-for="h in maintainability.hotspots.slice(0, 6)"
              :key="h.id"
              as="tr"
              class="cursor-pointer transition-colors hover:[&>td]:text-fg"
              @click="emit('focusNode', h.id)"
            >
              <template #content
                ><span class="text-muted">{{ dirOf(h.file) }}</span
                ><span class="text-purple">{{ baseOf(h.file) }}</span
                >{{ hotspotMeta(h) }}</template
              >
              <td class="max-w-[240px] truncate py-0.5 pl-2 first:rounded-l">
                <span v-if="h.inCycle" class="text-red">↻ </span>{{ baseOf(h.file) }}
              </td>
              <td class="py-0.5 pr-2 text-right tabular-nums text-muted last:rounded-r">
                {{ pct(h.blastRadius) }}%
              </td>
            </Tooltip>
          </tbody>
        </table>
      </div>
    </Collapsible>

    <Collapsible title="typing" :default-open="false">
      <!-- LoC-weighted typing progress of the shown set. -->
      <Tooltip
        content="LoC-weighted typing progress of the shown set: green lines of code ÷ total lines of code."
      >
        <ProgressBar :value="readouts?.locPct ?? 0" />
      </Tooltip>

      <div class="mt-3 space-y-1.5">
        <Tooltip
          content="Files that fully type-check (no type errors) — as % of total LoC that is green, then the green file count."
        >
          <StatRow>
            <template #label><Dot tone="green" />typed</template>
            {{ (readouts?.locPct ?? 0).toFixed(1) }}% LoC · {{ readouts?.greenFiles ?? 0 }} files
          </StatRow>
        </Tooltip>
        <Tooltip
          content="A file counts as an error if it has at least one type error — shown as total LoC, then the file count."
        >
          <StatRow>
            <template #label><Dot tone="red" />errors</template>
            {{ fmt(readouts?.redLoc ?? 0) }} LoC · {{ readouts?.redFiles ?? 0 }} files
          </StatRow>
        </Tooltip>
        <Tooltip content="Files shown / import edges among the shown files (parent imports child).">
          <StatRow>
            <template #label><span class="text-muted">files / edges</span></template>
            {{ readouts?.files ?? 0 }} / {{ readouts?.edges ?? 0 }}
          </StatRow>
        </Tooltip>
      </div>
    </Collapsible>

    <Collapsible title="settings">
      <div class="space-y-3">
        <TextInput v-model="search" clearable placeholder="search component…" />
        <Tooltip
          v-if="!ripgrep"
          content="Content search needs the ripgrep (rg) binary on PATH — not found. Install ripgrep to search file contents by regex."
        >
          <div class="opacity-40">
            <TextInput v-model="contentSearch" disabled placeholder="search contents (regex)…" />
          </div>
        </Tooltip>
        <TextInput
          v-else
          v-model="contentSearch"
          clearable
          placeholder="search contents (regex, multiline)…"
        />
        <Field label="colour mode">
          <Select v-model="mode" :options="modeOptions" />
        </Field>
      </div>

      <div class="mt-3 space-y-2.5">
        <Checkbox v-model="onlyRed">show only components with errors</Checkbox>
        <Checkbox v-model="showRings">show depth numbers</Checkbox>
        <Checkbox v-if="readouts && readouts.blame.available" v-model="showBlame">
          show git blame (LoC per author)
        </Checkbox>
        <Checkbox v-model="includeTs">
          include TS files <span class="text-ts">(blue ring)</span>
        </Checkbox>
        <Tooltip
          content="Draw every import edge among the shown components. Off by default for performance; edges otherwise appear only for a selected node's subtree."
        >
          <Checkbox v-model="showLinks">show import links</Checkbox>
        </Tooltip>
        <Tooltip
          content="Highlight every import edge among the shown components in blue at once — like hovering a node, but for all of them. Implies drawing the links."
        >
          <Checkbox v-model="highlightLinks">highlight all links</Checkbox>
        </Tooltip>
      </div>
    </Collapsible>

    <!-- Per-depth typing; click a row to isolate that ring. -->
    <Collapsible title="by depth" :default-open="false">
      <div class="mb-2 px-2 text-right text-xs font-medium tracking-wide text-muted uppercase">
        % typed
      </div>
      <table class="w-full border-collapse text-xs">
        <tbody>
          <Tooltip
            v-for="d in readouts?.depths ?? []"
            :key="d.height"
            as="tr"
            :content="depthTitle(d)"
            class="cursor-pointer transition-colors hover:[&>td]:text-fg"
            :class="{ '[&>td]:bg-accent/20 [&>td]:text-fg!': d.active }"
            @click="emit('depthClick', d.height)"
          >
            <td class="py-1 pl-2 first:rounded-l">{{ depthLabel(d) }}</td>
            <td
              class="py-1 pr-2 text-right tabular-nums last:rounded-r"
              :class="d.done ? 'text-green' : 'text-muted'"
            >
              {{ d.pct.toFixed(0) }}%
            </td>
          </Tooltip>
        </tbody>
      </table>
    </Collapsible>

    <!-- Blame LoC per author over the shown set. -->
    <Collapsible v-if="readouts && readouts.blame.available" title="blame by author">
      <template #actions>
        <span class="flex gap-3 text-xs text-muted">
          <Checkbox v-model="blameGreen">
            <Dot tone="green" size="sm" class="mr-1.5" />typed
          </Checkbox>
          <Checkbox v-model="blameRed"><Dot tone="red" size="sm" class="mr-1.5" />errors</Checkbox>
        </span>
      </template>
      <div class="mt-2 text-xs text-muted">
        {{ readouts.blame.set }} · {{ readouts.blame.files }} files ·
        {{ fmt(readouts.blame.sumLoc) }} LoC
      </div>
      <table class="mt-1 w-full border-collapse text-xs">
        <tbody>
          <tr v-for="row in readouts.blame.rows" :key="row.author">
            <td class="py-0.5">{{ row.author }}</td>
            <td class="py-0.5 text-right tabular-nums text-muted">
              {{ fmt(row.loc) }} · {{ row.pct.toFixed(1) }}%
            </td>
          </tr>
        </tbody>
      </table>
    </Collapsible>

    <footer class="mt-4 border-t border-border/70 pt-4 text-xs text-muted">
      drag to pan · scroll to zoom · click a node for its subtree · shift-click for its dependents ·
      ctrl-click for source
    </footer>
  </aside>
</template>
