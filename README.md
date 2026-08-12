# vite-plugin-tsmigrate

A minimal, well-structured **Vite 8** plugin — the "hello world" of Vite plugins.
It ships a configurable virtual module and demonstrates the conventions used by
plugins across the Vite ecosystem (factory function, `vite-plugin-*` name,
`resolveId`/`load` pair, NUL-prefixed virtual ids).

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

| Option       | Type      | Default            | Description                                                          |
| ------------ | --------- | ------------------ | -------------------------------------------------------------------- |
| `greeting`   | `string`  | `"Hello, Vite 8!"` | Message exposed by `virtual:tsmigrate` and logged on config resolve. |
| `logOnStart` | `boolean` | `true`             | Log the greeting on config resolve and the dev/preview server URL.   |

## Development

This project uses the [Vite+](https://viteplus.dev) toolchain — a single `vp`
CLI wrapping Vite, Rolldown, Vitest, tsdown, Oxlint, and Oxfmt.

```bash
vp install   # install dependencies
vp test      # run the test suite (Vitest)
vp check     # format + lint + type-check
vp build     # bundle the library to dist/ (tsdown)
```

## Playground

`playground/` hosts a Vue 3 counter app consuming the plugin from source
(`../src/index.ts`) — edits to the plugin apply instantly, no rebuild loop.
It runs through the standard Vite CLI, exactly like a real project:

```bash
cd playground
vp dev   # dev server — typical colored Vite output
```

The plugin appends its own line to Vite's URL block, styled exactly like
Vite's output (green `➜`, cyan URL, via picocolors — Vite's own color lib):

```
  ➜  Local:   http://localhost:5173/
  ➜  tsmigrate: http://localhost:5173/
```

The same line appears under `vite preview` (`configurePreviewServer`).
VSCode users: run the `Dev` task from the tracked `.vscode/tasks.json`.

## License

[MIT](./LICENSE)
