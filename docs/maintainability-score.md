# The maintainability score

`vite-plugin-tsmigrate` reduces a codebase to a single **maintainability
score** (capped at 100, open-ended below zero; higher is better), shown at the
top of the tool panel and served on `GET /api/graph` as
`ComponentGraph.maintainability`. This document is the full model: what it
measures, why each term is there, how the scale is anchored, and what it
deliberately cannot see.

## The idea: the cost of a safe change

The only honest definition of maintainability is operational: **when I change
a file, how much must I understand, how much can I break, and how much does
the compiler help me?** A maintainable codebase keeps those small.

Everything is priced in one currency: **the effort of reading one line of
code once** (a "LoC-equivalent unit"). Changing a file `m` sends you four
bills:

1. **Read** — you have to read the file itself. `loc(m)` units, unavoidable.
   Everything else in the model is overhead on top of this.
2. **Comprehension** — you can't read a file in isolation; you also carry
   what its imports do in your head. Importing a stable module is nearly
   free (learn it once, it stays learned); importing a module that changes
   every week means your mental model keeps going stale. A healthy number
   of imports costs nothing at all.
3. **Blast** — after your change, everything that imports the file — and
   everything that imports *those* files, all the way up — must be
   re-checked. The bill scales with how much of the codebase sits downstream
   **and** how often this file actually changes.
4. **Mass** — tangled logic in a big file. Every `if`, loop, and ternary
   costs more the bigger the haystack it's buried in.

Types don't get a bill of their own — they **discount** the other bills,
because the compiler carries most of the re-checking wherever code is typed
(see [Types](#types--a-discount-not-a-penalty)).

Formally:

```math
\mathrm{cost}(m) \;=\; \underbrace{\mathrm{loc}(m)}_{\text{read}} \;+\; t(m)\cdot\bigl(\underbrace{\mathrm{comp}(m)}_{\text{comprehension}} + \underbrace{\mathrm{mass}(m)}_{\text{mass}}\bigr) \;+\; \bigl(D + (1{-}D)\,u_{\text{dep}}(m)\bigr)\cdot\underbrace{\mathrm{blast}(m)}_{\text{blast}}
```

```math
\mathrm{comp}(m) = \mathrm{loc}(m)\,\alpha\,\max(0,\,C_e^{w}(m)-K),\quad
\mathrm{blast}(m) = \mathrm{loc}(m)\,\beta\,\mathrm{vol}(m)\,r(m),\quad
\mathrm{mass}(m) = \kappa\,\mathrm{cc}(m)\bigl(\tfrac{\mathrm{loc}(m)}{L_0}\bigr)^{p}
```

### Every symbol, in words

Measured per file:

| Symbol             | Plain meaning                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| $\mathrm{loc}(m)$  | The file's **maintainable lines**: the source with its `<style>` and `<svg>` blocks stripped.                                                             |
| $\mathrm{vol}(m)$  | **Volatility**, 0–1: how likely the file is to change soon, measured from git history (see [Volatility](#volatility--the-shared-change-likelihood-term)). |
| $r(m)$             | **Blast radius**, 0–1: the fraction of the codebase's lines sitting in files that import `m`, directly or through other files.                            |
| $C_e^{w}(m)$       | **Weighted import count**: each import counted by its target's volatility — a stable constants file ≈ 0, a churning store ≈ 1.                            |
| $\mathrm{cc}(m)$   | **Decision points**: `if`, loops, ternaries, `&&`/`\|\|`/`??`, `case`, `catch`, plus template `v-if`/`v-for`/`v-show`.                                     |
| $t(m)$             | 1 if the file has its own type errors ("red"), else the typed discount $D$.                                                                               |
| $u_{\text{dep}}(m)$ | Of all the lines downstream of `m` (the $r$ set), the fraction living in **red** files — "how much of what I can break is unprotected by types?"          |

Tunable constants (defined once in
[`src/analysis/maintainability.ts`](../src/analysis/maintainability.ts)):

| Symbol   | Plain meaning                                                                                                                                    | Default |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| $K$      | Free import budget: the first $K$ weighted import-points cost nothing — ordinary modularity is free.                                             | `8`     |
| $\alpha$ | Price per import-point over budget: each one makes **every line of the file 5% harder to read** (the whole file is read amid those moving parts). | `0.05`  |
| $\beta$  | Blast ceiling: the worst case — a file everyone imports that changes constantly — costs $\beta\times$ its own length extra per change.            | `3`     |
| $\kappa$ | Price of one decision point in a pivot-sized file: 1 branch in a 300-line file = the effort of reading one line.                                  | `1`     |
| $L_0$    | The "normal file" size mass prices against. At $p = 1$ only $\kappa/L_0$ matters — freeze $L_0$, tune $\kappa$.                                   | `300`   |
| $p$      | How fast a branch's price grows with file size (1 = linear). Raise to 1.25–1.5 if god files rank too low in the hotspots.                          | `1`     |
| $D$      | Typed discount: typed code pays this fraction of a flaw's cost — the compiler carries the rest.                                                    | `0.2`   |

A worked example: a **red** 300-line file with 12 weighted imports, cc 30,
vol 0.5, 10% of the codebase downstream of which half is red.

- read = 300
- comprehension = 300 · 0.05 · (12 − 8) = **60** (4 imports over budget →
  every line 20% harder)
- mass = 1 · 30 · (300/300)¹ = **30** (30 branches at full pivot price)
- blast = 300 · 3 · 0.5 · 0.1 = 45, discounted by 0.2 + 0.8 · 0.5 = 0.6 →
  **27**
- cost = 300 + 1·(60 + 30) + 27 = **417** — a 39% surcharge on just reading
  it.

The whole-codebase cost is the sum over files; the **floor** is the cost of
reading every file once (`Σ loc`); and the **overhead ratio**

```math
\Omega = \frac{\mathrm{cost} - \mathrm{floor}}{\mathrm{floor}}
```

is what the score maps: "how much does this codebase charge me *on top of*
the reading that any codebase requires?"

## The scale: criterion-referenced, two legible constants

```math
\boxed{\;\text{score} = \min\Bigl(100,\; 30 - 25 \cdot \log_2 \tfrac{\Omega}{\Omega_{\text{typ}}}\Bigr)\;}
```

- **Ω_typ = 0.10** — the overhead ratio of a _typical production Vue app_,
  pinned to score **30**. The scale is graded against a fixed quality bar,
  not on a curve: a standard defines it, and the average project is allowed
  (expected) to fail. Grading on a curve — median project = 50 — would hand
  half the world a passing grade by construction, which is exactly the
  dishonest encouragement this model avoids.
- **Slope: 25 points per doubling** of Ω — halve the overhead for +25, double
  it for −25.
- The **100 cap** is principled: Ω = 0 — changes cost only the reading — is a
  true floor. The **bottom is open**: negatives are reserved for genuine
  disasters.
- **Types live inside Ω as a discount on every flaw** (never a separate
  penalty term or post-mapping deduction) — the compiler carries most of the
  re-verification wherever code is typed, so a fully-typed repo prices every
  flaw at $D$ and a fully-red one at full price.

Archetypes under this anchoring (from the calibration analysis):

| archetype                      | Ω        | score     |
| ------------------------------ | -------- | --------- |
| tiny clean app                 | ≤0.013   | 100 (cap) |
| rare well-factored OSS         | ~0.02    | ~88       |
| decent, disciplined            | 0.06     | 48        |
| **typical production Vue app** | **0.10** | **30**    |
| legacy mess                    | 0.25     | −3        |
| really bad                     | 0.5      | −28       |

## Volatility — the shared change-likelihood term

Both comprehension and blast price change against **volatility**
vol ∈ [0, 1]: how likely is this file to actually change soon? A dependency
that never moves is cheap to depend on; a hub that never moves never sets its
blast off. The pinned, production-validated form:

```math
x(m) = \frac{\text{damped deleted lines/month}}{\mathrm{loc}(m)},
\qquad
\mathrm{vol}(m) = \max\Bigl(\frac{x(m)}{x(m) + x_{1/2}},\; f\cdot I_0(m)\Bigr)
```

In words: count how many of the file's lines get **deleted** per month
(from git), divide by its size, and squash the result into 0–1 so that
deleting 1% of the file per month reads as "half volatile". Files with no
usable history fall back to a small structure-based guess.

- **Deleted lines only** (from `git log --numstat`), never added lines:
  appending to a registry/barrel/config is risk-free — modifying existing
  lines is risk. Validated on production: vben's icon barrel (+60/−2 history)
  reads vol ≈ 0, while hot hubs that rewrite their lines keep vol 0.6–0.8.
  An added-lines signal marked the barrel fully volatile.
- **Absolute saturation**: half-volatile at $x_{1/2}$ = 1% of the file's
  lines deleted per month — a **fixed** scale, deliberately not a per-repo
  percentile. A percentile would make every repo's hottest quartile read as
  maximally volatile, so a becalmed maintenance-mode codebase would score
  like one whose core churns daily — and cross-repo comparability dies.
- **Hygiene** (in `src/analysis/churn.ts`): one `git log --numstat -M` pass
  per repository over a fixed 18-month window; **rename chaining** (`-M`,
  walked newest → oldest so pre-rename churn lands on the present path);
  **bulk damping** — a commit touching $k$ files carries weight
  $\min(1, \sqrt{30/k})$, and commits above 200 files (formatting passes,
  codemods) are dropped entirely (their renames still chain).
- **Structural fallback**: with thin or no history, vol bottoms out at
  $f \cdot I_0$, where $I_0 = C_e/(C_e+C_a)$ is raw **Martin instability**
  (imports ÷ (imports + importers) — "how much does this file depend on
  others vs. being depended on") and $f = 0.15$ shrinks it hard: presumed
  volatility is weak evidence, and an unshrunk structural prior drowned the
  other terms on history-less repos. History-less codebases still _order_ by
  structure; they just don't read as if every mid-layer module churned daily.
- Recency decay and age-corrected rates are deliberately **absent** — an age
  denominator saturated shallow-clone fixtures (the vben=22 incident) and
  neither was part of the validated runs. Re-validate against the regression
  fixtures before reintroducing either.

**Multi-repo resolution**: each file is attributed to its nearest enclosing
git work tree (`git -C <dir> rev-parse --show-toplevel`, walk-up cached) — a
submodule is a single gitlink entry in its parent, so a log at the parent root
would silently report nothing for files inside it. The panel's **churn
measured** readout is the LoC fraction with usable history; the rest runs on
the fallback.

Volatility replaces the old model's Martin-instability terms outright. The old
blast term $I\cdot r$ was structurally self-canceling: high fan-in drives
$r$ up but $I$ down, so a weekly-edited hub with 400 importers scored **zero**
blast — the exact files changes are feared in. Measured churn breaks that
anti-correlation.

## The graph: symbol-resolved edges

All quantities come from the **full module graph** (`.vue` + `.ts`), whose
edges are **symbol-resolved definition edges**: an import contributes an edge
to the module that _defines_ the symbol it uses, resolved through re-export
chains, so barrels and re-export hubs are transparent instead of reading as
false hubs. Each import form is classified; only `value`/`type` bindings are
symbol-narrowed — the rest stay safe whole-module edges:

| Source form                              | Narrowed to definers?                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `import { X }`, `import X` (default)     | yes — through re-exports, incl. `export * from` per name                                                                                                                 |
| `import type { X }`, `import { type X }` | yes (type-only; see projections below)                                                                                                                                   |
| `import * as ns from "s"`                | partial — static member reads (`ns.X`, `ns["X"]`) narrow; any escape (`f(ns)`, spread, dynamic key, shadowing) or a `.vue` file (template blind spot) stays whole-module |
| `import "s"`, `import(...)`, glob        | no — running the module is the dependency                                                                                                                                |

**Design principle: never lose an edge.** Whole-module over-approximates (may
add an unused edge, never misses one); narrowing risks the opposite — a missed
edge means an artificially _low_ blast radius, which in a maintainability tool
is the dangerous direction (false confidence). Narrowing happens only when
provably safe, and an empty resolution (external re-export target, unparseable
module, unfound name) falls back to a whole-module edge to the direct target —
never to nothing. Whole-module edges point at the module itself, never an
expansion of its exports: a 66-barrel side-effect entry keeps 66 edges, not
370 fabricated ones.

## The terms

All terms are computed over these edges, through per-kind projections.

### Edge projections

Not every import is a real "can break at runtime" dependency, so each term
sees only the edges that matter to it:

- **Type-only edges** (`import type`, `import { type X }`) leave every
  structural term — $C_e^{w}$, $C_a$, and the blast radius $r$. If only your
  types are consumed, a change is re-verified by the **compiler**, not by a
  human re-reasoning about behaviour.
- **Lazy edges** (`import(...)`, `import.meta.glob`) leave only the
  **importer's** $C_e^{w}$: a route table globbing 200 pages is a declarative
  registry, not 200 things its reader must understand. The targets keep
  their fan-in, reachability and blast radius — a broken page still breaks
  navigation.
- Everything else — including synchronous side-effect imports — counts
  everywhere.
- Cycle detection runs on the **structural** projection: a cycle held
  together only by `import type` edges does not exist for the score.

### Comprehension — $`\alpha\,\max(0,\,C_e^{w}(m)-K)`$

**"Do I have to keep too many moving parts in my head to read this file?"**

Count the file's imports, but weight each one by how volatile its target is:
$C_e^{w}(m)=\sum_{d\,\in\,\text{imports}(m)} \mathrm{vol}(d)$. Depending on a
**stable** module — an icon or constants barrel that never changes — is
nearly free, while depending on a churning store costs close to a full
import-point. The first $K = 8$ points are **free**, so ordinary modularity
costs nothing. Every point above the budget makes every line of the file
$\alpha = 5\%$ harder to read — the whole file is read in the context of
those moving parts, which is why the surcharge multiplies `loc`.

### Blast — $`\beta\,\mathrm{vol}(m)\,r(m)`$

**"How big is the explosion when I touch this, and how often does someone
touch it?"**

Change a widely-imported module and you must re-reason about, re-review, and
re-test everything downstream. The bill is the product of:

- $r(m)$ — the **blast radius**: what fraction of the codebase's lines sit in
  files that transitively import `m` (computed over the graph's
  strongly-connected condensation);
- $\mathrm{vol}(m)$ — how often `m` **actually changes**, so the bill is paid
  as often as the explosion actually goes off;
- $\beta = 3$ — the ceiling: the worst case (everyone imports it, it changes
  constantly) costs 3× the file's own length, every change.

Multiplying radius by measured volatility is the key move: a rock-stable
foundation imported by everyone costs **nothing** — popular but frozen means
the blast never goes off. A hub that half the app imports *and* that gets
rewritten weekly finally costs what it feels like. An import **cycle** folds
its entire LoC into every member's blast radius (cycle members are mutual
dependents), so cycles are penalised _through_ blast rather than by an ad-hoc
constant.

### Mass — $`\kappa\,\mathrm{cc}(m)\,(\mathrm{loc}(m)/L_0)^p`$

**"How tangled is the logic, and how big is the haystack it's buried in?"**

Each decision point costs $\kappa = 1$ line-equivalent in a pivot-sized
($L_0 = 300$ lines) file, scaled by file size: a branch in a 150-line
component is half price; a branch in a 1,400-line composable costs 4.7×,
because you navigate the whole haystack to reason about it. **Splitting a god
file genuinely lowers the score.**

$\mathrm{cc}(m)$ counts the script's decision points (`if`, `?:`, loops,
`catch`, non-default `case`, `&&`/`||`/`??` — from the oxc AST) **plus the
template's branch directives** (`v-if`/`v-else-if`/`v-for`/`v-show`) — a
`v-if`-dense component with a flat script is real branching load. And because
the size escalator only fires on branches, a 3,000-line file of flat data
(legal text, URL tables, icon lists) with zero branches costs zero.

### Types — a discount, not a penalty

A file is **red** when the type-checker reports at least one error *inside
it* — an implicit `any`, a missing prop type — meaning the compiler can't
vouch for it and a human must. Types are a cost **discount on every flaw**,
not a term of their own: the compiler carries most of the re-verification
wherever code is typed. Per file, with $D = 0.2$:

- **Own flaws** (comprehension, mass) scale by $t(m) = 1$ if $m$ is red,
  else $D$ — understanding a branchy, coupled file without type cover costs
  full price; with cover, a fifth.
- **Blast** scales by $D + (1{-}D)\,u_{\text{dep}}(m)$, where
  $u_{\text{dep}}$ is the fraction of `m`'s downstream lines living in red
  files (same reach set as the blast radius, weighted by red LoC). The
  slider runs from $D$ (everything downstream typed — `tsc` re-checks it for
  you) to 1 (everything red — humans re-reason it by hand), and it depends on
  the *dependents'* colour, not `m`'s own: typed downstream code is cheap to
  re-verify no matter what you changed.

Consequences worth naming: a red file with no flaws costs **nothing** (types
discount flaws — they are not a penalty of their own); a fully-typed repo
prices every flaw at $D$; red → green on a god file is worth exactly $1/D$ =
5× off its flaw cost.

The plugin option **`scoreTypeRisk: false`** treats every file as typed
($t = D$, $u_{\text{dep}} = 0$) — "score the structure as if the migration
were finished", the post-migration structural ceiling, on the same scale as
typed repos. The type-check pass keeps running and driving node coloring and
the typed % readout. With a bounded discount there is no longer a reason for
mid-migration projects to turn type risk off — the option exists to see the
ceiling. (`typeCheckCommand: false` skips the pass altogether; every file
then reads as typed.)

## Why the score is size-invariant

A clean, modular app maps to the same score whether it has 20 files or 900:
cost and floor both scale linearly with total LoC, every surcharge factor is
bounded and size-independent ($C_e^w$ is local; vol, $r$ ∈ [0, 1]), and mass
per LoC is $\kappa\,\mathrm{cc}/L_0 \cdot (\mathrm{loc}/L_0)^{p-1}$ —
per-file shape, not repo size. (Blast radius does drift slightly with size as
shared foundations approach universal reachability — an asymptote, not a
runaway.)

## What the panel shows

- **score** — the headline, graded green (≥ 70) / amber (≥ 30 — the typical
  app sits at the amber floor) / red (below typical, incl. negatives).
- **drivers** — how the overhead splits into `comprehension` (excess volatile
  fan-out), `blast` (volatility × radius), and `mass` (branches × size); the
  three add to 1, typed discounts included. Clicking a driver row rings each
  node in the graph by its contribution (`contributions` on the wire).
- **in cycles / typed** — as before: LoC fraction in structural cycles (with
  the cheapest cut per cycle), LoC-weighted typed fraction.
- **churn measured** — the LoC fraction whose volatility rests on real git
  history; the rest runs on the structural fallback (shallow clones and fresh
  repos read low here, and the score is honest about it).
- **hotspots** — the files dragging the score down most, sorted by overhead
  above their own floor (`cost − loc`, descending); the shown **score drag**
  % is each file's share of the codebase's total overhead. Files at their
  floor never appear. Hover for fan-out, fan-in, volatility, and blast
  radius.
- **scope** — "graph covers N of M source files · X% of source LoC", plus the
  **unreached files** list (dead code, intentional archives, crawler blind
  spots). Diagnostic only: unreached files enter neither floor nor cost. This
  exists so a JS-graph score is never read as a repo-wide verdict — backend
  code, Blade/ERB templates, and i18n JSONs are invisible to any Vite plugin.
- **edge weight** — every drawn edge's opacity/width is the exact number the
  score charges for it: the target's volatility. Stable imports render nearly
  invisible; churning hubs collect converging bold lines. Type-only and lazy
  edges sit at the floor with distinct dashes.
- **calibration epoch** — shipped on the wire (`calibrationEpoch`) so old
  screenshots stay interpretable across model versions.

## Parameters

All defaults live in one place,
[`src/analysis/maintainability.ts`](../src/analysis/maintainability.ts); the
term constants are explained in the
[symbol table](#every-symbol-in-words) above. Two more place repos on the
scale: $\Omega_{typ} = 0.10$ (the typical-app anchor → score 30) and the
slope of `25` points per doubling of Ω.

The tuning protocol: **term** constants ($K$, $\alpha$, $\beta$, $\kappa$,
$L_0$, $p$, $D$, $x_{1/2}$, $f$) shape Ω and the hotspot list — tune them
only on within-repo evidence (does the top-10 match the files you dread?).
**Mapping** constants ($\Omega_{typ}$, slope) place repos on the scale — tune
them only on cross-repo evidence. Never fix a score with a term knob or a
hotspot list with a mapping knob.

Churn-estimator constants, defined in
[`src/analysis/churn.ts`](../src/analysis/churn.ts): fixed window `18`
months (fetched as 540 days), bulk damping from `30` files, drop above `200`
files. Recency decay and age-corrected rates are deliberately absent (§
Volatility).

**Ω_typ = 0.10 is provisional.** Re-measure a taste-rated production app with
real history against the pinned estimator before moving the anchor, and bump
`CALIBRATION_EPOCH` when it moves. The v2.1 regression fixtures below place a
private taste-rated reference ("brain of materials", felt ≈ 30) at Ω 0.101 —
one point of independent support for the anchor.

## Recorded scores — regression fixtures (calibration epoch `v2.1-2026-08`)

Playground scores under the v2.1 model (`node scripts/score.mjs --assert`).
The submodules ship as shallow clones; the harness deepens each to cover the
18-month churn window (`git fetch --shallow-since="20 months ago"`) before
capturing, so these anchors exercise the **measured-churn** path (coverage
0.84 / 0.94 / 0.40 by LoC).

| Fixture                                | expected | measured | Ω      | drivers (comp / blast / mass) |
| -------------------------------------- | -------- | -------- | ------ | ----------------------------- |
| `playground-shadcn` (registry)         | 95       | 98       | 0.0153 | 0.00 / 0.10 / 0.90            |
| `playground` (vben web-antd)           | 71       | 73       | 0.0305 | 0.00 / 0.52 / 0.48            |
| `playground-vuetify` (library)         | 60       | 60       | 0.0439 | 0.00 / 0.40 / 0.60            |
| brain of materials (private reference) | 30       | —        | 0.101  | felt ≈ 30 — anchors Ω_typ     |

Tolerance ±5 points per fixture (estimator detail drift); **ordering is a
hard assertion**, as are two artifact guards: vben's icon barrel `lucide.ts`
(append-only +60/−2 history) must read vol < 0.1 — it measures 0 — and
vben's top hotspot must be `resize.vue` (1209 LoC / cc 141, vol 0.33).
`--assert` exits nonzero on any drift. The typed fixtures above must never
score below the untyped reference under any constant tweak.

History of the anchors: v1 (amplifier complexity, $I\cdot r$ blast,
`100·floor/cost` mapping) scored these 94 / 95 / 99 — uselessly compressed at
the top. v2 (shallow clones, rate÷age estimator, unshrunk structural prior)
scored 22 / 12 / 37 — the age denominator saturated volatility on 1-commit
submodules and the raw-I₀ prior priced structure as if it churned; both are
pinned out of the estimator now. The hotspot lists match the files one would
dread in each repo (vben's `resize.vue`, vuetify's `VCombobox.tsx` 857 /
cc 184, shadcn's `useMessageScroller.ts` 1038 / cc 178) — the within-repo
evidence the tuning protocol wants.

## Limits — what this model cannot see

- **Churn needs history** — a shallow clone or fresh repo degrades volatility
  to the structural fallback (the `churn measured` readout says so);
  submodule HEAD moves are not watched, only the root repo's.
- **Semantic coupling** — event buses, dependency injection, string-keyed
  registries. **Auto-imports** are the named worst case: manifest targets are
  crawled as nodes (so they don't read as dead code), but the _binding sites_
  have no import statements, so fan-in and blast radius still read low — the
  tool shows a warning banner.
- **Deep intra-file structure** — cc counts branch points (script + template),
  not the shape of a 2,000-line `switch` beyond its count.
- **Non-JS surfaces** — backend code, server templates, i18n files. The scope
  readout exists precisely so the score is read as a JS-graph signal, not a
  codebase verdict.
- **Test coverage** — arguably the strongest maintainability signal, and
  entirely invisible to a dependency graph.
