<script setup lang="ts">
 /**
 * A label/value readout row: the `label` slot sits left, the default slot
 * (the value) is right-aligned and muted. Presentational only.
 */
</script>

<template>
  <div class="flex items-center justify-between gap-3">
    <span class="flex items-center gap-2"><slot name="label" /></span>
    <span class="tabular-nums text-muted"><slot /></span>
  </div>
</template>
