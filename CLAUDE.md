# vite-plugin-tsmigrate

A minimal, well-structured **Vite 8** plugin (hello world), developed with the
[Vite+](https://viteplus.dev) toolchain (`vp`).

## What this package is

- A **distributable Vite plugin**, not an app. `src/index.ts` exports a
  `tsmigrate(options)` factory returning a Vite `Plugin`, plus a `default` export.
- The plugin registers a virtual module `virtual:tsmigrate` that re-exports a
  configurable `greeting`, demonstrating the `resolveId`/`load` pair and the
  NUL-prefixed (`\0`) resolved-id convention, plus `configResolved` (greeting
  log) and `configureServer`, which hosts the plugin's **own tool server**
  (`node:http`) on `toolPort` (default `7357`, ephemeral fallback; dev-only;
  skipped in middleware mode; closed with the dev server) and appends its URL
  to Vite's block by patching `server.printUrls` (a "listening" handler would
  race `resolvedUrls`).
- Built to `dist/` with `vp pack` (tsdown): ESM (`index.mjs`) + types (`index.d.mts`).

## Project conventions

- **Author against `vite`, build with Vite+.** Public types come from
  `import type { Plugin } from "vite"` and `vite` is declared as a
  `peerDependency` (`^8`) — because consumers use plain Vite, not Vite+. Only
  test/config utilities are imported from `vite-plus` (e.g. `vite-plus/test`).
- **Plugin naming:** the `name` field MUST stay `vite-plugin-tsmigrate` (Vite
  ecosystem convention); the npm package name matches.
- **Virtual modules:** keep the public id (`virtual:tsmigrate`) and its resolved
  id (`\0virtual:tsmigrate`) in sync via the exported `VIRTUAL_MODULE_ID`.
- **Tests** live in `tests/` and exercise the plugin inside a real Vite dev
  server (`createServer` + `transformRequest`, plus fetching the tool page) —
  that server run is the proof the plugin works, so keep it green.
- **Playground consumes the plugin from source** (`../src/index.ts`), not the
  built `dist/` — instant dev loop; packaging is validated by `vp pack` + attw.

## Layout

- `src/index.ts` — the plugin (public API).
- `tests/index.test.ts` — integration tests against a real Vite server.
- `vite.config.ts` — Vite+ config (pack/lint/fmt).
- `playground/` — private Vue 3 counter app (pnpm workspace member) run via
  the standard Vite CLI: `vp dev` (see `.vscode/tasks.json` task `Dev`).
- **Log styling:** startup lines mimic Vite's URL block (green `➜`, cyan URL)
  using `picocolors`, Vite's own color lib — keep new log lines consistent.
- `.vscode/` — tracked editor recommendations + settings (Oxc formatter).

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
