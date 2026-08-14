import pc from "picocolors";
import type { ViteDevServer } from "vite";

/** All plugin output mimics Vite's own URL block styling (picocolors is
 * Vite's own color lib) — keep new log lines consistent with these. */

/**
 * Append the tool URL to Vite's startup URL block.
 *
 * `server.resolvedUrls` is only populated after `listen()` resolves, so an
 * `httpServer` "listening" handler would race it. Patching `printUrls` is the
 * ecosystem convention: the CLI and programmatic servers call it once the
 * URLs exist.
 */
export function patchPrintUrls(server: ViteDevServer, toolUrl: string): void {
  const printUrls = server.printUrls.bind(server);
  server.printUrls = () => {
    printUrls();
    const colored = pc.cyan(
      toolUrl.replace(/:(\d+)\//, (_: string, port: string) => `:${pc.bold(port)}/`),
    );
    server.config.logger.info(`  ${pc.green("\u279C")}  ${pc.bold("tsmigrate")}: ${colored}`);
  };
}
