import { extname, join } from "node:path";
import type { ComponentEdge } from "../shared/types.ts";
import type { AnalysisHost } from "./host.ts";
import { extractSfcScripts, parseImports } from "./imports.ts";

const SCRIPT_EXTS: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".mts": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
};

/** Result of a crawl: every reachable `.vue` file plus component relations. */
export interface CrawlResult {
  nodes: string[];
  edges: ComponentEdge[];
}

/**
 * Find the app entry module: the `<script type="module">` of the root
 * index.html (Vite convention), falling back to `src/main.{ts,js}`.
 */
export async function findEntry(host: AnalysisHost): Promise<string | null> {
  const indexHtml = join(host.root, "index.html");
  const html = await host.readFile(indexHtml);
  const src = html?.match(
    /<script[^>]*type\s*=\s*["']module["'][^>]*src\s*=\s*["']([^"']+)["']/i,
  )?.[1];
  const candidates = src ? [src] : ["./src/main.ts", "./src/main.js"];
  for (const candidate of candidates) {
    const resolved = await host.resolve(candidate, indexHtml);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/**
 * BFS the import graph from the entry. Nodes are `.vue` files; edges connect
 * components, collapsing pass-through modules (barrels, composables):
 * `A.vue → shared/index.ts → B.vue` becomes `A → B`.
 */
export async function crawlGraph(host: AnalysisHost, entry: string): Promise<CrawlResult> {
  const directImports = new Map<string, string[]>();
  const vueNodes = new Set<string>();

  const resolveModuleImports = async (file: string): Promise<string[]> => {
    const code = await host.readFile(file);
    if (!code) {
      return [];
    }
    const source = file.endsWith(".vue") ? extractSfcScripts(code) : code;
    const resolved: string[] = [];
    for (const spec of parseImports(source)) {
      const target = await host.resolve(spec, file);
      if (!target) {
        continue;
      }
      const clean = target.split("?")[0];
      if (
        clean.startsWith("\0") ||
        !clean.startsWith(host.root) ||
        clean.includes("/node_modules/")
      ) {
        continue;
      }
      const ext = extname(clean);
      if (ext !== ".vue" && !SCRIPT_EXTS[ext]) {
        continue;
      }
      resolved.push(clean);
    }
    return resolved;
  };

  // Discover every reachable project module.
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (directImports.has(file)) {
      continue;
    }
    const imports = await resolveModuleImports(file);
    directImports.set(file, imports);
    if (file.endsWith(".vue")) {
      vueNodes.add(file);
    }
    queue.push(...imports);
  }

  // Components reachable from a non-vue module without crossing another
  // component — memoized so shared barrels are walked once.
  const reachMemo = new Map<string, Set<string>>();
  const vueReach = (file: string, visiting: Set<string>): Set<string> => {
    const memo = reachMemo.get(file);
    if (memo) {
      return memo;
    }
    if (visiting.has(file)) {
      return new Set();
    }
    visiting.add(file);
    const out = new Set<string>();
    for (const imported of directImports.get(file) ?? []) {
      if (imported.endsWith(".vue")) {
        out.add(imported);
      } else {
        for (const vue of vueReach(imported, visiting)) {
          out.add(vue);
        }
      }
    }
    visiting.delete(file);
    reachMemo.set(file, out);
    return out;
  };

  const edges: ComponentEdge[] = [];
  const seenEdges = new Set<string>();
  for (const from of vueNodes) {
    for (const imported of directImports.get(from) ?? []) {
      const targets = imported.endsWith(".vue") ? [imported] : vueReach(imported, new Set());
      for (const to of targets) {
        const key = `${from}\n${to}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          edges.push({ from, to });
        }
      }
    }
  }

  return { nodes: [...vueNodes].sort(), edges };
}
