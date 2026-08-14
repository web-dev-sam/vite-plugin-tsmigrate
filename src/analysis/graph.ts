import { dirname, extname, join, sep } from "node:path";
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

/** A reachable module and its kind, derived from the file extension. */
export interface CrawlFile {
  id: string;
  kind: "vue" | "ts";
}

/**
 * Result of a crawl. `nodes`/`edges` are the `.vue` component view with
 * barrel-collapsed edges (the existing semantics). `files`/`rawEdges` are the
 * full module view: every reachable file with its kind and the raw
 * importer→imported edges among them, uncollapsed.
 */
export interface CrawlResult {
  nodes: string[];
  edges: ComponentEdge[];
  files: CrawlFile[];
  rawEdges: ComponentEdge[];
}

/** Whether the crawl can follow this entry (a script module or an SFC). */
const isCrawlableEntry = (id: string): boolean => {
  const ext = extname(id.split("?")[0]);
  return ext === ".vue" || SCRIPT_EXTS[ext] === true;
};

/** Last-resort entry paths when nothing is configured and there's no index.html. */
const DEFAULT_ENTRIES = [
  "./src/main.ts",
  "./src/main.tsx",
  "./src/main.js",
  "./src/main.jsx",
  "./src/main.mts",
  "./src/main.mjs",
];

/**
 * Resolve the app's crawl roots, in priority order:
 *   1. build-configured entries (`build.rollupOptions.input`) — for apps that
 *      serve their module script from outside a static `index.html`, e.g.
 *      Laravel's `@vite('resources/js/app.ts')` in a Blade template, or
 *      library / multi-page builds. Non-script/SFC entries (CSS) are dropped.
 *   2. the root `index.html`'s first `<script type="module" src>` (Vite's
 *      default single-page convention).
 *   3. `src/main.{ts,tsx,js,jsx,mts,mjs}` as a last resort.
 *
 * Returns every resolved root (deduped); empty only when nothing resolves.
 */
export async function findEntries(host: AnalysisHost): Promise<string[]> {
  const configured: string[] = [];
  for (const entry of host.configuredEntries()) {
    if (isCrawlableEntry(entry) && (await host.readFile(entry)) !== null) {
      configured.push(entry);
    }
  }
  if (configured.length > 0) {
    return [...new Set(configured)];
  }

  const indexHtml = join(host.root, "index.html");
  const html = await host.readFile(indexHtml);
  // First `<script type="module">` that has a `src`, regardless of attribute
  // order (HTML attribute order is arbitrary — do not assume type precedes src).
  let src: string | undefined;
  for (const tag of html?.matchAll(/<script\b[^>]*>/gi) ?? []) {
    const attrs = tag[0];
    if (!/\btype\s*=\s*["']module["']/i.test(attrs)) {
      continue;
    }
    const match = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (match) {
      src = match[1];
      break;
    }
  }
  const candidates = src ? [src] : DEFAULT_ENTRIES;
  for (const candidate of candidates) {
    const resolved = await host.resolve(candidate, indexHtml);
    if (resolved) {
      return [resolved];
    }
  }
  return [];
}

/**
 * BFS the import graph from one or more entry roots. Nodes are `.vue` files;
 * edges connect components, collapsing pass-through modules (barrels,
 * composables): `A.vue → shared/index.ts → B.vue` becomes `A → B`.
 */
export async function crawlGraph(host: AnalysisHost, entries: string[]): Promise<CrawlResult> {
  const directImports = new Map<string, string[]>();
  const vueNodes = new Set<string>();

  // A resolved target is a crawlable project module: under the root, not a
  // virtual module or a dependency, and a script/SFC by extension.
  const accept = (target: string | null): string | null => {
    if (!target) {
      return null;
    }
    const clean = target.split("?")[0];
    if (
      clean.startsWith("\0") ||
      (clean !== host.root && !clean.startsWith(host.root + sep)) ||
      clean.includes("/node_modules/")
    ) {
      return null;
    }
    const ext = extname(clean);
    return ext === ".vue" || SCRIPT_EXTS[ext] ? clean : null;
  };

  const resolveModuleImports = async (file: string): Promise<string[]> => {
    const code = await host.readFile(file);
    if (!code) {
      return [];
    }
    const source = file.endsWith(".vue") ? extractSfcScripts(code) : code;
    const { specifiers, globs } = parseImports(source);
    const resolved = new Set<string>();
    for (const spec of specifiers) {
      const clean = accept(await host.resolve(spec, file));
      if (clean) {
        resolved.add(clean);
      }
    }
    // Follow `import.meta.glob` / computed dynamic imports by expanding their
    // patterns against the filesystem (relative to this module's directory).
    if (globs.length > 0) {
      for (const hit of await host.glob(globs, dirname(file))) {
        const clean = accept(hit);
        if (clean) {
          resolved.add(clean);
        }
      }
    }
    return [...resolved];
  };

  // Discover every reachable project module.
  const queue = [...entries];
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

  // Full module view: every reachable file with its kind, plus the raw
  // importer→imported edges among them (no barrel collapsing).
  const files: CrawlFile[] = [];
  const rawEdges: ComponentEdge[] = [];
  const seenRaw = new Set<string>();
  for (const from of [...directImports.keys()].sort()) {
    files.push({ id: from, kind: from.endsWith(".vue") ? "vue" : "ts" });
    for (const to of directImports.get(from) ?? []) {
      if (to === from) {
        continue;
      }
      const key = `${from}\n${to}`;
      if (seenRaw.has(key)) {
        continue;
      }
      seenRaw.add(key);
      rawEdges.push({ from, to });
    }
  }

  return { nodes: [...vueNodes].sort(), edges, files, rawEdges };
}
