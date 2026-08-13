import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
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
    async resolve(specifier, importer) {
      const resolved = await container.resolveId(specifier, importer);
      return resolved?.id ?? null;
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
