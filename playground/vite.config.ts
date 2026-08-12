import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
// Consume the plugin from source: instant feedback while editing the plugin,
// no rebuild loop. The packaged artifact is validated by `vp pack` + tests.
import { tsmigrate } from "../src/index.ts";

export default defineConfig({
  plugins: [vue(), tsmigrate({ greeting: "Hello from vite-plugin-tsmigrate + Vue!" })],
});
