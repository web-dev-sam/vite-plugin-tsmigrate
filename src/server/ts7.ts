import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as AsyncApi from "typescript-7/async";
import type { API, Snapshot } from "typescript-7/async";
import { type FileEvent, groupTs7Diagnostics, type TypeChecker } from "../analysis/typecheck.ts";

/**
 * EXPERIMENTAL: the project type-check pass on the TypeScript 7.1 (beta) API
 * with Vue's content mapper (`@vue/content-mapper`) mapping `.vue` files, in
 * place of a vue-tsc run. One API process (the Go `tsc`) lives as long as the
 * checker; watcher events become `snapshot.update` file notifications, so each
 * pass re-checks incrementally instead of re-running a CLI.
 *
 * `runExternalCode` is on: TypeScript spawns the content mapper's own Node
 * process.
 *
 * The API is a preview; names below were checked against `typescript@7.1.0-beta`'s
 * `.d.ts`. Content mappers only apply to configured projects opened through
 * `createSnapshot({ openProjects })` — `createPrograms` ignores them
 * (microsoft/TypeScript#64641).
 */

// Both ship as this package's own pinned dependencies — nothing for the user to
// install. The 7.1 API is an npm alias (`typescript-7`) so it never shadows
// the project's TypeScript 5/6 that vue-tsc needs.
const require = createRequire(import.meta.url);

type AsyncApiModule = typeof AsyncApi;

interface Session {
  api: API;
  snapshot: Snapshot;
  /** The config opened as the project (the user's, or the shim extending it). */
  config: string;
}

export function createTs7Checker(root: string, tsconfig: string): TypeChecker {
  let session: Promise<Session> | null = null;
  let disposed = false;
  // Watcher events since the snapshot last saw the disk; last event per path wins.
  const pending = new Map<string, FileEvent>();

  async function open(): Promise<Session> {
    const typescript = require.resolve("typescript-7/package.json");
    const mapper = require.resolve("@vue/content-mapper/package.json");
    const config = await projectConfig(root, resolve(root, tsconfig), {
      typescript: dirname(typescript),
      "@vue/content-mapper": dirname(mapper),
    });
    // The package's own name is `typescript`; resolve through it (from inside
    // the package) so its `exports` map applies to the alias too.
    const asyncApi = createRequire(typescript).resolve("typescript/async");
    // Dynamic: an ESM entry located at runtime, never bundled into the plugin.
    const { API } = (await import(pathToFileURL(asyncApi).href)) as AsyncApiModule;
    const api = new API({ cwd: root, runExternalCode: true });
    try {
      // The new snapshot reads the disk as it is now.
      pending.clear();
      const snapshot = await api.createSnapshot({ openProjects: [config] });
      return { api, snapshot, config };
    } catch (error) {
      await api.close().catch(() => {});
      throw error;
    }
  }

  return {
    info: { ts7: true },
    async check() {
      if (disposed) {
        throw new Error("TypeScript 7.1 checker was disposed");
      }
      session ??= open();
      const current = await session;
      if (pending.size > 0) {
        const fileNotifications = {
          changed: [] as string[],
          created: [] as string[],
          deleted: [] as string[],
        };
        for (const [file, event] of pending) {
          (event === "add"
            ? fileNotifications.created
            : event === "unlink"
              ? fileNotifications.deleted
              : fileNotifications.changed
          ).push(file);
        }
        pending.clear();
        // Without `ensurePrograms` the update only marks the project dirty and
        // its program keeps answering with the pre-change diagnostics.
        const next = await current.snapshot.update({ fileNotifications, ensurePrograms: true });
        // An update without effective changes hands back the same snapshot.
        if (next !== current.snapshot) {
          const previous = current.snapshot;
          current.snapshot = next;
          await previous.dispose();
        }
      }
      const project = current.snapshot.getConfiguredProject(current.config);
      if (!project) {
        throw new Error(`TypeScript 7.1 did not load ${current.config}`);
      }
      // Every file, every pass: one edit can break any importer. The program
      // belongs to the snapshot — `Program.dispose` only releases programs from
      // `api.createProgram`, so disposing the snapshot is what frees it.
      const { program } = project;
      const diagnostics = await Promise.all([
        program.getConfigFileParsingDiagnostics(),
        program.getSyntacticDiagnostics(),
        program.getSemanticDiagnostics(),
      ]);
      return groupTs7Diagnostics(diagnostics.flat());
    },
    fileChanged(file, event) {
      pending.set(file, event);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Free the Go side: snapshots pin programs and checkers there.
      void session?.then(
        async ({ api, snapshot }) => {
          await snapshot.dispose().catch(() => {});
          await api.close().catch(() => {});
        },
        () => {},
      );
    },
  };
}

/**
 * The config to open: a shim `tsconfig.json` in a directory whose
 * `node_modules` links the plugin's own packages. TypeScript resolves the
 * `contentMappers` package from the opened config's directory, and
 * `@vue/content-mapper` loads TypeScript itself as the plain `typescript`
 * package from there (refusing anything older than 7.1) — in the user's
 * project those would be missing, or the 5/6 that vue-tsc needs. Anything
 * else the mapper needs (`vue`) resolves on up into the project's
 * `node_modules`.
 */
async function projectConfig(
  root: string,
  userConfig: string,
  packages: Record<string, string>,
): Promise<string> {
  const shimDir = join(root, "node_modules", ".tsmigrate", "ts7");
  for (const [name, dir] of Object.entries(packages)) {
    const link = join(shimDir, "node_modules", name);
    const target = await realpath(dir);
    if ((await readlink(link).catch(() => null)) !== target) {
      await mkdir(dirname(link), { recursive: true });
      await rm(link, { force: true });
      // "junction": a directory link Windows creates without elevated rights.
      await symlink(target, link, "junction");
    }
  }
  const shim = join(shimDir, "tsconfig.json");
  const content = `${JSON.stringify(await shimConfig(root, userConfig), null, 2)}\n`;
  if ((await readFile(shim, "utf8").catch(() => null)) !== content) {
    await writeFile(shim, content);
  }
  return shim;
}

// Tried in order when the project has no `ts7Tsconfig`: Vite's app config
// (create-vue splits it out of a solution-style `tsconfig.json`), then the root one.
const BASE_CONFIGS = ["tsconfig.app.json", "tsconfig.json"];

/**
 * The user's `ts7Tsconfig` when it exists — `extends` keeps every path in it
 * (`include`, `paths`, `contentMappers`) relative to that file. Otherwise one
 * is generated: the project's own config plus no-emit and the Vue mapper.
 */
async function shimConfig(root: string, userConfig: string): Promise<object> {
  if (existsSync(userConfig)) {
    return { extends: userConfig };
  }
  const base = BASE_CONFIGS.map((name) => join(root, name)).find((path) => existsSync(path));
  const generated = {
    ...(base && { extends: base }),
    compilerOptions: { noEmit: true, skipLibCheck: true },
    contentMappers: [{ package: "@vue/content-mapper", extensions: [".vue"] }],
  };
  // A base that names its files keeps them (inherited, relative to the base).
  // Without one, TypeScript's default "every file" would be relative to the
  // shim, so spell it out for the project.
  const namesFiles = base && /"(?:include|files)"\s*:/.test(await readFile(base, "utf8"));
  return namesFiles
    ? generated
    : { ...generated, include: [join(base ? dirname(base) : root, "**/*")] };
}
