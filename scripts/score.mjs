#!/usr/bin/env node
// Headless maintainability capture: start each playground's dev server (the
// plugin serves its JSON API on TSMIGRATE_PORT), poll /api/graph until the
// engine reports `complete: true` (crawl + analyzers + type-check all done),
// save the full payload, and print a score summary. Used to record the
// before/after numbers in docs/maintainability-score.md (symbol-resolution
// steps 3 and 6) and to diff the `vue` graph across refactors.
//
//   node scripts/score.mjs [--out tmp/scores] [playground ...]
//
// Playgrounds default to all three. Output: <out>/<playground>.json (full
// /api/graph payload) plus a printed summary table.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAYGROUNDS = ["playground", "playground-vuetify", "playground-shadcn"];
const POLL_MS = 2000;
const TIMEOUT_MS = 20 * 60 * 1000;

const args = process.argv.slice(2);
let out = "tmp/scores";
const playgrounds = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") {
    out = args[++i];
  } else {
    playgrounds.push(args[i]);
  }
}
if (playgrounds.length === 0) {
  playgrounds.push(...DEFAULT_PLAYGROUNDS);
}
mkdirSync(join(root, out), { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(playground) {
  const port = await freePort();
  const child = spawn("vp", ["dev"], {
    cwd: join(root, playground),
    env: { ...process.env, TSMIGRATE_PORT: String(port) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let lastErr = "";
  child.stderr.on("data", (d) => {
    lastErr = String(d);
  });
  child.stdout.resume();
  const kill = () => {
    if (child.pid === undefined) {
      return; // never spawned
    }
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  try {
    const deadline = Date.now() + TIMEOUT_MS;
    let graph = null;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      if (child.exitCode !== null) {
        throw new Error(`${playground}: dev server exited (${child.exitCode})\n${lastErr}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/graph`);
        const json = await res.json();
        if (json.complete === true) {
          graph = json;
          break;
        }
      } catch {
        // server not up yet
      }
    }
    if (!graph) {
      throw new Error(`${playground}: timed out waiting for complete:true`);
    }
    writeFileSync(join(root, out, `${playground}.json`), JSON.stringify(graph));
    return graph;
  } finally {
    kill();
  }
}

const rows = [];
for (const playground of playgrounds) {
  process.stderr.write(`capturing ${playground}…\n`);
  const g = await capture(playground);
  const m = g.maintainability;
  rows.push({
    playground,
    score: m.score,
    nodes: m.nodes,
    edges: m.edges,
    floorLoc: m.floorLoc,
    costLoc: m.costLoc,
    comprehension: Number(m.drivers.comprehension.toFixed(3)),
    blast: Number(m.drivers.blast.toFixed(3)),
    types: Number(m.drivers.types.toFixed(3)),
    cycleLoc: Number(m.cycleLoc.toFixed(3)),
    vueNodes: g.vue.nodes.length,
    vueEdges: g.vue.edges.length,
  });
}
console.table(rows);
