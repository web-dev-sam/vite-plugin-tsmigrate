//! Force layout for the tool's radial graph.
//!
//! A port of the exact d3-force configuration the renderer used to run on the
//! main thread: link springs, Barnes–Hut many-body charge, a radial force onto
//! each node's depth ring, x/y anchors towards the folder-wedge seed, and
//! collision — with d3's integration, alpha schedule and LCG jiggle. Every
//! force term matches d3-force 3; only the pair visiting order differs (grid
//! instead of quadtree for collisions), so positions are equivalent, not
//! bit-identical.
//!
//! The module is dependency-free and exposes a raw C ABI (see the bottom of
//! this file): JS fills `input`/`links` through typed-array views over linear
//! memory, calls `sim_load`, then `sim_tick` and reads `out`. Views must be
//! re-created after any call — growing memory detaches the old buffer.

const NONE: u32 = u32::MAX;

// Force parameters (previously inline d3 calls in tool/src/graph/render.ts).
const LINK_DISTANCE: f64 = 24.0;
const LINK_STRENGTH: f64 = 0.04;
const CHARGE: f64 = -10.0;
const CHARGE_DIST_MIN2: f64 = 1.0;
const CHARGE_DIST_MAX2: f64 = 180.0 * 180.0;
const THETA2: f64 = 0.81;
const RADIAL_STRENGTH: f64 = 1.0;
const ANCHOR_STRENGTH: f64 = 0.06;
const COLLIDE_STRENGTH: f64 = 1.0;
const COLLIDE_ITERATIONS: usize = 2;
/// d3 stores `1 - velocityDecay(0.4)`.
const VELOCITY_KEEP: f64 = 0.6;

/// d3's `alphaMin`: the simulation counts as settled below this.
pub const ALPHA_MIN: f64 = 0.001;

/// Per-node stride of the input staging buffer:
/// `x, y, seedX, seedY, ringRadius, collideRadius`.
pub const INPUT_STRIDE: usize = 6;

/// d3-force's `jiggle(lcg)`: a tiny deterministic nudge for coincident points.
#[inline]
fn jiggle(rng: &mut u32) -> f64 {
    *rng = rng.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    (f64::from(*rng) / 4_294_967_296.0 - 0.5) * 1e-6
}

#[derive(Clone, Copy)]
struct Quad {
    child: [u32; 4],
    /// Head of the coincident-point chain (`Sim::next`); NONE when internal or empty.
    point: u32,
    internal: bool,
    /// Charge-weighted centre and summed charge (filled by `accumulate`).
    cx: f64,
    cy: f64,
    value: f64,
}

impl Quad {
    const fn leaf(point: u32) -> Self {
        Self { child: [NONE; 4], point, internal: false, cx: 0.0, cy: 0.0, value: 0.0 }
    }
}

pub struct Sim {
    n: usize,
    x: Vec<f64>,
    y: Vec<f64>,
    vx: Vec<f64>,
    vy: Vec<f64>,
    /// Fixed positions (drag); NaN = free.
    fx: Vec<f64>,
    fy: Vec<f64>,
    sx: Vec<f64>,
    sy: Vec<f64>,
    ring: Vec<f64>,
    radius: Vec<f64>,
    src: Vec<u32>,
    dst: Vec<u32>,
    bias: Vec<f64>,
    alpha: f64,
    alpha_target: f64,
    alpha_decay: f64,
    rng: u32,
    input: Vec<f32>,
    links: Vec<u32>,
    out: Vec<f32>,
    // Scratch, reused across ticks.
    quads: Vec<Quad>,
    next: Vec<u32>,
    stack: Vec<(u32, f64)>,
    cell_of: Vec<u32>,
    cell_start: Vec<u32>,
    cell_fill: Vec<u32>,
    cell_items: Vec<u32>,
}

impl Sim {
    #[must_use]
    pub fn new(n: usize, m: usize) -> Self {
        let z = || vec![0.0; n];
        Self {
            n,
            x: z(),
            y: z(),
            vx: z(),
            vy: z(),
            fx: vec![f64::NAN; n],
            fy: vec![f64::NAN; n],
            sx: z(),
            sy: z(),
            ring: z(),
            radius: z(),
            src: vec![0; m],
            dst: vec![0; m],
            bias: vec![0.0; m],
            alpha: 1.0,
            alpha_target: 0.0,
            alpha_decay: 1.0 - ALPHA_MIN.powf(1.0 / 300.0),
            rng: 1,
            input: vec![0.0; n * INPUT_STRIDE],
            links: vec![0; m * 2],
            out: vec![0.0; n * 2],
            quads: Vec::with_capacity(n * 2 + 1),
            next: vec![NONE; n],
            stack: Vec::new(),
            cell_of: vec![0; n],
            cell_start: Vec::new(),
            cell_fill: Vec::new(),
            cell_items: vec![0; n],
        }
    }

    pub fn input_mut(&mut self) -> &mut [f32] {
        &mut self.input
    }

    pub fn links_mut(&mut self) -> &mut [u32] {
        &mut self.links
    }

    #[must_use]
    pub fn out(&self) -> &[f32] {
        &self.out
    }

    #[must_use]
    pub fn alpha(&self) -> f64 {
        self.alpha
    }

    pub fn set_alpha(&mut self, alpha: f64) {
        self.alpha = alpha;
    }

    pub fn set_alpha_target(&mut self, target: f64) {
        self.alpha_target = target;
    }

    /// Pin node `i` at (x, y) — d3's `fx`/`fy` during a drag.
    pub fn fix(&mut self, i: usize, x: f64, y: f64) {
        self.fx[i] = x;
        self.fy[i] = y;
    }

    pub fn unfix(&mut self, i: usize) {
        self.fx[i] = f64::NAN;
        self.fy[i] = f64::NAN;
    }

    /// Read the staging buffers into the simulation state (d3's initialize).
    /// Panics on an out-of-range link endpoint — the caller maps ids to indices.
    pub fn load(&mut self, alpha: f64) {
        for i in 0..self.n {
            let s = &self.input[i * INPUT_STRIDE..(i + 1) * INPUT_STRIDE];
            self.x[i] = f64::from(s[0]);
            self.y[i] = f64::from(s[1]);
            self.sx[i] = f64::from(s[2]);
            self.sy[i] = f64::from(s[3]);
            self.ring[i] = f64::from(s[4]);
            self.radius[i] = f64::from(s[5]);
            self.vx[i] = 0.0;
            self.vy[i] = 0.0;
            self.fx[i] = f64::NAN;
            self.fy[i] = f64::NAN;
        }
        let mut count = vec![0u32; self.n];
        for (k, &[s, t]) in self.links.as_chunks::<2>().0.iter().enumerate() {
            assert!((s as usize) < self.n && (t as usize) < self.n, "link endpoint out of range");
            self.src[k] = s;
            self.dst[k] = t;
            count[s as usize] += 1;
            count[t as usize] += 1;
        }
        for k in 0..self.src.len() {
            let cs = f64::from(count[self.src[k] as usize]);
            let ct = f64::from(count[self.dst[k] as usize]);
            self.bias[k] = cs / (cs + ct);
        }
        self.alpha = alpha;
        self.alpha_target = 0.0;
        self.rng = 1;
        self.write_out();
    }

    /// Re-read only the collide radii from the input buffer (node sizes changed).
    pub fn reload_radii(&mut self) {
        for i in 0..self.n {
            self.radius[i] = f64::from(self.input[i * INPUT_STRIDE + 5]);
        }
    }

    /// One d3 tick: decay alpha, apply forces in d3's insertion order, integrate.
    pub fn tick(&mut self) {
        self.alpha += (self.alpha_target - self.alpha) * self.alpha_decay;
        let alpha = self.alpha;
        self.force_link(alpha);
        self.force_charge(alpha);
        self.force_radial(alpha);
        self.force_anchor(alpha);
        self.force_collide();
        for i in 0..self.n {
            if self.fx[i].is_nan() {
                self.vx[i] *= VELOCITY_KEEP;
                self.x[i] += self.vx[i];
            } else {
                self.x[i] = self.fx[i];
                self.vx[i] = 0.0;
            }
            if self.fy[i].is_nan() {
                self.vy[i] *= VELOCITY_KEEP;
                self.y[i] += self.vy[i];
            } else {
                self.y[i] = self.fy[i];
                self.vy[i] = 0.0;
            }
        }
    }

    pub fn write_out(&mut self) {
        for i in 0..self.n {
            self.out[i * 2] = self.x[i] as f32;
            self.out[i * 2 + 1] = self.y[i] as f32;
        }
    }

    fn force_link(&mut self, alpha: f64) {
        let Self { x, y, vx, vy, src, dst, bias, rng, .. } = self;
        for k in 0..src.len() {
            let (s, t) = (src[k] as usize, dst[k] as usize);
            let mut dx = x[t] + vx[t] - x[s] - vx[s];
            if dx == 0.0 {
                dx = jiggle(rng);
            }
            let mut dy = y[t] + vy[t] - y[s] - vy[s];
            if dy == 0.0 {
                dy = jiggle(rng);
            }
            let l = (dx * dx + dy * dy).sqrt();
            let l = (l - LINK_DISTANCE) / l * alpha * LINK_STRENGTH;
            dx *= l;
            dy *= l;
            let b = bias[k];
            vx[t] -= dx * b;
            vy[t] -= dy * b;
            vx[s] += dx * (1.0 - b);
            vy[s] += dy * (1.0 - b);
        }
    }

    /// Build the Barnes–Hut quadtree over current positions; returns the root side.
    fn build_quadtree(&mut self) -> f64 {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for i in 0..self.n {
            x0 = x0.min(self.x[i]);
            y0 = y0.min(self.y[i]);
            x1 = x1.max(self.x[i]);
            y1 = y1.max(self.y[i]);
        }
        let w0 = (x1 - x0).max(y1 - y0).max(1.0);
        self.quads.clear();
        self.quads.push(Quad::leaf(NONE));
        self.next.fill(NONE);
        for i in 0..self.n {
            self.insert(i as u32, x0, y0, w0);
        }
        w0
    }

    fn insert(&mut self, i: u32, x0: f64, y0: f64, w0: f64) {
        let (px, py) = (self.x[i as usize], self.y[i as usize]);
        let (mut bx, mut by, mut w) = (x0, y0, w0);
        let mut q = 0usize;
        let mut depth = 0u32;
        loop {
            if self.quads[q].internal {
                w *= 0.5;
                let right = px >= bx + w;
                let bottom = py >= by + w;
                if right {
                    bx += w;
                }
                if bottom {
                    by += w;
                }
                let j = (usize::from(bottom) << 1) | usize::from(right);
                let c = self.quads[q].child[j];
                if c == NONE {
                    self.quads[q].child[j] = self.quads.len() as u32;
                    self.quads.push(Quad::leaf(i));
                    return;
                }
                q = c as usize;
                depth += 1;
                continue;
            }
            let p = self.quads[q].point;
            if p == NONE {
                self.quads[q].point = i;
                return;
            }
            let (qx, qy) = (self.x[p as usize], self.y[p as usize]);
            // Coincident (or numerically inseparable): chain, like d3's `next`.
            if (qx == px && qy == py) || depth >= 52 {
                self.next[i as usize] = p;
                self.quads[q].point = i;
                return;
            }
            // Split the leaf: push its chain one level down, then retry here.
            let h = w * 0.5;
            let j = (usize::from(qy >= by + h) << 1) | usize::from(qx >= bx + h);
            let c = self.quads.len() as u32;
            self.quads.push(Quad::leaf(p));
            let quad = &mut self.quads[q];
            quad.point = NONE;
            quad.internal = true;
            quad.child[j] = c;
        }
    }

    /// Post-order charge/centre accumulation. Children are always pushed after
    /// their parent, so a reverse index walk visits children first.
    fn accumulate(&mut self) {
        for q in (0..self.quads.len()).rev() {
            let quad = self.quads[q];
            let (mut strength, mut weight, mut cx, mut cy) = (0.0, 0.0, 0.0, 0.0);
            if quad.internal {
                for &c in &quad.child {
                    if c == NONE {
                        continue;
                    }
                    let child = &self.quads[c as usize];
                    let a = child.value.abs();
                    if a != 0.0 {
                        strength += child.value;
                        weight += a;
                        cx += a * child.cx;
                        cy += a * child.cy;
                    }
                }
                cx /= weight;
                cy /= weight;
            } else if quad.point != NONE {
                cx = self.x[quad.point as usize];
                cy = self.y[quad.point as usize];
                let mut p = quad.point;
                while p != NONE {
                    strength += CHARGE;
                    p = self.next[p as usize];
                }
            }
            let quad = &mut self.quads[q];
            quad.cx = cx;
            quad.cy = cy;
            quad.value = strength;
        }
    }

    fn force_charge(&mut self, alpha: f64) {
        if self.n == 0 {
            return;
        }
        let w0 = self.build_quadtree();
        self.accumulate();
        let Self { n, x, y, vx, vy, quads, next, stack, rng, .. } = self;
        for i in 0..*n {
            let (xi, yi) = (x[i], y[i]);
            stack.clear();
            stack.push((0, w0));
            while let Some((q, w)) = stack.pop() {
                let quad = &quads[q as usize];
                if quad.value == 0.0 {
                    continue;
                }
                let mut dx = quad.cx - xi;
                let mut dy = quad.cy - yi;
                let mut l = dx * dx + dy * dy;
                // Far enough: treat the whole cell as one body.
                if w * w / THETA2 < l {
                    if l < CHARGE_DIST_MAX2 {
                        if dx == 0.0 {
                            dx = jiggle(rng);
                            l += dx * dx;
                        }
                        if dy == 0.0 {
                            dy = jiggle(rng);
                            l += dy * dy;
                        }
                        if l < CHARGE_DIST_MIN2 {
                            l = (CHARGE_DIST_MIN2 * l).sqrt();
                        }
                        vx[i] += dx * quad.value * alpha / l;
                        vy[i] += dy * quad.value * alpha / l;
                    }
                    continue;
                }
                if quad.internal {
                    for &c in quad.child.iter().rev() {
                        if c != NONE {
                            stack.push((c, w * 0.5));
                        }
                    }
                    continue;
                }
                if l >= CHARGE_DIST_MAX2 {
                    continue;
                }
                let head = quad.point;
                if head as usize != i || next[head as usize] != NONE {
                    if dx == 0.0 {
                        dx = jiggle(rng);
                        l += dx * dx;
                    }
                    if dy == 0.0 {
                        dy = jiggle(rng);
                        l += dy * dy;
                    }
                    if l < CHARGE_DIST_MIN2 {
                        l = (CHARGE_DIST_MIN2 * l).sqrt();
                    }
                }
                let mut p = head;
                while p != NONE {
                    if p as usize != i {
                        let k = CHARGE * alpha / l;
                        vx[i] += dx * k;
                        vy[i] += dy * k;
                    }
                    p = next[p as usize];
                }
            }
        }
    }

    fn force_radial(&mut self, alpha: f64) {
        for i in 0..self.n {
            let dx = if self.x[i] == 0.0 { 1e-6 } else { self.x[i] };
            let dy = if self.y[i] == 0.0 { 1e-6 } else { self.y[i] };
            let r = (dx * dx + dy * dy).sqrt();
            let k = (self.ring[i] - r) * RADIAL_STRENGTH * alpha / r;
            self.vx[i] += dx * k;
            self.vy[i] += dy * k;
        }
    }

    fn force_anchor(&mut self, alpha: f64) {
        let k = ANCHOR_STRENGTH * alpha;
        for i in 0..self.n {
            self.vx[i] += (self.sx[i] - self.x[i]) * k;
            self.vy[i] += (self.sy[i] - self.y[i]) * k;
        }
    }

    /// d3's forceCollide over a uniform grid: cells of twice the largest
    /// radius, so every overlapping pair sits in adjacent cells. Same pair
    /// rule (each pair once, `j > i`), same predicted positions, same
    /// radius-weighted split.
    fn force_collide(&mut self) {
        let n = self.n;
        let rmax = self.radius.iter().copied().fold(0.0, f64::max);
        if n < 2 || rmax <= 0.0 {
            return;
        }
        for _ in 0..COLLIDE_ITERATIONS {
            let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for i in 0..n {
                let (px, py) = (self.x[i] + self.vx[i], self.y[i] + self.vy[i]);
                x0 = x0.min(px);
                y0 = y0.min(py);
                x1 = x1.max(px);
                y1 = y1.max(py);
            }
            if !(x1 - x0).is_finite() || !(y1 - y0).is_finite() {
                return;
            }
            // Cap the grid at ~4 cells per node (sparse, spread-out layouts).
            let mut cell = 2.0 * rmax;
            let (mut cols, mut rows);
            loop {
                cols = ((x1 - x0) / cell) as usize + 1;
                rows = ((y1 - y0) / cell) as usize + 1;
                if cols * rows <= 4 * n + 64 {
                    break;
                }
                cell *= 2.0;
            }
            let cells = cols * rows;
            let cell_index = |px: f64, py: f64| -> (usize, usize) {
                let cx = (((px - x0) / cell) as usize).min(cols - 1);
                let cy = (((py - y0) / cell) as usize).min(rows - 1);
                (cx, cy)
            };
            self.cell_start.clear();
            self.cell_start.resize(cells + 1, 0);
            for i in 0..n {
                let (cx, cy) = cell_index(self.x[i] + self.vx[i], self.y[i] + self.vy[i]);
                let c = cy * cols + cx;
                self.cell_of[i] = c as u32;
                self.cell_start[c + 1] += 1;
            }
            for c in 0..cells {
                self.cell_start[c + 1] += self.cell_start[c];
            }
            self.cell_fill.clear();
            self.cell_fill.extend_from_slice(&self.cell_start);
            for i in 0..n {
                let c = self.cell_of[i] as usize;
                self.cell_items[self.cell_fill[c] as usize] = i as u32;
                self.cell_fill[c] += 1;
            }
            let Self { x, y, vx, vy, radius, cell_start, cell_items, rng, .. } = self;
            for i in 0..n {
                let ri = radius[i];
                let ri2 = ri * ri;
                let xi = x[i] + vx[i];
                let yi = y[i] + vy[i];
                let (cx, cy) = cell_index(xi, yi);
                for gy in cy.saturating_sub(1)..=(cy + 1).min(rows - 1) {
                    for gx in cx.saturating_sub(1)..=(cx + 1).min(cols - 1) {
                        let c = gy * cols + gx;
                        for idx in cell_start[c]..cell_start[c + 1] {
                            let j = cell_items[idx as usize] as usize;
                            if j <= i {
                                continue;
                            }
                            let rj = radius[j];
                            let r = ri + rj;
                            let mut dx = xi - x[j] - vx[j];
                            let mut dy = yi - y[j] - vy[j];
                            let mut l = dx * dx + dy * dy;
                            if l >= r * r {
                                continue;
                            }
                            if dx == 0.0 {
                                dx = jiggle(rng);
                                l += dx * dx;
                            }
                            if dy == 0.0 {
                                dy = jiggle(rng);
                                l += dy * dy;
                            }
                            let len = l.sqrt();
                            let f = (r - len) / len * COLLIDE_STRENGTH;
                            dx *= f;
                            dy *= f;
                            let rj2 = rj * rj;
                            let share = rj2 / (ri2 + rj2);
                            vx[i] += dx * share;
                            vy[i] += dy * share;
                            vx[j] -= dx * (1.0 - share);
                            vy[j] -= dy * (1.0 - share);
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// C ABI for the worker. Every pointer argument is a live `sim_new` handle.

/// d3's `alphaMin`, exported so the worker shares one source of truth.
#[unsafe(no_mangle)]
pub extern "C" fn sim_alpha_min() -> f64 {
    ALPHA_MIN
}

/// # Safety
/// The returned handle must be released with `sim_free`.
#[unsafe(no_mangle)]
pub extern "C" fn sim_new(n: u32, m: u32) -> *mut Sim {
    Box::into_raw(Box::new(Sim::new(n as usize, m as usize)))
}

/// # Safety
/// `s` must come from `sim_new` and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_free(s: *mut Sim) {
    drop(unsafe { Box::from_raw(s) });
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_input(s: *mut Sim) -> *mut f32 {
    unsafe { (*s).input.as_mut_ptr() }
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_links(s: *mut Sim) -> *mut u32 {
    unsafe { (*s).links.as_mut_ptr() }
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_out(s: *mut Sim) -> *const f32 {
    unsafe { (*s).out.as_ptr() }
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_load(s: *mut Sim, alpha: f64) {
    unsafe { (*s).load(alpha) }
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_reload_radii(s: *mut Sim) {
    unsafe { (*s).reload_radii() }
}

/// Run `iterations` ticks, refresh `out`, and return the resulting alpha.
///
/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_tick(s: *mut Sim, iterations: u32) -> f64 {
    let sim = unsafe { &mut *s };
    for _ in 0..iterations {
        sim.tick();
    }
    sim.write_out();
    sim.alpha
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_alpha(s: *mut Sim) -> f64 {
    unsafe { (*s).alpha }
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_set_alpha(s: *mut Sim, alpha: f64) {
    unsafe { (*s).set_alpha(alpha) }
}

/// # Safety
/// `s` must be a live handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_set_alpha_target(s: *mut Sim, target: f64) {
    unsafe { (*s).set_alpha_target(target) }
}

/// # Safety
/// `s` must be a live handle and `i` a node index.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_fix(s: *mut Sim, i: u32, x: f64, y: f64) {
    unsafe { (*s).fix(i as usize, x, y) }
}

/// # Safety
/// `s` must be a live handle and `i` a node index.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sim_unfix(s: *mut Sim, i: u32) {
    unsafe { (*s).unfix(i as usize) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic ring graph: `n` nodes over `rings` depth rings, each node
    /// linked to two pseudo-random others, seeded on its ring like render.ts.
    fn sample(n: usize, rings: usize) -> Sim {
        let mut links = Vec::new();
        let mut s = 7u32;
        for i in 0..n {
            for _ in 0..2 {
                s = s.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let j = (s >> 8) as usize % n;
                if j != i {
                    links.extend([i as u32, j as u32]);
                }
            }
        }
        let mut sim = Sim::new(n, links.len() / 2);
        sim.links_mut().copy_from_slice(&links);
        for i in 0..n {
            let ring = (i % rings) as f64 * 150.0 + 40.0;
            let a = i as f64 / n as f64 * std::f64::consts::TAU;
            let input = &mut sim.input_mut()[i * INPUT_STRIDE..(i + 1) * INPUT_STRIDE];
            let (x, y) = ((a.cos() * ring) as f32, (a.sin() * ring) as f32);
            input.copy_from_slice(&[x, y, x, y, ring as f32, 5.0 + (i % 4) as f32 * 3.0]);
        }
        sim.load(1.0);
        sim
    }

    fn settle(sim: &mut Sim) {
        for _ in 0..340 {
            sim.tick();
        }
        sim.write_out();
    }

    #[test]
    fn settles_onto_rings_without_overlap() {
        let mut sim = sample(600, 6);
        settle(&mut sim);
        assert!(sim.alpha() < ALPHA_MIN);
        let n = sim.n;
        // d3-force 3 on this exact input: mean ring drift 27.5, max 80.7,
        // worst overlap 0.12 — the radial force competes with links/charge.
        let mut drift = 0.0;
        for i in 0..n {
            assert!(sim.x[i].is_finite() && sim.y[i].is_finite());
            let off = (sim.x[i].hypot(sim.y[i]) - sim.ring[i]).abs();
            assert!(off < 100.0, "node {i} drifted {off} off its ring");
            drift += off;
        }
        assert!(drift / (n as f64) < 35.0, "mean ring drift {}", drift / n as f64);
        let mut worst: f64 = 0.0;
        for i in 0..n {
            for j in i + 1..n {
                let d = (sim.x[i] - sim.x[j]).hypot(sim.y[i] - sim.y[j]);
                worst = worst.max(sim.radius[i] + sim.radius[j] - d);
            }
        }
        assert!(worst < 3.0, "residual overlap {worst}");
    }

    #[test]
    fn deterministic() {
        let (mut a, mut b) = (sample(300, 4), sample(300, 4));
        settle(&mut a);
        settle(&mut b);
        assert_eq!(a.out(), b.out());
    }

    #[test]
    fn fixed_nodes_stay_put() {
        let mut sim = sample(100, 3);
        sim.fix(5, 12.5, -7.0);
        sim.set_alpha_target(0.15);
        for _ in 0..30 {
            sim.tick();
        }
        assert_eq!((sim.x[5], sim.y[5]), (12.5, -7.0));
        sim.unfix(5);
        sim.tick();
        assert!(sim.fx[5].is_nan());
    }
}
