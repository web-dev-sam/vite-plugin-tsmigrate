<script setup lang="ts">
/**
 * A panel section: a consistent top divider (skipped when `flush`, for the
 * first section) and an optional uppercase caption matching the field-label
 * style. Presentational only — groups related controls/readouts so the sidebar
 * reads as distinct blocks rather than one stream.
 */
defineProps<{ label?: string; flush?: boolean }>();
</script>

<template>
  <section :class="flush ? '' : 'mt-4 border-t border-border/70 pt-4'">
    <h2 v-if="label" class="mb-2.5 text-xs font-medium tracking-wide text-muted uppercase">
      {{ label }}
    </h2>
    <slot />
  </section>
</template>
