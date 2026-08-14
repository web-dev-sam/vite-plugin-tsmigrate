import { parseSync } from "oxc-parser";

/**
 * Module-record extraction for the component graph. Static imports/exports are
 * read from oxc's ESM module record (binding-accurate, so the crawl can resolve
 * *which* export a consumer actually uses); dynamic `import(...)` and
 * `import.meta.glob(...)` are scanned with regex, since the module record does
 * not surface them.
 *
 * Binding accuracy is what lets a hub module (e.g. a `routes.ts` that imports
 * 175 view components to build a table, and exports only route-name strings)
 * NOT spill all 175 components onto every consumer that imports a single name.
 */

/** What a single imported binding refers to in its source module. */
export type ImportedName =
  | { kind: "default" }
  | { kind: "namespace" }
  | { kind: "named"; name: string };

/** A `local` binding name and the source export it aliases. */
export interface ImportBinding {
  imported: ImportedName;
  /** Local name, used to trace binding re-exports (`import X; export { X }`). */
  local: string | null;
}

/** One `import ... from "source"` statement. `bindings` empty = side-effect import. */
export interface ImportRef {
  source: string;
  bindings: ImportBinding[];
}

/** One export binding, normalised across the ESM re-export forms. */
export type ExportRef =
  // `export { imported as exportName } from "source"` (incl. `default as X`).
  | { kind: "reexport"; exportName: string; importName: string; source: string }
  // `export * from "source"` — forwards every named (non-default) export.
  | { kind: "star"; source: string }
  // `export * as exportName from "source"` — a namespace-object export.
  | { kind: "ns"; exportName: string; source: string }
  // `export const x`, `export function x`, `export default …`, `export { local }`.
  | { kind: "local"; exportName: string; local: string | null };

/** Everything the crawl needs from one module's source. */
export interface ModuleRecord {
  imports: ImportRef[];
  exports: ExportRef[];
  /** Lone-string dynamic import specifiers (namespace semantics). */
  dynamic: string[];
  /**
   * Glob patterns (module-relative, or root-relative with a leading `/`) from
   * `import.meta.glob(...)` and computed dynamic imports. The crawl expands
   * these against the filesystem so glob/`import(`./x/${v}.vue`)` routes become
   * graph nodes.
   */
  globs: string[];
}

// `import.meta.glob('pat')` / `import.meta.globEager(['a','b'])` — the first arg
// is a quoted string or an array literal of them.
const META_GLOB_RE = /\bimport\.meta\.glob(?:Eager)?\s*\(\s*(\[[\s\S]*?\]|["'][^"']*["'])/g;

// Any `import( … )` argument — a static string, a template, or a concatenation.
// (oxc's module record intentionally omits dynamic imports.)
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*([^)]+?)\s*\)/g;

const SCRIPT_BLOCK_RE = /<script[^>]*>([\s\S]*?)<\/script>/gi;

/** Pick the oxc language from a filename (`.vue` scripts are parsed as `ts`). */
function langOf(filename: string): "ts" | "tsx" | "js" | "jsx" {
  if (filename.endsWith(".tsx")) {
    return "tsx";
  }
  if (filename.endsWith(".jsx")) {
    return "jsx";
  }
  return /\.(?:c|m)?js$/.test(filename) ? "js" : "ts";
}

// AST node types that each add one decision point (a branch) to cyclomatic
// complexity. `SwitchCase` (non-default) and short-circuit `LogicalExpression`
// are handled separately since they need a field check.
const DECISION_NODES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
]);

/**
 * Cyclomatic complexity of a source: the number of decision points (branches).
 * Counts `if`, `?:`, every loop, `catch`, each non-default `case`, and each
 * short-circuit operator (`&&`, `||`, `??`) in the oxc AST. This is the *shape*
 * the LoC count cannot see — a 40-branch file and a flat file of equal length
 * weigh the same by LoC but not here. Only the `<script>` of an SFC is parsed,
 * so template branching (`v-if`/`v-for`) is not counted. Unparseable → 0.
 *
 * Iterative walk (an explicit stack) so a deeply nested file cannot overflow.
 */
export function cyclomaticComplexity(code: string, filename: string): number {
  let count = 0;
  try {
    const { program } = parseSync(filename, code, { lang: langOf(filename) });
    const stack: unknown[] = [program];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        for (const child of node) {
          stack.push(child);
        }
        continue;
      }
      if (!node || typeof node !== "object") {
        continue;
      }
      const record = node as Record<string, unknown>;
      const type = record.type;
      if (typeof type === "string") {
        if (DECISION_NODES.has(type)) {
          count++;
        } else if (type === "SwitchCase") {
          if (record.test != null) {
            count++;
          }
        } else if (type === "LogicalExpression") {
          const op = record.operator;
          if (op === "&&" || op === "||" || op === "??") {
            count++;
          }
        }
      }
      for (const key in record) {
        const value = record[key];
        if (value && typeof value === "object") {
          stack.push(value);
        }
      }
    }
  } catch {
    // Unparseable source has no measurable complexity.
  }
  return count;
}

/**
 * Classify a dynamic-import argument. A lone string is a specifier; a template
 * or string-concatenation with a static prefix becomes a glob (mirroring Vite's
 * dynamic-import-vars: `${expr}` and non-literal operands → `*`, segment-scoped
 * so it never crosses `/`). Returns null for a fully dynamic / bare specifier.
 */
function classifyDynamic(arg: string): { spec: string; isGlob: boolean } | null {
  const s = arg.trim();
  const str = s.match(/^["'](.*)["']$/);
  if (str) {
    return { spec: str[1], isGlob: str[1].includes("*") };
  }
  let pattern: string;
  const template = s.match(/^`([^`]*)`$/);
  if (template) {
    pattern = template[1].replace(/\$\{[^}]*\}/g, "*");
  } else if (s.includes("+") && /["']/.test(s)) {
    pattern = s
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
  if (!pattern.startsWith(".") && !pattern.startsWith("/")) {
    return null;
  }
  return { spec: pattern, isGlob: pattern.includes("*") };
}

/** Normalise an oxc export-name span to a plain name (`Default` → "default"). */
function exportNameOf(n: { kind: string; name: string | null }): string {
  return n.kind === "Default" ? "default" : (n.name ?? "");
}

/** Static imports/exports (oxc) plus dynamic/glob specifiers (regex). */
export function parseModule(code: string, filename: string): ModuleRecord {
  const imports: ImportRef[] = [];
  const exports: ExportRef[] = [];
  const dynamic: string[] = [];
  const globs: string[] = [];

  try {
    const { module } = parseSync(filename, code, { lang: langOf(filename) });
    for (const imp of module.staticImports) {
      const bindings: ImportBinding[] = imp.entries.map((e) => ({
        local: e.localName.value || null,
        imported:
          e.importName.kind === "Default"
            ? { kind: "default" }
            : e.importName.kind === "NamespaceObject"
              ? { kind: "namespace" }
              : { kind: "named", name: e.importName.name ?? "" },
      }));
      imports.push({ source: imp.moduleRequest.value, bindings });
    }
    for (const exp of module.staticExports) {
      for (const e of exp.entries) {
        const source = e.moduleRequest?.value;
        if (source) {
          if (e.importName.kind === "AllButDefault") {
            exports.push({ kind: "star", source });
          } else if (e.importName.kind === "All") {
            exports.push({ kind: "ns", exportName: exportNameOf(e.exportName), source });
          } else if (e.importName.kind === "Name") {
            exports.push({
              kind: "reexport",
              exportName: exportNameOf(e.exportName),
              importName: e.importName.name ?? "",
              source,
            });
          }
        } else {
          exports.push({
            kind: "local",
            exportName: exportNameOf(e.exportName),
            local: e.localName.kind === "Default" ? "default" : e.localName.name,
          });
        }
      }
    }
  } catch {
    // Unparseable source contributes no static graph; dynamic/glob still scanned.
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
    const classified = classifyDynamic(match[1]);
    if (classified) {
      (classified.isGlob ? globs : dynamic).push(classified.spec);
    }
  }

  return { imports, exports, dynamic, globs };
}

/** Concatenated contents of every `<script>` block in an SFC. */
export function extractSfcScripts(sfc: string): string {
  const blocks: string[] = [];
  for (const match of sfc.matchAll(SCRIPT_BLOCK_RE)) {
    blocks.push(match[1]);
  }
  return blocks.join("\n");
}
