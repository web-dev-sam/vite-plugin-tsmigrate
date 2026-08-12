# vite-plugin-tsmigrate

A minimal, well-structured **Vite 8** plugin — the "hello world" of
devtool-style Vite plugins (vite-plugin-inspect, vue-devtools, …). It ships a
configurable virtual module and hosts its **own Vue application** on a
separate port that diagnoses the user's Vue app through a small API.

Scaffolded and maintained with [Vite+](https://viteplus.dev) (`vp`).

## Install

```bash
vp add -D vite-plugin-tsmigrate
# or: npm i -D vite-plugin-tsmigrate
```

Requires `vite@^8` as a peer dependency.

## Usage

Add the plugin to your Vite config:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { tsmigrate } from "vite-plugin-tsmigrate";

export default defineConfig({
  plugins: [tsmigrate({ greeting: "Hello from my app!" })],
});
```

Then import the virtual module anywhere in your app:

```ts
import { greeting } from "virtual:tsmigrate";

console.log(greeting); // -> "Hello from my app!"
```

For TypeScript, register the virtual module's types (e.g. in `env.d.ts`):

```ts
declare module "virtual:tsmigrate" {
  export const greeting: string;
}
```

## Options

| Option       | Type      | Default            | Description                                                                      |
| ------------ | --------- | ------------------ | -------------------------------------------------------------------------------- |
| `greeting`   | `string`  | `"Hello, Vite 8!"` | Message exposed by `virtual:tsmigrate`, shown on the tool page, logged on start. |
| `logOnStart` | `boolean` | `true`             | Log the greeting on config resolve and the tool URL on dev startup.              |
| `toolPort`   | `number`  | `7357`             | Port of the plugin's own tool server (dev only); ephemeral fallback when taken.  |

## Development

This project uses the [Vite+](https://viteplus.dev) toolchain — a single `vp`
CLI wrapping Vite, Rolldown, Vitest, tsdown, Oxlint, and Oxfmt.

```bash
vp install    # install dependencies (workspace: plugin + tool + playground)
vp test       # run the test suite (Vitest)
vp check      # format + lint + type-check
vp run build  # bundle the plugin (tsdown) + build the tool UI to dist/client
```

## Playground

`playground/` hosts a Vue 3 counter app consuming the plugin from source
(`../src/index.ts`) — edits to the plugin apply instantly, no rebuild loop.
It runs through the standard Vite CLI, exactly like a real project:

```bash
cd playground
vp dev   # dev server — typical colored Vite output
```

During dev the plugin hosts **its own Vue app** — the tool UI in `tool/`,
prebuilt into `dist/client` and shipped with the package — on a separate
port, unrelated to the app server. The tool diagnoses the user's app via
`/api/diagnostics` (detected Vue version, loaded `.vue` modules, plugin
list). Its URL is appended to Vite's block, styled exactly like Vite's
output (green `➜`, cyan URL, via picocolors — Vite's own color lib):

```
  ➜  Local:   http://localhost:5173/
  ➜  tsmigrate: http://localhost:7357/
```

Two Vue apps run side by side: yours on 5173, the plugin's tool on 7357.
The tool shuts down with the dev server. After editing `tool/`, rebuild it
with `vp run build` (the plugin serves the prebuilt `dist/client`). VSCode
users: run the `Dev` task from the tracked `.vscode/tasks.json`.

## License

[MIT](./LICENSE)
