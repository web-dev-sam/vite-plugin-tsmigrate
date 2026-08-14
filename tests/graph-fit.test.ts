import { expect, test } from "vite-plus/test";
import { fitTransform } from "../tool/src/graph/render.ts";

// Regression: an empty graph (no nodes) must not produce an invalid
// `translate(NaN,NaN) scale(0)` transform. `Math.min`/`Math.max` over empty
// arrays return +/-Infinity, so the box centre becomes NaN and the browser
// rejects the resulting <g> transform:
//   Error: <g> attribute transform: Expected number, "translate(NaN,NaN) scale(0…"
test("fitTransform returns a finite identity transform for an empty node set", () => {
  const t = fitTransform([], 800, 600);
  expect(t.x).toBe(0);
  expect(t.y).toBe(0);
  expect(t.k).toBe(1);
  expect(t.toString()).not.toContain("NaN");
});

test("fitTransform centres and scales a real bounding box (all finite)", () => {
  const pts = [
    { x: -100, y: -100 },
    { x: 100, y: 100 },
  ];
  const t = fitTransform(pts, 800, 600);
  expect(Number.isFinite(t.x)).toBe(true);
  expect(Number.isFinite(t.y)).toBe(true);
  expect(Number.isFinite(t.k)).toBe(true);
  expect(t.k).toBeGreaterThan(0);
  // The box centre (0,0) maps to the viewport centre (400,300).
  expect(t.applyX(0)).toBeCloseTo(400);
  expect(t.applyY(0)).toBeCloseTo(300);
  expect(t.toString()).not.toContain("NaN");
});

test("fitTransform tolerates a single node (degenerate zero-size box)", () => {
  const t = fitTransform([{ x: 42, y: 42 }], 800, 600);
  expect(Number.isFinite(t.x)).toBe(true);
  expect(Number.isFinite(t.y)).toBe(true);
  expect(Number.isFinite(t.k)).toBe(true);
  expect(t.k).toBeGreaterThan(0);
  expect(t.toString()).not.toContain("NaN");
});
