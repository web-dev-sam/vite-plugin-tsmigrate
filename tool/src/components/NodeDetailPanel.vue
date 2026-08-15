<script setup lang="ts">
import type { NodeDetail } from "../graph/render.ts";
import Collapsible from "../ui/Collapsible.vue";
import StatRow from "../ui/StatRow.vue";
import Tooltip from "../ui/Tooltip.vue";

/**
 * The sidebar's bottom section: structured detail of the hovered or selected
 * graph node. Carries everything the tooltip used to show beyond the terse
 * filename/LOC/links summary — status, path, per-depth stats, git blame and the
 * (formerly alt-hover) change-cost breakdown — laid out with collapsibles.
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

// Instability ∈ [0,1]: low = stable (green), high = change-prone (red).
function instabilityTone(v: number): string {
  if (v < 0.34) {
    return "text-green";
  }
  return v < 0.67 ? "text-warn" : "text-red";
}
const INSTABILITY_HELP =
  "How change-prone this file is: it leans on more files than lean on it. " +
  "Green = stable; red = changes often, so edits here ripple further.";
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
        <StatRow>
          <template #label><span class="text-muted">branches</span></template>
          {{ detail.cc }}
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

    <Collapsible v-if="detail.breakdown" title="change-cost breakdown" :default-open="false">
      <p v-if="detail.breakdown.atFloor" class="text-xs text-muted">
        at its floor · nothing dragging the score here
      </p>
      <div v-else class="space-y-2.5">
        <div v-for="d in detail.breakdown.drivers" :key="d.key">
          <div class="flex items-center justify-between gap-2">
            <span class="flex items-center gap-2">
              <span
                class="inline-block size-2 shrink-0 rounded-full"
                :style="{ backgroundColor: d.color }"
              />
              {{ d.label }}
            </span>
            <span class="shrink-0 font-semibold tabular-nums">
              <template v-if="d.share !== null">{{ d.share }}%</template>
              <template v-else-if="d.multiplier !== undefined"
                >×{{ d.multiplier.toFixed(2) }}</template
              >
            </span>
          </div>
          <p class="mt-0.5 text-xs text-muted">
            {{ d.meta
            }}<template v-if="d.instability !== undefined">
              ·
              <Tooltip as="span" :content="INSTABILITY_HELP">
                <span class="underline decoration-dotted underline-offset-2">instability</span>
                <span :class="instabilityTone(d.instability)"
                  >&nbsp;{{ d.instability.toFixed(2) }}</span
                >
              </Tooltip>
            </template>
          </p>
          <p v-if="d.action" class="mt-0.5 text-xs text-accent">→ {{ d.action }}</p>
          <ul v-if="d.items.length" class="mt-1 space-y-0.5">
            <li
              v-for="(item, i) in d.items"
              :key="i"
              class="flex items-center justify-between gap-2 pl-3 text-xs"
              :title="item.why"
            >
              <span class="truncate">{{ item.name }}</span>
              <span class="shrink-0 text-muted tabular-nums">{{ item.tail }}</span>
            </li>
          </ul>
        </div>
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
