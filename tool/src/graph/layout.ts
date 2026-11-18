/**
 * Main-thread handle on the force-layout worker (`layout.worker.ts`, which
 * runs the Rust/WASM simulation in `tool/layout`). The layout never blocks the
 * UI thread: positions stream back as transferable `Float32Array`s (x, y per
 * node, in node-index order).
 */

/** Per-node stride of `LoadMessage.input`: x, y, seedX, seedY, ringRadius, collideRadius. */
export const INPUT_STRIDE = 6;

export interface LoadMessage {
  type: "load";
  gen: number;
  /** `INPUT_STRIDE` floats per node. */
  input: Float32Array;
  /** Node-index pairs: source (importer), target (imported). */
  links: Uint32Array;
  alpha: number;
  /** >0: exactly this many settling ticks (d3's pre-ticks); 0: tick until cold. */
  ticks: number;
}

export interface RadiiMessage {
  type: "radii";
  gen: number;
  /** New collide radius per node. */
  radii: Float32Array;
  /** Raise alpha to at least this, so the new radii resolve visibly. */
  reheat: number;
}

export interface DragMessage {
  type: "drag";
  gen: number;
  phase: "start" | "move" | "end";
  index: number;
  x: number;
  y: number;
}

export type ToWorker = LoadMessage | RadiiMessage | DragMessage;

export interface PositionsMessage {
  type: "positions";
  gen: number;
  positions: Float32Array;
  /** True on the message that ends the initial settling run. */
  settled: boolean;
}

export class LayoutClient {
  private readonly worker: Worker;
  private gen = 0;

  constructor(onPositions: (positions: Float32Array, settled: boolean) => void) {
    this.worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<PositionsMessage>) => {
      // Positions from a superseded layout must never paint the new graph.
      if (e.data.gen === this.gen) onPositions(e.data.positions, e.data.settled);
    };
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  load(input: Float32Array, links: Uint32Array, alpha: number, ticks: number): void {
    this.gen++;
    this.post({ type: "load", gen: this.gen, input, links, alpha, ticks }, [
      input.buffer,
      links.buffer,
    ]);
  }

  radii(radii: Float32Array, reheat: number): void {
    this.post({ type: "radii", gen: this.gen, radii, reheat }, [radii.buffer]);
  }

  drag(phase: DragMessage["phase"], index: number, x: number, y: number): void {
    this.post({ type: "drag", gen: this.gen, phase, index, x, y });
  }

  destroy(): void {
    this.worker.terminate();
  }
}
