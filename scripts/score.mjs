#!/usr/bin/env node
// Headless maintainability capture: start each playground's dev server (the
// plugin serves its JSON API on TSMIGRATE_PORT), poll /api/graph until the
// engine reports `complete: true` (crawl + analyzers + type-check all done),
// save the full payload, and print a score summary. Used to record the
// anchor scores in docs/maintainability-score.md and to diff graphs across
// refactors.
//
//   node scripts/score.mjs [--out tmp/scores] [--no-deepen] [--assert] [playground ...]
//
// Playgrounds default to all three. Output: <out>/<playground>.json (full
// /api/graph payload) plus a printed summary table.
//
// The playground submodules are shallow clones — churn needs history, so by
// default each submodule is deepened to cover the estimator's window
// (`git fetch --shallow-since="20 months ago"`); `--no-deepen` skips the
// network round-trip. `--assert` checks the captured scores against the
// recorded calibration fixtures (v2.1) and exits nonzero on drift:
// ±5 points per fixture, ordering is a hard assertion, plus artifact guards
// (vben's icon barrel must read calm, vben's top hotspot is resize.vue).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLAYGROUNDS = ["playground", "playground-vuetify", "playground-shadcn"];
const POLL_MS = 2000;
const TIMEOUT_MS = 20 * 60 * 1000;

const args = process.argv.slice(2);
let out = "tmp/scores";
let deepen = true;
let assert = false;
const playgrounds = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") {
    out = args[++i];
  } else if (args[i] === "--no-deepen") {
    deepen = false;
  } else if (args[i] === "--assert") {
    assert = true;
  } else {
    playgrounds.push(args[i]);
  }
}
if (playgrounds.length === 0) {
  playgrounds.push(...DEFAULT_PLAYGROUNDS);
}
mkdirSync(join(root, out), { recursive: true });

// The shallow fixture submodules and the branch each tracks (.gitmodules).
const SUBMODULES = {
  playground: { path: "playground/vben", branch: "main" },
  "playground-vuetify": { path: "playground-vuetify/vuetify", branch: "master" },
  "playground-shadcn": { path: "playground-shadcn/shadcn-vue", branch: "dev" },
};

// Calibration fixtures (epoch v2.1): expected score ±5; ordering is hard.
const EXPECTED = {
  "playground-shadcn": 95,
  playground: 71,
  "playground-vuetify": 60,
};
const TOLERANCE = 5;

/** Deepen a shallow fixture submodule to cover the churn window. Best-effort: offline runs still capture, churn just reads thin. */
function deepenFixture(playground) {
  const sub = SUBMODULES[playground];
  if (!sub || !existsSync(join(root, sub.path, ".git"))) {
    return;
  }
  const res = spawnSync(
    "git",
    ["-C", join(root, sub.path), "fetch", "--shallow-since=20 months ago", "origin", sub.branch],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 300_000 },
  );
  if (res.status !== 0) {
    const err = res.stderr ? String(res.stderr).trim().split("\n").at(-1) : "spawn failure";
    process.stderr.write(`warn: ${playground}: deepen failed (${err}) — churn may read thin\n`);
  }
}

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
const captured = new Map();
for (const playground of playgrounds) {
  if (deepen) {
    process.stderr.write(`deepening ${playground} history…\n`);
    deepenFixture(playground);
  }
  process.stderr.write(`capturing ${playground}…\n`);
  const g = await capture(playground);
  captured.set(playground, g);
  const m = g.maintainability;
  rows.push({
    playground,
    score: m.score,
    omega: m.omega,
    nodes: m.nodes,
    edges: m.edges,
    floorLoc: m.floorLoc,
    costLoc: m.costLoc,
    comprehension: Number(m.drivers.comprehension.toFixed(3)),
    blast: Number(m.drivers.blast.toFixed(3)),
    mass: Number(m.drivers.mass.toFixed(3)),
    cycleLoc: Number(m.cycleLoc.toFixed(3)),
    churnCov: m.churnCoverage,
    unreached: g.coverage.sourceFiles - g.coverage.graphFiles,
    epoch: m.calibrationEpoch,
  });
}
console.table(rows);

if (assert) {
  const failures = [];
  const scoreOf = (p) => captured.get(p)?.maintainability.score;

  // Per-fixture tolerance (±5 — estimator detail drift is acceptable).
  for (const [p, expected] of Object.entries(EXPECTED)) {
    const actual = scoreOf(p);
    if (actual === undefined) {
      continue; // not captured this run
    }
    if (Math.abs(actual - expected) > TOLERANCE) {
      failures.push(`${p}: score ${actual}, expected ${expected} ±${TOLERANCE}`);
    }
  }

  // Ordering is a hard assertion: registry > vben app > vuetify library.
  const order = ["playground-shadcn", "playground", "playground-vuetify"]
    .map((p) => [p, scoreOf(p)])
    .filter(([, s]) => s !== undefined);
  for (let i = 1; i < order.length; i++) {
    if (order[i - 1][1] <= order[i][1]) {
      failures.push(
        `ordering violated: ${order[i - 1][0]} (${order[i - 1][1]}) <= ${order[i][0]} (${order[i][1]})`,
      );
    }
  }

  // Artifact guards on the vben capture.
  const vben = captured.get("playground");
  if (vben) {
    const m = vben.maintainability;
    const lucide = Object.entries(m.volatility).find(([id]) => id.endsWith("/lucide.ts"));
    if (lucide && lucide[1] >= 0.1) {
      failures.push(
        `vben lucide.ts volatility ${lucide[1]}, expected < 0.1 (append-only barrel must read calm)`,
      );
    }
    const top = m.hotspots[0]?.file ?? "(none)";
    if (!top.endsWith("resize.vue")) {
      failures.push(`vben top hotspot ${top}, expected resize.vue`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `\nFIXTURE ASSERTIONS FAILED\n${failures.map((f) => `  - ${f}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stderr.write("fixture assertions passed\n");
}
