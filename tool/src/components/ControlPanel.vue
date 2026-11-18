<script setup lang="ts">
import { computed, ref } from "vue";
import type { DepthRow, Mode, NodeDetail, Readouts } from "../graph/render.ts";
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
  /** Detail of the hovered/selected graph node — populates the bottom section (null hides it). */
  nodeDetail: NodeDetail | null;
  /** Whether the project has any `.vue` components (gates the vue-only toggle). */
  hasVue: boolean;
  /** Why the TS 7.1 checker fell back to `typeCheckCommand` (null: it didn't). */
  ts7Fallback: string | null;
}>();
const emit = defineEmits<{
  depthClick: [height: number];
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
const ts7 = defineModel<boolean>("ts7", { required: true });

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

      <Collapsible title="typing" flush :default-open="false">
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

          <div>
            <p class="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">type check</p>
            <div class="space-y-2.5">
              <Tooltip
                content="Experimental: type-check with TypeScript 7.1 (beta) and @vue/content-mapper instead of vue-tsc (typeCheckCommand). Runs external code — TypeScript starts the content mapper's own Node process. Uses tsconfig.ts7-check.json when present, else your tsconfig plus the Vue mapper; falls back to typeCheckCommand when it can't run."
              >
                <Checkbox v-model="ts7">
                  TypeScript 7.1
                  <span class="text-xs text-warn">experimental · runs external code</span>
                </Checkbox>
              </Tooltip>
              <p v-if="ts7 && ts7Fallback" class="text-xs break-words text-warn">
                Fell back to typeCheckCommand: {{ ts7Fallback }}
              </p>
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
