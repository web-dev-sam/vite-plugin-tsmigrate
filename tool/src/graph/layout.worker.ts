/// <reference lib="webworker" />
import wasmUrl from "../../layout/target/wasm32-unknown-unknown/release/tsmigrate_layout.wasm?url";
import { INPUT_STRIDE, type PositionsMessage, type ToWorker } from "./layout.ts";

/**
 * Force-layout worker: hosts the Rust/WASM simulation (`tool/layout`) and
 * mirrors d3's scheduling — a fixed settling run (time-sliced so drag
 * messages interleave), then a ~60 Hz live loop whenever alpha is hot
 * (dragging, reheat) until it cools below alphaMin.
 */

interface LayoutExports {
  memory: WebAssembly.Memory;
  sim_alpha_min(): number;
  sim_new(n: number, m: number): number;
  sim_free(sim: number): void;
  sim_input(sim: number): number;
  sim_links(sim: number): number;
  sim_out(sim: number): number;
  sim_load(sim: number, alpha: number): void;
  sim_reload_radii(sim: number): void;
  sim_tick(sim: number, iterations: number): number;
  sim_alpha(sim: number): number;
  sim_set_alpha(sim: number, alpha: number): void;
  sim_set_alpha_target(sim: number, target: number): void;
  sim_fix(sim: number, index: number, x: number, y: number): void;
  sim_unfix(sim: number, index: number): void;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

const ready = (async () => {
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports as unknown as LayoutExports;
})();

/** Settling budget per slice before yielding to the message queue (ms). */
const SLICE_MS = 12;
/** Live-loop frame interval (ms) — d3's timer runs once per animation frame. */
const FRAME_MS = 16;

let wasm: LayoutExports;
let alphaMin = 0.001;
let sim = 0;
let n = 0;
let gen = -1;
/** Remaining settling ticks; Infinity = until cold; 0 = not settling. */
let settleLeft = 0;
let dragging = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function post(settled: boolean): void {
  const positions = new Float32Array(wasm.memory.buffer, wasm.sim_out(sim), n * 2).slice();
  const msg: PositionsMessage = { type: "positions", gen, positions, settled };
  scope.postMessage(msg, [positions.buffer]);
}

function schedule(delay: number): void {
  if (timer === undefined) timer = setTimeout(pump, delay);
}

function pump(): void {
  timer = undefined;
  if (!sim) return;
  if (settleLeft > 0) {
    const end = performance.now() + SLICE_MS;
    let alpha = wasm.sim_alpha(sim);
    do {
      alpha = wasm.sim_tick(sim, 1);
      settleLeft--;
      if (settleLeft === Infinity && alpha < alphaMin) settleLeft = 0;
    } while (settleLeft > 0 && performance.now() < end);
    const settled = settleLeft <= 0;
    if (settled) settleLeft = 0;
    post(settled);
    if (!settled) schedule(0);
    else if (dragging || alpha >= alphaMin) schedule(FRAME_MS);
    return;
  }
  const alpha = wasm.sim_tick(sim, 1);
  post(false);
  if (dragging || alpha >= alphaMin) schedule(FRAME_MS);
}

function handle(msg: ToWorker): void {
  if (msg.type === "load") {
    if (sim) wasm.sim_free(sim);
    gen = msg.gen;
    n = msg.input.length / INPUT_STRIDE;
    const m = msg.links.length / 2;
    sim = wasm.sim_new(n, m);
    // Views are created after every call that may grow memory.
    new Float32Array(wasm.memory.buffer, wasm.sim_input(sim), msg.input.length).set(msg.input);
    new Uint32Array(wasm.memory.buffer, wasm.sim_links(sim), msg.links.length).set(msg.links);
    wasm.sim_load(sim, msg.alpha);
    settleLeft = msg.ticks > 0 ? msg.ticks : Infinity;
    dragging = false;
    clearTimeout(timer);
    timer = undefined;
    schedule(0);
    return;
  }
  if (msg.gen !== gen || !sim) return;
  if (msg.type === "radii") {
    const input = new Float32Array(wasm.memory.buffer, wasm.sim_input(sim), n * INPUT_STRIDE);
    for (let i = 0; i < n; i++) input[i * INPUT_STRIDE + 5] = msg.radii[i]!;
    wasm.sim_reload_radii(sim);
    if (wasm.sim_alpha(sim) < msg.reheat) wasm.sim_set_alpha(sim, msg.reheat);
    schedule(0);
    return;
  }
  // Drag: d3's `alphaTarget(0.15).restart()` + fx/fy pinning.
  if (msg.phase === "start") {
    dragging = true;
    wasm.sim_set_alpha_target(sim, 0.15);
    wasm.sim_fix(sim, msg.index, msg.x, msg.y);
    schedule(0);
  } else if (msg.phase === "move") {
    wasm.sim_fix(sim, msg.index, msg.x, msg.y);
  } else {
    dragging = false;
    wasm.sim_set_alpha_target(sim, 0);
    wasm.sim_unfix(sim, msg.index);
  }
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  // Every handler awaits the same promise, so message order is preserved.
  wasm = await ready;
  alphaMin = wasm.sim_alpha_min();
  handle(e.data);
};
