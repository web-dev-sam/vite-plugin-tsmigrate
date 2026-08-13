<script setup lang="ts">
/**
 * A two-tone progress track: the fill (green) grows over a coloured track
 * (red). Purely presentational — the caller owns the semantics and the number.
 */
defineProps<{ value: number }>();
</script>

<template>
  <div class="h-2 overflow-hidden rounded-full bg-red/90">
    <span
      class="block h-full rounded-full bg-green transition-[width] duration-500 ease-out"
      :style="{ width: `${value}%` }"
    />
  </div>
</template>
