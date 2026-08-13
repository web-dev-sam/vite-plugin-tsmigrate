// Playground entry: pull in Vuetify's own framework source so the tsmigrate
// crawl fans out across the real component-library graph — every component
// (`.tsx`), composable, directive and blueprint reachable from the bundler
// entry, plus the experimental `labs` set, resolved to source by the `@/` alias
// in vite.config.ts (no Vuetify build required).
import "../vuetify/packages/vuetify/src/entry-bundler.ts";
import "../vuetify/packages/vuetify/src/labs/index.ts";
