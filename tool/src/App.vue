<script setup lang="ts">
import { onMounted, ref } from "vue";

interface Diagnostics {
  greeting: string;
  appUrl: string | null;
  root: string;
  vueVersion: string | null;
  vueModules: string[];
  plugins: string[];
}

const data = ref<Diagnostics | null>(null);
const error = ref<string | null>(null);

async function refresh() {
  try {
    const res = await fetch("/api/diagnostics");
    data.value = (await res.json()) as Diagnostics;
    error.value = null;
  } catch (err) {
    error.value = String(err);
  }
}

onMounted(refresh);
</script>

<template>
  <main>
    <h1>tsmigrate</h1>
    <p class="sub">Diagnosing your Vue app</p>

    <p v-if="error" class="error">{{ error }}</p>
    <template v-else-if="data">
      <p class="greeting">{{ data.greeting }}</p>
      <dl>
        <dt>App server</dt>
        <dd>
          <a v-if="data.appUrl" :href="data.appUrl" target="_blank">{{ data.appUrl }}</a>
          <span v-else>not listening</span>
        </dd>

        <dt>Vue in the app</dt>
        <dd>{{ data.vueVersion ? `v${data.vueVersion}` : "not detected" }}</dd>

        <dt>Project root</dt>
        <dd>
          <code>{{ data.root }}</code>
        </dd>

        <dt>Loaded .vue modules ({{ data.vueModules.length }})</dt>
        <dd>
          <ul v-if="data.vueModules.length">
            <li v-for="m in data.vueModules" :key="m">
              <code>{{ m }}</code>
            </li>
          </ul>
          <span v-else>none yet — open the app, then refresh</span>
        </dd>

        <dt>Plugins ({{ data.plugins.length }})</dt>
        <dd>
          <ul>
            <li v-for="p in data.plugins" :key="p">
              <code>{{ p }}</code>
            </li>
          </ul>
        </dd>
      </dl>
      <button type="button" @click="refresh">Refresh</button>
    </template>
    <p v-else>Loading…</p>
  </main>
</template>

<style scoped>
main {
  font-family: system-ui, sans-serif;
  max-width: 40rem;
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

dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 1.25rem;
}

dt {
  font-weight: 600;
}

dd {
  margin: 0;
}

ul {
  margin: 0;
  padding-left: 1.1rem;
}

button {
  margin-top: 1.25rem;
  padding: 0.5em 1.1em;
  cursor: pointer;
}
</style>
