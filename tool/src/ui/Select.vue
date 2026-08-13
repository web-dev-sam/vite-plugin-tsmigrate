<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

/**
 * A shadcn-style single-select: a styled trigger button and a popover listbox
 * (chevron, per-item check on the selection, hover/focus highlight). Fully
 * presentational — two-way binds the chosen value over `{ value, label }`
 * options. Keyboard: Enter/Space/↓ open, ↑/↓ move, Enter select, Esc close;
 * pointer-down outside closes.
 */
const props = defineProps<{ options: readonly { value: T; label: string }[] }>();
const model = defineModel<T>({ required: true });

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);

const selectedLabel = computed(
  () => props.options.find((o) => o.value === model.value)?.label ?? "",
);

function items(): HTMLElement[] {
  return root.value ? [...root.value.querySelectorAll<HTMLElement>("[role=option]")] : [];
}
function focusItem(i: number): void {
  const els = items();
  if (els.length > 0) els[(i + els.length) % els.length]?.focus();
}
function currentIndex(): number {
  return items().indexOf(document.activeElement as HTMLElement);
}

async function openMenu(): Promise<void> {
  open.value = true;
  await nextTick();
  focusItem(
    Math.max(
      0,
      props.options.findIndex((o) => o.value === model.value),
    ),
  );
}
function close(focusTrigger = false): void {
  open.value = false;
  if (focusTrigger) trigger.value?.focus();
}
function select(value: T): void {
  model.value = value;
  close(true);
}

function onTriggerKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    void openMenu();
  }
}
function onItemKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusItem(currentIndex() + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    focusItem(currentIndex() - 1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    close(true);
  } else if (e.key === "Tab") {
    close();
  }
}

function onPointerDown(e: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close();
}
onMounted(() => document.addEventListener("pointerdown", onPointerDown, true));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onPointerDown, true));
</script>

<template>
  <div ref="root" class="relative">
    <button
      ref="trigger"
      type="button"
      role="combobox"
      :aria-expanded="open"
      class="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-canvas px-3 py-2 text-left text-sm text-fg shadow-sm outline-none transition focus:border-accent focus:ring-1 focus:ring-accent/50"
      :class="{ 'border-accent ring-1 ring-accent/50': open }"
      @click="open ? close() : openMenu()"
      @keydown="onTriggerKeydown"
    >
      <span class="truncate">{{ selectedLabel }}</span>
      <svg
        class="size-4 shrink-0 opacity-60 transition-transform"
        :class="{ 'rotate-180': open }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="scale-95 opacity-0"
      leave-active-class="transition duration-75 ease-in"
      leave-to-class="scale-95 opacity-0"
    >
      <div
        v-if="open"
        role="listbox"
        class="absolute z-50 mt-1 w-full origin-top overflow-hidden rounded-md border border-border bg-[#1c2128] p-1 shadow-lg shadow-black/40"
      >
        <button
          v-for="o in options"
          :key="o.value"
          type="button"
          role="option"
          :aria-selected="o.value === model"
          class="relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pr-2 pl-8 text-left text-sm text-fg outline-none transition-colors hover:bg-accent/15 focus:bg-accent/15"
          @click="select(o.value)"
          @keydown="onItemKeydown"
        >
          <svg
            v-if="o.value === model"
            class="absolute left-2 size-4 text-accent"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          {{ o.label }}
        </button>
      </div>
    </Transition>
  </div>
</template>
