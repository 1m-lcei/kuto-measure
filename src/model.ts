import {
  buildProjection,
  type CameraCalibration,
  circlePoint,
  circleValid,
  DEFAULT_CALIBRATION,
  distance,
  type GameDistance,
  type GroundLength,
  type GroundPoint,
  gameDistance,
  groundLength,
  groundPoint,
  groundToImage,
  type ImageRect,
  imageToGround,
  inRect,
  positive,
  type Size,
} from "./geometry";

export type Endpoint =
  | { kind: "pin"; id: string }
  | { kind: "group"; id: string };
export type CircleCenter = Endpoint | { kind: "point"; point: GroundPoint };
export type Selection =
  | Endpoint
  | { kind: "reference" }
  | { kind: "measurement"; id: string }
  | { kind: "guide"; id: string };
export interface Pin {
  id: string;
  name: string;
  point: GroundPoint;
  groupId: string | null;
}
export interface Group {
  id: string;
  name: string;
}
export interface Measurement {
  id: string;
  from: Endpoint;
  to: Endpoint;
}
export interface ReferenceCircle {
  center: GroundPoint;
  radiusGround: GroundLength;
  radiusGame: GameDistance | null;
}
export interface GuideCircle {
  id: string;
  center: CircleCenter;
  radiusGame: GameDistance;
}
export interface AnalysisDocument {
  readonly calibration: CameraCalibration;
  readonly renderArea: RenderAreaSetting | null;
  readonly pins: readonly Pin[];
  readonly groups: readonly Group[];
  readonly measurements: readonly Measurement[];
  readonly guides: readonly GuideCircle[];
  readonly reference: ReferenceCircle | null;
}
export const emptyDocument = (): AnalysisDocument => ({
  calibration: DEFAULT_CALIBRATION,
  renderArea: null,
  pins: [],
  groups: [],
  measurements: [],
  guides: [],
  reference: null,
});
export interface RenderAreaSetting {
  readonly bounds: ImageRect;
  readonly source: "auto" | "manual" | "full" | "fallback";
  readonly confirmed: boolean;
}
export function automaticRenderArea(
  size: Size,
  bounds: ImageRect,
): RenderAreaSetting {
  return {
    bounds,
    confirmed: false,
    source:
      bounds.x === 0 &&
      bounds.y === 0 &&
      bounds.width === size.width &&
      bounds.height === size.height
        ? "fallback"
        : "auto",
  };
}
export function validateRenderArea(bounds: ImageRect, size: Size): void {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(
      Number.isSafeInteger,
    ) ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width < 1 ||
    bounds.height < 1 ||
    bounds.x + bounds.width > size.width ||
    bounds.y + bounds.height > size.height
  )
    throw new Error(
      "除外幅は0以上の整数にし、ゲーム領域を縦横とも1px以上残してください。",
    );
}
export interface ReferencePreset {
  version: 1;
  calibration: CameraCalibration;
  reference: ReferenceCircle & { radiusGame: GameDistance };
}
export function referencePreset(doc: AnalysisDocument): ReferencePreset {
  const r = doc.reference,
    c = doc.calibration;
  if (!r?.radiusGame)
    throw new Error("先に基準円のゲーム内半径を設定してください。");
  return {
    version: 1,
    calibration: {
      elevationDegrees: c.elevationDegrees,
      rollDegrees: c.rollDegrees,
      verticalFovDegrees: c.verticalFovDegrees,
      principalPoint: { x: c.principalPoint.x, y: c.principalPoint.y },
    },
    reference: {
      center: groundPoint(r.center.x, r.center.y),
      radiusGround: r.radiusGround,
      radiusGame: r.radiusGame,
    },
  };
}
export function parseReferencePreset(raw: string): ReferencePreset {
  const invalid = () =>
    new Error(
      "保存した基準の形式または数値が不正です。削除して保存し直してください。",
    );
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalid();
    return value as Record<string, unknown>;
  };
  const number = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
    return value;
  };
  try {
    const value = record(JSON.parse(raw));
    if (value.version !== 1) throw invalid();
    const c = record(value.calibration),
      principal = record(c.principalPoint);
    const r = record(value.reference),
      center = record(r.center);
    if (center.space !== "ground") throw invalid();
    const doc = applyEdit(
      {
        ...emptyDocument(),
        calibration: {
          elevationDegrees: number(c.elevationDegrees),
          rollDegrees: number(c.rollDegrees),
          verticalFovDegrees: number(c.verticalFovDegrees),
          principalPoint: { x: number(principal.x), y: number(principal.y) },
        },
      },
      {
        type: "reference",
        value: {
          center: groundPoint(number(center.x), number(center.y)),
          radiusGround: groundLength(number(r.radiusGround)),
          radiusGame: gameDistance(number(r.radiusGame)),
        },
      },
    );
    const p = buildProjection(doc.calibration, { width: 1, height: 1 });
    const preset = referencePreset(doc);
    if (!circleValid(preset.reference.center, preset.reference.radiusGround, p))
      throw invalid();
    return preset;
  } catch {
    throw invalid();
  }
}
export function documentFromPreset(
  preset: ReferencePreset,
  size: Size,
  renderArea: ImageRect,
): AnalysisDocument {
  const p = buildProjection(preset.calibration, size, renderArea);
  const center = groundToImage(preset.reference.center, p);
  if (
    !center ||
    !inRect(center, renderArea) ||
    !circleValid(preset.reference.center, preset.reference.radiusGround, p)
  )
    throw new Error("保存した基準円をこの画像の描画領域に適用できません。");
  return {
    ...emptyDocument(),
    calibration: preset.calibration,
    reference: preset.reference,
  };
}
export const sameCalibration = (
  a: CameraCalibration,
  b: CameraCalibration,
): boolean =>
  a.elevationDegrees === b.elevationDegrees &&
  a.rollDegrees === b.rollDegrees &&
  a.verticalFovDegrees === b.verticalFovDegrees &&
  a.principalPoint.x === b.principalPoint.x &&
  a.principalPoint.y === b.principalPoint.y;
export function centroid(
  doc: AnalysisDocument,
  id: string,
): GroundPoint | null {
  const pins = doc.pins.filter((p) => p.groupId === id);
  if (!pins.length) return null;
  return groundPoint(
    pins.reduce((sum, p) => sum + p.point.x / pins.length, 0),
    pins.reduce((sum, p) => sum + p.point.y / pins.length, 0),
  );
}
export function resolveCenter(
  doc: AnalysisDocument,
  ref: CircleCenter,
): GroundPoint | null {
  if (ref.kind === "point") return ref.point;
  if (ref.kind === "pin")
    return doc.pins.find((p) => p.id === ref.id)?.point ?? null;
  return centroid(doc, ref.id);
}
export const sameEndpoint = (a: Endpoint, b: Endpoint): boolean =>
  a.kind === b.kind && a.id === b.id;
export function scaleFactor(doc: AnalysisDocument): number | null {
  const ref = doc.reference;
  let scale: number;
  if (ref?.radiusGame) scale = ref.radiusGame / ref.radiusGround;
  else {
    const first = doc.measurements[0];
    if (!first) return null;
    const a = resolveCenter(doc, first.from),
      b = resolveCenter(doc, first.to);
    if (!a || !b) return null;
    scale = 1 / distance(a, b);
  }
  return positive(scale) ? scale : null;
}
export function measuredDistance(
  doc: AnalysisDocument,
  m: Measurement,
): number | null {
  const a = resolveCenter(doc, m.from),
    b = resolveCenter(doc, m.to),
    scale = scaleFactor(doc);
  if (!a || !b || !scale) return null;
  const result = distance(a, b) * scale;
  return Number.isFinite(result) ? result : null;
}
export const selectionKey = (s: Selection): string =>
  s.kind === "reference" ? "reference" : `${s.kind}:${s.id}`;
export function exists(doc: AnalysisDocument, s: Selection): boolean {
  switch (s.kind) {
    case "reference":
      return !!doc.reference;
    case "pin":
      return doc.pins.some((p) => p.id === s.id);
    case "group":
      return doc.groups.some((g) => g.id === s.id);
    case "measurement":
      return doc.measurements.some((m) => m.id === s.id);
    case "guide":
      return doc.guides.some((g) => g.id === s.id);
  }
}
export type Edit =
  | { type: "confirm-area" }
  | {
      type: "render-area";
      value: RenderAreaSetting;
      size: Size;
      renderArea: ImageRect;
    }
  | { type: "reset-reference"; size: Size; renderArea: ImageRect }
  | {
      type: "calibration";
      value: CameraCalibration;
      size: Size;
      renderArea: ImageRect;
    }
  | { type: "pin"; value: Pin }
  | { type: "group"; value: Group }
  | { type: "measurement"; value: Measurement }
  | { type: "guide"; value: GuideCircle }
  | { type: "reference"; value: ReferenceCircle | null }
  | { type: "delete"; target: Selection };
const pointValid = (p: GroundPoint) =>
  Number.isFinite(p.x) && Number.isFinite(p.y);
function checkPoint(p: GroundPoint) {
  if (!pointValid(p)) throw new Error("座標が不正です。");
}
function checkRadius(n: number) {
  if (!positive(n)) throw new Error("半径には正の有限数を入力してください。");
}
function checkEndpoint(doc: AnalysisDocument, e: Endpoint) {
  if (!exists(doc, e)) throw new Error("参照先が存在しません。");
}
function upsert<T extends { id: string }>(
  items: readonly T[],
  value: T,
): readonly T[] {
  if (!value.id) throw new Error("IDがありません。");
  return items.some((i) => i.id === value.id)
    ? items.map((i) => (i.id === value.id ? value : i))
    : [...items, value];
}
export function applyEdit(doc: AnalysisDocument, edit: Edit): AnalysisDocument {
  let next: AnalysisDocument;
  switch (edit.type) {
    case "confirm-area":
      if (!doc.renderArea || doc.renderArea.confirmed) return doc;
      next = { ...doc, renderArea: { ...doc.renderArea, confirmed: true } };
      break;
    case "reset-reference":
      return applyEdit(
        { ...doc, reference: null },
        {
          type: "calibration",
          value: DEFAULT_CALIBRATION,
          size: edit.size,
          renderArea: edit.renderArea,
        },
      );
    case "calibration":
    case "render-area": {
      const calibration =
        edit.type === "calibration" ? edit.value : doc.calibration;
      const renderArea =
        edit.type === "render-area" ? edit.value : doc.renderArea;
      if (edit.type === "render-area")
        validateRenderArea(edit.value.bounds, edit.size);
      const previous = buildProjection(
        doc.calibration,
        edit.size,
        doc.renderArea?.bounds ?? edit.renderArea,
      );
      const projection = buildProjection(
        calibration,
        edit.size,
        renderArea?.bounds ?? edit.renderArea,
      );
      if (
        sameCalibration(doc.calibration, calibration) &&
        (["x", "y", "width", "height"] as const).every(
          (key) => previous.renderArea[key] === projection.renderArea[key],
        )
      ) {
        next = { ...doc, renderArea };
        break;
      }
      const remap = (point: GroundPoint): GroundPoint => {
        const image = groundToImage(point, previous);
        const ground = image && imageToGround(image, projection);
        if (!ground || !groundToImage(ground, projection))
          throw new Error("設定を変更すると既存の点を地面に投影できません。");
        return ground;
      };
      let reference = doc.reference;
      if (reference) {
        const center = remap(reference.center);
        // ponytail: preserve center and one +X rim anchor; use a multi-point refit if full-outline fitting is needed.
        const rim = remap(
          circlePoint(reference.center, reference.radiusGround, 0),
        );
        const radiusGround = groundLength(distance(center, rim));
        if (reference.radiusGame !== null)
          checkRadius(reference.radiusGame / radiusGround);
        if (!circleValid(center, radiusGround, projection))
          throw new Error("基準円がカメラ前方に収まりません。");
        reference = { ...reference, center, radiusGround };
      }
      next = {
        ...doc,
        calibration,
        renderArea,
        pins: doc.pins.map((pin) => ({ ...pin, point: remap(pin.point) })),
        guides: doc.guides.map((guide) => ({
          ...guide,
          center:
            guide.center.kind === "point"
              ? { kind: "point", point: remap(guide.center.point) }
              : guide.center,
        })),
        reference,
      };
      break;
    }
    case "pin": {
      checkPoint(edit.value.point);
      if (
        edit.value.groupId &&
        !doc.groups.some((g) => g.id === edit.value.groupId)
      )
        throw new Error("グループが存在しません。");
      next = { ...doc, pins: upsert(doc.pins, edit.value) };
      break;
    }
    case "group":
      next = { ...doc, groups: upsert(doc.groups, edit.value) };
      break;
    case "measurement": {
      const m = edit.value;
      checkEndpoint(doc, m.from);
      checkEndpoint(doc, m.to);
      if (sameEndpoint(m.from, m.to))
        throw new Error("異なる2つの対象を指定してください。");
      next = { ...doc, measurements: upsert(doc.measurements, m) };
      break;
    }
    case "guide": {
      const g = edit.value;
      checkRadius(g.radiusGame);
      if (g.center.kind === "point") checkPoint(g.center.point);
      else checkEndpoint(doc, g.center);
      next = { ...doc, guides: upsert(doc.guides, g) };
      break;
    }
    case "reference": {
      const r = edit.value;
      if (r) {
        checkPoint(r.center);
        checkRadius(r.radiusGround);
        if (r.radiusGame !== null) {
          checkRadius(r.radiusGame);
          checkRadius(r.radiusGame / r.radiusGround);
        }
      }
      next = { ...doc, reference: r };
      break;
    }
    case "delete": {
      const s = edit.target;
      if (s.kind === "reference") {
        next = { ...doc, reference: null };
        break;
      }
      const uses = (e: Endpoint) => e.kind === s.kind && e.id === s.id;
      next = {
        ...doc,
        pins: doc.pins
          .filter((p) => s.kind !== "pin" || p.id !== s.id)
          .map((p) =>
            s.kind === "group" && p.groupId === s.id
              ? { ...p, groupId: null }
              : p,
          ),
        groups: doc.groups.filter((g) => s.kind !== "group" || g.id !== s.id),
        measurements: doc.measurements.filter(
          (m) =>
            !(s.kind === "measurement" && m.id === s.id) &&
            !uses(m.from) &&
            !uses(m.to),
        ),
        guides: doc.guides.filter(
          (g) =>
            !(s.kind === "guide" && g.id === s.id) &&
            !(g.center.kind !== "point" && uses(g.center)),
        ),
      };
      break;
    }
  }
  // ponytail: small screenshot documents; replace this O(n) comparison only if profiling warrants it.
  return JSON.stringify(next) === JSON.stringify(doc) ? doc : next;
}
export interface History {
  past: readonly AnalysisDocument[];
  present: AnalysisDocument;
  future: readonly AnalysisDocument[];
}
export const newHistory = (doc = emptyDocument()): History => ({
  past: [],
  present: doc,
  future: [],
});
export function commit(history: History, next: AnalysisDocument): History {
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history;
  // ponytail: keep the most recent 100 edits; image resources never enter snapshots.
  return {
    past: [...history.past, history.present].slice(-100),
    present: next,
    future: [],
  };
}
export function undo(h: History): History {
  const previous = h.past.at(-1);
  return previous
    ? {
        past: h.past.slice(0, -1),
        present: previous,
        future: [h.present, ...h.future],
      }
    : h;
}
export function redo(h: History): History {
  const next = h.future[0];
  return next
    ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) }
    : h;
}
export function endpointName(doc: AnalysisDocument, e: Endpoint): string {
  return (
    (e.kind === "pin"
      ? doc.pins.find((p) => p.id === e.id)?.name
      : doc.groups.find((g) => g.id === e.id)?.name) || "名称なし"
  );
}
export const formatDistance = (
  value: number | null,
  doc: AnalysisDocument,
): string =>
  value === null
    ? "距離スケール未設定"
    : new Intl.NumberFormat("ja-JP", {
        minimumFractionDigits: doc.reference?.radiusGame ? 2 : 4,
        maximumFractionDigits: doc.reference?.radiusGame ? 2 : 4,
      }).format(value);
