import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { glob as tinyGlob } from "tinyglobby";
import type { ViteDevServer } from "vite";
import type { AnalysisEngine } from "../analysis/engine.ts";
import type { AnalysisHost } from "../analysis/host.ts";

const execFileAsync = promisify(execFile);

/**
 * The ONLY module that hands Vite capabilities to the analysis core.
 * Everything Vite-version-sensitive (resolver, watcher, module graph access)
 * lives here — analysis/ stays pure and unit-testable.
 */
export function createAnalysisHost(server: ViteDevServer): AnalysisHost {
  const root = server.config.root;
  const container = server.environments.client.pluginContainer;
  return {
    root,
    configuredEntries() {
      // Vite's resolved `build.rollupOptions.input` holds the entry modules a
      // plugin declared (laravel-vite-plugin, library/MPA builds). Normalise
      // the string | string[] | Record<string,string> shape to absolute paths;
      // non-JS entries (e.g. CSS) are filtered downstream by extension.
      const input = server.config.build?.rollupOptions?.input;
      const specs =
        input == null
          ? []
          : typeof input === "string"
            ? [input]
            : Array.isArray(input)
              ? input
              : Object.values(input);
      return specs.map((spec) => (isAbsolute(spec) ? spec : resolve(root, spec)));
    },
    async resolve(specifier, importer) {
      const resolved = await container.resolveId(specifier, importer);
      return resolved?.id ?? null;
    },
    async glob(patterns, fromDir) {
      // Relative patterns are anchored at the importing module's dir; a leading
      // `/` is project-root-relative (Vite's convention for import.meta.glob).
      const relative_ = patterns.filter((p) => !p.startsWith("/"));
      const rooted = patterns.filter((p) => p.startsWith("/")).map((p) => p.slice(1));
      const out = new Set<string>();
      const run = async (pats: string[], cwd: string) => {
        if (pats.length === 0) return;
        for (const hit of await tinyGlob(pats, {
          cwd,
          absolute: true,
          onlyFiles: true,
          ignore: ["**/node_modules/**"],
        })) {
          out.add(hit);
        }
      };
      await run(relative_, fromDir);
      await run(rooted, root);
      // Deterministic order: tinyglobby's concurrent traversal returns hits in
      // run-varying order, which would jitter BFS discovery (and thus edge
      // order) across otherwise identical crawls.
      return [...out].sort();
    },
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    },
    async runGit(args) {
      const { stdout } = await execFileAsync("git", args, {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    },
    exec(command, args) {
      // Never reject: a nonzero exit is normal for a type checker with
      // diagnostics, and we want its output regardless. Spawn failures
      // (ENOENT) resolve with a nonzero code and the reason in stderr.
      const { promise, resolve } = Promise.withResolvers<{
        stdout: string;
        stderr: string;
        code: number;
      }>();
      execFile(
        command,
        args,
        { cwd: root, maxBuffer: 256 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr, code: 0 });
            return;
          }
          // Nonzero exit → `code` is the numeric status. Spawn failure
          // → `code` is a string (e.g. "ENOENT"); surface its message.
          if (typeof error.code === "number") {
            resolve({ stdout, stderr, code: error.code });
          } else {
            resolve({ stdout, stderr: stderr || error.message, code: 1 });
          }
        },
      );
      return promise;
    },
  };
}

/**
 * A multiline content search backed by the `rg` (ripgrep) binary. Kept here
 * with the other process spawning; analysis/ stays pure. `available` is probed
 * once at construction — the UI disables the content-search bar when false.
 */
export interface ContentSearch {
  available: boolean;
  /**
   * Run a multiline regex over the project tree, resolving with matching paths
   * relative to root (matching `ComponentNode.file`). Rejects on an invalid
   * regex so the caller can surface it; empty query → no matches.
   */
  search(pattern: string): Promise<string[]>;
}

export async function createContentSearch(root: string): Promise<ContentSearch> {
  let available = false;
  try {
    await execFileAsync("rg", ["--version"], { timeout: 2000 });
    available = true;
  } catch {
    available = false;
  }
  return {
    available,
    async search(pattern) {
      if (!available || !pattern) return [];
      try {
        // -l: files with matches; -0: NUL-separated; -U: multiline. rg honours
        // .gitignore and skips binaries by default. `--` guards regex dashes.
        const { stdout } = await execFileAsync(
          "rg",
          ["--multiline", "--files-with-matches", "--null", "--", pattern, "."],
          { cwd: root, maxBuffer: 16 * 1024 * 1024 },
        );
        // Searching `.` prefixes every path with `./`; strip it so results line
        // up with `ComponentNode.file` (a bare `relative(root, id)`).
        return stdout
          .split("\0")
          .filter(Boolean)
          .map((p) => (p.startsWith("./") ? p.slice(2) : p));
      } catch (error) {
        // exit 1 = no matches (normal); exit 2 = bad regex (surface it).
        const err = error as { code?: number | string; stderr?: string };
        if (err.code === 1) return [];
        throw new Error(err.stderr?.trim() || "search failed");
      }
    },
  };
}

/**
 * Read one project file for the source-view modal, resolving `id` (an absolute
 * module id) against `root`. Returns `null` when the path escapes the root or
 * the file is unreadable — the caller answers 404. Kept beside the other fs
 * access; analysis/ stays pure.
 */
export async function readProjectFile(
  root: string,
  id: string,
): Promise<{ file: string; content: string } | null> {
  const abs = isAbsolute(id) ? resolve(id) : resolve(root, id);
  // Confine reads to the project tree — no `..` traversal, no absolute escapes.
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  try {
    const content = await readFile(abs, "utf8");
    return { file: relative(root, abs), content };
  } catch {
    return null;
  }
}

/** Forward watcher events to the engine; detach when the server closes. */
export function wireInvalidation(server: ViteDevServer, engine: AnalysisEngine): void {
  const onFileEvent = (path: string) => {
    engine.invalidateFile(path);
  };
  server.watcher.on("change", onFileEvent);
  server.watcher.on("add", onFileEvent);
  server.watcher.on("unlink", onFileEvent);
  server.httpServer?.once("close", () => {
    server.watcher.off("change", onFileEvent);
    server.watcher.off("add", onFileEvent);
    server.watcher.off("unlink", onFileEvent);
  });
}
