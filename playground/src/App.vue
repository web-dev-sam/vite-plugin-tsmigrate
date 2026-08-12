<script setup lang="ts">
import { ref } from "vue";
import { greeting } from "virtual:tsmigrate";

const count = ref(0);
</script>

<template>
  <main>
    <h1>{{ greeting }}</h1>
    <p>A Vue 3 counter served by Vite 8 with <code>vite-plugin-tsmigrate</code>.</p>
    <button type="button" data-testid="counter" @click="count++">count is {{ count }}</button>
  </main>
</template>

<style scoped>
main {
  font-family: system-ui, sans-serif;
  max-width: 32rem;
  margin: 4rem auto;
  text-align: center;
}

button {
  padding: 0.6em 1.2em;
  font-size: 1rem;
  cursor: pointer;
}
</style>
