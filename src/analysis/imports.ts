/**
 * Import extraction. Regex-based on purpose: fast, dependency-free, and good
 * enough for building a component relation graph. This module is the
 * designated swap point for a real parser (oxc-parser) if fidelity ever
 * becomes a problem — nothing outside it knows how specifiers are found.
 */

const IMPORT_RE =
  /(?:^|[;\n{])\s*(?:import|export)\s+(?:[\w$*{},\s]*?from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

const SCRIPT_BLOCK_RE = /<script[^>]*>([\s\S]*?)<\/script>/gi;

/** Static + dynamic import specifiers found in a JS/TS source. */
export function parseImports(code: string): string[] {
  const specifiers: string[] = [];
  for (const match of code.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) {
      specifiers.push(spec);
    }
  }
  return specifiers;
}

/** Concatenated contents of every `<script>` block in an SFC. */
export function extractSfcScripts(sfc: string): string {
  const blocks: string[] = [];
  for (const match of sfc.matchAll(SCRIPT_BLOCK_RE)) {
    blocks.push(match[1]);
  }
  return blocks.join("\n");
}
