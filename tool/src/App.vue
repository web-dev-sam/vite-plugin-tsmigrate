<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import type { ComponentGraph, Diagnostics, MaintainabilityDriver } from "../../src/shared/types.ts";
import { fetchDiagnostics, fetchGraph, fetchSearch } from "./api/client.ts";
import ControlPanel from "./components/ControlPanel.vue";
import GraphChart from "./components/GraphChart.vue";
import SourceModal from "./components/SourceModal.vue";
import type { Controls, Readouts } from "./graph/render.ts";

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
const error = ref<string | null>(null);

// Persistent view controls (defaults mirror the prototype's initial panel).
const view = reactive({
  mode: "strict" as Controls["mode"],
  onlyRed: false,
  showRings: true,
  showBlame: false,
  includeTs: false,
  showLinks: false,
  highlightLinks: false,
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
  showRings: view.showRings,
  showBlame: view.showBlame,
  search: view.search,
  contentMatches: contentMatches.value,
  blameGreen: view.blameGreen,
  blameRed: view.blameRed,
  showLinks: view.showLinks,
  highlightLinks: view.highlightLinks,
}));

// `include TS files` swaps the component-only graph for the full module graph.
const activeGraph = computed(() => {
  if (!graph.value) return null;
  return view.includeTs ? graph.value.full : graph.value.vue;
});

const header = computed(() => ({
  complete: graph.value?.complete ?? false,
  appUrl: diag.value?.appUrl ?? null,
}));

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

let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let appliedTsDefault = false;

// Poll fast while analysis runs, then slowly (cheap ?since probes) once
// complete so watcher-driven changes still surface.
async function poll() {
  try {
    const res = await fetchGraph(graph.value?.version);
    if (!("unchanged" in res)) {
      graph.value = res;
      // A tsx-only project (e.g. a component library like Vuetify) has no
      // `.vue` nodes; once the crawl completes, default the view to the full
      // module graph so it isn't blank. Fires once — a manual toggle sticks.
      if (
        !appliedTsDefault &&
        res.complete &&
        res.vue.nodes.length === 0 &&
        res.full.nodes.length > 0
      ) {
        view.includeTs = true;
        appliedTsDefault = true;
      }
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
    :controls="controls"
    :driver="activeDriver"
    :contributions="graph?.maintainability.contributions ?? null"
    @readouts="readouts = $event"
    @open-source="source = $event"
  />

  <ControlPanel
    v-model:mode="view.mode"
    v-model:only-red="view.onlyRed"
    v-model:show-rings="view.showRings"
    v-model:show-blame="view.showBlame"
    v-model:include-ts="view.includeTs"
    v-model:show-links="view.showLinks"
    v-model:highlight-links="view.highlightLinks"
    v-model:search="view.search"
    v-model:content-search="view.contentSearch"
    v-model:blame-green="view.blameGreen"
    v-model:blame-red="view.blameRed"
    :readouts="readouts"
    :header="header"
    :ripgrep="ripgrep"
    :maintainability="graph?.maintainability ?? null"
    :active-driver="activeDriver"
    @depth-click="chart?.toggleDepth($event)"
    @focus-node="chart?.focusDependents($event)"
    @driver-click="toggleDriver($event)"
  />

  <p
    v-if="error"
    class="fixed bottom-3 right-3 rounded-md border border-red/50 bg-panel/95 px-3 py-2 text-xs text-red"
  >
    {{ error }}
  </p>

  <SourceModal :node-id="source?.id ?? null" :file="source?.file ?? null" @close="source = null" />
</template>
