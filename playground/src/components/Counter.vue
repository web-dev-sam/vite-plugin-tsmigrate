<script setup lang="ts">
import { ref } from "vue";

const count = ref(0);
</script>

<template>
  <button type="button" data-testid="counter" @click="count++">count is {{ count }}</button>
</template>

<style scoped>
button {
  padding: 0.6em 1.2em;
  font-size: 1rem;
  cursor: pointer;
}
</style>
