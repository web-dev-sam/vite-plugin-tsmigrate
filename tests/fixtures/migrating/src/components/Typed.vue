<script setup lang="ts">
import { formatTyped } from "../util/typed";

const label: string = formatTyped("typed");
</script>

<template>
  <p>{{ label }}</p>
</template>
