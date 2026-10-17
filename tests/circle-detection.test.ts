import { expect, test } from "bun:test";
import { detectCircles } from "../src/circle-detection";
import { circleScorer, loadCircleSimd } from "../src/circle-score";
import {
  buildProjection,
  DEFAULT_CALIBRATION,
  distance,
} from "../src/geometry";
import {
  circlePixels,
  type FixtureCircle,
  fixtureCircle,
  fixtureProjection,
  glowingCirclePixels,
} from "./circle-fixture";

const wasm = await Bun.file(
  new URL("../src/circle-score.wasm", import.meta.url),
).arrayBuffer();
const simd = await loadCircleSimd(wasm);

function matches(
  actual: ReturnType<typeof detectCircles>,
  expected: FixtureCircle[],
) {
  expect(actual.length).toBe(expected.length);
  for (const circle of expected) {
    const found = actual.find(
      (c) =>
        distance(c.center, circle.center) < circle.radius * 0.04 &&
        Math.abs(c.radiusGround / circle.radius - 1) < 0.04,
    );
    expect(found).toBeDefined();
    expect(
      Math.abs((found?.radiusGround ?? 0) / circle.radius - 1),
    ).toBeLessThan(0.04);
  }
}
test("detects several projected ground circles with color, noise and overlapping outlines", () => {
  const p = fixtureProjection();
  const circles = [
    fixtureCircle(p, 190, 160, 95),
    fixtureCircle(p, 440, 275, 120),
    fixtureCircle(p, 290, 185, 85),
  ];
  const pixels = circlePixels(p, circles, { noise: true });
  const found = detectCircles(pixels, p);
  matches(found, circles);
  expect(detectCircles(pixels, p, simd)).toEqual(found);
});
test("fits a partially occluded circle", () => {
  const p = fixtureProjection(),
    circles = [fixtureCircle(p, 320, 210, 150)];
  matches(
    detectCircles(circlePixels(p, circles, { noise: true, occluded: true }), p),
    circles,
  );
});

test("rejects sparse fragments spread around a circle", () => {
  const p = fixtureProjection();
  const circle = fixtureCircle(p, 320, 210, 200);
  expect(
    detectCircles(circlePixels(p, [circle], { fragmented: true }), p),
  ).toEqual([]);
});

test("refines a broad inner glow onto its thin bright outer rim", () => {
  const p = fixtureProjection();
  const circle = fixtureCircle(p, 320, 210, 95);
  const found = detectCircles(glowingCirclePixels(p, circle), p);
  expect(found.length).toBe(1);
  expect(distance(found[0].center, circle.center) / circle.radius).toBeLessThan(
    0.01,
  );
  expect(Math.abs(found[0].radiusGround / circle.radius - 1)).toBeLessThan(
    0.01,
  );
});

test("preserves dark outlines when no bright rim is present", () => {
  const p = fixtureProjection(),
    circle = fixtureCircle(p, 320, 210, 110);
  const pixels = circlePixels(p, [circle], { noise: true });
  for (let i = 0; i < pixels.data.length; i += 4)
    for (let c = 0; c < 3; c++) pixels.data[i + c] = 255 - pixels.data[i + c];
  matches(detectCircles(pixels, p), [circle]);
});

test("preserves a low-contrast outline with partial occlusion", () => {
  const p = fixtureProjection(),
    circle = fixtureCircle(p, 320, 210, 150);
  const pixels = circlePixels(p, [circle], { occluded: true });
  for (let i = 0; i < pixels.data.length; i += 4)
    if (pixels.data[i + 1] === 245) pixels.data.set([40, 100, 120, 255], i);
  matches(detectCircles(pixels, p), [circle]);
});
test("uses perspective, roll, off-center principal point and cropped game area", () => {
  const p = buildProjection(
    {
      ...DEFAULT_CALIBRATION,
      elevationDegrees: 40,
      verticalFovDegrees: 58,
      rollDegrees: 17,
      principalPoint: { x: 0.45, y: 0.58 },
    },
    { width: 740, height: 500 },
    { x: 50, y: 40, width: 640, height: 420 },
  );
  const circles = [
    fixtureCircle(p, 275, 260, 85),
    fixtureCircle(p, 505, 330, 65),
  ];
  matches(detectCircles(circlePixels(p, circles), p), circles);
});
test("detects concentric circles without duplicating inner/outer stroke edges", () => {
  const p = fixtureProjection(),
    circles = [fixtureCircle(p, 320, 210, 95), fixtureCircle(p, 320, 210, 160)];
  matches(detectCircles(circlePixels(p, circles), p), circles);
});
test("ignores blank images, transparency, straight edges and invalid buffers", () => {
  const p = fixtureProjection();
  for (const options of [
    {},
    { noise: true },
    { noise: true, transparent: true },
    { rectangle: true },
  ])
    expect(detectCircles(circlePixels(p, [], options), p)).toEqual([]);
  expect(() =>
    detectCircles(
      { width: 640, height: 420, data: new Uint8ClampedArray(4) },
      p,
    ),
  ).toThrow();
});
test("SIMD and JavaScript agree for empty, odd, even and grown buffers", async () => {
  expect(simd).toBeDefined();
  for (const length of [0, 1, 3, 20, 10000]) {
    const points = Array.from({ length }, (_, i) => ({
      x: Math.sin(i) * 10,
      y: Math.cos(i * 3) * 10,
      tolerance: 0.1 + (i % 3),
    }));
    const scalar = circleScorer(points),
      vector = circleScorer(points, simd);
    for (const radius of [0.01, 1, 5, 15, 100]) {
      const circle = { x: 1.5, y: -2.5, radius };
      expect(vector(circle)).toBe(scalar(circle));
    }
  }
  expect(await loadCircleSimd(new Uint8Array([0, 1, 2]))).toBeUndefined();
  expect(
    await loadCircleSimd(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
  ).toBeUndefined();
});

test("handles overhead circles and detection pixels scaled from a larger image", () => {
  for (const elevationDegrees of [25.2, 90]) {
    const small = buildProjection(
      { ...DEFAULT_CALIBRATION, elevationDegrees },
      { width: 640, height: 420 },
    );
    const large = buildProjection(
      { ...DEFAULT_CALIBRATION, elevationDegrees },
      { width: 2560, height: 1680 },
    );
    const circles = [fixtureCircle(small, 320, 210, 100)];
    matches(detectCircles(circlePixels(small, circles), large), circles);
  }
});
