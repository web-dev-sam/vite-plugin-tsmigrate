<script setup lang="ts">
/**
 * A styled single-line text input. Two-way binds its value. When `clearable`,
 * a clear (×) button appears on the right edge while the field is non-empty.
 */
defineProps<{ placeholder?: string; clearable?: boolean; disabled?: boolean }>();
const value = defineModel<string>({ required: true });
</script>

<template>
  <div class="relative">
    <input
      v-model="value"
      :placeholder="placeholder"
      :disabled="disabled"
      autocomplete="off"
      class="box-border w-full rounded-md border border-border bg-canvas px-3 py-2 text-fg outline-none transition placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent/50 disabled:cursor-not-allowed"
      :class="clearable ? 'pr-9' : ''"
    />
    <button
      v-if="clearable && value && !disabled"
      type="button"
      aria-label="Clear search"
      title="Clear"
      class="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted transition-colors hover:text-fg"
      @click="value = ''"
    >
      <svg
        viewBox="0 0 16 16"
        class="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  </div>
</template>
