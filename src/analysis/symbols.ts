/**
 * Domain vocabulary for symbol-resolved dependency edges (edge semantics:
 * docs/maintainability-score.md "The graph").
 * Pure types + one helper, no IO. Internal to the analysis pipeline — the wire
 * (`shared/types.ts`) sees only the flattened `ComponentEdge` projection.
 */

/** Absolute module id (as produced by the resolver). Alias for intent. */
export type ModuleId = string;
/** An export name, or the literal "default". */
export type SymbolName = string;

/** What counts as a "definition" in a given graph view. */
export interface Terminality {
  /** `.vue` files are always terminal definers (their default component). */
  readonly isComponent: (mod: ModuleId) => boolean;
  /**
   * Do locally-declared `.ts` exports count as definers?
   * Module graph: true; component (vue) graph: false.
   */
  readonly localsAreDefiners: boolean;
}

/**
 * Why a dependency could not be narrowed to specific symbols.
 * Each variant NAMES a specific cause so results are explainable and the
 * known blind spots are greppable in code.
 */
export type WholeModuleCause =
  | "sideEffect" // import "x"
  | "namespaceImport" // import * as ns  (non-narrowable usage, see §5)
  | "namespaceReexport" // export * as ns
  | "dynamicImport" // import(...) / import.meta.glob — a LAZY boundary
  | "unresolvable" // empty resolution: re-export chain exits the project,
  //   unparseable module, or missing name — fall back to
  //   the direct target, never drop the edge (§2)
  | "namespaceEscape" // §5: ns used as a value / spread / enumerated / dynamic key
  | "namespaceShadowed" // §5: the local ns name is shadowed in scope
  | "sfcTemplateBlindSpot"; // §5: .vue namespace usage is invisible — the crawl
// parses <script> only, never <template>, so a namespace used only in the
// template can't be seen; we conservatively keep the whole-module edge.

/** Why `from` depends on `to`, most precise first. A `whole` dependency can
 *  itself be type-only (`import type * as ns`, `export type * from`) — the
 *  flag keeps the wire `type` marker and the score's projections truthful. */
export type DependencyReason =
  | { readonly tag: "value"; readonly symbols: readonly SymbolName[] }
  | { readonly tag: "type"; readonly symbols: readonly SymbolName[] }
  | { readonly tag: "whole"; readonly cause: WholeModuleCause; readonly isType: boolean };

/**
 * An internal, provenance-rich edge. Merged to the wire `ComponentEdge` at the
 * topology boundary. `from`/`to` deduped; `reasons` accumulated. `via` is the
 * first re-export hop the resolution passed through (the import statement's
 * direct target) when it differs from `to` — captured at edge-build time so a
 * narrowed edge stays greppable in `from`'s source (§6 "Provenance is cheap").
 */
export interface SymbolEdge {
  readonly from: ModuleId;
  readonly to: ModuleId;
  readonly reasons: readonly DependencyReason[];
  readonly via?: readonly ModuleId[];
}

export function assertNever(x: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(x)}`);
}
