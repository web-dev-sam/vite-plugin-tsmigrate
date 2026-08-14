<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { fetchSource } from "../api/client.ts";
import { highlightSource } from "../highlight.ts";

/**
 * A shadcn-style dialog showing a node's source with shiki syntax highlighting.
 * Open when `nodeId` is non-null; `file` is the project-relative path shown in
 * the header while the fetch resolves. Fetches by absolute id, highlights, and
 * guards against out-of-order responses with a monotonic token. Closes on the
 * overlay, the × button, or Escape.
 */
const props = defineProps<{ nodeId: string | null; file: string | null }>();
const emit = defineEmits<{ close: [] }>();

const html = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
let token = 0;

watch(
  () => props.nodeId,
  async (id) => {
    html.value = null;
    error.value = null;
    if (!id) return;
    loading.value = true;
    const seq = ++token;
    try {
      const source = await fetchSource(id);
      const rendered = await highlightSource(source.content, source.file);
      if (seq === token) html.value = rendered;
    } catch (err) {
      if (seq === token) error.value = String(err);
    } finally {
      if (seq === token) loading.value = false;
    }
  },
);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && props.nodeId) emit("close");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-75 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="nodeId"
        class="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
        @click.self="emit('close')"
      >
        <div
          class="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl shadow-black/50"
          role="dialog"
          aria-modal="true"
        >
          <header class="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
            <span class="truncate font-mono text-sm text-fg">{{ file }}</span>
            <button
              type="button"
              aria-label="Close"
              class="flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-border/60 hover:text-fg"
              @click="emit('close')"
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
          </header>

          <div class="min-h-0 flex-1 overflow-auto text-xs leading-relaxed">
            <p v-if="loading" class="px-4 py-6 text-muted">loading…</p>
            <p v-else-if="error" class="px-4 py-6 text-red">{{ error }}</p>
            <!-- v-html is safe here: the markup is shiki's own escaped output over server-read source. -->
            <div
              v-else-if="html"
              class="source [&_pre]:m-0 [&_pre]:px-4 [&_pre]:py-3"
              v-html="html"
            />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
