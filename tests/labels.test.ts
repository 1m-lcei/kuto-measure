import { expect, test } from "bun:test";
import { imagePoint } from "../src/geometry";
import {
  type LabelLine,
  labelStrokeScorer,
  lineHitsRect,
  loadLabelSimd,
} from "../src/label-score";
import { type Label, layoutLabels } from "../src/labels";
import {
  lineHitsRect as referenceHit,
  layoutLabels as referenceLayout,
  linesOverlap as referenceOverlap,
} from "./labels-reference";

const simd = await loadLabelSimd(
  await Bun.file(
    new URL("../src/label-score.wasm", import.meta.url),
  ).arrayBuffer(),
);
const measure = (text: string) => ({
  width: [...text].length * 8,
  ascent: 10,
  descent: 3,
});
const rect = { x: 20, y: 30, width: 60, height: 40 };
const line = (x: number, y: number, ex: number, ey: number): LabelLine => ({
  start: { x, y },
  end: { x: ex, y: ey },
});
let seed = 0x12345678;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};

test("label SIMD initializes and rejects invalid modules", async () => {
  expect(simd).toBeDefined();
  expect(await loadLabelSimd(new Uint8Array([0, 1, 2]))).toBeUndefined();
  expect(
    await loadLabelSimd(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
  ).toBeUndefined();
});

test("stroke scores preserve clipping, padding, degenerate lines, odd lanes and early exits", () => {
  const edges = [
    line(0, 30, 100, 30),
    line(20, 0, 20, 100),
    line(0, 27, 100, 27),
    line(0, 26.999, 100, 26.999),
    line(80, 70, 80, 70),
    line(100, 100, 100, 100),
    line(0, 0, 0, 0),
    line(50, 50, 50 + 1e-10, 50),
    line(20, 20, 20 + 1e-9, 100),
    line(100, 100, 0, 0),
    line(-1e155, 0, 1e155, 0),
  ];
  for (const l of edges)
    for (const gap of [0, 2, 3])
      expect(lineHitsRect(l, rect, gap)).toBe(referenceHit(l, rect, gap));
  for (const n of [0, 1, 2, 3, 11, 32, 2001]) {
    const lines = Array.from({ length: n }, (_, i) => edges[i % edges.length]);
    const js = labelStrokeScorer(lines, undefined),
      wasm = labelStrokeScorer(lines, simd);
    for (const leader of [null, ...edges]) {
      const expected = lines.reduce(
        (sum, l) =>
          sum +
          (referenceHit(l, rect, 3) ? 4 : 0) +
          (leader && referenceOverlap(leader, l) ? 1 : 0),
        0,
      );
      expect(js(rect, leader, 0, 0, 0, Infinity)).toBe(expected);
      expect(wasm(rect, leader, 0, 0, 0, Infinity)).toBe(expected);
      for (const best of [0, 200, 800, 1000, 2134.1]) {
        const fullScore = 0.1234 * 1000 + (expected + 3) * 200 + 4.5;
        for (const scorer of [js, wasm]) {
          const count = scorer(rect, leader, 3, 0.1234, 4.5, best);
          expect(0.1234 * 1000 + count * 200 + 4.5 >= best).toBe(
            fullScore >= best,
          );
          if (fullScore < best) expect(count).toBe(expected + 3);
        }
      }
    }
  }
});

test("randomized stroke scores agree with the original scalar formulas", () => {
  for (let i = 0; i < 150; i++) {
    const lines = Array.from({ length: i % 33 }, () =>
      line(random() * 200, random() * 200, random() * 200, random() * 200),
    );
    const r = {
      x: random() * 120,
      y: random() * 120,
      width: random() * 80,
      height: random() * 80,
    };
    const leader = line(
      random() * 200,
      random() * 200,
      random() * 200,
      random() * 200,
    );
    const expected = lines.reduce(
      (sum, l) =>
        sum +
        (referenceHit(l, r, 3) ? 4 : 0) +
        (referenceOverlap(leader, l) ? 1 : 0),
      0,
    );
    expect(labelStrokeScorer(lines, simd)(r, leader, 0, 0, 0, Infinity)).toBe(
      expected,
    );
  }
});

test("layouts match the original at different zooms, dense anchors and clipped text", () => {
  for (const zoom of [0.25, 1, 4, 10])
    for (const dense of [false, true]) {
      const labels: Label[] = Array.from({ length: 12 }, (_, i) => ({
        key: `${["pin", "group", "measurement", "reference", "guide"][i % 5]}:${i}`,
        text: i === 11 ? "長い文字👨‍👩‍👧‍👦".repeat(25) : `ラベル${i}`,
        name: "",
        color: "#000",
        anchor: imagePoint(
          dense ? 120 : 15 + random() * 250,
          dense ? 90 : 15 + random() * 160,
        ),
        dx: 10,
        dy: -10,
      }));
      const area = { x: 10, y: 10, width: 280, height: 190 };
      const obstacles = labels.map((l) => ({
        x: l.anchor.x - 16 / zoom,
        y: l.anchor.y - 16 / zoom,
        width: 32 / zoom,
        height: 32 / zoom,
      }));
      const lines = Array.from({ length: 37 }, () =>
        line(random() * 300, random() * 200, random() * 300, random() * 200),
      );
      lines.push(line(100, 100, 100, 100));
      const expected = referenceLayout(
        labels,
        area,
        zoom,
        obstacles,
        measure,
        lines,
      );
      expect(
        layoutLabels(labels, area, zoom, obstacles, measure, lines, null),
      ).toEqual(expected);
      expect(
        layoutLabels(labels, area, zoom, obstacles, measure, lines, simd),
      ).toEqual(expected);
      const nested = labelStrokeScorer([line(0, 0, 200, 200)], simd);
      expect(
        layoutLabels(
          labels,
          area,
          zoom,
          obstacles,
          (text) => {
            nested(rect, null, 0, 0, 0, Infinity);
            return measure(text);
          },
          lines,
          simd,
        ),
      ).toEqual(expected);
    }
});

test("SIMD allocation failure keeps the JavaScript scorer usable", () => {
  const lines = Array.from({ length: 2001 }, () => line(0, 0, 100, 100));
  const limited = {
    memory: new WebAssembly.Memory({ initial: 1, maximum: 1 }),
    count: () => {
      throw new Error("must use fallback");
    },
  };
  expect(labelStrokeScorer(lines, limited)(rect, null, 0, 0, 0, Infinity)).toBe(
    labelStrokeScorer(lines, undefined)(rect, null, 0, 0, 0, Infinity),
  );
});
