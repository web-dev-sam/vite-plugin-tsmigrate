<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

/**
 * A shadcn-style tooltip. Wraps its trigger (default slot) and shows `content`
 * on hover/focus after a short delay, in a teleported, fixed-positioned bubble
 * centred above the trigger with a downward arrow. Fixed positioning keeps it
 * clear of the sidebar's scroll clipping. Presentational only.
 *
 * `as` sets the wrapper tag so the trigger stays layout-correct in any context
 * (e.g. `tr` inside a table); fall-through attrs (class, @click, …) land on it.
 */
const props = withDefaults(defineProps<{ content: string; as?: string }>(), { as: "div" });

const anchor = ref<HTMLElement | null>(null);
const shown = ref(false);
const pos = ref<{ left: number; top: number }>({ left: 0, top: 0 });
let timer: ReturnType<typeof setTimeout> | undefined;

function open(): void {
  const el = anchor.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  pos.value = { left: r.left + r.width / 2, top: r.top - 8 };
  clearTimeout(timer);
  timer = setTimeout(() => (shown.value = true), 300);
}
function close(): void {
  clearTimeout(timer);
  shown.value = false;
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <component
    :is="as"
    ref="anchor"
    @mouseenter="open"
    @mouseleave="close"
    @focusin="open"
    @focusout="close"
  >
    <slot />
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-100 ease-out"
        enter-from-class="scale-95 opacity-0"
        leave-active-class="transition duration-75 ease-in"
        leave-to-class="scale-95 opacity-0"
      >
        <div
          v-if="shown"
          class="pointer-events-none fixed z-[100] max-w-xs origin-bottom -translate-x-1/2 -translate-y-full rounded-md border border-border bg-[#1c2128] px-3 py-1.5 text-xs leading-snug text-fg shadow-lg shadow-black/40"
          :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
          role="tooltip"
        >
          {{ content }}
          <span
            class="absolute top-full left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-r border-b border-border bg-[#1c2128]"
          />
        </div>
      </Transition>
    </Teleport>
  </component>
</template>
