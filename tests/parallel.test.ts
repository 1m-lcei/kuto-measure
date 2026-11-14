import { describe, expect, test } from "bun:test";
import { prepareAnnotations } from "../src/annotations";
import {
  buildProjection,
  DEFAULT_CALIBRATION,
  groundPoint,
  groundToImage,
  imagePoint,
  imageToGround,
} from "../src/geometry";
import { type AnalysisDocument, emptyDocument } from "../src/model";
import {
  parallelMeasurements,
  snapPin,
  translateMeasurement,
} from "../src/parallel";
import { renderAnnotations } from "../src/render";

const projection = buildProjection(DEFAULT_CALIBRATION, {
  width: 1000,
  height: 800,
});
const pin = (
  id: string,
  x: number,
  y: number,
  groupId: string | null = null,
) => ({ id, name: id, point: groundPoint(x, y), groupId });
const measurement = (id: string, from: string, to: string) => ({
  id,
  from: { kind: "pin" as const, id: from },
  to: { kind: "pin" as const, id: to },
});
const make = (
  pins: AnalysisDocument["pins"],
  measurements: AnalysisDocument["measurements"],
): AnalysisDocument => ({ ...emptyDocument(), pins, measurements });

describe("parallel measurements", () => {
  test("uses pairwise ground angles, including reversed lines and excluding degenerate lines", () => {
    const at = (degrees: number) => Math.tan((degrees * Math.PI) / 180);
    const doc = make(
      [
        pin("a", 0, 0),
        pin("b", 1, 0),
        pin("c", 1, at(0.08)),
        pin("d", 1, at(0.16)),
        pin("z", 0, 0),
      ],
      [
        measurement("first", "a", "b"),
        measurement("second", "c", "a"),
        measurement("third", "a", "d"),
        measurement("zero", "a", "z"),
        measurement("missing", "a", "absent"),
      ],
    );
    const pairs = parallelMeasurements(doc);
    expect([...(pairs.get("first") ?? [])]).toEqual(["second"]);
    expect([...(pairs.get("second") ?? [])]).toEqual(["first", "third"]);
    expect(pairs.has("zero")).toBe(false);
    expect(pairs.has("missing")).toBe(false);
  });

  test("translates the union of group and pin members once and rejects out-of-bounds moves", () => {
    const doc = {
      ...make(
        [pin("a", 0, 0, "g"), pin("b", 0.01, 0, "g"), pin("c", 0, 0.01)],
        [
          {
            id: "m",
            from: { kind: "group" as const, id: "g" },
            to: { kind: "pin" as const, id: "a" },
          },
        ],
      ),
      groups: [{ id: "g", name: "g" }],
    };
    const moved = translateMeasurement(
      doc,
      "m",
      groundPoint(0.001, 0.001),
      projection,
    );
    expect(moved?.pins[0].point.x).toBeCloseTo(0.001);
    expect(moved?.pins[1].point.x).toBeCloseTo(0.011);
    expect(moved?.pins[2]).toBe(doc.pins[2]);
    expect(moved?.measurements).toBe(doc.measurements);
    expect(
      translateMeasurement(doc, "m", groundPoint(100, 0), projection),
    ).toBeNull();
    expect(
      translateMeasurement(doc, "m", groundPoint(NaN, 0), projection),
    ).toBeNull();
    expect(
      translateMeasurement(
        { ...doc, pins: [] },
        "m",
        groundPoint(0, 0),
        projection,
      ),
    ).toBeNull();
  });
});

describe("pin snapping", () => {
  test("projects the ground-parallel line and chooses the nearest image point", () => {
    const doc = make(
      [
        pin("fixed", -0.02, -0.03),
        pin("moving", 0.02, 0.01),
        pin("r1", -0.01, 0.03),
        pin("r2", 0.03, 0.07),
      ],
      [
        measurement("moving-line", "fixed", "moving"),
        measurement("reference", "r1", "r2"),
      ],
    );
    const raw = groundPoint(0.02, 0.0105);
    const snap = snapPin(doc, "moving", raw, projection, 1);
    expect(snap?.referenceId).toBe("reference");
    if (!snap) throw new Error("Expected a snap");
    expect(snap.point.y).toBeCloseTo(snap.point.x - 0.01, 10);
    const fixedImage = groundToImage(doc.pins[0].point, projection);
    const snappedImage = groundToImage(snap.point, projection);
    const rawImage = groundToImage(raw, projection);
    const ref1 = groundToImage(doc.pins[2].point, projection),
      ref2 = groundToImage(doc.pins[3].point, projection);
    if (!fixedImage || !snappedImage || !rawImage || !ref1 || !ref2)
      throw new Error("Expected projected points");
    expect(
      (rawImage.x - snappedImage.x) * (snappedImage.x - fixedImage.x) +
        (rawImage.y - snappedImage.y) * (snappedImage.y - fixedImage.y),
    ).toBeCloseTo(0, 7);
    expect(
      Math.abs(
        (snappedImage.x - fixedImage.x) * (ref2.y - ref1.y) -
          (snappedImage.y - fixedImage.y) * (ref2.x - ref1.x),
      ),
    ).toBeGreaterThan(1);
  });

  test("enforces thresholds, excludes dependent references, and prefers the previous pair on ties", () => {
    const doc = make(
      [
        pin("a", -0.02, 0),
        pin("b", 0.02, 0),
        pin("c", -0.02, 0.02),
        pin("d", 0.02, 0.02),
      ],
      [
        measurement("move", "a", "b"),
        measurement("r1", "c", "d"),
        measurement("r2", "d", "c"),
        measurement("dependent", "a", "b"),
      ],
    );
    const raw = groundPoint(0.02, 0.0002);
    expect(snapPin(doc, "b", raw, projection, 1)?.referenceId).toBe("r1");
    expect(
      snapPin(doc, "b", raw, projection, 1, {
        movingId: "move",
        referenceId: "r2",
      })?.referenceId,
    ).toBe("r2");
    expect(snapPin(doc, "b", raw, projection, 100)).toBeNull();
    expect(
      snapPin(doc, "b", groundPoint(0.02, 0.01), projection, 0.01),
    ).toBeNull();
    expect(snapPin(doc, "b", raw, projection, 0)).toBeNull();
    const outside = imageToGround(imagePoint(-10, 400), projection);
    if (!outside) throw new Error("Expected a ground point");
    expect(snapPin(doc, "b", outside, projection, 0.001)).toBeNull();
  });
});

test("parallel marks are derived without a distance scale and exported with the same geometry", () => {
  const slope = (degrees: number) => 0.08 * Math.tan((degrees * Math.PI) / 180);
  const doc = make(
    [
      pin("a", -0.04, 0),
      pin("b", 0.04, 0),
      pin("c", -0.04, 0.03),
      pin("d", 0.04, 0.03 + slope(0.099)),
      pin("e", -0.04, -0.03),
      pin("f", 0.04, -0.03 + slope(0.101)),
    ],
    [
      measurement("zero", "a", "a"),
      measurement("first", "a", "b"),
      measurement("inside", "c", "d"),
      measurement("outside", "e", "f"),
    ],
  );
  const measure = (text: string) => ({
    width: text.length * 6,
    ascent: 9,
    descent: 3,
  });
  const scene = prepareAnnotations(doc, projection, 1, measure);
  const first = scene.lines.find((line) => line.key === "measurement:first");
  const outside = scene.lines.find(
    (line) => line.key === "measurement:outside",
  );
  if (!first || !outside) throw new Error("Expected measurement lines");
  expect(doc.reference).toBeNull();
  expect(first.parallelKeys).toEqual(["measurement:inside"]);
  expect(first.parallelPath).not.toBe("");
  expect(outside.parallelKeys).not.toContain("measurement:first");
  const reversed = {
    ...doc,
    measurements: doc.measurements.map((m) =>
      m.id === "first" ? { ...m, from: m.to, to: m.from } : m,
    ),
  };
  const reversedLine = prepareAnnotations(
    reversed,
    projection,
    1,
    measure,
  ).lines.find((line) => line.key === first.key);
  expect(reversedLine?.parallelPath).toBe(first.parallelPath);
  const { markup } = renderAnnotations(doc, projection, measure);
  expect(markup).toContain(
    `data-part="parallel-mark" d="${first.parallelPath}"`,
  );
  expect(markup).not.toContain("data-parallel-highlight");
});

test("snap applies the angle and screen-distance thresholds on every update", () => {
  const doc = make(
    [
      pin("a", -0.1, 0),
      pin("b", 0.1, 0),
      pin("c", -0.1, 0.04),
      pin("d", 0.1, 0.04),
    ],
    [measurement("move", "a", "b"), measurement("reference", "c", "d")],
  );
  const image = groundToImage(doc.pins[1].point, projection);
  if (!image) throw new Error("Expected projected point");
  const rawAt = (pixels: number) => {
    const point = imageToGround(
      imagePoint(image.x, image.y + pixels),
      projection,
    );
    if (!point) throw new Error("Expected ground point");
    return point;
  };
  expect(snapPin(doc, "b", rawAt(7.99), projection, 1)).not.toBeNull();
  expect(snapPin(doc, "b", rawAt(8), projection, 1)).not.toBeNull();
  expect(
    snapPin(doc, "b", rawAt(8.01), projection, 1, {
      movingId: "move",
      referenceId: "reference",
    }),
  ).toBeNull();
  const angled = (degrees: number) =>
    groundPoint(0.1, 0.2 * Math.tan((degrees * Math.PI) / 180));
  expect(snapPin(doc, "b", angled(2.99), projection, 0.001)).not.toBeNull();
  expect(
    snapPin(doc, "b", angled(3.01), projection, 0.001, {
      movingId: "move",
      referenceId: "reference",
    }),
  ).toBeNull();
});

test.each([0.1, 3])("includes the %d-degree angle cutoff", (limit) => {
  const start = Math.PI / 180,
    end = start + (limit * Math.PI) / 180;
  const doc = make(
    [
      pin("a", 0, 0),
      pin("b", 0.08 * Math.cos(start), 0.08 * Math.sin(start)),
      pin("c", 0, 0),
      pin("d", 0.08 * Math.cos(end), 0.08 * Math.sin(end)),
    ],
    [measurement("move", "a", "b"), measurement("reference", "c", "d")],
  );
  if (limit === 0.1) {
    expect(parallelMeasurements(doc).get("move")?.has("reference")).toBe(true);
  } else {
    const snap = snapPin(doc, "b", doc.pins[1].point, projection, 0.01);
    expect(snap?.referenceId).toBe("reference");
  }
});

test("snap excludes a moving pin's group from fixed endpoints and references", () => {
  const doc = {
    ...make(
      [
        pin("a", -0.02, 0),
        pin("b", 0.02, 0, "g"),
        pin("c", -0.02, 0.02),
        pin("d", 0.02, 0.02),
      ],
      [
        measurement("move", "a", "b"),
        {
          id: "dependent",
          from: { kind: "group" as const, id: "g" },
          to: { kind: "pin" as const, id: "d" },
        },
        measurement("reference", "c", "d"),
      ],
    ),
    groups: [{ id: "g", name: "g" }],
  };
  expect(
    snapPin(doc, "b", groundPoint(0.02, 0.0002), projection, 1)?.referenceId,
  ).toBe("reference");
  const onlyDependent = {
    ...doc,
    measurements: [
      {
        id: "move",
        from: { kind: "group" as const, id: "g" },
        to: { kind: "pin" as const, id: "b" },
      },
      measurement("reference", "c", "d"),
    ],
  };
  expect(
    snapPin(onlyDependent, "b", groundPoint(0.02, 0.0002), projection, 1),
  ).toBeNull();
});
