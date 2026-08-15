# vite-plugin-tsmigrate

A minimal, well-structured **Vite 8** plugin (hello world), developed with the
[Vite+](https://viteplus.dev) toolchain (`vp`).

## What this package is

- A **distributable devtool-style Vite plugin** (à la vite-plugin-inspect /
  vue-devtools), not an app. `src/index.ts` exports a `tsmigrate(options)`
  factory returning a Vite `Plugin`, plus a `default` export.
- Ships a virtual module (`virtual:tsmigrate`) and, during dev, hosts its
  **own Vue app** (`tool/`, prebuilt into `dist/client`, served with `sirv`)
  on `toolPort` (default `7357`, ephemeral fallback; dev-only; skipped in
  middleware mode; closed with the dev server).
- The tool analyses the user's app: **component import graph** (nodes =
  `.vue` files, edges collapse pass-through barrels), **LoC**, and **git
  blame lines-per-author** per component, served via `/api/graph` with
  progressive per-analyzer status. `/api/diagnostics` is the environment
  summary. Edges exist for a future d3 graph view.
- Built with `vp run build`: `vp pack` (tsdown → `dist/index.mjs` + types)
  then `vite build tool` (tool UI → `dist/client`). npm ships all of `dist/`.

## Architecture (dependency direction is enforced, acyclic)

- `src/index.ts` — public API + hook wiring ONLY; read this first.
- `src/shared/types.ts` — plugin ↔ tool UI wire contract; environment-neutral;
  the tool imports these types directly (type-only) — NEVER re-declare them.
- `src/analysis/` — **pure core, no `vite` imports, no process spawning**;
  capabilities injected via `AnalysisHost` (`host.ts`): resolver, fs, git.
  - `graph.ts` — entry discovery + BFS crawl; barrel-collapsing edges.
  - `imports.ts` — regex import scanner (designated swap point: oxc-parser).
  - `analyzers/` — the extension point: `Analyzer<T>` with `cost: "inline" |
"queued"`; currently `loc` and `blame`.
  - `cache.ts` — FactStore keyed (file, analyzer); invalidate per file
    (watcher) or per kind (blame on HEAD move).
  - `engine.ts` — orchestration: crawl + schedule + bounded queue (4) +
    monotonic `version`; snapshots are progressive, never blocking.
- `src/server/` —
  - `vite-adapter.ts` — the ONLY module touching `ViteDevServer` (resolver
    from `environments.client.pluginContainer`, watcher → invalidation, git
    runner). Vite API drift lands here.
  - `routes.ts` — HTTP → engine mapping; the transport seam (`?since=` cheap
    probes now; birpc/WS later replaces this file + `tool/src/api/client.ts`).
  - `static.ts`, `diagnostics.ts`, `index.ts` (lifecycle).
- `src/constants.ts`, `options.ts` (defaults live ONLY in `resolveOptions`),
  `virtual.ts`, `log.ts` (Vite-styled output via picocolors — keep new lines
  consistent).

## Where changes land

| Change              | Location                                          |
| ------------------- | ------------------------------------------------- |
| New option          | `options.ts` (type + default in `resolveOptions`) |
| New metric/analyzer | `analysis/analyzers/*.ts` + engine wiring         |
| New API endpoint    | `server/routes.ts` → logic in analysis/           |
| New Vite hook       | own top-level module, wired in `index.ts`         |
| Vite API usage      | `server/vite-adapter.ts` ONLY                     |
| Wire shape          | `shared/types.ts` (server + tool consume it)      |

## Project conventions

- **Author against `vite`, build with Vite+.** Public types come from
  `import type { Plugin } from "vite"` and `vite` is declared as a
  `peerDependency` (`^8`) — because consumers use plain Vite, not Vite+. Only
  test/config utilities are imported from `vite-plus` (e.g. `vite-plus/test`).
- **Plugin naming:** the `name` field MUST stay `vite-plugin-tsmigrate`.
- **Relative imports use explicit `.ts` extensions** (nodenext resolution).
- **Tests:** `tests/analysis.test.ts` exercises the pure core with in-memory
  fixtures (no dev server — the point of the DI boundary), including Vue 2
  options-API SFCs; `tests/index.test.ts` boots real Vite servers, including a
  full graph e2e against the hermetic app in `tests/fixtures/app/`. Keep both
  green.
- **Playground consumes the plugin from source** (`../src/index.ts`) —
  instant dev loop; packaging is validated by `vp pack` + attw.
- **Tool UI is prebuilt, not dev-served:** the plugin serves `dist/client`
  (fallback page when absent). After editing `tool/`, run `vp run build`.
  The tool bundles its own Vue — independent of the user's app.
- **The analyzer is Vue-version-agnostic** (Vue 2 and Vue 3): the crawl reads
  SFC `<script>` blocks and import specifiers statically and never compiles
  components. Author against `vite`; nothing assumes a Vue major.
- `playground/` — a complex real-world app: **vue-vben-admin**'s `web-antd`
  (Vue 3 + TypeScript, ~700 `.vue` + ~700 `.ts`) as a git submodule under
  `playground/vben`, wired so the crawl fans out across the real module graph
  (aliases map `#/*` and `@vben/*` to package source). Type-check runs vben's
  own `vue-tsc` over the app (clean → all green; needs the submodule's
  `node_modules`); blame is empty (shallow history). Run via `vp dev`.
  `.vscode/` is git-tracked (settings, extensions, tasks).
- `playground-vuetify/` — the **Vuetify monorepo itself** (`vuetifyjs/vuetify`)
  as a submodule under `playground-vuetify/vuetify`: a component _library_
  (~520 `.tsx`/`.ts` modules from `packages/vuetify/src`, aliased `@/` → src).
  Runs a **real** `vue-tsc` over `packages/vuetify` (needs the submodule's
  `node_modules`); Vuetify is fully migrated so a clean checkout is all green,
  but a real type error reddens its node and every importer. Vuetify has no
  `.vue` files, so the tool auto-selects the TS/module view (App.vue defaults
  `includeTs` on when a graph has no `.vue` nodes).
- `playground-shadcn/` — the **shadcn-vue monorepo** (`unovue/shadcn-vue`) as a
  submodule under `playground-shadcn/shadcn-vue`: a component _registry_ (Nuxt
  app). The entry imports all 66 `apps/v4/registry/new-york-v4/ui/*` barrels,
  aliased `@/`/`~/` → `apps/v4`, so the crawl fans out across ~370 `.vue`
  components + ~76 `.ts` (~450 nodes). Type-check is off (`typeCheckCommand:
false`) — the registry is a Nuxt app whose `vue-tsc` needs Nuxt's generated
  tsconfig/auto-imports; the crawl still maps the real component graph + LoC.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ commands take precedence over `package.json` scripts. If there is a `test` script defined in `scripts` that conflicts with the built-in `vp test` command, run it using `vp run test`.
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.

<!--VITE PLUS END-->
