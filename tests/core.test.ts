import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import rangeCalibration from "../docs/calibration/range-2026-09-26.json";
import {
  buildProjection,
  circlePoint,
  clientPoint,
  clientToImage,
  DEFAULT_CALIBRATION,
  distance,
  gameDistance,
  groundLength,
  groundPoint,
  groundToImage,
  imagePoint,
  imageToClient,
  imageToGround,
  projectCircle,
} from "../src/geometry";
import { type Label, layoutLabels, overlapArea } from "../src/labels";
import {
  type AnalysisDocument,
  applyEdit,
  automaticRenderArea,
  centroid,
  commit,
  documentFromPreset,
  type Endpoint,
  emptyDocument,
  formatDistance,
  measuredDistance,
  newHistory,
  parseReferencePreset,
  redo,
  referencePreset,
  resolveCenter,
  scaleFactor,
  undo,
  validateRenderArea,
} from "../src/model";
import { fitProjectArea, parseProject, serializeProject } from "../src/project";
import { renderAnnotations } from "../src/render";

test("editing JSON roundtrips, rejects malformed data, and fits smaller images", () => {
  const size = { width: 1536, height: 900 };
  let doc = {
    ...populated(),
    renderArea: {
      bounds: { x: 12, y: 90, width: 1500, height: 708 },
      source: "manual" as const,
      confirmed: true,
    },
  } as AnalysisDocument;
  doc = applyEdit(doc, {
    type: "measurement",
    value: { id: "m", from: endpoint("a"), to: { kind: "group", id: "g" } },
  });
  for (const [id, center] of [
    ["free", { kind: "point", point: groundPoint(0.1, 0.1) }],
    ["linked", endpoint("b")],
  ] as const)
    doc = applyEdit(doc, {
      type: "guide",
      value: { id, center, radiusGame: gameDistance(100) },
    });
  const raw = serializeProject(doc, size);
  expect(parseProject(raw)).toEqual({ imageSize: size, document: doc });
  expect(
    parseProject(serializeProject(emptyDocument(), size)).document,
  ).toEqual(emptyDocument());
  expect(fitProjectArea(doc, size, size)).toBe(doc);
  const small = { width: 768, height: 450 };
  const fitted = fitProjectArea(doc, size, small);
  expect(fitted.renderArea?.bounds).toEqual({
    x: 6,
    y: 45,
    width: 750,
    height: 354,
  });
  expect(fitted.renderArea?.confirmed).toBe(false);
  expect(fitted.pins).toBe(doc.pins);
  buildProjection(fitted.calibration, small, fitted.renderArea?.bounds);
  const tiny = fitProjectArea(doc, size, { width: 1, height: 1 });
  assert(tiny.renderArea);
  validateRenderArea(tiny.renderArea.bounds, { width: 1, height: 1 });
  expect(undo(commit(newHistory(doc), fitted)).present).toEqual(doc);
  for (const mutate of [
    (v: ReturnType<typeof JSON.parse>) => {
      v.version = 2;
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.imageSize.width = 0;
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.pins[0].point.x = "0";
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.pins[0].groupId = "missing";
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.pins.push(v.document.pins[0]);
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.measurements[0].from.kind = "reference";
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.guides[0].radiusGame = -1;
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.reference.radiusGround = 0;
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.calibration.verticalFovDegrees = 180;
    },
    (v: ReturnType<typeof JSON.parse>) => {
      v.document.renderArea.bounds.width = 2000;
    },
  ]) {
    const value = JSON.parse(raw);
    mutate(value);
    expect(() => parseProject(JSON.stringify(value))).toThrow("編集JSON");
  }
  for (const value of [
    "{",
    "null",
    "[]",
    "{}",
    raw.replace('"x": 0', '"x": 1e400'),
  ])
    expect(() => parseProject(value)).toThrow("編集JSON");
});

test("saved references are validated, portable across resolution/borders, and reset atomically", () => {
  const original = populated(),
    preset = referencePreset(original);
  const roundtrip = parseReferencePreset(
    JSON.stringify({ ...preset, pins: original.pins }),
  );
  expect(roundtrip).toEqual(preset);
  expect(Object.keys(roundtrip)).toEqual([
    "version",
    "calibration",
    "reference",
  ]);
  const area = { x: 40, y: 100, width: 3072, height: 1418 };
  const restored = documentFromPreset(
    roundtrip,
    { width: 3152, height: 1618 },
    area,
  );
  expect(restored.pins).toEqual([]);
  expect(scaleFactor(restored)).toBe(scaleFactor(original));
  const p = buildProjection(
    restored.calibration,
    { width: 3152, height: 1618 },
    area,
  );
  for (const pin of original.pins) {
    const a = groundToImage(pin.point, projection),
      b = groundToImage(pin.point, p);
    assert(a && b);
    pointClose(b, { x: a.x * 2 + 40, y: a.y * 2 + 100 });
  }
  const changed = applyEdit(original, {
    type: "calibration",
    value: { ...DEFAULT_CALIBRATION, elevationDegrees: 35, rollDegrees: 7 },
    size: projection.size,
    renderArea: projection.renderArea,
  });
  const changedProjection = buildProjection(
    changed.calibration,
    projection.size,
  );
  const reset = applyEdit(changed, {
    type: "reset-reference",
    size: projection.size,
    renderArea: projection.renderArea,
  });
  expect(reset.reference).toBeNull();
  expect(reset.calibration).toEqual(DEFAULT_CALIBRATION);
  for (const [i, pin] of changed.pins.entries()) {
    const before = groundToImage(pin.point, changedProjection);
    assert(before);
    pointClose(groundToImage(reset.pins[i].point, projection), before);
  }
  const h = commit(newHistory(changed), reset);
  expect(h.past).toHaveLength(1);
  expect(undo(h).present).toEqual(changed);
  expect(redo(undo(h)).present).toEqual(reset);
  expect(referencePreset(original)).toEqual(preset);
  const bad = {
    ...changed,
    pins: [{ ...changed.pins[0], point: groundPoint(0, 100000) }],
  };
  expect(() =>
    applyEdit(bad, {
      type: "reset-reference",
      size: projection.size,
      renderArea: projection.renderArea,
    }),
  ).toThrow();
  expect(bad.reference).toBe(changed.reference);
  const offscreen = {
    ...preset,
    reference: { ...preset.reference, center: groundPoint(100, 0) },
  };
  expect(() =>
    documentFromPreset(offscreen, projection.size, projection.renderArea),
  ).toThrow();
  for (const raw of [
    "{",
    "null",
    "[]",
    JSON.stringify({ ...preset, version: 2 }),
    ...[
      { ...preset.reference, radiusGame: null },
      { ...preset.reference, radiusGame: "500" },
      { ...preset.reference, radiusGround: 0 },
      { ...preset.reference, radiusGame: 1e308, radiusGround: 1e-308 },
      { ...preset.reference, center: { x: 0, y: 0, space: "image" } },
    ].map((reference) => JSON.stringify({ ...preset, reference })),
    JSON.stringify({
      ...preset,
      calibration: { ...preset.calibration, elevationDegrees: 0 },
    }),
  ]) {
    expect(() => parseReferencePreset(raw)).toThrow();
  }
});

test("label packing separates coincident and nearby labels without moving anchors and is bounded", () => {
  const measure = (text: string) => ({
    width:
      [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)]
        .length * 12,
    ascent: 10,
    descent: 3,
  });
  const labels: Label[] = Array.from({ length: 5 }, (_, i) => ({
    key: `pin:${i}`,
    text: `ピン${i}`,
    name: `ピン ${i}`,
    color: "#fff",
    anchor: imagePoint(400, 300),
    dx: 10,
    dy: -10,
  }));
  labels.push({
    ...labels[0],
    key: "group:g",
    text: "近くのグループ",
    anchor: imagePoint(430, 300),
  });
  const before = JSON.stringify(labels),
    area = { x: 0, y: 0, width: 800, height: 600 };
  const obstacles = [{ x: 384, y: 284, width: 32, height: 32 }];
  const result = layoutLabels(labels, area, 1, obstacles, measure);
  expect(result.crowded).toBe(false);
  expect(result.boxes).toHaveLength(6);
  result.boxes.forEach((box, i) => {
    expect(box.x).toBeGreaterThanOrEqual(4);
    expect(box.y).toBeGreaterThanOrEqual(4);
    expect(box.x + box.width).toBeLessThanOrEqual(796);
    expect(box.y + box.height).toBeLessThanOrEqual(596);
    for (const other of result.boxes.slice(i + 1))
      expect(overlapArea(box, other, 4)).toBe(0);
    for (const obstacle of obstacles)
      expect(overlapArea(box, obstacle, 4)).toBe(0);
  });
  expect(layoutLabels(labels, area, 1, obstacles, measure)).toEqual(result);
  expect(JSON.stringify(labels)).toBe(before);
  for (const anchor of [
    imagePoint(0, 0),
    imagePoint(800, 0),
    imagePoint(0, 600),
    imagePoint(800, 600),
  ]) {
    const edge = layoutLabels([{ ...labels[0], anchor }], area, 1, [], measure);
    expect(edge.crowded).toBe(false);
    expect(edge.boxes[0].x).toBeGreaterThanOrEqual(4);
    expect(edge.boxes[0].x + edge.boxes[0].width).toBeLessThanOrEqual(796);
  }
  const emoji = "👨‍👩‍👧‍👦";
  const long = layoutLabels(
    [{ ...labels[0], text: emoji.repeat(30) }],
    { ...area, width: 100 },
    1,
    [],
    measure,
  );
  expect(long.boxes[0].text).toMatch(/^(👨‍👩‍👧‍👦)*…$/u);
  expect(
    layoutLabels(labels, { ...area, width: 1, height: 1 }, 1, [], measure)
      .crowded,
  ).toBe(true);
  expect(
    layoutLabels(labels, { ...area, width: 70, height: 70 }, 1, [], measure)
      .crowded,
  ).toBe(true);
});

const projection = buildProjection(DEFAULT_CALIBRATION, {
  width: 1536,
  height: 709,
});
const close = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
const pointClose = (
  a: { x: number; y: number } | null,
  b: { x: number; y: number },
) => {
  expect(a).not.toBeNull();
  if (a) {
    close(a.x, b.x);
    close(a.y, b.y);
  }
};
const endpoint = (id: string): Endpoint => ({ kind: "pin", id });
function populated(): AnalysisDocument {
  let d = emptyDocument();
  d = applyEdit(d, { type: "group", value: { id: "g", name: "G" } });
  for (const [id, x, y, groupId] of [
    ["a", 0, 0, "g"],
    ["b", 0.2, 0.4, "g"],
    ["c", 0.3, 0.4, null],
  ] as const)
    d = applyEdit(d, {
      type: "pin",
      value: { id, name: id, point: groundPoint(x, y), groupId },
    });
  return applyEdit(d, {
    type: "reference",
    value: {
      center: groundPoint(0, 0),
      radiusGround: groundLength(0.2),
      radiusGame: gameDistance(500),
    },
  });
}
test("game area edits preserve anchors, update distances and restore bounds and state together", () => {
  const size = { width: 1536, height: 900 };
  const full = { x: 0, y: 0, ...size };
  const bounds = { x: 12, y: 90, width: 1500, height: 709 };
  const doc = applyEdit(
    applyEdit(
      { ...populated(), renderArea: automaticRenderArea(size, full) },
      {
        type: "guide",
        value: {
          id: "free",
          center: { kind: "point", point: groundPoint(0.1, 0.1) },
          radiusGame: gameDistance(100),
        },
      },
    ),
    {
      type: "measurement",
      value: { id: "m", from: endpoint("a"), to: endpoint("b") },
    },
  );
  const edit = {
    type: "render-area" as const,
    value: { bounds, source: "manual" as const, confirmed: true },
    size,
    renderArea: full,
  };
  const next = applyEdit(doc, edit);
  const before = buildProjection(doc.calibration, size, full);
  const after = buildProjection(next.calibration, size, bounds);
  expect(doc.renderArea?.source).toBe("fallback");
  expect(automaticRenderArea(size, bounds).source).toBe("auto");
  expect(next.renderArea).toEqual(edit.value);
  assert(doc.reference && next.reference);
  for (let i = 0; i < doc.pins.length; i++) {
    const image = groundToImage(doc.pins[i].point, before);
    assert(image);
    pointClose(groundToImage(next.pins[i].point, after), image);
  }
  const oldFree = resolveCenter(doc, doc.guides[0].center);
  const newFree = resolveCenter(next, next.guides[0].center);
  assert(oldFree && newFree);
  const oldFreeImage = groundToImage(oldFree, before);
  const oldCenter = groundToImage(doc.reference.center, before);
  const oldRim = groundToImage(
    circlePoint(doc.reference.center, doc.reference.radiusGround, 0),
    before,
  );
  assert(oldFreeImage && oldCenter && oldRim);
  pointClose(groundToImage(newFree, after), oldFreeImage);
  pointClose(groundToImage(next.reference.center, after), oldCenter);
  const newRim = imageToGround(oldRim, after);
  assert(newRim);
  close(next.reference.radiusGround, distance(next.reference.center, newRim));
  expect(next.reference.radiusGame).toBe(doc.reference.radiusGame);
  expect(next.guides[0].radiusGame).toBe(doc.guides[0].radiusGame);
  expect(next.measurements).toBe(doc.measurements);
  expect(next.groups).toBe(doc.groups);
  expect(measuredDistance(next, next.measurements[0])).not.toBe(
    measuredDistance(doc, doc.measurements[0]),
  );
  const history = commit(newHistory(doc), next);
  expect(undo(history).present).toEqual(doc);
  expect(redo(undo(history)).present).toEqual(next);
  expect(applyEdit(next, edit)).toBe(next);
  const confirmed = applyEdit(doc, {
    ...edit,
    value: { bounds: full, source: "full", confirmed: true },
  });
  expect(confirmed.pins).toBe(doc.pins);
  expect(confirmed.reference).toBe(doc.reference);
  expect(confirmed.renderArea?.source).toBe("full");
  expect(
    undo(commit(newHistory(doc), confirmed)).present.renderArea?.source,
  ).toBe("fallback");
  const preset = referencePreset(next);
  expect(preset).not.toHaveProperty("renderArea");
  expect(documentFromPreset(preset, size, bounds).renderArea).toBeNull();
  const reset = applyEdit(next, {
    type: "reset-reference",
    size,
    renderArea: full,
  });
  expect(reset.renderArea).toBe(next.renderArea);
  expect(reset.pins).toBe(next.pins);
  for (const invalid of [
    { ...bounds, x: -1 },
    { ...bounds, y: NaN },
    { ...bounds, x: 0.5 },
    { ...bounds, width: Infinity },
    { ...bounds, width: 0 },
    { ...bounds, height: 0 },
    { ...bounds, height: size.height },
    { ...bounds, width: size.width },
  ]) {
    expect(() => validateRenderArea(invalid, size)).toThrow();
    expect(() =>
      applyEdit(doc, { ...edit, value: { ...edit.value, bounds: invalid } }),
    ).toThrow();
  }
  const snapshot = JSON.stringify(doc);
  expect(() =>
    applyEdit(doc, {
      ...edit,
      value: {
        ...edit.value,
        bounds: { x: 0, y: 899, width: 1536, height: 1 },
      },
    }),
  ).toThrow();
  expect(JSON.stringify(doc)).toBe(snapshot);
  const render = (interactive: boolean) =>
    renderAnnotations(next, after, {
      zoom: 1,
      selection: null,
      interactive,
      areaPreview: full,
      measureLabel: (text) => ({
        width: text.length * 7,
        ascent: 9,
        descent: 3,
      }),
    }).markup;
  expect(render(true)).toContain('class="area-preview"');
  expect(render(false)).not.toContain('class="area-preview"');
  expect(render(false)).not.toContain('class="excluded-boundary"');
  expect(render(false)).toContain(`x="12" y="90" width="1500" height="709"`);
});

test("confirming automatic and fallback areas preserves geometry and participates in history", () => {
  const size = { width: 1536, height: 900 };
  for (const bounds of [
    { x: 0, y: 0, ...size },
    { x: 0, y: 90, width: 1536, height: 720 },
  ]) {
    const doc = {
      ...populated(),
      renderArea: automaticRenderArea(size, bounds),
    };
    expect(doc.renderArea.confirmed).toBe(false);
    const next = applyEdit(doc, { type: "confirm-area" });
    expect(next.renderArea?.confirmed).toBe(true);
    expect(next.renderArea?.bounds).toBe(bounds);
    expect(next.renderArea?.source).toBe(doc.renderArea.source);
    expect(next.pins).toBe(doc.pins);
    expect(next.reference).toBe(doc.reference);
    expect(referencePreset(next)).toEqual(referencePreset(doc));
    expect(applyEdit(next, { type: "confirm-area" })).toBe(next);
    const history = commit(newHistory(doc), next);
    expect(undo(history).present).toEqual(doc);
    expect(redo(undo(history)).present).toEqual(next);
  }
});

test("calibration preserves image anchors, recalculates distances, and undoes atomically", () => {
  const doc = applyEdit(
    applyEdit(populated(), {
      type: "guide",
      value: {
        id: "free",
        center: { kind: "point", point: groundPoint(0.1, 0.1) },
        radiusGame: gameDistance(100),
      },
    }),
    {
      type: "measurement",
      value: { id: "m", from: endpoint("a"), to: endpoint("b") },
    },
  );
  const value = {
    elevationDegrees: 35,
    verticalFovDegrees: 12,
    rollDegrees: 7,
    principalPoint: { x: 0.48, y: 0.55 },
  };
  const size = { width: 1536, height: 900 };
  const renderArea = { x: 0, y: 90, width: 1536, height: 709 };
  const before = buildProjection(doc.calibration, size, renderArea);
  const after = buildProjection(value, size, renderArea);
  const edit = { type: "calibration" as const, value, size, renderArea };
  const next = applyEdit(doc, edit);
  assert(doc.reference && next.reference);
  for (let i = 0; i < doc.pins.length; i++) {
    const image = groundToImage(doc.pins[i].point, before);
    assert(image);
    pointClose(groundToImage(next.pins[i].point, after), image);
  }
  const oldCenter = resolveCenter(doc, doc.guides[0].center);
  const newCenter = resolveCenter(next, next.guides[0].center);
  assert(oldCenter && newCenter);
  const centerImage = groundToImage(oldCenter, before);
  const referenceImage = groundToImage(doc.reference.center, before);
  const rimImage = groundToImage(
    circlePoint(doc.reference.center, doc.reference.radiusGround, 0),
    before,
  );
  assert(centerImage && referenceImage && rimImage);
  pointClose(groundToImage(newCenter, after), centerImage);
  pointClose(groundToImage(next.reference.center, after), referenceImage);
  const rim = imageToGround(rimImage, after);
  assert(rim);
  close(next.reference.radiusGround, distance(next.reference.center, rim));
  expect(next.reference.radiusGame).toBe(doc.reference.radiusGame);
  expect(next.guides[0].radiusGame).toBe(doc.guides[0].radiusGame);
  expect(measuredDistance(next, next.measurements[0])).not.toBe(
    measuredDistance(doc, doc.measurements[0]),
  );
  const history = commit(newHistory(doc), next);
  expect(undo(history).present).toEqual(doc);
  expect(redo(undo(history)).present).toEqual(next);
  expect(applyEdit(next, edit)).toBe(next);
  expect(
    applyEdit(doc, {
      ...edit,
      value: {
        elevationDegrees: 25.2,
        verticalFovDegrees: 9.92,
        rollDegrees: 0,
        principalPoint: { x: 0.5, y: 0.5 },
      },
    }),
  ).toBe(doc);
  for (const invalid of [
    { ...value, elevationDegrees: 0 },
    { ...value, elevationDegrees: 91 },
    { ...value, verticalFovDegrees: 180 },
    { ...value, rollDegrees: Number.NaN },
    { ...value, principalPoint: { x: 1.1, y: 0.5 } },
    { ...value, elevationDegrees: 0.01, principalPoint: { x: 0.5, y: 1 } },
  ])
    expect(() => applyEdit(doc, { ...edit, value: invalid })).toThrow();
  expect(doc.calibration).toEqual(DEFAULT_CALIBRATION);
});

describe("perspective geometry", () => {
  test("resolution-independent camera has an orthonormal ground basis", () => {
    close(
      projection.e1.reduce((sum, x, i) => sum + x * projection.e2[i], 0),
      0,
    );
    close((2 * Math.atan(709 / (2 * projection.focal)) * 180) / Math.PI, 9.92);
    close(Math.hypot(...projection.e1), 1);
    close(Math.hypot(...projection.e2), 1);
    close((Math.asin(projection.normal[2]) * 180) / Math.PI, 25.2);
  });
  test("round trips across the image and resized resolutions", () => {
    for (const width of [768, 1536, 1920, 3072]) {
      const height = Math.round((width * 709) / 1536),
        p = buildProjection(DEFAULT_CALIBRATION, { width, height });
      for (const [x, y] of [
        [0, 0],
        [1, 1],
        [0.5, 0.5],
        [0.1, 0.9],
        [0.9, 0.1],
      ]) {
        const i = imagePoint(x * width, y * height),
          g = imageToGround(i, p);
        expect(g).not.toBeNull();
        if (!g) continue;
        pointClose(groundToImage(g, p), i);
        const back = groundToImage(g, p);
        if (back) pointClose(imageToGround(back, p), g);
      }
    }
  });
  test("equal ground segments differ in image length", () => {
    const lengths = [100, 600].map((y) => {
      const a = imageToGround(imagePoint(400, y), projection);
      if (!a) throw Error("missing ground");
      const b = groundPoint(a.x + 0.1, a.y),
        imageA = groundToImage(a, projection),
        imageB = groundToImage(b, projection);
      if (!imageA || !imageB) throw Error("missing image");
      const backA = imageToGround(imageA, projection),
        backB = imageToGround(imageB, projection);
      if (!backA || !backB) throw Error("missing inverse");
      close(distance(backA, backB), 0.1);
      return Math.hypot(imageA.x - imageB.x, imageA.y - imageB.y);
    });
    expect(lengths[1] / lengths[0]).toBeGreaterThan(1.2);
  });
  test("projected circles remain true ground circles, with bounded subdivision", () => {
    for (const center of [groundPoint(0, 0), groundPoint(0.2, -0.3)]) {
      const result = projectCircle(center, 0.15, projection, 0.25);
      expect(result).not.toBeNull();
      if (!result) continue;
      expect(result.points.length).toBeLessThanOrEqual(4096);
      expect(result.limited).toBe(false);
      for (const point of result.points) {
        const g = imageToGround(point, projection);
        if (!g) throw Error("missing ground");
        close(distance(g, center), 0.15);
      }
    }
    expect(
      projectCircle(groundPoint(0, 0), 0.2, projection, 1e-12)?.limited,
    ).toBe(true);
    expect(projectCircle(groundPoint(0, 0), 100, projection, 0.25)).toBeNull();
  });
  test("zoom, pan and client layout affect no ground data", () => {
    const doc = populated(),
      serialized = JSON.stringify(doc),
      g = doc.pins[0].point,
      i = groundToImage(g, projection);
    if (!i) throw Error("missing image");
    for (const zoom of [0.1, 0.7, 1, 10])
      for (const [x, y] of [
        [0, 0],
        [-1234, 578],
        [91, 75],
      ]) {
        const v = { origin: clientPoint(x, y), zoom };
        const back = clientToImage(imageToClient(i, v), v);
        pointClose(back, i);
        pointClose(imageToGround(back, projection), g);
        expect(
          measuredDistance(doc, {
            id: "m",
            from: endpoint("a"),
            to: endpoint("c"),
          }),
        ).toBe(1250);
      }
    expect(JSON.stringify(doc)).toBe(serialized);
  });
  test("resizing, letterboxing and horizontal cropping preserve ground geometry", () => {
    const source = { width: 1536, height: 709 };
    const g = groundPoint(0.1, 0.2);
    const original = groundToImage(g, projection);
    if (!original) throw Error("missing image");
    for (const scale of [0.5, 1, 2.5]) {
      const area = {
        x: 40,
        y: 80,
        width: source.width * scale,
        height: source.height * scale,
      };
      const size = { width: area.width + 80, height: area.height + 160 };
      const p = buildProjection(DEFAULT_CALIBRATION, size, area);
      const expected = imagePoint(
        original.x * scale + area.x,
        original.y * scale + area.y,
      );
      pointClose(groundToImage(g, p), expected);
      pointClose(imageToGround(expected, p), g);
    }
    for (const size of [
      { width: 1000, height: 709 },
      { width: 2100, height: 709 },
    ]) {
      const p = buildProjection(DEFAULT_CALIBRATION, size);
      pointClose(p.principal, imagePoint(size.width / 2, size.height / 2));
      close(p.focal, projection.focal);
      pointClose(
        groundToImage(g, p),
        imagePoint(original.x + (size.width - source.width) / 2, original.y),
      );
    }
  });
  test("calibrated circle follows independent pixels sampled from the game range edge", () => {
    const p = buildProjection(
      DEFAULT_CALIBRATION,
      rangeCalibration.imageSize,
      rangeCalibration.renderArea,
    );
    const center = imageToGround(
      imagePoint(
        rangeCalibration.circleCenter.x,
        rangeCalibration.circleCenter.y,
      ),
      p,
    );
    if (!center) throw Error("missing center");
    const circle = projectCircle(
      center,
      rangeCalibration.radiusGround,
      p,
      0.05,
    );
    if (!circle) throw Error("missing circle");
    const errors = rangeCalibration.arcPoints.map(([x, y]) => {
      return Math.min(
        ...circle.points.map((a, i) => {
          const b = circle.points[(i + 1) % circle.points.length];
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy),
            ),
          );
          return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
        }),
      );
    });
    expect(
      Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length),
    ).toBeLessThan(2);
    expect(Math.max(...errors)).toBeLessThan(8);
  });
  test("invalid calibration, inputs, horizon and back-plane are rejected", () => {
    expect(() =>
      buildProjection(DEFAULT_CALIBRATION, { width: 0, height: 1080 }),
    ).toThrow();
    expect(() =>
      buildProjection(
        {
          ...DEFAULT_CALIBRATION,
          verticalFovDegrees: 180,
        },
        { width: 1536, height: 709 },
      ),
    ).toThrow();
    expect(() =>
      buildProjection(
        { ...DEFAULT_CALIBRATION, principalPoint: imagePoint(Number.NaN, 0) },
        { width: 1536, height: 709 },
      ),
    ).toThrow();
    expect(imageToGround(imagePoint(0, -100000), projection)).toBeNull();
    for (const change of [
      { elevationDegrees: 0 },
      { elevationDegrees: 91 },
      { rollDegrees: Number.NaN },
    ])
      expect(() =>
        buildProjection(
          { ...DEFAULT_CALIBRATION, ...change },
          { width: 1536, height: 709 },
        ),
      ).toThrow();
    expect(() =>
      buildProjection(
        DEFAULT_CALIBRATION,
        { width: 100, height: 100 },
        { x: 0, y: 90, width: 100, height: 20 },
      ),
    ).toThrow();
    expect(groundToImage(groundPoint(0, 1000), projection)).toBeNull();
    expect(groundToImage(groundPoint(Infinity, 0), projection)).toBeNull();
    for (const n of [0, -1, Infinity, Number.NaN]) {
      expect(() => groundLength(n)).toThrow();
      expect(() => gameDistance(n)).toThrow();
    }
  });
});
describe("analysis and editing", () => {
  test("distance labels always show four relative or two calibrated decimals", () => {
    const calibrated = populated();
    const relative = applyEdit(calibrated, { type: "reference", value: null });
    expect(formatDistance(1.234567, relative)).toBe("1.2346");
    expect(formatDistance(1.234567, calibrated)).toBe("1.23");
    expect(formatDistance(0.0001, relative)).toBe("0.0001");
    expect(formatDistance(1.999, calibrated)).toBe("2.00");
    expect(formatDistance(1, relative)).toBe("1.0000");
    expect(formatDistance(0, calibrated)).toBe("0.00");
    expect(formatDistance(0, relative)).toBe("0.0000");
    expect(formatDistance(null, calibrated)).toBe("距離スケール未設定");
    if (!calibrated.reference) throw Error("reference");
    const unset = applyEdit(calibrated, {
      type: "reference",
      value: { ...calibrated.reference, radiusGame: null },
    });
    expect(formatDistance(1.234567, unset)).toBe("1.2346");
  });
  test("uncalibrated measurements use the first line as one and follow edits", () => {
    const calibrated = populated();
    let doc = applyEdit(calibrated, { type: "reference", value: null });
    expect(scaleFactor(doc)).toBeNull();
    for (const [id, to] of [
      ["first", "b"],
      ["second", "c"],
    ])
      doc = applyEdit(doc, {
        type: "measurement",
        value: { id, from: endpoint("a"), to: endpoint(to) },
      });
    close(measuredDistance(doc, doc.measurements[0]) ?? -1, 1);
    close(
      measuredDistance(doc, doc.measurements[1]) ?? -1,
      0.5 / Math.hypot(0.2, 0.4),
    );
    const moved = applyEdit(doc, {
      type: "pin",
      value: { ...doc.pins[1], point: groundPoint(0, 1) },
    });
    close(measuredDistance(moved, moved.measurements[0]) ?? -1, 1);
    close(measuredDistance(moved, moved.measurements[1]) ?? -1, 0.5);
    const deleted = applyEdit(doc, {
      type: "delete",
      target: { kind: "measurement", id: "first" },
    });
    close(measuredDistance(deleted, deleted.measurements[0]) ?? -1, 1);
    const restored = undo(commit(newHistory(doc), deleted)).present;
    expect(scaleFactor(restored)).toBe(scaleFactor(doc));
    const zero = applyEdit(doc, {
      type: "pin",
      value: { ...doc.pins[1], point: doc.pins[0].point },
    });
    expect(scaleFactor(zero)).toBeNull();
    const pinned = applyEdit(doc, {
      type: "reference",
      value: calibrated.reference,
    });
    expect(scaleFactor(pinned)).toBe(2500);
    if (!pinned.reference) throw Error("reference");
    const unset = applyEdit(pinned, {
      type: "reference",
      value: { ...pinned.reference, radiusGame: null },
    });
    expect(scaleFactor(unset)).toBe(scaleFactor(doc));
    const grouped = applyEdit(doc, {
      type: "measurement",
      value: { ...doc.measurements[0], to: { kind: "group", id: "g" } },
    });
    close(measuredDistance(grouped, grouped.measurements[0]) ?? -1, 1);
    const empty = {
      ...grouped,
      pins: grouped.pins.map((p) => ({ ...p, groupId: null })),
    };
    expect(scaleFactor(empty)).toBeNull();
    expect(
      renderAnnotations(doc, projection, {
        zoom: 1,
        selection: null,
        interactive: false,
        measureLabel: (text) => ({
          width: text.length * 8,
          ascent: 10,
          descent: 3,
        }),
      }).markup,
    ).not.toContain("距離スケール未設定");
  });
  test("scale follows reference values, not pin or guide coordinates", () => {
    let doc = populated();
    doc = applyEdit(doc, {
      type: "guide",
      value: { id: "q", center: endpoint("a"), radiusGame: gameDistance(350) },
    });
    expect(scaleFactor(doc)).toBe(2500);
    if (!doc.reference) throw Error("reference");
    const changed = applyEdit(doc, {
      type: "reference",
      value: { ...doc.reference, radiusGame: gameDistance(1000) },
    });
    expect(scaleFactor(changed)).toBe(5000);
    if (!changed.reference) throw Error("reference");
    expect(changed.pins).toBe(doc.pins);
    expect(Number(changed.guides[0].radiusGame)).toBe(350);
    expect(
      scaleFactor(
        applyEdit(changed, {
          type: "reference",
          value: { ...changed.reference, radiusGround: groundLength(0.4) },
        }),
      ),
    ).toBe(2500);
    const removed = applyEdit(doc, {
      type: "delete",
      target: { kind: "reference" },
    });
    expect(scaleFactor(removed)).toBeNull();
    expect(removed.guides).toEqual(doc.guides);
  });
  test("ground means update after movement and membership changes", () => {
    const doc = populated();
    pointClose(centroid(doc, "g"), groundPoint(0.1, 0.2));
    const moved = applyEdit(doc, {
      type: "pin",
      value: { ...doc.pins[0], point: groundPoint(0.4, 0.8) },
    });
    pointClose(centroid(moved, "g"), groundPoint(0.3, 0.6));
    const detached = applyEdit(moved, {
      type: "pin",
      value: { ...moved.pins[0], groupId: null },
    });
    pointClose(centroid(detached, "g"), doc.pins[1].point);
    const empty = applyEdit(detached, {
      type: "pin",
      value: { ...detached.pins[1], groupId: null },
    });
    expect(centroid(empty, "g")).toBeNull();
  });
  test("all endpoint combinations and attached guides resolve dynamically", () => {
    let doc = populated();
    doc = applyEdit(doc, { type: "group", value: { id: "h", name: "H" } });
    doc = applyEdit(doc, {
      type: "pin",
      value: { ...doc.pins[2], groupId: "h" },
    });
    for (const [from, to] of [
      [endpoint("a"), endpoint("c")],
      [endpoint("a"), { kind: "group", id: "g" }],
      [
        { kind: "group", id: "g" },
        { kind: "group", id: "h" },
      ],
    ] as [Endpoint, Endpoint][]) {
      const a = resolveCenter(doc, from),
        b = resolveCenter(doc, to);
      if (!a || !b) throw Error("missing center");
      close(
        measuredDistance(doc, { id: "m", from, to }) ?? -1,
        distance(a, b) * 2500,
      );
    }
    for (const center of [endpoint("a"), { kind: "group" as const, id: "g" }]) {
      const before = resolveCenter(doc, center);
      const moved = applyEdit(doc, {
        type: "pin",
        value: { ...doc.pins[0], point: groundPoint(1, 1) },
      });
      expect(resolveCenter(moved, center)).not.toEqual(before);
    }
  });
  test("deleting pins cascades only direct references and undo restores everything", () => {
    let doc = populated();
    doc = applyEdit(doc, {
      type: "measurement",
      value: { id: "m", from: endpoint("a"), to: endpoint("b") },
    });
    doc = applyEdit(doc, {
      type: "guide",
      value: { id: "q", center: endpoint("a"), radiusGame: gameDistance(350) },
    });
    doc = applyEdit(doc, {
      type: "guide",
      value: {
        id: "gq",
        center: { kind: "group", id: "g" },
        radiusGame: gameDistance(350),
      },
    });
    const deleted = applyEdit(doc, { type: "delete", target: endpoint("a") });
    expect(deleted.measurements).toHaveLength(0);
    expect(deleted.guides.map((g) => g.id)).toEqual(["gq"]);
    expect(deleted.groups).toHaveLength(1);
    const h = commit(newHistory(doc), deleted);
    expect(undo(h).present).toEqual(doc);
    expect(redo(undo(h)).present).toEqual(deleted);
  });
  test("group deletion detaches pins and removes group references", () => {
    let doc = populated();
    doc = applyEdit(doc, {
      type: "guide",
      value: {
        id: "q",
        center: { kind: "group", id: "g" },
        radiusGame: gameDistance(350),
      },
    });
    const next = applyEdit(doc, {
      type: "delete",
      target: { kind: "group", id: "g" },
    });
    expect(next.pins).toHaveLength(3);
    expect(next.pins.every((p) => p.groupId === null)).toBe(true);
    expect(next.guides).toHaveLength(0);
  });
  test("preview is separate; commit once, cancel without history, redo invalidation and cap", () => {
    const doc = populated();
    let h = newHistory(doc),
      preview = doc;
    for (let i = 0; i < 10; i++)
      preview = applyEdit(doc, {
        type: "pin",
        value: { ...doc.pins[0], point: groundPoint(i / 100, 0) },
      });
    expect(h.past).toHaveLength(0);
    h = commit(h, preview);
    expect(h.past).toHaveLength(1);
    const unchanged = applyEdit(h.present, {
      type: "pin",
      value: h.present.pins[0],
    });
    expect(commit(h, unchanged)).toBe(h);
    h = undo(h);
    h = commit(
      h,
      applyEdit(h.present, {
        type: "group",
        value: { id: "new", name: "new" },
      }),
    );
    expect(h.future).toHaveLength(0);
    for (let i = 0; i < 110; i++)
      h = commit(
        h,
        applyEdit(h.present, {
          type: "group",
          value: { id: "new", name: String(i) },
        }),
      );
    expect(h.past).toHaveLength(100);
  });
  test("invalid edits leave the original untouched; separate coincident pins measure zero", () => {
    const doc = populated(),
      serialized = JSON.stringify(doc);
    expect(() =>
      applyEdit(doc, {
        type: "measurement",
        value: { id: "m", from: endpoint("a"), to: endpoint("a") },
      }),
    ).toThrow();
    expect(() =>
      applyEdit(doc, {
        type: "pin",
        value: { ...doc.pins[0], groupId: "missing" },
      }),
    ).toThrow();
    const same = applyEdit(doc, {
      type: "pin",
      value: { ...doc.pins[2], point: doc.pins[0].point },
    });
    expect(
      measuredDistance(same, {
        id: "m",
        from: endpoint("a"),
        to: endpoint("c"),
      }),
    ).toBe(0);
    expect(JSON.stringify(doc)).toBe(serialized);
  });
  test("SVG escapes names and excludes controls in export", () => {
    let doc = populated();
    doc = applyEdit(doc, {
      type: "pin",
      value: { ...doc.pins[0], name: '<script>"&' },
    });
    const svg = renderAnnotations(doc, projection, {
      zoom: 1,
      selection: { kind: "reference" },
      interactive: false,
      measureLabel: (text) => ({
        width: text.length * 8,
        ascent: 10,
        descent: 3,
      }),
    }).markup;
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("data-handle");
    expect(svg).not.toContain("tabindex");
    const fine = groundToImage(
      circlePoint(groundPoint(0, 0), 0.2, 0),
      projection,
    );
    expect(fine).not.toBeNull();
  });
});
