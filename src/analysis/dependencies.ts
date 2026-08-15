import type { ComponentEdge } from "../shared/types.ts";
import type { ModuleRecord } from "./imports.ts";
import type { DefinerResolver } from "./resolve.ts";
import type {
  DependencyReason,
  ModuleId,
  SymbolEdge,
  Terminality,
  WholeModuleCause,
} from "./symbols.ts";
import { assertNever } from "./symbols.ts";

/**
 * Edge construction: classify every import/export/dynamic/glob form of a module
 * into provenance-rich `SymbolEdge`s (edge semantics:
 * docs/maintainability-score.md "The graph"), and flatten them to wire
 * `ComponentEdge`s.
 *
 * Two views share the classifier but differ where the semantics say they must:
 *
 * - `component` — today's `vue` graph, byte-for-byte: edges only between
 *   components, whole-module forms EXPAND via `ofModule` (a `.ts` file is not a
 *   node there), empty resolutions legitimately mean "not a component" and drop,
 *   side-effect imports of non-components contribute nothing.
 * - `module` — the symbol-resolved `full` graph: value/type imports narrow to
 *   their definers, whole-module forms emit exactly ONE edge to the module
 *   itself (never an expansion — reachability over-approximates through the
 *   target's own edges), and an empty resolution FALLS BACK to a whole-module
 *   edge to the direct target (`unresolvable`) — narrowing may shrink an edge's
 *   target set, never lose the edge.
 */
export type GraphView = "component" | "module";

/** Per-module inputs captured during discovery (specifiers pre-resolved). */
export interface EdgeSources {
  readonly records: ReadonlyMap<ModuleId, ModuleRecord>;
  readonly resolveSpec: (from: ModuleId, spec: string) => ModuleId | null;
  readonly globHits: (from: ModuleId) => readonly ModuleId[];
}

/** Wire caps: enough to explain an edge, small enough to keep payloads lean. */
const SYMBOL_CAP = 24;
const VIA_CAP = 4;

/** Accumulates one (from,to) edge's provenance across contributions. */
interface EdgeAcc {
  from: ModuleId;
  to: ModuleId;
  reasons: DependencyReason[];
  via: Set<ModuleId>;
}

/**
 * Build the provenance-rich edges for every module in `froms` (the component
 * view passes only `.vue` nodes; the module view every reachable file). Edges
 * are deduped per (from,to) with reasons accumulated in contribution order;
 * self-edges are dropped.
 */
export function buildEdges(
  froms: Iterable<ModuleId>,
  sources: EdgeSources,
  resolver: DefinerResolver,
  term: Terminality,
  view: GraphView,
): SymbolEdge[] {
  const edges: SymbolEdge[] = [];
  for (const from of froms) {
    const rec = sources.records.get(from);
    if (!rec) {
      continue;
    }
    const acc = new Map<ModuleId, EdgeAcc>();
    const add = (to: ModuleId, reason: DependencyReason, via?: ModuleId): void => {
      if (to === from) {
        return;
      }
      let entry = acc.get(to);
      if (!entry) {
        entry = { from, to, reasons: [], via: new Set() };
        acc.set(to, entry);
      }
      entry.reasons.push(reason);
      if (via !== undefined && via !== to) {
        entry.via.add(via);
      }
    };
    // A whole-module dependency: the component view expands to the components
    // the target surfaces; the module view emits a single edge to the target
    // itself (§2 "Edge target: expansion vs. the module itself").
    const whole = (t: ModuleId, cause: WholeModuleCause, isType: boolean): void => {
      const reason: DependencyReason = { tag: "whole", cause, isType };
      if (view === "module") {
        add(t, reason);
        return;
      }
      for (const d of resolver.ofModule(t)) {
        add(d, reason);
      }
    };
    // A symbol-narrowed dependency on `name` of direct target `t`. The module
    // view must never lose the edge: an empty resolution (re-export chain exits
    // the project, unparseable module, missing name — or one that collapses to
    // `from` itself) falls back to a whole-module edge to `t` (§2 "Fallback").
    const narrowed = (t: ModuleId, name: string, label: string, isType: boolean): void => {
      const reason: DependencyReason = isType
        ? { tag: "type", symbols: [label] }
        : { tag: "value", symbols: [label] };
      let emitted = false;
      for (const d of resolver.ofExport(t, name)) {
        if (d !== from) {
          add(d, reason, d === t ? undefined : t);
          emitted = true;
        }
      }
      if (!emitted && view === "module" && t !== from) {
        add(t, { tag: "whole", cause: "unresolvable", isType });
      }
    };

    for (const imp of rec.imports) {
      const t = sources.resolveSpec(from, imp.source);
      if (!t) {
        continue; // external / out of root — not a node in either graph
      }
      if (imp.bindings.length === 0) {
        // `import "s"` — running the module is a real dependency. The module
        // view records it; the component view has nowhere to point it unless
        // the target IS a component (today's behavior, kept byte-identical).
        if (view === "module") {
          whole(t, "sideEffect", false);
        } else if (term.isComponent(t)) {
          add(t, { tag: "whole", cause: "sideEffect", isType: false });
        }
        continue;
      }
      for (const b of imp.bindings) {
        const imported = b.imported;
        switch (imported.kind) {
          case "namespace": {
            // §5: the dependency is decided by USAGE (`ns.Home`), not the
            // import statement. Narrow to the statically-read members when the
            // parser proved it safe; any escape/shadow/template blind spot
            // keeps the whole-module edge under its named cause. The component
            // view always expands (its observable behavior is frozen).
            const usage = rec.nsUsage.find((u) => u.local === b.local && u.source === imp.source);
            if (view === "module" && usage) {
              if (usage.members && usage.members.length > 0) {
                for (const m of usage.members) {
                  narrowed(t, m, m, b.isType);
                }
              } else {
                whole(t, usage.cause ?? "namespaceImport", b.isType);
              }
            } else {
              whole(t, "namespaceImport", b.isType);
            }
            break;
          }
          case "default":
            narrowed(t, "default", b.local ?? "default", b.isType);
            break;
          case "named":
            narrowed(t, imported.name, b.local ?? imported.name, b.isType);
            break;
          default:
            assertNever(imported);
        }
      }
    }

    for (const exp of rec.exports) {
      switch (exp.kind) {
        case "local":
          break; // no source — not a dependency
        case "reexport": {
          const t = sources.resolveSpec(from, exp.source);
          if (t) {
            // The barrel itself depends on the definer (barrel transparent).
            narrowed(t, exp.importName, exp.exportName, exp.isType);
          }
          break;
        }
        case "star": {
          const t = sources.resolveSpec(from, exp.source);
          if (t) {
            if (view === "module") {
              // `export * from "s"` executes and forwards s wholesale: one
              // value edge to the direct target. Consumers narrow through it
              // per name (§2); expanding here would fabricate the very barrel
              // fan-out this work removes.
              add(t, exp.isType ? { tag: "type", symbols: [] } : { tag: "value", symbols: [] });
            } else {
              whole(t, "namespaceReexport", exp.isType);
            }
          }
          break;
        }
        case "ns": {
          const t = sources.resolveSpec(from, exp.source);
          if (t) {
            whole(t, "namespaceReexport", exp.isType);
          }
          break;
        }
        default:
          assertNever(exp);
      }
    }

    for (const spec of rec.dynamic) {
      const t = sources.resolveSpec(from, spec);
      if (t) {
        whole(t, "dynamicImport", false);
      }
    }
    for (const hit of sources.globHits(from)) {
      whole(hit, "dynamicImport", false);
    }

    for (const entry of acc.values()) {
      edges.push(
        entry.via.size > 0
          ? { from: entry.from, to: entry.to, reasons: entry.reasons, via: [...entry.via] }
          : { from: entry.from, to: entry.to, reasons: entry.reasons },
      );
    }
  }
  return edges;
}

/** True when every reason is type-only — the wire `type` (dashed) marker. */
export function isTypeOnly(reasons: readonly DependencyReason[]): boolean {
  return reasons.every((r) => (r.tag === "whole" ? r.isType : r.tag === "type"));
}

/** True when every reason crosses a lazy boundary (dynamic import / glob). */
export function isLazyOnly(reasons: readonly DependencyReason[]): boolean {
  return reasons.every((r) => r.tag === "whole" && r.cause === "dynamicImport");
}

/**
 * Flatten to the wire. The component view stays exactly today's shape (no
 * provenance — the `vue` graph is byte-identical across this refactor); the
 * module view carries `symbols`/`via`/`lazy` for the UI and the score.
 */
export function toWireEdges(edges: readonly SymbolEdge[], view: GraphView): ComponentEdge[] {
  return edges.map((e) => {
    const wire: ComponentEdge = { from: e.from, to: e.to };
    if (isTypeOnly(e.reasons)) {
      wire.type = true;
    }
    if (view === "component") {
      return wire;
    }
    if (isLazyOnly(e.reasons)) {
      wire.lazy = true;
    }
    const symbols: string[] = [];
    for (const r of e.reasons) {
      if (r.tag === "whole") {
        continue;
      }
      for (const s of r.symbols) {
        if (!symbols.includes(s)) {
          symbols.push(s);
          if (symbols.length === SYMBOL_CAP) {
            break;
          }
        }
      }
      if (symbols.length === SYMBOL_CAP) {
        break;
      }
    }
    if (symbols.length > 0) {
      wire.symbols = symbols;
    }
    if (e.via && e.via.length > 0) {
      wire.via = e.via.slice(0, VIA_CAP);
    }
    return wire;
  });
}
