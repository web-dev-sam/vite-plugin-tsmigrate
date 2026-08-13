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
  // Dev-only HMR loop: `vp exec vite tool` serves this app with hot reload,
  // proxying the data endpoints to a running playground's plugin server
  // (default port 7357; override with TSMIGRATE_API). Not used by the build.
  server: {
    proxy: {
      "/api": process.env.TSMIGRATE_API ?? "http://localhost:7357",
    },
  },
});
