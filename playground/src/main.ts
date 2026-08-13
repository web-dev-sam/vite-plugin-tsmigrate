// Playground entry: pull in vue-vben-admin's `web-antd` app entry so the
// tsmigrate crawl fans out across a real Vue 3 + TypeScript module graph — the
// app shell plus every reachable `@vben/*` / `@vben-core/*` package, resolved
// to source by the aliases in vite.config.ts (no monorepo build required).
import "../vben/apps/web-antd/src/main.ts";
