<script setup lang="ts">
import { ref } from "vue";

/**
 * A collapsible panel section: the same top divider as `Section` (skipped with
 * `flush` for the first block), plus a clickable caption with a rotating
 * chevron that toggles the body. An optional `#actions` slot renders to the
 * right of the caption and stays visible when collapsed (e.g. the
 * maintainability score, the blame filter checkboxes).
 */
const props = withDefaults(
  defineProps<{ title: string; defaultOpen?: boolean; flush?: boolean }>(),
  {
    defaultOpen: true,
    flush: false,
  },
);

const open = ref(props.defaultOpen);
</script>

<template>
  <section :class="flush ? '' : 'mt-4 border-t border-border/70 pt-4'">
    <div class="flex items-center justify-between gap-2">
      <button
        type="button"
        class="flex flex-1 items-center gap-1.5 text-left text-xs font-medium tracking-wide text-muted uppercase transition-colors hover:text-fg"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span
          class="inline-block text-[0.65rem] transition-transform"
          :class="open ? 'rotate-90' : ''"
          >▶</span
        >
        {{ title }}
      </button>
      <slot name="actions" />
    </div>
    <div v-show="open">
      <slot />
    </div>
  </section>
</template>
