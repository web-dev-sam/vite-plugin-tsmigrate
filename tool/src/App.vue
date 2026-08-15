<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import type { ComponentGraph, Diagnostics, MaintainabilityDriver } from "../../src/shared/types.ts";
import { fetchDiagnostics, fetchGraph, fetchSearch } from "./api/client.ts";
import ControlPanel from "./components/ControlPanel.vue";
import GraphChart from "./components/GraphChart.vue";
import SourceModal from "./components/SourceModal.vue";
import type { Controls, CycleInfo, NodeDetail, Readouts } from "./graph/render.ts";

/**
 * Root of the dev tool. Owns the live data lifecycle (progressive polling of
 * `/api/graph` with cheap `?since` probes), the persistent view-control state,
 * and the chart + panel layout. The panel
 * two-way-binds every control; the chart renders whichever induced graph
 * (`vue` or `full`) the TS-swap selects and reports its readouts back up.
 */
const graph = ref<ComponentGraph | null>(null);
const diag = ref<Diagnostics | null>(null);
const readouts = ref<Readouts | null>(null);
// Detail of the hovered/selected graph node — feeds the sidebar's bottom panel
// (null hides it).
const nodeDetail = ref<NodeDetail | null>(null);
const error = ref<string | null>(null);

// Persistent view controls (defaults mirror the prototype's initial panel).
const view = reactive({
  mode: "strict" as Controls["mode"],
  onlyRed: false,
  onlyGreen: false,
  showRings: true,
  showBlame: false,
  includeTs: true,
  showLinks: false,
  highlightLinks: false,
  showLabels: false,
  search: "",
  contentSearch: "",
  blameGreen: true,
  blameRed: false,
});

// Whether the server found the ripgrep binary (gates the content-search bar).
const ripgrep = computed(() => diag.value?.ripgrep ?? false);

// Files whose contents match the content-search regex; null = no active
// content query. The renderer ANDs this with the name/id search.
const contentMatches = ref<Set<string> | null>(null);

// The subset the renderer consumes (TS-swap is resolved into `activeGraph`).
const controls = computed<Controls>(() => ({
  mode: view.mode,
  onlyRed: view.onlyRed,
  onlyGreen: view.onlyGreen,
  showRings: view.showRings,
  showBlame: view.showBlame,
  search: view.search,
  contentMatches: contentMatches.value,
  blameGreen: view.blameGreen,
  blameRed: view.blameRed,
  showLinks: view.showLinks,
  highlightLinks: view.highlightLinks,
  showLabels: view.showLabels,
}));

// `only show vue files` swaps the full module graph back to the component-only
// graph; the full (vue+ts) graph is the default view.
const activeGraph = computed(() => {
  if (!graph.value) return null;
  return view.includeTs ? graph.value.full : graph.value.vue;
});

// Whether the project has any `.vue` components — gates the "only show vue
// files" toggle, which is meaningless (and would blank the graph) otherwise.
const hasVue = computed(() => (graph.value?.vue.nodes.length ?? 0) > 0);

const header = computed(() => ({
  complete: graph.value?.complete ?? false,
  appUrl: diag.value?.appUrl ?? null,
  projectName: diag.value?.projectName ?? null,
}));

// Browser tab reflects the analyzed project by name (falls back to the tool's own name).
watch(
  () => header.value.projectName,
  (name) => {
    document.title = name ?? "tsmigrate";
  },
  { immediate: true },
);

// Shipped import cycles preprocessed for the panel + renderer: display label
// and the cut hint — the internal value edge crossing the fewest symbols is
// the cheapest to sever (type-only edges are not what holds a cycle together).
const cycleInfos = computed<CycleInfo[]>(() => {
  const g = graph.value;
  if (!g) return [];
  const baseOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  return g.maintainability.cycles.map((members) => {
    const set = new Set(members);
    let cut: CycleInfo["cut"] = null;
    let best = Infinity;
    for (const e of g.full.edges) {
      if (e.type || !set.has(e.from) || !set.has(e.to)) continue;
      const n = e.symbols?.length ?? Infinity;
      if (n < best) {
        best = n;
        const count = n === Infinity ? "whole module" : `${n} ${n === 1 ? "symbol" : "symbols"}`;
        cut = { from: e.from, to: e.to, label: `${baseOf(e.from)} → ${baseOf(e.to)} (${count})` };
      }
    }
    return { members, label: members.map(baseOf).join(" ↔ "), cut };
  });
});

const chart = ref<InstanceType<typeof GraphChart> | null>(null);

// The node whose source the modal is showing (null = closed). Set on a
// Ctrl/Cmd-click on a node in the chart; the modal fetches + highlights by id.
const source = ref<{ id: string; file: string } | null>(null);

// The driver whose per-node contribution the graph highlights as rings
// (null = off). Toggled by clicking a driver row in the panel.
const activeDriver = ref<MaintainabilityDriver | null>(null);
function toggleDriver(d: MaintainabilityDriver) {
  activeDriver.value = activeDriver.value === d ? null : d;
}

// Actionability contract (§9): the score's hotspots and cycles live in the
// FULL module graph, but the default view is `.vue`-only. Clicking one must
// never silently no-op — switch the view on first, then focus.
async function focusNode(id: string) {
  if (!view.includeTs && graph.value && !graph.value.vue.nodes.some((n) => n.id === id)) {
    view.includeTs = true;
    await nextTick();
  }
  chart.value?.focusDependents(id);
}
async function focusCycle(members: string[]) {
  const inVue = (id: string) => graph.value?.vue.nodes.some((n) => n.id === id) ?? false;
  if (!view.includeTs && !members.every(inVue)) {
    view.includeTs = true;
    await nextTick();
  }
  chart.value?.focusSet(members);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

// Poll fast while analysis runs, then slowly (cheap ?since probes) once
// complete so watcher-driven changes still surface.
async function poll() {
  try {
    const res = await fetchGraph(graph.value?.version);
    if (!("unchanged" in res)) {
      graph.value = res;
    }
    error.value = null;
  } catch (err) {
    error.value = String(err);
  }
  if (stopped) return;
  timer = setTimeout(poll, graph.value?.complete ? 2000 : 300);
}

// Content search runs server-side via ripgrep. Debounce keystrokes, and guard
// against out-of-order responses with a monotonic token so the latest query
// always wins. Empty query clears the filter (null = inactive).
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;
watch(
  () => view.contentSearch,
  (pattern) => {
    clearTimeout(searchTimer);
    const query = pattern.trim();
    if (!query) {
      searchSeq++;
      contentMatches.value = null;
      return;
    }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      try {
        const files = await fetchSearch(query);
        if (seq === searchSeq) contentMatches.value = new Set(files);
      } catch (err) {
        if (seq !== searchSeq) return;
        // Invalid regex (or search failure): show the message and match nothing.
        error.value = String(err);
        contentMatches.value = new Set();
      }
    }, 250);
  },
);

onMounted(async () => {
  try {
    diag.value = await fetchDiagnostics();
  } catch {
    // Diagnostics are best-effort chrome; ignore when offline.
  }
  void poll();
});

onUnmounted(() => {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(searchTimer);
});
</script>

<template>
  <GraphChart
    v-if="activeGraph"
    ref="chart"
    :graph="activeGraph"
    :full-graph="graph?.full ?? null"
    :cycles="cycleInfos"
    :controls="controls"
    :driver="activeDriver"
    :contributions="graph?.maintainability.contributions ?? null"
    :breakdown="graph?.maintainability.breakdown ?? null"
    @readouts="readouts = $event"
    @open-source="source = $event"
    @node-detail="nodeDetail = $event"
  />

  <ControlPanel
    v-model:mode="view.mode"
    v-model:only-red="view.onlyRed"
    v-model:only-green="view.onlyGreen"
    v-model:show-rings="view.showRings"
    v-model:show-blame="view.showBlame"
    v-model:include-ts="view.includeTs"
    v-model:show-links="view.showLinks"
    v-model:highlight-links="view.highlightLinks"
    v-model:show-labels="view.showLabels"
    v-model:search="view.search"
    v-model:content-search="view.contentSearch"
    v-model:blame-green="view.blameGreen"
    v-model:blame-red="view.blameRed"
    :readouts="readouts"
    :header="header"
    :ripgrep="ripgrep"
    :maintainability="graph?.maintainability ?? null"
    :active-driver="activeDriver"
    :node-detail="nodeDetail"
    :cycles="cycleInfos"
    :has-vue="hasVue"
    @depth-click="chart?.toggleDepth($event)"
    @focus-node="focusNode($event)"
    @cycle-click="focusCycle($event)"
    @driver-click="toggleDriver($event)"
  />

  <p
    v-if="error"
    class="fixed bottom-3 right-3 rounded-md border border-red/50 bg-panel/95 px-3 py-2 text-xs text-red"
  >
    {{ error }}
  </p>

  <!-- §12 blind-spot banner: auto-imported bindings have no import statements,
       so their edges are missing and blast radius reads falsely LOW. -->
  <p
    v-if="graph?.autoImportManifests.length"
    class="fixed top-3 right-3 max-w-110 rounded-md border border-warn/50 bg-panel/95 px-3 py-2 text-xs text-warn"
    :title="graph.autoImportManifests.join('\n')"
  >
    auto-imports detected — some bindings are invisible to the graph; coupling and blast radius are
    under-reported
  </p>

  <SourceModal :node-id="source?.id ?? null" :file="source?.file ?? null" @close="source = null" />
</template>
