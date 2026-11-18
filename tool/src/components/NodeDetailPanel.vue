<script setup lang="ts">
import type { NodeDetail } from "../graph/render.ts";
import Collapsible from "../ui/Collapsible.vue";
import StatRow from "../ui/StatRow.vue";

/**
 * The sidebar's bottom section: structured detail of the hovered or selected
 * graph node. Carries everything the tooltip used to show beyond the terse
 * filename/LOC/links summary — status, path, depth and git blame — laid out
 * with collapsibles.
 */
defineProps<{ detail: NodeDetail }>();

const statusTone: Record<NodeDetail["status"], string> = {
  typed: "text-green",
  red: "text-red",
  analyzing: "text-muted",
};
const statusLabel: Record<NodeDetail["status"], string> = {
  typed: "typed",
  red: "red",
  analyzing: "analyzing",
};
</script>

<template>
  <div class="text-sm text-fg">
    <!-- Filename (base) + path + kind badge + hover/selection tag. -->
    <header class="mb-3">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="truncate font-semibold text-purple" :title="detail.file">
          {{ detail.fileBase }}
        </h2>
        <span class="shrink-0 text-xs text-muted">
          {{ detail.source === "hover" ? "hovered" : "selected" }}
        </span>
      </div>
      <p v-if="detail.fileDir" class="truncate text-xs text-muted" :title="detail.file">
        {{ detail.fileDir }}
      </p>
    </header>

    <Collapsible title="overview" flush>
      <div class="space-y-1.5">
        <StatRow>
          <template #label><span class="text-muted">status</span></template>
          <span :class="statusTone[detail.status]">{{ statusLabel[detail.status] }}</span>
          <span v-if="detail.ownStatus" class="text-muted"> · {{ detail.ownStatus }}</span>
        </StatRow>
        <StatRow>
          <template #label><span class="text-muted">kind</span></template>
          {{ detail.ext }}
        </StatRow>
        <StatRow>
          <template #label><span class="text-muted">depth</span></template>
          {{ detail.height }}
        </StatRow>
        <StatRow>
          <template #label><span class="text-muted">LOC</span></template>
          {{ detail.loc }}
        </StatRow>
        <StatRow v-if="detail.errors">
          <template #label><span class="text-muted">type errors</span></template>
          <span class="text-red">{{ detail.errors }}</span>
        </StatRow>
        <StatRow>
          <template #label><span class="text-muted">links</span></template>
          {{ detail.fanIn }} consume it · consumes {{ detail.fanOut }} deps
        </StatRow>
      </div>
    </Collapsible>

    <Collapsible v-if="detail.blame.length" title="blame by author" :default-open="false">
      <table class="w-full border-collapse text-xs">
        <tbody>
          <tr v-for="row in detail.blame" :key="row.author">
            <td class="py-0.5">{{ row.author }}</td>
            <td class="py-0.5 text-right tabular-nums text-muted">{{ row.loc }} LOC</td>
          </tr>
        </tbody>
      </table>
    </Collapsible>
  </div>
</template>
