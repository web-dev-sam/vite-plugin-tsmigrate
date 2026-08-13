<script setup lang="ts">
import { useAttrs } from "vue";

/** A small round legend swatch. Presentational only. */
const props = withDefaults(defineProps<{ tone: "green" | "red" | "ts"; size?: "sm" | "md" }>(), {
  size: "md",
});

const attrs = useAttrs();

const toneClass = { green: "bg-green", red: "bg-red", ts: "bg-ts" }[props.tone];
const sizeClass = props.size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
</script>

<template>
  <span class="inline-block shrink-0 rounded-full" :class="[toneClass, sizeClass, attrs.class]" />
</template>
