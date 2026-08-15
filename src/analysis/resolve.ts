import type { ImportedName, ModuleRecord } from "./imports.ts";
import type { ModuleId, SymbolName, Terminality } from "./symbols.ts";

/**
 * Definer resolution: which modules actually *define* what an export — or a
 * whole module namespace — surfaces, following re-export chains through
 * barrels. Extracted and generalized from the crawl's component-only
 * `resolveExport`/`resolveModule` (docs/symbol-resolution.md §6).
 *
 * Pure and synchronous: specifier resolution happened during discovery, so the
 * caller injects a `(from, spec) → ModuleId | null` lookup. Parametrized by
 * `Terminality` — the component graph treats only `.vue` files as definers,
 * the module graph also every locally-defined export.
 *
 * Correctness rules carried by this extraction (§6, both latent in the old
 * crawl code and load-bearing once the score consumes the module graph):
 *
 * - **`export *` never forwards `default`** (ESM semantics) — the star
 *   fallback is skipped for the name "default".
 * - **Never memoize a truncated result.** A resolution computed while a cycle
 *   guard was active (its subtree touched a key still in progress) is returned
 *   but not cached, so mutual `export *` cycles resolve identically regardless
 *   of query order. Tracked with a Tarjan-style lowlink: each frame records the
 *   shallowest in-progress frame its subtree reached; only frames whose subtree
 *   never dips below themselves cache their result.
 */
export interface DefinerResolver {
  /** Defining modules a named export surfaces to (through re-exports/barrels). */
  ofExport(mod: ModuleId, name: SymbolName): ReadonlySet<ModuleId>;
  /**
   * Defining modules a whole module/namespace surfaces. Used for
   * component-graph expansion only — module-graph `whole` edges target the
   * module itself (§2), so with `localsAreDefiners` this is just `{mod}`.
   */
  ofModule(mod: ModuleId): ReadonlySet<ModuleId>;
}

export function makeResolver(
  records: ReadonlyMap<ModuleId, ModuleRecord>,
  resolveSpec: (from: ModuleId, spec: string) => ModuleId | null,
  term: Terminality,
): DefinerResolver {
  const exportMemo = new Map<string, Set<ModuleId>>();
  const moduleMemo = new Map<ModuleId, Set<ModuleId>>();

  // Cycle guard + memo taint. `inProgress` maps an active key to its stack
  // depth; `minTouched` is the lowlink of the *current* frame's subtree — the
  // shallowest in-progress depth it reached. A frame caches only when its
  // subtree never reached below its own depth (the result is complete, not
  // truncated by an ancestor's guard).
  const inProgress = new Map<string, number>();
  let minTouched = Infinity;

  /** Run `compute` as a guarded frame for `key`; memoize into `memo` iff clean. */
  function framed<K>(
    key: string,
    memo: Map<K, Set<ModuleId>>,
    memoKey: K,
    compute: () => Set<ModuleId>,
  ): Set<ModuleId> {
    const cached = memo.get(memoKey);
    if (cached) {
      return cached;
    }
    const active = inProgress.get(key);
    if (active !== undefined) {
      // Cycle: truncate here, and taint every frame down to the one re-entered.
      minTouched = Math.min(minTouched, active);
      return new Set();
    }
    const depth = inProgress.size;
    inProgress.set(key, depth);
    const parentMin = minTouched;
    minTouched = Infinity;
    const out = compute();
    const myMin = minTouched;
    inProgress.delete(key);
    if (myMin >= depth) {
      // Subtree stayed at or above this frame — complete result, safe to cache.
      memo.set(memoKey, out);
      minTouched = parentMin;
    } else {
      // Truncated by an ancestor's guard: return, don't cache, propagate taint.
      minTouched = Math.min(parentMin, myMin);
    }
    return out;
  }

  function ofExport(mod: ModuleId, name: SymbolName): Set<ModuleId> {
    if (term.isComponent(mod)) {
      return new Set([mod]);
    }
    const rec = records.get(mod);
    if (!rec) {
      return new Set();
    }
    const key = `${mod}\n${name}`;
    return framed(key, exportMemo, key, () => {
      const out = new Set<ModuleId>();
      let matched = false;
      for (const exp of rec.exports) {
        if (exp.kind === "reexport" && exp.exportName === name) {
          matched = true;
          const t = resolveSpec(mod, exp.source);
          if (t) {
            for (const v of ofExport(t, exp.importName)) {
              out.add(v);
            }
          }
        } else if (exp.kind === "ns" && exp.exportName === name) {
          matched = true;
          const t = resolveSpec(mod, exp.source);
          if (t) {
            for (const v of ofModule(t)) {
              out.add(v);
            }
          }
        } else if (exp.kind === "local" && exp.exportName === name) {
          matched = true;
          const binding = exp.local ? bindingOf(rec, exp.local) : undefined;
          if (binding) {
            for (const v of ofBinding(mod, binding)) {
              out.add(v);
            }
          } else if (term.localsAreDefiners) {
            // A locally-defined export: the module itself is the definer.
            out.add(mod);
          }
          // else: a locally-defined value in a `.ts` — not a component.
        }
      }
      // `export * from "x"` forwards named exports not matched above — but
      // NEVER `default` (ESM semantics; §6 correctness rule).
      if (!matched && name !== "default") {
        for (const exp of rec.exports) {
          if (exp.kind === "star") {
            const t = resolveSpec(mod, exp.source);
            if (t) {
              for (const v of ofExport(t, name)) {
                out.add(v);
              }
            }
          }
        }
      }
      return out;
    });
  }

  /** Resolve a local name that re-binds an import (`import X; export { X }`). */
  function ofBinding(
    mod: ModuleId,
    binding: { source: string; imported: ImportedName },
  ): Set<ModuleId> {
    const t = resolveSpec(mod, binding.source);
    if (!t) {
      return new Set();
    }
    if (binding.imported.kind === "namespace") {
      return ofModule(t);
    }
    if (binding.imported.kind === "default") {
      return ofExport(t, "default");
    }
    return ofExport(t, binding.imported.name);
  }

  function ofModule(mod: ModuleId): Set<ModuleId> {
    if (term.isComponent(mod)) {
      return new Set([mod]);
    }
    if (term.localsAreDefiners) {
      // Module graph: the module itself stands in for its whole namespace —
      // never expand (§2 "Edge target"); reachability flows through the
      // module's own outgoing edges.
      return new Set([mod]);
    }
    const rec = records.get(mod);
    if (!rec) {
      return new Set();
    }
    return framed(`*${mod}`, moduleMemo, mod, () => {
      const out = new Set<ModuleId>();
      for (const exp of rec.exports) {
        if (exp.kind === "star") {
          const t = resolveSpec(mod, exp.source);
          if (t) {
            for (const v of ofModule(t)) {
              out.add(v);
            }
          }
        } else {
          for (const v of ofExport(mod, exp.exportName)) {
            out.add(v);
          }
        }
      }
      return out;
    });
  }

  return { ofExport, ofModule };
}

function bindingOf(
  rec: ModuleRecord,
  local: string,
): { source: string; imported: ImportedName } | undefined {
  for (const imp of rec.imports) {
    for (const b of imp.bindings) {
      if (b.local === local) {
        return { source: imp.source, imported: b.imported };
      }
    }
  }
  return undefined;
}
