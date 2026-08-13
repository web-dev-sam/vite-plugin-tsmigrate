<script setup lang="ts">
/** A labelled form field: caption above, control (slot) below. */
defineProps<{ label: string }>();
</script>

<template>
  <label class="block select-none">
    <span class="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">
      {{ label }}
    </span>
    <slot />
  </label>
</template>
