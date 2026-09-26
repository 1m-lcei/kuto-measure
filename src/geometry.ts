/** Coordinate brands prevent accidentally passing screen pixels as ground positions. */
type Point<S extends string> = Readonly<{ x: number; y: number; space: S }>;
export type ClientPoint = Point<"client">;
export type ImagePoint = Point<"image">;
export type GroundPoint = Point<"ground">;
export type GroundLength = number & { readonly groundLength: unique symbol };
export type GameDistance = number & { readonly gameDistance: unique symbol };
export const clientPoint = (x: number, y: number): ClientPoint => ({
  x,
  y,
  space: "client",
});
export const imagePoint = (x: number, y: number): ImagePoint => ({
  x,
  y,
  space: "image",
});
export const groundPoint = (x: number, y: number): GroundPoint => ({
  x,
  y,
  space: "ground",
});
export const positive = (n: number): boolean => Number.isFinite(n) && n > 0;
export function groundLength(n: number): GroundLength {
  if (!positive(n)) throw new Error("半径には正の有限数を入力してください。");
  return n as GroundLength;
}
export function gameDistance(n: number): GameDistance {
  if (!positive(n)) throw new Error("半径には正の有限数を入力してください。");
  return n as GameDistance;
}
export interface Size {
  width: number;
  height: number;
}
export interface ImageRect extends Size {
  x: number;
  y: number;
}
export interface CameraCalibration {
  readonly elevationDegrees: number;
  readonly rollDegrees: number;
  readonly verticalFovDegrees: number;
  /** Fractions of the detected game viewport, independent of screenshot pixels. */
  readonly principalPoint: Readonly<{ x: number; y: number }>;
}
// Estimate and original calibration are recorded in docs/calibration/.
export const DEFAULT_CALIBRATION: CameraCalibration = {
  elevationDegrees: 25.2,
  rollDegrees: 0,
  verticalFovDegrees: 9.92,
  principalPoint: { x: 0.5, y: 0.5 },
};
type Vec3 = readonly [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const finite = (p: { x: number; y: number }) =>
  Number.isFinite(p.x) && Number.isFinite(p.y);
const NEAR = 1e-6;
export interface Projection {
  readonly size: Size;
  readonly renderArea: ImageRect;
  readonly principal: ImagePoint;
  readonly focal: number;
  readonly e1: Vec3;
  readonly e2: Vec3;
  readonly normal: Vec3;
  readonly originZ: number;
}
export function buildProjection(
  c: CameraCalibration,
  size: Size,
  renderArea: ImageRect = { ...size, x: 0, y: 0 },
): Projection {
  if (
    ![size.width, size.height, renderArea.width, renderArea.height].every(
      positive,
    ) ||
    !finite(renderArea) ||
    renderArea.x < 0 ||
    renderArea.y < 0 ||
    renderArea.x + renderArea.width > size.width ||
    renderArea.y + renderArea.height > size.height
  )
    throw new Error("画像寸法が不正です。");
  if (
    !finite(c.principalPoint) ||
    c.principalPoint.x < 0 ||
    c.principalPoint.x > 1 ||
    c.principalPoint.y < 0 ||
    c.principalPoint.y > 1 ||
    !positive(c.elevationDegrees) ||
    c.elevationDegrees > 90 ||
    !Number.isFinite(c.rollDegrees) ||
    !positive(c.verticalFovDegrees) ||
    c.verticalFovDegrees >= 180
  )
    throw new Error("キャリブレーションが不正です。");
  const principal = imagePoint(
    renderArea.x + c.principalPoint.x * renderArea.width,
    renderArea.y + c.principalPoint.y * renderArea.height,
  );
  const elevation = (c.elevationDegrees * Math.PI) / 180,
    roll = ((c.rollDegrees % 360) * Math.PI) / 180,
    sin = Math.sin(elevation),
    cos = Math.cos(elevation),
    sr = Math.sin(roll),
    cr = Math.cos(roll);
  const focal =
    renderArea.height / (2 * Math.tan((c.verticalFovDegrees * Math.PI) / 360));
  if (!positive(focal)) throw new Error("焦点距離が不正です。");
  const e1: Vec3 = [cr, sr, 0];
  const e2: Vec3 = [-sr * sin, cr * sin, -cos];
  const normal: Vec3 = [-sr * cos, cr * cos, sin];
  if (normal[2] < NEAR) throw new Error("光軸と地面が平行です。");
  return {
    size,
    renderArea,
    principal,
    focal,
    e1,
    e2,
    normal,
    originZ: 1 / normal[2],
  };
}
export interface ViewportSnapshot {
  origin: ClientPoint;
  zoom: number;
}
export function clientToImage(p: ClientPoint, v: ViewportSnapshot): ImagePoint {
  return imagePoint((p.x - v.origin.x) / v.zoom, (p.y - v.origin.y) / v.zoom);
}
export function imageToClient(p: ImagePoint, v: ViewportSnapshot): ClientPoint {
  return clientPoint(v.origin.x + p.x * v.zoom, v.origin.y + p.y * v.zoom);
}
export function groundToImage(
  g: GroundPoint,
  p: Projection,
): ImagePoint | null {
  if (!finite(g)) return null;
  const x = g.x * p.e1[0] + g.y * p.e2[0];
  const y = g.x * p.e1[1] + g.y * p.e2[1];
  const z = p.originZ + g.x * p.e1[2] + g.y * p.e2[2];
  if (z <= NEAR) return null;
  const result = imagePoint(
    p.principal.x + (p.focal * x) / z,
    p.principal.y + (p.focal * y) / z,
  );
  return finite(result) ? result : null;
}
export function imageToGround(
  i: ImagePoint,
  p: Projection,
): GroundPoint | null {
  if (!finite(i)) return null;
  const ray: Vec3 = [
    (i.x - p.principal.x) / p.focal,
    (i.y - p.principal.y) / p.focal,
    1,
  ];
  const denominator = dot(p.normal, ray);
  if (denominator <= 1e-9) return null;
  const q: Vec3 = [
    ray[0] / denominator,
    ray[1] / denominator,
    1 / denominator - p.originZ,
  ];
  const result = groundPoint(dot(q, p.e1), dot(q, p.e2));
  return finite(result) ? result : null;
}
export const distance = (a: GroundPoint, b: GroundPoint): number =>
  Math.hypot(a.x - b.x, a.y - b.y);
export const inImage = (p: ImagePoint, s: Size): boolean =>
  finite(p) && p.x >= 0 && p.y >= 0 && p.x <= s.width && p.y <= s.height;
export const inRect = (p: ImagePoint, r: ImageRect): boolean =>
  finite(p) &&
  p.x >= r.x &&
  p.y >= r.y &&
  p.x <= r.x + r.width &&
  p.y <= r.y + r.height;
export const circlePoint = (
  c: GroundPoint,
  r: number,
  t: number,
): GroundPoint => groundPoint(c.x + r * Math.cos(t), c.y + r * Math.sin(t));
export function circleValid(c: GroundPoint, r: number, p: Projection): boolean {
  return (
    finite(c) &&
    positive(r) &&
    p.originZ +
      c.x * p.e1[2] +
      c.y * p.e2[2] -
      r * Math.hypot(p.e1[2], p.e2[2]) >
      NEAR
  );
}
export interface CircleSample {
  points: ImagePoint[];
  limited: boolean;
}
export function projectCircle(
  c: GroundPoint,
  r: number,
  p: Projection,
  tolerance: number,
): CircleSample | null {
  if (!circleValid(c, r, p) || !positive(tolerance)) return null;
  const at = (t: number) =>
    groundToImage(circlePoint(c, r, t), p) as ImagePoint;
  const points: ImagePoint[] = [];
  let limited = false;
  const walk = (
    a: number,
    b: number,
    left: ImagePoint,
    right: ImagePoint,
    depth: number,
  ) => {
    const mid = at((a + b) / 2);
    const dx = right.x - left.x,
      dy = right.y - left.y;
    const length2 = dx * dx + dy * dy;
    const t =
      length2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((mid.x - left.x) * dx + (mid.y - left.y) * dy) / length2,
            ),
          );
    const error = Math.hypot(mid.x - left.x - t * dx, mid.y - left.y - t * dy);
    if (error > tolerance && depth < 8) {
      walk(a, (a + b) / 2, left, mid, depth + 1);
      walk((a + b) / 2, b, mid, right, depth + 1);
    } else {
      points.push(left);
      if (error > tolerance) limited = true;
    }
  };
  // ponytail: 16 × 2^8 = 4096 vertices; use clipped conics if extreme circles need more precision.
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8,
      b = ((i + 1) * Math.PI) / 8;
    walk(a, b, at(a), at(b), 0);
  }
  return { points, limited };
}
