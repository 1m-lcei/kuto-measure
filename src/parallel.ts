import {
  type GroundPoint,
  groundPoint,
  groundToImage,
  imagePoint,
  imageToGround,
  inRect,
  type Projection,
} from "./geometry";
import {
  type AnalysisDocument,
  type Endpoint,
  type Measurement,
  resolveCenter,
} from "./model";

type Vector = { x: number; y: number };
// Inclusive cutoffs tolerate roundoff from projection and normalized directions.
const ANGLE_EPSILON = 1e-12;
const PIXEL_EPSILON = 1e-9;

const direction = (a: GroundPoint, b: GroundPoint): Vector | null => {
  const x = b.x - a.x,
    y = b.y - a.y,
    length = Math.hypot(x, y);
  return Number.isFinite(length) && length > 0
    ? { x: x / length, y: y / length }
    : null;
};
const parallel = (a: Vector, b: Vector, degrees: number) =>
  Math.atan2(
    Math.abs(a.x * b.y - a.y * b.x),
    Math.abs(a.x * b.x + a.y * b.y),
  ) <=
  (degrees * Math.PI) / 180 + ANGLE_EPSILON;
const resolveEndpoint = (doc: AnalysisDocument, endpoint: Endpoint) =>
  endpoint.kind === "group" && !doc.groups.some((g) => g.id === endpoint.id)
    ? null
    : resolveCenter(doc, endpoint);
const measurementDirection = (doc: AnalysisDocument, m: Measurement) => {
  const a = resolveEndpoint(doc, m.from),
    b = resolveEndpoint(doc, m.to);
  return a && b ? direction(a, b) : null;
};

export function parallelMeasurements(
  doc: AnalysisDocument,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const directions = doc.measurements.map((m) => measurementDirection(doc, m));
  for (let i = 0; i < directions.length; i++) {
    const a = directions[i];
    if (!a) continue;
    for (let j = i + 1; j < directions.length; j++) {
      const b = directions[j];
      if (!b || !parallel(a, b, 0.1)) continue;
      const left = doc.measurements[i].id,
        right = doc.measurements[j].id;
      if (!result.has(left)) result.set(left, new Set());
      if (!result.has(right)) result.set(right, new Set());
      result.get(left)?.add(right);
      result.get(right)?.add(left);
    }
  }
  return result;
}

function endpointPins(doc: AnalysisDocument, endpoint: Endpoint): string[] {
  if (
    endpoint.kind === "group" &&
    !doc.groups.some((g) => g.id === endpoint.id)
  )
    return [];
  return doc.pins
    .filter((pin) =>
      endpoint.kind === "pin"
        ? pin.id === endpoint.id
        : pin.groupId === endpoint.id,
    )
    .map((pin) => pin.id);
}

export function translateMeasurement(
  doc: AnalysisDocument,
  measurementId: string,
  delta: GroundPoint,
  projection: Projection,
): AnalysisDocument | null {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return null;
  const measurement = doc.measurements.find((m) => m.id === measurementId);
  if (!measurement) return null;
  const from = endpointPins(doc, measurement.from),
    to = endpointPins(doc, measurement.to);
  if (!from.length || !to.length) return null;
  const ids = new Set([...from, ...to]);
  const pins = doc.pins.map((pin) =>
    ids.has(pin.id)
      ? {
          ...pin,
          point: groundPoint(pin.point.x + delta.x, pin.point.y + delta.y),
        }
      : pin,
  );
  if (
    pins.some((pin) => {
      if (!ids.has(pin.id)) return false;
      const image = groundToImage(pin.point, projection);
      return !image || !inRect(image, projection.renderArea);
    })
  )
    return null;
  return { ...doc, pins };
}

export interface SnapPair {
  movingId: string;
  referenceId: string;
}
export interface PinSnap extends SnapPair {
  point: GroundPoint;
}

export function snapPin(
  doc: AnalysisDocument,
  pinId: string,
  rawPoint: GroundPoint,
  projection: Projection,
  zoom: number,
  previous: SnapPair | null = null,
): PinSnap | null {
  const pin = doc.pins.find((p) => p.id === pinId);
  const rawImage = groundToImage(rawPoint, projection);
  if (!pin || !rawImage || !Number.isFinite(zoom) || zoom <= 0) return null;
  const depends = (e: Endpoint) =>
    e.kind === "pin" ? e.id === pinId : pin.groupId === e.id;
  let best: PinSnap | null = null,
    bestDistance = Infinity,
    bestPrevious = false;
  for (const moving of doc.measurements) {
    const opposite =
      moving.from.kind === "pin" && moving.from.id === pinId
        ? moving.to
        : moving.to.kind === "pin" && moving.to.id === pinId
          ? moving.from
          : null;
    if (!opposite || depends(opposite)) continue;
    const fixed = resolveEndpoint(doc, opposite);
    const movingDirection = fixed && direction(fixed, rawPoint);
    if (!fixed || !movingDirection) continue;
    for (const reference of doc.measurements) {
      if (depends(reference.from) || depends(reference.to)) continue;
      const refDirection = measurementDirection(doc, reference);
      if (!refDirection || !parallel(movingDirection, refDirection, 3))
        continue;
      // Project the ground line in homogeneous coordinates, including its point at infinity.
      const z =
        projection.originZ +
        fixed.x * projection.e1[2] +
        fixed.y * projection.e2[2];
      const x = fixed.x * projection.e1[0] + fixed.y * projection.e2[0];
      const y = fixed.x * projection.e1[1] + fixed.y * projection.e2[1];
      const dz =
        refDirection.x * projection.e1[2] + refDirection.y * projection.e2[2];
      const dx =
        refDirection.x * projection.e1[0] + refDirection.y * projection.e2[0];
      const dy =
        refDirection.x * projection.e1[1] + refDirection.y * projection.e2[1];
      const ax = projection.principal.x * z + projection.focal * x,
        ay = projection.principal.y * z + projection.focal * y;
      const bx = projection.principal.x * dz + projection.focal * dx,
        by = projection.principal.y * dz + projection.focal * dy;
      const a = ay * dz - z * by,
        b = z * bx - ax * dz,
        c = ax * by - ay * bx;
      const norm = Math.hypot(a, b);
      if (!Number.isFinite(norm) || norm === 0) continue;
      const correction =
        (a / norm) * rawImage.x + (b / norm) * rawImage.y + c / norm;
      const cost = Math.abs(correction) * zoom;
      if (!Number.isFinite(cost) || cost > 8 + PIXEL_EPSILON) continue;
      const image = imagePoint(
        rawImage.x - (correction * a) / norm,
        rawImage.y - (correction * b) / norm,
      );
      if (!inRect(image, projection.renderArea)) continue;
      const point = imageToGround(image, projection);
      if (!point || !direction(fixed, point)) continue;
      const isPrevious =
        previous?.movingId === moving.id &&
        previous.referenceId === reference.id;
      if (
        cost < bestDistance - PIXEL_EPSILON ||
        (Math.abs(cost - bestDistance) <= PIXEL_EPSILON &&
          isPrevious &&
          !bestPrevious)
      ) {
        best = { movingId: moving.id, referenceId: reference.id, point };
        bestDistance = cost;
        bestPrevious = isPrevious;
      }
    }
  }
  return best;
}
