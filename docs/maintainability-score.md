# The maintainability score

`vite-plugin-tsmigrate` reduces a codebase to a single **maintainability
score** in `[0, 100]` (higher is better), shown at the top of the tool panel
and served on `GET /api/graph` as `ComponentGraph.maintainability`. This
document is the full model: what it measures, why each term is there, and what
it deliberately cannot see.

## The idea: the cost of a _safe_ change

The only honest definition of maintainability is operational: **when I change a
file, how much must I understand, how much can I break, and how much does the
compiler help me?** A maintainable codebase keeps those small. So we model the
expected cost of a change and invert it.

We express each module's cost in **LoC-equivalent units** (a "unit" is the
effort of reading one line once):

```math
\mathrm{cost}(m) \;=\; \mathrm{loc}(m)\cdot\Bigl(\underbrace{1}_{\text{read}} + W(m)\bigl(\underbrace{\alpha\,\max(0,\,C_e^{w}(m)-K)}_{\text{comprehension}} + \underbrace{\beta\,I(m)\,r(m)}_{\text{blast}} + \underbrace{\mathrm{type}(m)}_{\text{type risk}}\bigr)\Bigr)
```

```math
\mathrm{type}(m) = \begin{cases} \gamma\,\bigl(1 + \delta\,r(m)\bigr) & m \text{ has a type error} \\ 0 & \text{otherwise} \end{cases}
```

The **complexity weight** $W(m)=1+\lambda\,\dfrac{\rho(m)}{\rho(m)+D_0}$ scales the
_flaw_ terms by the file's cyclomatic-complexity density
$\rho(m)=\mathrm{cc}(m)/\mathrm{loc}(m)$ (decision points per maintainable line).
Complexity is a **cost amplifier, not a standalone penalty**: a file with no
coupling or type debt costs $\mathrm{loc}(m)$ however branch-dense it is ($W$
multiplies only the overhead), and a simple file ($\rho\to0$, $W\to1$) is scored
exactly as before. Dense logic makes the _real_ flaws — coupling, ripple, type
errors — costlier to change safely.

The whole-codebase cost is the sum, and the score normalises it against the
**floor** — the irreducible cost of reading every file once, with no excess
coupling and no type errors:

```math
\mathrm{floor} = \sum_m \mathrm{loc}(m),
\qquad
\mathrm{cost} = \sum_m \mathrm{cost}(m),
\qquad
\boxed{\;\text{score} = 100\cdot\frac{\mathrm{floor}}{\mathrm{cost}}\;}
```

A clean, fully-typed, modular codebase approaches 100; each unit of _excess_
coupling, structural blast, or type debt drives it down.

Throughout, $\mathrm{loc}(m)$ is **maintainable** source lines: the file
with its `<style>` and `<svg>` blocks removed. CSS and inline vector data are
not type-checked logic and are not edited line-by-line, so a big icon or a
large style block does not inflate a file's weight (nor its graph node size).

## The terms

All quantities come from the **full module graph** (`.vue` + `.ts`, raw import
edges — not the barrel-collapsed `vue` view), where an edge $u \to v$ means
"$u$ imports $v$".

### Comprehension — $`\alpha\,\max(0,\,C_e^{w}(m)-K)`$

$`C_e^{w}(m)=\sum_{d\,\in\,\text{imports}(m)} I_0(d)`$ is the **volatility-weighted
fan-out**: each import is counted by how unstable its target is. $I_0(d)$ is the
raw Martin instability of the imported module (see [Blast](#blast--betaimr)),
computed in a first pass. Depending on a **stable** module — an icon or
constants barrel, a pure types module ($I_0 \approx 0$) — is therefore nearly
free, while depending on a **volatile** one costs close to a full edge. Only
weighted fan-out **above a healthy budget** $K$ costs anything, so ordinary
modularity is free and a file that wires together many _volatile_ modules pays
for the excess. This refines the naive "charge every import equally" model
(under which a normal codebase, average fan-out 3–5, could never score above
~65) with a second refinement: importing seven icons is not the same as
importing seven churning stores.

### Blast — $`\beta\,I(m)\,r(m)`$

This is the cost of _behavioural_ ripple: change a widely-depended-upon module
and you must re-reason about, re-review, and re-test everything downstream. It
is deliberately **not** raw fan-in — a utility that 500 modules import but that
never itself changes costs nothing. Blast is the product of two bounded
factors:

- **Instability** $I(m) = \dfrac{C_e^{w}(m)}{C_e^{w}(m) + C_a(m)} \in [0, 1]$,
  where $C_a$ is the **afferent coupling** (direct importers) and $C_e^{w}$ the
  volatility-weighted fan-out from [Comprehension](#comprehension--alphamax0-cewm-k).
  This is Robert Martin's instability made **dependency-aware**: the raw
  $I_0 = C_e/(C_e+C_a)$ (used only as the first-pass edge weight) is Martin's
  original. A pure sink ($C_e = 0$, e.g. a leaf constant) has $I = 0$ and
  contributes **no** blast however many importers it has — the
  Stable-Dependencies Principle, and why a stable foundation is not punished for
  being popular. Weighting extends the same principle to the importer: a module
  that imports only _stable_ code stays stable itself, so `import { … } from
'@vben/icons'` never inflates the consumer's instability.

- **Blast radius** $r(m) = \dfrac{\text{LoC transitively importing } m}{\sum_k \mathrm{loc}(k)} \in [0, 1]$
  — the fraction of the codebase that would need re-verifying if $m$'s
  behaviour changed. Blast radius is computed over the graph's strongly-connected
  condensation, so an import **cycle** folds its entire LoC into every member's
  blast radius (cycle members are mutual dependents). A cycle is therefore
  penalised _through_ blast rather than by an ad-hoc constant.

### Type risk — $`\gamma\,(1 + \delta\,r(m))`$ for red files

This is where type errors enter the score, as a **first-class term** — the
graph is a TypeScript-migration view, and the score must track red → green.
Every file that carries at least one type error costs $\gamma$ extra directly
(so the score responds to the _amount_ of red code, even in leaves that nothing
imports), and that cost is **amplified by blast radius** via $\delta$: a bad type in a
foundational module the whole codebase imports is far worse than one in an
isolated leaf.

An earlier design folded types into blast as a $(1 + \rho)$ attenuator; that
made type coverage almost inert (a fully-red codebase scored within a point or
two of a fully-green one), which is unacceptable for a migration tool. The
direct term fixes that: a fully-typed codebase scores near its structural
ceiling, and the score falls monotonically as red code accumulates.

### Complexity — the flaw weight $`W(m)`$

$`\mathrm{cc}(m)`$ is the **cyclomatic complexity** of the file's script: the
count of decision points (`if`, `?:`, every loop, `catch`, each non-default
`case`, and each `&&`/`||`/`??`), read from the oxc AST. LoC weighs every line
the same; a 40-branch function and a flat list of 40 assignments are equal by
LoC but not by the effort to change them safely. So complexity does not add its
own term — it **weights** the structural and type flaws above: a coupling edge
or a type error inside dense, branch-heavy logic costs more than the same flaw
in simple code. The weight saturates in density ($W \in [1, 1+\lambda)$), so it
stays bounded and size-invariant like $I$ and $r$. Only the `<script>` is
parsed, so template branching (`v-if`/`v-for`) is not counted.

## Why the score is size-invariant

Both `floor` and `cost` scale linearly with total LoC, and every surcharge
factor is bounded and size-independent: $C_e$ is local, $I$ and $r$ live in
$[0, 1]$, and the type term is per-file. A clean, typed, modular app scores in
the low-to-mid 90s whether it has 20 files or 900. (Blast radius does drift slightly
with size as shared foundations approach universal reachability, so the score
converges toward a ceiling rather than being exactly flat — an asymptote, not
the runaway of the naive model.)

## What the panel shows

- **score** — the headline `100·floor/cost`, graded green (≥ 80) / amber
  (≥ 50) / red.
- **drivers** — how the overhead above the floor splits into `comprehension`
  (excess fan-out), `blast` (structural ripple), and `types` (the direct cost
  of red files); the three add to 1. This says _why_ the score is what it is.
  Clicking a driver row highlights each node in the graph with a ring in that
  driver's colour, its opacity set by the file's contribution to that driver
  (`contributions` on the wire, normalised to `[0,1]` by the top contributor).
- **in cycles** — the fraction of LoC trapped in import cycles.
- **typed** — LoC-weighted typed fraction (omitted when the type pass is off).
- **complexity load** — how much of the overhead exists _because_ flaws sit in
  complex, branch-dense files (the $W>1$ amplification). 0 when the code is
  flaw-free or uniformly simple.
- **hotspots** — the files dragging the score down most (highest overhead above their own floor), each with its fan-out,
  fan-in, instability, and blast radius. This is where to look first: lower these and
  the score rises.

## Parameters

The model's constants are defined once in
[`src/analysis/maintainability.ts`](../src/analysis/maintainability.ts):

| Symbol    | Meaning                                              | Default |
| --------- | ---------------------------------------------------- | ------- |
| $K$       | healthy fan-out budget (imports before cost)         | `8`     |
| $\alpha$  | comprehension surcharge per import above $K$         | `0.05`  |
| $\beta$   | structural blast weight                              | `3`     |
| $\gamma$  | direct cost of a type error, as a multiple of LoC    | `1.2`   |
| $\delta$  | blast-radius amplification of a red file's type cost | `4`     |
| $\lambda$ | max complexity amplification of a file's flaw cost   | `2`     |
| $D_0$     | decision density at half amplification (cc / LoC)    | `0.3`   |

## Limits — what an import graph cannot see

The score is honest about its blind spots; read it as a _relative_ signal, not
an absolute verdict:

- **Deep intra-file complexity** — cyclomatic complexity is now measured
  (decision points in the script) and _amplifies_ a file's flaw cost, but only
  script logic is seen: template branching (`v-if`/`v-for`) and the shape of a
  2000-line `switch` beyond its branch count remain invisible.
- **Real churn** — volatility is proxied by instability ($I$). A frequently
  edited but dependency-free leaf looks stable to the model. True churn needs
  per-file commit history the crawl does not yet collect.
- **Semantic coupling** — event buses, dependency injection, string-keyed
  registries, and dynamic imports the static import scanner misses.
- **Test coverage** — arguably the strongest maintainability signal, and
  entirely invisible to a dependency graph.
