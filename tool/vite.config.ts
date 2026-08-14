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
      "/api": {
        target: process.env.TSMIGRATE_API ?? "http://localhost:7357",
        changeOrigin: true,
        // The API backend (the plugin's tool server) briefly disappears while
        // the playground dev server restarts. Answer the gap with a quiet 503 —
        // the tool polls /api/graph and reconnects on its own — instead of
        // hanging the request or spewing ECONNREFUSED.
        configure(proxy) {
          proxy.on("error", (_err, _req, res) => {
            if ("writeHead" in res) {
              if (!res.headersSent) {
                res.writeHead(503, { "content-type": "application/json" });
              }
              res.end('{"error":"tsmigrate backend restarting"}');
            } else {
              res.destroy();
            }
          });
        },
      },
    },
  },
});
