<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import type {
  Graph,
  MaintainabilityContributions,
  MaintainabilityDriver,
} from "../../../src/shared/types.ts";
import { type Controls, type GraphController, type Readouts, initGraph } from "../graph/render.ts";

/**
 * Thin Vue wrapper around the framework-agnostic d3 renderer. Owns the
 * full-viewport `<svg>` and its hover tooltip; drives the renderer from props
 * and surfaces the renderer's computed readouts back up as an event.
 */
const props = defineProps<{
  graph: Graph;
  controls: Controls;
  driver: MaintainabilityDriver | null;
  contributions: MaintainabilityContributions | null;
}>();
const emit = defineEmits<{
  readouts: [Readouts];
  openSource: [{ id: string; file: string }];
}>();

const svgRef = ref<SVGSVGElement | null>(null);
const tipRef = ref<HTMLElement | null>(null);
let controller: GraphController | null = null;

onMounted(() => {
  if (!svgRef.value || !tipRef.value) return;
  controller = initGraph({
    svg: svgRef.value,
    tooltip: tipRef.value,
    onReadouts: (r) => emit("readouts", r),
    onOpenSource: (n) => emit("openSource", n),
  });
  // Controls first so the initial paint honours the live colour mode / filters.
  controller.setControls(props.controls);
  controller.setGraph(props.graph);
  controller.setDriverHighlight(props.driver, props.contributions);
});

// A new graph reference means a vue↔full swap or fresh server data.
watch(
  () => props.graph,
  (g) => controller?.setGraph(g),
);
watch(
  () => props.controls,
  (c) => controller?.setControls(c),
  { deep: true },
);
watch(
  () => [props.driver, props.contributions],
  () => controller?.setDriverHighlight(props.driver, props.contributions),
);

onUnmounted(() => controller?.destroy());

// Depth-row isolate and hotspot-row focus are driven imperatively from the panel via the parent.
defineExpose({
  toggleDepth: (height: number) => controller?.toggleDepth(height),
  focusDependents: (id: string) => controller?.focusDependents(id),
});
</script>

<template>
  <svg ref="svgRef" class="block h-screen w-screen cursor-grab bg-canvas active:cursor-grabbing" />
  <div
    ref="tipRef"
    class="tip pointer-events-none fixed max-w-[340px] rounded-md border border-border bg-[#010409]/95 px-2 py-1.5 text-xs opacity-0 transition-opacity duration-75"
  />
</template>
