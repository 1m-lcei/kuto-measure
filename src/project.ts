import {
  buildProjection,
  circleValid,
  gameDistance,
  groundLength,
  groundPoint,
  type Size,
} from "./geometry";
import {
  type AnalysisDocument,
  applyEdit,
  type Endpoint,
  emptyDocument,
  type RenderAreaSetting,
  validateRenderArea,
} from "./model";

export function serializeProject(
  document: AnalysisDocument,
  size: Size,
): string {
  return JSON.stringify(
    {
      version: 1,
      imageSize: { width: size.width, height: size.height },
      document,
    },
    null,
    2,
  );
}

export function parseProject(raw: string): {
  imageSize: Size;
  document: AnalysisDocument;
} {
  const invalid = () =>
    new Error(
      "編集JSONの形式または数値が不正です。対応するバージョンは1です。",
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
  const string = (value: unknown): string => {
    if (typeof value !== "string") throw invalid();
    return value;
  };
  const point = (value: unknown) => {
    const p = record(value);
    if (p.space !== "ground") throw invalid();
    return groundPoint(number(p.x), number(p.y));
  };
  const endpoint = (value: unknown): Endpoint => {
    const e = record(value);
    if (e.kind !== "pin" && e.kind !== "group") throw invalid();
    return { kind: e.kind, id: string(e.id) };
  };
  const items = (
    value: unknown,
  ): (Record<string, unknown> & { id: string })[] => {
    if (!Array.isArray(value)) throw invalid();
    const ids = new Set<string>();
    return value.map((item: unknown) => {
      const r = record(item),
        id = string(r.id);
      if (!id || ids.has(id)) throw invalid();
      ids.add(id);
      return { ...r, id };
    });
  };
  try {
    const root = record(JSON.parse(raw));
    if (root.version !== 1) throw invalid();
    const s = record(root.imageSize);
    const imageSize = { width: number(s.width), height: number(s.height) };
    if (
      ![imageSize.width, imageSize.height].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw invalid();
    const d = record(root.document),
      c = record(d.calibration),
      principal = record(c.principalPoint);
    let renderArea: RenderAreaSetting | null = null;
    if (d.renderArea !== null) {
      const a = record(d.renderArea),
        b = record(a.bounds);
      if (
        (a.source !== "auto" &&
          a.source !== "manual" &&
          a.source !== "full" &&
          a.source !== "fallback") ||
        typeof a.confirmed !== "boolean"
      )
        throw invalid();
      const bounds = {
        x: number(b.x),
        y: number(b.y),
        width: number(b.width),
        height: number(b.height),
      };
      validateRenderArea(bounds, imageSize);
      renderArea = { bounds, source: a.source, confirmed: a.confirmed };
    }
    let doc: AnalysisDocument = {
      ...emptyDocument(),
      renderArea,
      calibration: {
        elevationDegrees: number(c.elevationDegrees),
        rollDegrees: number(c.rollDegrees),
        verticalFovDegrees: number(c.verticalFovDegrees),
        principalPoint: { x: number(principal.x), y: number(principal.y) },
      },
    };
    const projection = buildProjection(
      doc.calibration,
      imageSize,
      renderArea?.bounds,
    );
    for (const g of items(d.groups))
      doc = applyEdit(doc, {
        type: "group",
        value: { id: g.id, name: string(g.name) },
      });
    for (const p of items(d.pins)) {
      const groupId = p.groupId === null ? null : string(p.groupId);
      if (groupId !== null && !doc.groups.some((g) => g.id === groupId))
        throw invalid();
      doc = applyEdit(doc, {
        type: "pin",
        value: {
          id: p.id,
          name: string(p.name),
          point: point(p.point),
          groupId,
        },
      });
    }
    for (const m of items(d.measurements))
      doc = applyEdit(doc, {
        type: "measurement",
        value: { id: m.id, from: endpoint(m.from), to: endpoint(m.to) },
      });
    for (const g of items(d.guides)) {
      const center = record(g.center);
      doc = applyEdit(doc, {
        type: "guide",
        value: {
          id: g.id,
          radiusGame: gameDistance(number(g.radiusGame)),
          center:
            center.kind === "point"
              ? { kind: "point", point: point(center.point) }
              : endpoint(center),
        },
      });
    }
    if (d.reference !== null) {
      const r = record(d.reference);
      doc = applyEdit(doc, {
        type: "reference",
        value: {
          center: point(r.center),
          radiusGround: groundLength(number(r.radiusGround)),
          radiusGame:
            r.radiusGame === null ? null : gameDistance(number(r.radiusGame)),
        },
      });
      if (
        doc.reference &&
        !circleValid(
          doc.reference.center,
          doc.reference.radiusGround,
          projection,
        )
      )
        throw invalid();
    }
    return { imageSize, document: doc };
  } catch {
    throw invalid();
  }
}

export function fitProjectArea(
  doc: AnalysisDocument,
  saved: Size,
  current: Size,
): AnalysisDocument {
  if (
    !doc.renderArea ||
    (saved.width === current.width && saved.height === current.height)
  )
    return doc;
  const b = doc.renderArea.bounds;
  const x = Math.min(
    current.width - 1,
    Math.round((b.x / saved.width) * current.width),
  );
  const y = Math.min(
    current.height - 1,
    Math.round((b.y / saved.height) * current.height),
  );
  const width = Math.max(
    1,
    Math.round(((b.x + b.width) / saved.width) * current.width) - x,
  );
  const height = Math.max(
    1,
    Math.round(((b.y + b.height) / saved.height) * current.height) - y,
  );
  return {
    ...doc,
    renderArea: {
      ...doc.renderArea,
      bounds: { x, y, width, height },
      confirmed: false,
    },
  };
}
