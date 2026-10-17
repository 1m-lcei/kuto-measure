import { prepareAnnotations } from "../src/annotations";
import {
  buildProjection,
  gameDistance,
  groundLength,
  groundPoint,
  imagePoint,
  imageToGround,
} from "../src/geometry";
import type { MeasureLabel } from "../src/labels";
import { emptyDocument } from "../src/model";

export function labelDocument(count: number) {
  const doc = emptyDocument(),
    size = { width: 1536, height: 709 };
  const projection = buildProjection(doc.calibration, size);
  const columns = count === 24 ? 6 : 20,
    rows = count / columns;
  const pins = Array.from({ length: count }, (_, i) => {
    const point = imageToGround(
      imagePoint(
        150 + ((i % columns) * 1200) / (columns - 1),
        120 + (Math.floor(i / columns) * 480) / (rows - 1),
      ),
      projection,
    );
    if (!point) throw new Error("Invalid label fixture projection");
    return { id: `p${i}`, name: `ピン${i + 1}`, groupId: null, point };
  });
  const guides = count === 24 ? 3 : 12;
  return {
    size,
    projection,
    doc: {
      ...doc,
      pins,
      reference: {
        center: groundPoint(0, 0),
        radiusGround: groundLength(0.1),
        radiusGame: gameDistance(10),
      },
      measurements: Array.from({ length: count / 3 }, (_, i) => ({
        id: `m${i}`,
        from: { kind: "pin" as const, id: `p${i}` },
        to: { kind: "pin" as const, id: `p${(i + columns + 1) % count}` },
      })),
      guides: Array.from({ length: guides }, (_, i) => ({
        id: `g${i}`,
        center: {
          kind: "point" as const,
          point: pins[Math.floor((i * count) / guides)].point,
        },
        radiusGame: gameDistance(5),
      })),
    },
  };
}

export function labelFixture(count: number, measure: MeasureLabel) {
  const { doc, projection } = labelDocument(count);
  const scene = prepareAnnotations(doc, projection, 1, measure);
  return {
    labels: scene.labels.map((box) => box.label),
    area: projection.renderArea,
    obstacles: scene.markers.map(({ point }) => ({
      x: point.x - 16,
      y: point.y - 16,
      width: 32,
      height: 32,
    })),
    lines: [
      ...scene.circles.flatMap((circle) =>
        circle.points.map((start, i) => ({
          start,
          end: circle.points[(i + 1) % circle.points.length],
        })),
      ),
      ...scene.lines.map(({ start, end }) => ({ start, end })),
    ],
  };
}
