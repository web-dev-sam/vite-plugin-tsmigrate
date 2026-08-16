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
  /** TypeScript type-only binding (`import type {X}` or `import {type X}`). */
  isType: boolean;
}

/** One `import ... from "source"` statement. `bindings` empty = side-effect import. */
export interface ImportRef {
  source: string;
  bindings: ImportBinding[];
}

/** One export binding, normalised across the ESM re-export forms. */
export type ExportRef =
  // `export { imported as exportName } from "source"` (incl. `default as X`).
  | { kind: "reexport"; exportName: string; importName: string; source: string; isType: boolean }
  // `export * from "source"` — forwards every named (non-default) export.
  | { kind: "star"; source: string; isType: boolean }
  // `export * as exportName from "source"` — a namespace-object export.
  | { kind: "ns"; exportName: string; source: string; isType: boolean }
  // `export const x`, `export function x`, `export default …`, `export { local }`.
  | { kind: "local"; exportName: string; local: string | null };

/**
 * Statically-observed usage of one `import * as local from source` binding
 * (docs/maintainability-score.md "The graph"). `members` lists the member names read via
 * static access (`ns.X`, `ns?.X`, `ns["X"]`, `ns.X` in type positions);
 * `members: null` means narrowing is unsafe and `cause` names why:
 *
 * - `namespaceEscape` — the binding escapes static analysis: used bare
 *   (`f(ns)`, `export { ns }`, `export default ns`), spread, enumerated
 *   (`Object.keys(ns)`, `for (… in ns)`, `typeof ns`), or read with a
 *   dynamic key (`ns[expr]`).
 * - `namespaceShadowed` — a local declaration re-binds the name somewhere in
 *   the file (scope-insensitive on purpose: over-approximate, never miss).
 * - `sfcTemplateBlindSpot` — `.vue` files are never narrowed: the crawl
 *   parses `<script>` only, so template-only usage is invisible.
 */
export type NamespaceUsage =
  | { local: string; source: string; members: string[]; cause: null }
  | {
      local: string;
      source: string;
      members: null;
      cause: "namespaceEscape" | "namespaceShadowed" | "sfcTemplateBlindSpot";
    };

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
  /** Per-namespace-import usage, for §5 narrowing. Empty when none exist. */
  nsUsage: NamespaceUsage[];
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
 * weigh the same by LoC but not here. Script only — SFC template branching is
 * counted separately by `templateBranches`. Unparseable → 0.
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

/** Names bound by a binding pattern (params, declarator ids, catch params). */
function patternNames(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      patternNames(item, out);
    }
    return out;
  }
  if (!node || typeof node !== "object") {
    return out;
  }
  const n = node as Record<string, unknown>;
  switch (n.type) {
    case "Identifier":
      out.push(n.name as string);
      break;
    case "ObjectPattern":
      patternNames(n.properties, out);
      break;
    case "Property":
      patternNames(n.value, out);
      break;
    case "ArrayPattern":
      patternNames(n.elements, out);
      break;
    case "AssignmentPattern":
      patternNames(n.left, out);
      break;
    case "RestElement":
      patternNames(n.argument, out);
      break;
    case "TSParameterProperty":
      patternNames(n.parameter, out);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Walk a program collecting static member reads on each namespace local in
 * `targets` (local → source), plus every condition that makes narrowing
 * unsafe (escape / shadowing — see `NamespaceUsage`). The walk is
 * over-approximate by construction: any reference it cannot classify as a
 * static member read fails the local into a whole-module dependency.
 */
function collectNamespaceUsage(program: unknown, targets: Map<string, string>): NamespaceUsage[] {
  const members = new Map<string, Set<string>>();
  const failed = new Map<string, "namespaceEscape" | "namespaceShadowed">();
  for (const local of targets.keys()) {
    members.set(local, new Set());
  }
  const fail = (local: string, cause: "namespaceEscape" | "namespaceShadowed"): void => {
    if (!failed.has(local)) {
      failed.set(local, cause);
    }
  };
  const targetOf = (node: unknown): string | null => {
    const n = node as Record<string, unknown> | null;
    return n && n.type === "Identifier" && targets.has(n.name as string)
      ? (n.name as string)
      : null;
  };
  const shadowCheck = (pattern: unknown): void => {
    for (const name of patternNames(pattern)) {
      if (targets.has(name)) {
        fail(name, "namespaceShadowed");
      }
    }
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    const n = node as Record<string, unknown>;
    switch (n.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return; // module-request positions never reference a local
      case "ExportNamedDeclaration":
        if (n.source) {
          return; // `export { x } from "y"` — no local references
        }
        walk(n.declaration);
        // `export { ns }` — the local slot is a real reference (an escape).
        for (const spec of (n.specifiers as unknown[]) ?? []) {
          walk((spec as Record<string, unknown>).local);
        }
        return;
      case "MemberExpression": {
        const local = targetOf(n.object);
        if (local) {
          const prop = n.property as Record<string, unknown>;
          if (!n.computed && prop?.type === "Identifier") {
            members.get(local)!.add(prop.name as string); // ns.X / ns?.X
            return;
          }
          if (n.computed && prop?.type === "Literal" && typeof prop.value === "string") {
            members.get(local)!.add(prop.value); // ns["X"]
            return;
          }
          fail(local, "namespaceEscape"); // ns[expr] — dynamic key
          walk(n.property);
          return;
        }
        walk(n.object);
        if (n.computed) {
          walk(n.property);
        }
        return;
      }
      case "TSQualifiedName": {
        // Type position: `ns.Foo` — a statically-known member.
        const local = targetOf(n.left);
        if (local) {
          members.get(local)!.add((n.right as Record<string, unknown>).name as string);
          return;
        }
        walk(n.left);
        return;
      }
      case "Property":
      case "PropertyDefinition":
      case "MethodDefinition":
        if (n.computed) {
          walk(n.key); // `{ [ns.X]: v }` — the key references ns
        }
        walk(n.value);
        return;
      case "VariableDeclarator":
        shadowCheck(n.id);
        walk(n.id);
        walk(n.init);
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        shadowCheck(n.id);
        shadowCheck(n.params);
        walk(n.params);
        walk(n.body);
        return;
      case "CatchClause":
        shadowCheck(n.param);
        walk(n.param);
        walk(n.body);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        shadowCheck(n.id);
        walk(n.superClass);
        walk(n.body);
        return;
      case "Identifier": {
        // Any reference not consumed above escapes static analysis: bare use,
        // spread, enumeration, `export default ns`, `typeof ns`, …
        const name = n.name as string;
        if (targets.has(name)) {
          fail(name, "namespaceEscape");
        }
        walk(n.typeAnnotation); // param types may hold `ns.Foo` qualified names
        return;
      }
      default:
        for (const key in n) {
          const value = n[key];
          if (value && typeof value === "object") {
            walk(value);
          }
        }
    }
  };
  walk(program);

  return [...targets].map(([local, source]) => {
    const cause = failed.get(local);
    return cause
      ? { local, source, members: null, cause }
      : { local, source, members: [...members.get(local)!].sort(), cause: null };
  });
}

/** Static imports/exports (oxc) plus dynamic/glob specifiers (regex). */
export function parseModule(code: string, filename: string): ModuleRecord {
  const imports: ImportRef[] = [];
  const exports: ExportRef[] = [];
  const dynamic: string[] = [];
  const globs: string[] = [];
  const nsUsage: NamespaceUsage[] = [];

  try {
    const { module, program } = parseSync(filename, code, { lang: langOf(filename) });
    for (const imp of module.staticImports) {
      const bindings: ImportBinding[] = imp.entries.map((e) => ({
        local: e.localName.value || null,
        imported:
          e.importName.kind === "Default"
            ? { kind: "default" }
            : e.importName.kind === "NamespaceObject"
              ? { kind: "namespace" }
              : { kind: "named", name: e.importName.name ?? "" },
        isType: e.isType,
      }));
      imports.push({ source: imp.moduleRequest.value, bindings });
    }
    for (const exp of module.staticExports) {
      for (const e of exp.entries) {
        const source = e.moduleRequest?.value;
        if (source) {
          if (e.importName.kind === "AllButDefault") {
            exports.push({ kind: "star", source, isType: e.isType });
          } else if (e.importName.kind === "All") {
            exports.push({
              kind: "ns",
              exportName: exportNameOf(e.exportName),
              source,
              isType: e.isType,
            });
          } else if (e.importName.kind === "Name") {
            exports.push({
              kind: "reexport",
              exportName: exportNameOf(e.exportName),
              importName: e.importName.name ?? "",
              source,
              isType: e.isType,
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

    // §5 namespace precision: collect member usage for every namespace local.
    // `.vue` scripts are never narrowed — the template (unparsed) may use any
    // member, so the whole-module edge must stay (`sfcTemplateBlindSpot`).
    const nsTargets = new Map<string, string>();
    for (const imp of imports) {
      for (const b of imp.bindings) {
        if (b.imported.kind === "namespace" && b.local) {
          nsTargets.set(b.local, imp.source);
        }
      }
    }
    if (nsTargets.size > 0) {
      if (filename.endsWith(".vue")) {
        for (const [local, source] of nsTargets) {
          nsUsage.push({ local, source, members: null, cause: "sfcTemplateBlindSpot" });
        }
      } else {
        nsUsage.push(...collectNamespaceUsage(program, nsTargets));
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

  return { imports, exports, dynamic, globs, nsUsage };
}

/** Concatenated contents of every `<script>` block in an SFC. */
export function extractSfcScripts(sfc: string): string {
  const blocks: string[] = [];
  for (const match of sfc.matchAll(SCRIPT_BLOCK_RE)) {
    blocks.push(match[1]);
  }
  return blocks.join("\n");
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>/gi;
const LANG_TS_RE = /\blang\s*=\s*["']?tsx?["']?/i;
const TS_EXTS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Whether a module already carries TypeScript contracts — the thing a
 * migration adds, and what a depth-ordered work list has to filter on.
 *
 * `.ts`-family files do by definition; `.js`-family ones never do. An SFC
 * counts as typed when EVERY `<script>` block declares `lang="ts"` (a mixed
 * SFC still has an untyped half), and a script-less template counts as typed
 * because it declares nothing to type.
 */
export function isTypedModule(filename: string, code: string): boolean {
  const clean = filename.split("?")[0]!;
  if (clean.endsWith(".vue")) {
    for (const tag of code.matchAll(SCRIPT_TAG_RE)) {
      if (!LANG_TS_RE.test(tag[1]!)) {
        return false;
      }
    }
    return true;
  }
  return TS_EXTS.some((ext) => clean.endsWith(ext));
}

// Template branch points: each `v-if`/`v-else-if`/`v-for`/`v-show` binding is
// one decision the reader must trace (`v-else` is the arm of its `v-if`, not
// a new decision). Matched as attributes (`=` required) so prose mentioning a
// directive doesn't count.
const TEMPLATE_BRANCH_RE = /\bv-(?:if|else-if|for|show)\s*=/g;

/**
 * Branch points in an SFC's `<template>` markup — the decisions
 * `cyclomaticComplexity` cannot see because only `<script>` blocks are
 * parsed. A `v-if`-dense component with a flat script is real branching load;
 * the maintainability score adds these to the file's cc. Counted over the
 * outermost template block (nested `<template #slot>` markup is inside it).
 */
export function templateBranches(sfc: string): number {
  const open = sfc.match(/<template[^>]*>/i);
  if (!open || open.index === undefined) {
    return 0;
  }
  const start = open.index + open[0].length;
  const end = sfc.lastIndexOf("</template>");
  if (end <= start) {
    return 0;
  }
  let count = 0;
  for (const _ of sfc.slice(start, end).matchAll(TEMPLATE_BRANCH_RE)) {
    count++;
  }
  return count;
}
