<script setup lang="ts">
import type { DepthRow, Mode, Readouts } from "../graph/render.ts";
import Checkbox from "../ui/Checkbox.vue";
import Dot from "../ui/Dot.vue";
import Field from "../ui/Field.vue";
import ProgressBar from "../ui/ProgressBar.vue";
import Section from "../ui/Section.vue";
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
}>();
const emit = defineEmits<{ depthClick: [height: number] }>();

const mode = defineModel<Mode>("mode", { required: true });
const onlyRed = defineModel<boolean>("onlyRed", { required: true });
const showRings = defineModel<boolean>("showRings", { required: true });
const showBlame = defineModel<boolean>("showBlame", { required: true });
const includeTs = defineModel<boolean>("includeTs", { required: true });
const showLinks = defineModel<boolean>("showLinks", { required: true });
const highlightLinks = defineModel<boolean>("highlightLinks", { required: true });
const search = defineModel<string>("search", { required: true });
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

    <Section flush>
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
    </Section>

    <Section>
      <div class="space-y-3">
        <TextInput v-model="search" clearable placeholder="search component…" />
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
    </Section>

    <!-- Per-depth typing; click a row to isolate that ring. -->
    <Section>
      <div
        class="mb-2 flex items-center justify-between px-2 text-xs font-medium tracking-wide text-muted uppercase"
      >
        <span>by depth</span>
        <span>% typed</span>
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
    </Section>

    <!-- Blame LoC per author over the shown set. -->
    <Section v-if="readouts && readouts.blame.available">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-xs font-medium tracking-wide text-muted uppercase">blame by author</h2>
        <span class="flex gap-3 text-xs text-muted">
          <Checkbox v-model="blameGreen">
            <Dot tone="green" size="sm" class="mr-1.5" />typed
          </Checkbox>
          <Checkbox v-model="blameRed"><Dot tone="red" size="sm" class="mr-1.5" />errors</Checkbox>
        </span>
      </div>
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
    </Section>

    <footer class="mt-4 border-t border-border/70 pt-4 text-xs text-muted">
      drag to pan · scroll to zoom · hover a node
    </footer>
  </aside>
</template>
