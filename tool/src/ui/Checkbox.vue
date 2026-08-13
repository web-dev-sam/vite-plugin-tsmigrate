<script setup lang="ts">
/**
 * A shadcn-style checkbox: a small accent-filled box with a check glyph, plus
 * an inline label (default slot). Two-way binds `checked`. The native input is
 * kept (appearance stripped) so it stays keyboard- and a11y-correct.
 */
const checked = defineModel<boolean>({ required: true });
</script>

<template>
  <label
    class="flex cursor-pointer select-none items-center gap-2.5 text-muted transition-colors hover:text-fg"
  >
    <span class="relative inline-flex size-4 shrink-0 items-center justify-center">
      <input
        v-model="checked"
        type="checkbox"
        class="peer absolute inset-0 cursor-pointer appearance-none rounded-[4px] border border-border bg-canvas shadow-sm outline-none transition-colors checked:border-accent checked:bg-accent focus-visible:ring-2 focus-visible:ring-accent/50"
      />
      <svg
        class="pointer-events-none relative z-10 size-3 text-canvas opacity-0 transition-opacity peer-checked:opacity-100"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
    <span><slot /></span>
  </label>
</template>
