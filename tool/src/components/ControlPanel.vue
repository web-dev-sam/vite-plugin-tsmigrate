<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  CoverageSummary,
  Maintainability,
  MaintainabilityDriver,
} from "../../../src/shared/types.ts";
import type { CycleInfo, DepthRow, Mode, NodeDetail, Readouts } from "../graph/render.ts";
import NodeDetailPanel from "./NodeDetailPanel.vue";
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
  header: { complete: boolean; appUrl: string | null; projectName: string | null };
  /** `false` disables the content-search bar (ripgrep binary not found). */
  ripgrep: boolean;
  /** Whole-graph maintainability score (over the full module graph). */
  maintainability: Maintainability | null;
  /** Crawl scope: graph vs. total source files/LoC, with the unreached list (null until the graph arrives). */
  coverage: CoverageSummary | null;
  /** The driver whose per-node contribution the graph is highlighting (null = none). */
  activeDriver: MaintainabilityDriver | null;
  /** Detail of the hovered/selected graph node — populates the bottom section (null hides it). */
  nodeDetail: NodeDetail | null;
  /** Shipped import cycles (largest first), preprocessed with cut hints. */
  cycles: CycleInfo[];
  /** Whether the project has any `.vue` components (gates the vue-only toggle). */
  hasVue: boolean;
}>();
const emit = defineEmits<{
  depthClick: [height: number];
  focusNode: [id: string];
  cycleClick: [members: string[]];
  driverClick: [driver: MaintainabilityDriver];
}>();

const mode = defineModel<Mode>("mode", { required: true });
const onlyRed = defineModel<boolean>("onlyRed", { required: true });
const onlyGreen = defineModel<boolean>("onlyGreen", { required: true });
const showRings = defineModel<boolean>("showRings", { required: true });
const showBlame = defineModel<boolean>("showBlame", { required: true });
const includeTs = defineModel<boolean>("includeTs", { required: true });
const showLinks = defineModel<boolean>("showLinks", { required: true });
const highlightLinks = defineModel<boolean>("highlightLinks", { required: true });
const showLabels = defineModel<boolean>("showLabels", { required: true });
const search = defineModel<string>("search", { required: true });
const contentSearch = defineModel<string>("contentSearch", { required: true });
const blameGreen = defineModel<boolean>("blameGreen", { required: true });
const blameRed = defineModel<boolean>("blameRed", { required: true });

// The settings toggle is phrased as "only show vue files", the inverse of the
// `includeTs` source of truth (full graph is the default view).
const vueOnly = computed({
  get: () => !includeTs.value,
  set: (v: boolean) => {
    includeTs.value = !v;
  },
});

// Clicking the typed/errors readouts isolates that colour in the graph. The two
// filters are mutually exclusive — enabling one clears the other (both on would
// hide every node).
function toggleOnlyGreen() {
  const next = !onlyGreen.value;
  onlyGreen.value = next;
  if (next) onlyRed.value = false;
}
function toggleOnlyRed() {
  const next = !onlyRed.value;
  onlyRed.value = next;
  if (next) onlyGreen.value = false;
}

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
// Tooltip text around the (colour-coded) volatility value: one string each
// side so the formatter can't wedge stray whitespace between the segments.
function hotspotMetaPre(h: Maintainability["hotspots"][number]): string {
  return (
    ` · ${h.loc} LoC · ${h.cc} branches · imports ${h.fanOut} · imported by ${h.fanIn}` +
    ` · volatility `
  );
}
function hotspotMetaPost(h: Maintainability["hotspots"][number]): string {
  return (
    ` · blast radius ${pct(h.blastRadius)}% of the codebase` +
    `${h.inCycle ? " · in a cycle" : ""}. Click to isolate its dependents.`
  );
}

// Share of the codebase's total overhead this hotspot causes — the visible
// sort key of the hotspot list (rows are sorted by cost − loc, descending).
function dragShare(h: Maintainability["hotspots"][number], m: Maintainability): string {
  const total = m.costLoc - m.floorLoc;
  if (total <= 0) {
    return "0%";
  }
  const p = Math.round(((h.cost - h.loc) / total) * 100);
  return p < 1 ? "<1%" : `${p}%`;
}

// Volatility ∈ [0,1]: low = stable (green), high = change-prone (red).
function volatilityTone(v: number): string {
  if (v < 0.34) {
    return "text-green";
  }
  return v < 0.67 ? "text-warn" : "text-red";
}

// Score grade on the criterion-referenced scale: a typical production app
// sits at 30 (amber starts there), green is reserved for genuinely
// well-factored codebases, red is below typical. Negatives render red.
function scoreTone(score: number): string {
  if (score >= 70) {
    return "text-green";
  }
  return score >= 30 ? "text-warn" : "text-red";
}

// The two stacked sections resize by dragging the divider. The bottom (detail)
// section owns an explicit pixel height; the top settings section takes the
// remaining flex space. Height is clamped to keep both sections usable.
const asideEl = ref<HTMLElement | null>(null);
const bottomHeight = ref(260);

function startResize(e: PointerEvent) {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = bottomHeight.value;
  const total = asideEl.value?.clientHeight ?? window.innerHeight;
  const max = Math.max(120, total - 160);
  const onMove = (ev: PointerEvent) => {
    // Dragging the divider up grows the bottom section; down shrinks it.
    const next = startHeight - (ev.clientY - startY);
    bottomHeight.value = Math.min(max, Math.max(120, next));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
</script>

<template>
  <aside
    ref="asideEl"
    class="fixed inset-y-4 left-4 flex w-95 flex-col overflow-hidden rounded-xl border border-border/70 bg-panel/85 text-sm text-fg shadow-2xl shadow-black/40 backdrop-blur-md"
  >
    <!-- Top section: settings, scrollable. Flexes to fill the space the detail panel leaves. -->
    <div class="min-h-0 flex-1 overflow-y-auto p-5">
      <header class="mb-4">
        <h1
          class="truncate text-base font-semibold tracking-tight"
          :title="header.projectName ?? undefined"
        >
          {{ header.projectName ?? "tsmigrate" }}
        </h1>

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
            content="Criterion-referenced: 100 means every change costs only the reading; a typical production Vue app sits around 30 (deliberately not a passing grade); negatives are genuine disasters. Typed code discounts its flaws — the compiler carries re-verification. Measured over the full module graph — see docs/maintainability-score.md."
          >
            <span
              class="text-2xl font-semibold tabular-nums"
              :class="scoreTone(maintainability.score)"
            >
              {{ maintainability.score }}<span class="text-sm font-normal text-muted">/100</span>
            </span>
          </Tooltip>
        </template>

        <!-- Structural overhead drivers: excess coupling | change blast | complexity mass. -->
        <Tooltip
          content="What makes a change cost more than just reading the file: too many volatile imports, ripple from churning files that lots of code depends on, and branchy logic buried in big files. The bar shows how much each one adds."
        >
          <div class="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              class="bg-accent"
              :style="{ width: pct(maintainability.drivers.comprehension) + '%' }"
            />
            <div class="bg-purple" :style="{ width: pct(maintainability.drivers.blast) + '%' }" />
            <div class="bg-warn" :style="{ width: pct(maintainability.drivers.mass) + '%' }" />
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
            content="How far a change to this file spreads. High only when the file really changes (measured from git history as deleted lines per month, floored by a structural estimate) and is widely imported — many files then need re-checking. A stable foundation stays cheap however popular it is."
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
            content="Branch-dense logic in big files: every decision point costs more the bigger the file it's buried in. Flat files (prose, plain declarations) cost nothing however long they are — splitting a god file genuinely lowers this."
          >
            <StatRow
              class="-mx-1 cursor-pointer rounded px-1 transition-colors hover:bg-border/40"
              :class="{ 'bg-border/60': activeDriver === 'mass' }"
              @click="emit('driverClick', 'mass')"
            >
              <template #label>
                <span class="inline-block size-2 rounded-full bg-warn" />complexity mass
              </template>
              {{ pct(maintainability.drivers.mass) }}%
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
            v-if="maintainability.churnCoverage !== null"
            content="How much of the graph (by LoC) has usable git history behind its volatility. The rest falls back to a structural estimate — the score still works, but it can't see real churn there (shallow clones and fresh repos read low)."
          >
            <StatRow>
              <template #label><span class="text-muted">⟳</span>churn measured</template>
              {{ pct(maintainability.churnCoverage) }}% LoC
            </StatRow>
          </Tooltip>
          <Tooltip
            v-if="maintainability.typeHealth !== null"
            content="How much of the codebase, by lines of code, is free of type errors — the migration's headline progress readout."
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
              content="Sorted by score drag — how much each file adds to the change cost beyond just reading it. The % is the file's share of the codebase's total overhead, so fixing the top row buys the most points. Hover a row for its stats (volatility, blast radius, branches)."
            >
              <span>score drag</span>
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
                  >{{ hotspotMetaPre(h)
                  }}<span :class="volatilityTone(h.volatility)">{{ h.volatility.toFixed(2) }}</span
                  >{{ hotspotMetaPost(h) }}</template
                >
                <td class="max-w-[240px] truncate py-0.5 pl-2 first:rounded-l">
                  <span v-if="h.inCycle" class="text-red">↻ </span>{{ baseOf(h.file) }}
                </td>
                <td class="py-0.5 pr-2 text-right tabular-nums text-muted last:rounded-r">
                  {{ dragShare(h, maintainability) }}
                </td>
              </Tooltip>
            </tbody>
          </table>
        </div>

        <!-- Import cycles: members + the cheapest edge to sever. Click to isolate. -->
        <div v-if="cycles.length" class="mt-3">
          <div
            class="mb-1 flex items-center justify-between px-2 text-xs font-medium tracking-wide text-muted uppercase"
          >
            <span>cycles</span>
            <Tooltip
              content="Files that import each other in a loop — none can be read, tested or changed alone. The hint names the cycle edge crossing the fewest symbols: the cheapest place to break the loop. Click a row to isolate its members."
            >
              <span>where to cut</span>
            </Tooltip>
          </div>
          <table class="w-full border-collapse text-xs">
            <tbody>
              <Tooltip
                v-for="(c, i) in cycles"
                :key="i"
                as="tr"
                class="cursor-pointer transition-colors hover:[&>td]:text-fg"
                @click="emit('cycleClick', c.members)"
              >
                <template #content>
                  <span class="text-purple">{{ c.label }}</span>
                  <template v-if="c.cut"> · cheapest cut: {{ c.cut.label }}</template>
                  <template v-else>
                    · no narrowed edge to cut — break a whole-module import</template
                  >
                  . Click to isolate the members.
                </template>
                <td class="max-w-[190px] truncate py-0.5 pl-2 first:rounded-l">
                  <span class="text-red">↻ </span>{{ c.label }}
                </td>
                <td
                  class="max-w-[130px] truncate py-0.5 pr-2 text-right tabular-nums text-muted last:rounded-r"
                >
                  {{ c.cut ? c.cut.label : "—" }}
                </td>
              </Tooltip>
            </tbody>
          </table>
        </div>

        <!-- Crawl scope: prevents reading a JS-graph score as a repo-wide verdict. -->
        <div v-if="coverage" class="mt-3">
          <div class="mb-1 px-2 text-xs font-medium tracking-wide text-muted uppercase">scope</div>
          <Tooltip
            content="What the score can actually see. Only files reachable from the app's entry are measured — anything else (dead code, intentional archives, files only bound via auto-imports the crawler can't trace, and every non-JS surface like backend code or i18n JSONs) is invisible to it."
          >
            <p class="px-2 text-xs text-muted">
              graph covers {{ fmt(coverage.graphFiles) }} of {{ fmt(coverage.sourceFiles) }} source
              files ·
              {{ coverage.sourceLoc > 0 ? pct(coverage.graphLoc / coverage.sourceLoc) : 100 }}% of
              source LoC
            </p>
          </Tooltip>
          <Collapsible
            v-if="coverage.unreached.length"
            :title="`${fmt(coverage.sourceFiles - coverage.graphFiles)} unreached files`"
            :default-open="false"
          >
            <ul class="max-h-40 space-y-0.5 overflow-y-auto">
              <li
                v-for="u in coverage.unreached"
                :key="u.file"
                class="flex items-center justify-between gap-2 text-xs"
                :title="u.file"
              >
                <span class="truncate text-muted">{{ u.file }}</span>
                <span class="shrink-0 text-muted tabular-nums">{{ u.loc }} LoC</span>
              </li>
            </ul>
          </Collapsible>
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
            content="Files that fully type-check (no type errors) — as % of total LoC that is green, then the green file count. Click to show only typed components."
            class="-mx-1.5 cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-accent/10"
            :class="{ 'bg-accent/20 [&_span:last-child]:text-fg!': onlyGreen }"
            @click="toggleOnlyGreen"
          >
            <StatRow>
              <template #label><Dot tone="green" />typed</template>
              {{ (readouts?.locPct ?? 0).toFixed(1) }}% LoC · {{ readouts?.greenFiles ?? 0 }} files
            </StatRow>
          </Tooltip>
          <Tooltip
            content="A file counts as an error if it has at least one type error — shown as total LoC, then the file count. Click to show only components with errors."
            class="-mx-1.5 cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-accent/10"
            :class="{ 'bg-accent/20 [&_span:last-child]:text-fg!': onlyRed }"
            @click="toggleOnlyRed"
          >
            <StatRow>
              <template #label><Dot tone="red" />errors</template>
              {{ fmt(readouts?.redLoc ?? 0) }} LoC · {{ readouts?.redFiles ?? 0 }} files
            </StatRow>
          </Tooltip>
          <Tooltip
            content="Files shown / import edges among the shown files (parent imports child)."
          >
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

        <div class="mt-4 space-y-4">
          <div>
            <p class="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">overlays</p>
            <div class="space-y-2.5">
              <Checkbox v-model="showRings">depth numbers</Checkbox>
              <Checkbox v-model="showLabels">filenames</Checkbox>
              <Checkbox v-if="readouts && readouts.blame.available" v-model="showBlame">
                git blame (LoC per author)
              </Checkbox>
            </div>
          </div>

          <div>
            <p class="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">links</p>
            <div class="space-y-2.5">
              <Tooltip
                content="Draw every import edge among the shown components. Off by default for performance; edges otherwise appear only for a selected node's subtree."
              >
                <Checkbox v-model="showLinks">import edges</Checkbox>
              </Tooltip>
              <div class="ml-[7px] border-l border-border/60 pl-3">
                <Tooltip
                  content="Highlight every import edge among the shown components in blue at once — like hovering a node, but for all of them. Implies drawing the links."
                >
                  <Checkbox v-model="highlightLinks">highlight all</Checkbox>
                </Tooltip>
              </div>
            </div>
          </div>

          <div v-if="hasVue">
            <p class="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">filter</p>
            <div class="space-y-2.5">
              <Tooltip
                content="Hide the TS/TSX modules and show only the .vue components. TS files are included by default (drawn with a blue ring)."
              >
                <Checkbox v-model="vueOnly">only .vue files</Checkbox>
              </Tooltip>
            </div>
          </div>
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
            <Checkbox v-model="blameRed"
              ><Dot tone="red" size="sm" class="mr-1.5" />errors</Checkbox
            >
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
        drag to pan · scroll to zoom · click a node for its subtree · shift-click for its dependents
        · ctrl-click for source
      </footer>
    </div>

    <!-- Bottom section: hovered/selected node detail. Only present when needed;
         drag the divider to resize the two sections. -->
    <template v-if="nodeDetail">
      <div
        class="group h-2 shrink-0 cursor-row-resize border-y border-border/70 bg-border/30 transition-colors hover:bg-accent/30"
        @pointerdown="startResize"
      >
        <div
          class="mx-auto mt-[3px] h-0.5 w-8 rounded-full bg-muted/50 transition-colors group-hover:bg-accent"
        />
      </div>
      <div class="min-h-0 shrink-0 overflow-y-auto p-5" :style="{ height: bottomHeight + 'px' }">
        <NodeDetailPanel :detail="nodeDetail" />
      </div>
    </template>
  </aside>
</template>
