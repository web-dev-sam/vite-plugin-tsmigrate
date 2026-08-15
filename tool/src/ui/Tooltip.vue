<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from "vue";

/**
 * A shadcn-style tooltip. Wraps its trigger (default slot) and shows `content`
 * on hover/focus after a short delay, in a teleported, fixed-positioned bubble.
 * Fixed positioning keeps it clear of the sidebar's scroll clipping.
 * Presentational only.
 *
 * Placement is viewport-aware: the bubble prefers to sit above the trigger,
 * flips below when it would clip the top edge, and its left is clamped inside
 * the viewport so long tooltips near a screen edge never run off-screen. The
 * arrow is repositioned to keep pointing at the trigger after clamping.
 *
 * `as` sets the wrapper tag so the trigger stays layout-correct in any context
 * (e.g. `tr` inside a table); fall-through attrs (class, @click, …) land on it.
 */
const props = withDefaults(defineProps<{ content?: string; as?: string }>(), {
  as: "div",
  content: "",
});

/** Viewport edge padding and trigger↔bubble gap, in px. */
const MARGIN = 8;
const GAP = 8;

const anchor = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const shown = ref(false);
const pos = ref<{ left: number; top: number }>({ left: 0, top: 0 });
// Arrow offset from the bubble's left edge (px) and which side it sits on.
const arrow = ref<{ left: number; below: boolean }>({ left: 0, below: false });
let timer: ReturnType<typeof setTimeout> | undefined;

function open(): void {
  if (!anchor.value) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    shown.value = true;
    await nextTick();
    place();
  }, 300);
}

// Position the (already-rendered) bubble relative to the trigger, clamped to the
// viewport. Uses offsetWidth/Height (layout box, transform-independent) so the
// enter animation's scale doesn't skew the measurement.
function place(): void {
  const a = anchor.value?.getBoundingClientRect();
  const el = bubble.value;
  if (!a || !el) return;
  const bw = el.offsetWidth;
  const bh = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const triggerCx = a.left + a.width / 2;

  // Horizontal: centre on the trigger, then clamp both edges into the viewport.
  const left = Math.max(MARGIN, Math.min(triggerCx - bw / 2, vw - bw - MARGIN));

  // Vertical: prefer above; flip below when the top would clip.
  let below = false;
  let top = a.top - GAP - bh;
  if (top < MARGIN) {
    below = true;
    top = a.bottom + GAP;
  }
  top = Math.max(MARGIN, Math.min(top, vh - bh - MARGIN));

  pos.value = { left, top };
  // Keep the arrow pointing at the trigger centre, clamped inside the bubble.
  arrow.value = { left: Math.max(10, Math.min(triggerCx - left, bw - 10)), below };
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
          ref="bubble"
          class="pointer-events-none fixed z-[100] max-w-xs rounded-md border border-border bg-[#1c2128] px-3 py-1.5 text-xs leading-snug text-fg shadow-lg shadow-black/40"
          :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
          role="tooltip"
        >
          <slot name="content">{{ content }}</slot>
          <span
            class="absolute size-2 -translate-x-1/2 rotate-45 border-border bg-[#1c2128]"
            :class="
              arrow.below
                ? 'bottom-full translate-y-1/2 border-t border-l'
                : 'top-full -translate-y-1/2 border-r border-b'
            "
            :style="{ left: `${arrow.left}px` }"
          />
        </div>
      </Transition>
    </Teleport>
  </component>
</template>
