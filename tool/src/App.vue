<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import type { ComponentGraph, Diagnostics } from "../../src/shared/types.ts";
import { fetchDiagnostics, fetchGraph } from "./api/client.ts";
import ControlPanel from "./components/ControlPanel.vue";
import GraphChart from "./components/GraphChart.vue";
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
  search: "",
  blameGreen: true,
  blameRed: false,
});

// The subset the renderer consumes (TS-swap is resolved into `activeGraph`).
const controls = computed<Controls>(() => ({
  mode: view.mode,
  onlyRed: view.onlyRed,
  showRings: view.showRings,
  showBlame: view.showBlame,
  search: view.search,
  blameGreen: view.blameGreen,
  blameRed: view.blameRed,
  showLinks: view.showLinks,
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
});
</script>

<template>
  <GraphChart
    v-if="activeGraph"
    ref="chart"
    :graph="activeGraph"
    :controls="controls"
    @readouts="readouts = $event"
  />

  <ControlPanel
    v-model:mode="view.mode"
    v-model:only-red="view.onlyRed"
    v-model:show-rings="view.showRings"
    v-model:show-blame="view.showBlame"
    v-model:include-ts="view.includeTs"
    v-model:show-links="view.showLinks"
    v-model:search="view.search"
    v-model:blame-green="view.blameGreen"
    v-model:blame-red="view.blameRed"
    :readouts="readouts"
    :header="header"
    @depth-click="chart?.toggleDepth($event)"
  />

  <p
    v-if="error"
    class="fixed bottom-3 right-3 rounded-md border border-red/50 bg-panel/95 px-3 py-2 text-xs text-red"
  >
    {{ error }}
  </p>
</template>
