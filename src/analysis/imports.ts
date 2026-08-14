/**
 * Import extraction. Regex-based on purpose: fast, dependency-free, and good
 * enough for building a component relation graph. This module is the
 * designated swap point for a real parser (oxc-parser) if fidelity ever
 * becomes a problem — nothing outside it knows how specifiers are found.
 */

const IMPORT_RE =
  /(?:^|[;\n{])\s*(?:import|export)\s+(?:[\w$*{},\s]*?from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

// `import.meta.glob('pat')` / `import.meta.globEager(['a','b'])` — the first
// arg is a quoted string or an array literal of them.
const META_GLOB_RE = /\bimport\.meta\.glob(?:Eager)?\s*\(\s*(\[[\s\S]*?\]|["'][^"']*["'])/g;

// Any `import( … )` whose argument is NOT a lone quoted string, i.e. a computed
// path: a template literal or a string concatenation. Lone-string dynamic
// imports are already covered by IMPORT_RE.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*([^)]+?)\s*\)/g;

const SCRIPT_BLOCK_RE = /<script[^>]*>([\s\S]*?)<\/script>/gi;

/** Imports found in a source: fixed specifiers plus glob patterns. */
export interface ParsedImports {
  /** Static and single-string dynamic `import`/`export … from` specifiers. */
  specifiers: string[];
  /**
   * Glob patterns (relative to the module, or root-relative with a leading
   * `/`) from `import.meta.glob(...)` and computed dynamic imports. The crawl
   * expands these against the filesystem — this is how lazy routes/components
   * registered by glob or ``import(`./views/${x}.vue`)`` become graph nodes.
   */
  globs: string[];
}

/**
 * Turn a computed dynamic-import argument into a glob, mirroring how bundlers
 * expand them (Vite's dynamic-import-vars): `${expr}` and non-literal
 * concatenation operands become `*` (a single path segment, so it never
 * crosses `/` — matching runtime behaviour). Returns null when the path is not
 * statically scoped (does not begin with `.` or `/`), e.g. a bare package or a
 * fully dynamic specifier.
 */
function argToPath(arg: string): string | null {
  let pattern: string;
  const template = arg.match(/^`([^`]*)`$/);
  if (template) {
    pattern = template[1].replace(/\$\{[^}]*\}/g, "*");
  } else if (arg.includes("+") && /["']/.test(arg)) {
    pattern = arg
      .split("+")
      .map((part) => {
        const literal = part.trim().match(/^["'](.*)["']$/);
        return literal ? literal[1] : "*";
      })
      .join("");
  } else {
    return null;
  }
  pattern = pattern.replace(/\*{2,}/g, "*");
  return pattern.startsWith(".") || pattern.startsWith("/") ? pattern : null;
}

/** Static + dynamic imports (fixed specifiers and glob patterns) in a source. */
export function parseImports(code: string): ParsedImports {
  const specifiers: string[] = [];
  const globs: string[] = [];
  for (const match of code.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) {
      specifiers.push(spec);
    }
  }
  for (const match of code.matchAll(META_GLOB_RE)) {
    for (const quoted of match[1].matchAll(/["']([^"']+)["']/g)) {
      // Negative patterns only prune a glob set — never a crawl root.
      if (!quoted[1].startsWith("!")) {
        globs.push(quoted[1]);
      }
    }
  }
  for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) {
    const path = argToPath(match[1].trim());
    if (path === null) {
      continue;
    }
    // A `*`-free result is a plain (backtick) specifier; otherwise a glob.
    (path.includes("*") ? globs : specifiers).push(path);
  }
  return { specifiers, globs };
}

/** Concatenated contents of every `<script>` block in an SFC. */
export function extractSfcScripts(sfc: string): string {
  const blocks: string[] = [];
  for (const match of sfc.matchAll(SCRIPT_BLOCK_RE)) {
    blocks.push(match[1]);
  }
  return blocks.join("\n");
}
