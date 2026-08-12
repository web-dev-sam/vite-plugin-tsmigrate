// Programmatic Vite dev server using the JavaScript API:
// https://vite.dev/guide/api-javascript
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const server = await createServer({
  root: fileURLToPath(new URL(".", import.meta.url)),
});

await server.listen();

// Prints the Local/Network block; the plugin's patched `printUrls` appends
// its own "[vite-plugin-tsmigrate] serving <url>" line after it.
server.printUrls();
server.config.logger.info(`ready: ${server.resolvedUrls?.local[0] ?? "(no local url)"}`);
