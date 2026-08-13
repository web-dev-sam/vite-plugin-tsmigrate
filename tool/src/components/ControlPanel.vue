<script setup lang="ts">
import type { DepthRow, Mode, Readouts } from "../graph/render.ts";

/**
 * The fixed left panel: title + diagnostics header, LoC-weighted progress bar,
 * the typed/errors/files/edges/leaves-roots readouts, search, colour mode,
 * the view-filter checkboxes (incl. the TS-swap), the clickable depth table
 * and the blame-by-author rollup. All readouts are computed by the renderer
 * over the shown set and passed in; every control is a two-way model. Titles
 * are carried over from the prototype verbatim for parity.
 */
defineProps<{
  readouts: Readouts | null;
  header: { version: number; complete: boolean; appUrl: string | null; demo: boolean };
}>();
const emit = defineEmits<{ depthClick: [height: number] }>();

const mode = defineModel<Mode>("mode", { required: true });
const onlyRed = defineModel<boolean>("onlyRed", { required: true });
const showRings = defineModel<boolean>("showRings", { required: true });
const showBlame = defineModel<boolean>("showBlame", { required: true });
const includeTs = defineModel<boolean>("includeTs", { required: true });
const search = defineModel<string>("search", { required: true });
const blameGreen = defineModel<boolean>("blameGreen", { required: true });
const blameRed = defineModel<boolean>("blameRed", { required: true });

const fmt = (n: number) => n.toLocaleString();

function depthLabel(d: DepthRow): string {
  return d.height === 0 ? "depth 0 (leaves)" : `depth ${d.height}`;
}
function depthTitle(d: DepthRow): string {
  const hops = `${d.height} hop${d.height === 1 ? "" : "s"}`;
  const leaf = d.height === 0 ? " (imports no other shown component)" : "";
  return (
    `Depth ${d.height}: longest import path to a leaf is ${hops}${leaf}. ` +
    `${d.pct.toFixed(0)}% of the LoC at this depth is typed ` +
    `(${d.green}/${d.total} files). Click to isolate this depth.`
  );
}
</script>

<template>
  <aside
    class="fixed bottom-3 left-3 top-3 w-[375px] overflow-y-auto rounded-lg border border-border bg-panel/95 px-3 py-2.5 text-fg shadow-[0_6px_24px_rgba(0,0,0,0.4)]"
  >
    <h1 class="mb-1 text-[13px] font-semibold">Vue typing progress</h1>

    <!-- Diagnostics header — analysis version/progress + live app link. -->
    <p class="mb-2 text-[11px] text-muted">
      <template v-if="header.demo">demo fixture</template>
      <template v-else>
        v{{ header.version }} ·
        <span :class="header.complete ? 'text-green' : 'text-muted'">
          {{ header.complete ? "complete" : "analyzing…" }}
        </span>
        <template v-if="header.appUrl">
          ·
          <a :href="header.appUrl" target="_blank" class="text-accent hover:underline">app</a>
        </template>
      </template>
    </p>

    <!-- LoC-weighted typing progress of the shown set. -->
    <div
      class="my-2 mb-2.5 h-2 overflow-hidden rounded bg-red"
      title="LoC-weighted typing progress of the shown set: green lines-of-code ÷ total lines-of-code"
    >
      <span
        class="block h-full bg-green"
        :style="{ width: `${(readouts?.locPct ?? 0).toFixed(1)}%` }"
      />
    </div>

    <div
      class="my-0.5 flex justify-between"
      title="Files counted green (typed) in the shown set — shown as % of total LoC that is green, then the green file count"
    >
      <span
        ><span
          class="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-green align-[-1px]"
        />typed</span
      >
      <span class="text-muted"
        >{{ (readouts?.locPct ?? 0).toFixed(1) }}% LoC · {{ readouts?.greenFiles ?? 0 }} files</span
      >
    </div>
    <div
      class="my-0.5 flex justify-between"
      title="Files counted red (has errors) in the shown set — file count, then their total lines of code"
    >
      <span
        ><span
          class="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-red align-[-1px]"
        />errors</span
      >
      <span class="text-muted"
        >{{ readouts?.redFiles ?? 0 }} files · {{ fmt(readouts?.redLoc ?? 0) }} LoC</span
      >
    </div>
    <div
      class="my-0.5 flex justify-between text-muted"
      title="Files shown / import edges among the shown files (parent imports child)"
    >
      <span>files / edges</span>
      <span>{{ readouts?.files ?? 0 }} / {{ readouts?.edges ?? 0 }}</span>
    </div>
    <div
      class="my-0.5 flex justify-between text-muted"
      title="Leaves = shown files that import no other shown file (outer rim) / roots = shown files imported by no other shown file (core)"
    >
      <span>leaves (outer) / roots (core)</span>
      <span>{{ readouts?.leaves ?? 0 }} / {{ readouts?.roots ?? 0 }}</span>
    </div>

    <input
      v-model="search"
      class="mt-2 box-border w-full rounded-md border border-border bg-canvas px-[7px] py-[5px] text-fg"
      placeholder="search component…"
      autocomplete="off"
    />

    <label class="mt-2 block select-none text-muted">
      colour mode
      <select
        v-model="mode"
        class="mt-1 w-full rounded-md border border-border bg-canvas px-1.5 py-1 text-fg"
      >
        <option value="strict">strict — red if any subtree file is red</option>
        <option value="naive">naive — red only if the file itself is red</option>
      </select>
    </label>

    <label class="mt-2 block select-none text-muted">
      <input v-model="onlyRed" type="checkbox" /> show only components with errors
    </label>
    <label class="mt-2 block select-none text-muted">
      <input v-model="showRings" type="checkbox" /> show depth numbers
    </label>
    <label class="mt-2 block select-none text-muted">
      <input v-model="showBlame" type="checkbox" /> show git blame (LoC per author)
    </label>
    <label class="mt-2 block select-none text-muted">
      <input v-model="includeTs" type="checkbox" /> include TS files
      <span class="text-ts">(purple ring)</span>
    </label>

    <!-- Per-depth progress; click a row to isolate that ring. -->
    <div class="mt-2.5 border-t border-border pt-2">
      <table class="w-full border-collapse">
        <tbody>
          <tr
            v-for="d in readouts?.depths ?? []"
            :key="d.height"
            class="cursor-pointer hover:[&>td]:text-fg"
            :class="{ '[&>td]:bg-[#1f6feb]/20 [&>td]:text-fg!': d.active }"
            :title="depthTitle(d)"
            @click="emit('depthClick', d.height)"
          >
            <td class="py-px">{{ depthLabel(d) }}</td>
            <td class="py-px text-right tabular-nums" :class="d.done ? 'text-green' : 'text-muted'">
              {{ d.pct.toFixed(0) }}%
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Blame rollup source toggles. -->
    <div class="mt-2.5 flex items-center justify-between border-t border-border pt-2 text-muted">
      <span>blame LoC from</span>
      <span>
        <label class="ml-2.5 inline-block select-none text-muted">
          <input v-model="blameGreen" type="checkbox" /><span
            class="mr-1 inline-block h-2 w-2 rounded-full bg-green"
          />green
        </label>
        <label class="ml-2.5 inline-block select-none text-muted">
          <input v-model="blameRed" type="checkbox" /><span
            class="mr-1 inline-block h-2 w-2 rounded-full bg-red"
          />red
        </label>
      </span>
    </div>

    <div v-if="readouts" class="mt-1">
      <div class="mb-1 text-muted">
        total LoC by author · {{ readouts.blame.set }} · {{ readouts.blame.files }} files ·
        {{ fmt(readouts.blame.sumLoc) }} LoC
      </div>
      <table class="w-full border-collapse">
        <tbody>
          <tr v-for="row in readouts.blame.rows" :key="row.author">
            <td class="py-px">{{ row.author }}</td>
            <td class="py-px text-right tabular-nums text-muted">
              {{ fmt(row.loc) }} · {{ row.pct.toFixed(1) }}%
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mt-2 flex justify-between text-[11px] text-muted">
      <span>drag to pan · scroll to zoom · hover a node</span>
    </div>
  </aside>
</template>
