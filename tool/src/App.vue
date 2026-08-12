<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { ComponentGraph, ComponentNode, Diagnostics } from "../../src/shared/types.ts";
import { fetchDiagnostics, fetchGraph } from "./api/client.ts";

const diag = ref<Diagnostics | null>(null);
const graph = ref<ComponentGraph | null>(null);
const error = ref<string | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

// Poll fast while analysis is running, slowly (cheap ?since probes) once
// complete so watcher-driven changes still show up.
async function poll() {
  try {
    const res = await fetchGraph(graph.value?.version);
    if (!("unchanged" in res)) {
      graph.value = res;
    }
    error.value = null;
  } catch (err) {
    error.value = String(err);
  }
  if (stopped) {
    return;
  }
  timer = setTimeout(poll, graph.value?.complete ? 2000 : 300);
}

onMounted(async () => {
  try {
    diag.value = await fetchDiagnostics();
  } catch (err) {
    error.value = String(err);
  }
  void poll();
});

onUnmounted(() => {
  stopped = true;
  clearTimeout(timer);
});

const nameById = computed(() => {
  const names = new Map<string, string>();
  for (const node of graph.value?.nodes ?? []) {
    names.set(node.id, node.name);
  }
  return names;
});

function blameLabel(node: ComponentNode): string {
  if (!node.blame) {
    return node.errors.blame ?? node.status.blame;
  }
  return Object.entries(node.blame.authorLines)
    .map(([author, lines]) => `${author}: ${lines}`)
    .join(", ");
}
</script>

<template>
  <main>
    <h1>tsmigrate</h1>
    <p class="sub">
      Diagnosing your Vue app
      <template v-if="diag">
        — <a v-if="diag.appUrl" :href="diag.appUrl" target="_blank">app</a>
        <span v-if="diag.vueVersion"> · vue {{ diag.vueVersion }}</span>
      </template>
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="graph">
      <p class="status">
        {{ graph.nodes.length }} components · {{ graph.edges.length }} relations ·
        {{ graph.complete ? "analysis complete" : "analyzing…" }} · v{{ graph.version }}
      </p>

      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th>File</th>
            <th>LoC</th>
            <th>Blame (lines per author)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in graph.nodes" :key="node.id">
            <td>{{ node.name }}</td>
            <td>
              <code>{{ node.file }}</code>
            </td>
            <td>{{ node.loc ?? node.status.loc }}</td>
            <td>{{ blameLabel(node) }}</td>
          </tr>
        </tbody>
      </table>

      <h2>Relations</h2>
      <ul v-if="graph.edges.length">
        <li v-for="edge in graph.edges" :key="edge.from + edge.to">
          {{ nameById.get(edge.from) ?? edge.from }} →
          {{ nameById.get(edge.to) ?? edge.to }}
        </li>
      </ul>
      <p v-else>no component imports found</p>
    </template>
    <p v-else>Loading…</p>
  </main>
</template>

<style scoped>
main {
  font-family: system-ui, sans-serif;
  max-width: 48rem;
  margin: 3rem auto;
  padding: 0 1rem;
}

.sub {
  color: #888;
  margin-top: -0.75rem;
}

.error {
  color: #c00;
}

.status {
  color: #666;
  font-size: 0.9rem;
}

table {
  border-collapse: collapse;
  width: 100%;
}

th,
td {
  text-align: left;
  padding: 0.35rem 0.75rem 0.35rem 0;
  border-bottom: 1px solid #ddd;
  vertical-align: top;
}

h2 {
  font-size: 1rem;
  margin-top: 1.5rem;
}

ul {
  margin: 0;
  padding-left: 1.1rem;
}
</style>
