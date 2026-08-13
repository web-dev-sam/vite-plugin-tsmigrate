import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The plugin's own tool UI — prebuilt into dist/client and shipped with the
// npm package, then served by the plugin on its own port during dev.
export default defineConfig({
  base: "./",
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
