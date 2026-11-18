<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { Graph } from "../../../src/shared/types.ts";
import {
  type Controls,
  type GraphController,
  type NodeDetail,
  type Readouts,
  initGraph,
} from "../graph/render.ts";

/**
 * Thin Vue wrapper around the framework-agnostic renderer. Owns the
 * full-viewport host element (the renderer adds its WebGL + text canvases)
 * and the hover tooltip; drives the renderer from props and surfaces its
 * computed readouts back up as an event.
 */
const props = defineProps<{
  graph: Graph;
  controls: Controls;
}>();
const emit = defineEmits<{
  readouts: [Readouts];
  openSource: [{ id: string; file: string }];
  nodeDetail: [NodeDetail | null];
}>();

const hostRef = ref<HTMLDivElement | null>(null);
const tipRef = ref<HTMLElement | null>(null);
let controller: GraphController | null = null;

onMounted(() => {
  if (!hostRef.value || !tipRef.value) return;
  controller = initGraph({
    host: hostRef.value,
    tooltip: tipRef.value,
    onReadouts: (r) => emit("readouts", r),
    onOpenSource: (n) => emit("openSource", n),
    onNodeDetail: (d) => emit("nodeDetail", d),
  });
  // Controls first so the initial paint honours the live colour mode / filters.
  controller.setControls(props.controls);
  controller.setGraph(props.graph);
});

// A new graph reference means a vue↔full swap or fresh server data (the
// renderer restyles in place when the topology is unchanged).
watch(
  () => props.graph,
  (g) => controller?.setGraph(g),
);
watch(
  () => props.controls,
  (c) => controller?.setControls(c),
  { deep: true },
);

onUnmounted(() => controller?.destroy());

// The depth-row isolate is driven imperatively from the panel via the parent.
defineExpose({
  toggleDepth: (height: number) => controller?.toggleDepth(height),
});
</script>

<template>
  <div
    ref="hostRef"
    class="relative block h-screen w-screen cursor-grab overflow-hidden bg-canvas active:cursor-grabbing"
  />
  <div
    ref="tipRef"
    class="tip pointer-events-none fixed max-w-[340px] rounded-md border border-border bg-[#010409]/95 px-2 py-1.5 text-xs opacity-0 transition-opacity duration-75"
  />
</template>
