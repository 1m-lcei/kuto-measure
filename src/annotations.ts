import {
  circlePoint,
  groundPoint,
  groundToImage,
  type ImagePoint,
  type Projection,
  projectCircle,
} from "./geometry";
import {
  DENSE_LABELS,
  type Label,
  type LabelBox,
  type LabelLine,
  layoutLabels,
  type MeasureLabel,
  overlapArea,
} from "./labels";
import {
  type AnalysisDocument,
  centroid,
  endpointName,
  formatDistance,
  measuredDistance,
  resolveCenter,
  scaleFactor,
} from "./model";

export interface Marker {
  key: string;
  name: string;
  color: string;
  point: ImagePoint;
  shape: "cross" | "diamond" | "circle";
  movable?: boolean;
  handle?: "center" | "radius";
  angle?: number;
}
export interface Circle {
  key: string;
  name: string;
  color: string;
  path: string;
  points: ImagePoint[];
}
export interface Line {
  key: string;
  name: string;
  start: ImagePoint;
  end: ImagePoint;
}
export interface Annotations {
  circles: Circle[];
  lines: Line[];
  markers: Marker[];
  labels: LabelBox[];
  warnings: string[];
}

// Shared by Svelte and PNG. Selection, hover and pan never invalidate label packing.
export function prepareAnnotations(
  doc: AnalysisDocument,
  p: Projection,
  zoom: number,
  measure: MeasureLabel,
  interactive = true,
  coarse = false,
): Annotations {
  const circles: Circle[] = [],
    lines: Line[] = [],
    markers: Marker[] = [];
  const labels: Label[] = [],
    obstacles: Projection["renderArea"][] = [],
    labelLines: LabelLine[] = [],
    warnings: string[] = [];
  const typeNames: Record<string, string> = {
    pin: "ピン",
    group: "グループ",
    measurement: "測距線",
    reference: "基準円",
    guide: "補助円",
  };
  const addLabel = (
    anchor: ImagePoint,
    text: string,
    key: string,
    color: string,
    dx = 10,
    dy = -10,
    detail = "",
  ) => {
    labels.push({
      anchor,
      text,
      key,
      color,
      dx,
      dy,
      name: `${typeNames[key.split(":")[0]]} ${detail} ${text}`.trim(),
    });
  };
  const circle = (
    center: Parameters<typeof projectCircle>[0],
    radius: number,
    key: string,
    name: string,
    color: string,
  ) => {
    const sample = projectCircle(
      center,
      radius,
      p,
      interactive ? 0.5 / zoom : 0.25,
    );
    if (!sample) {
      warnings.push(`${name}：円がカメラ前方に収まりません。`);
      return;
    }
    if (sample.limited)
      warnings.push(`${name}：円の描画精度が分割上限に達しました。`);
    circles.push({
      key,
      name,
      color,
      points: sample.points,
      path: `M${sample.points.map((q) => `${q.x},${q.y}`).join("L")}Z`,
    });
    sample.points.forEach((start, i) => {
      labelLines.push({
        start,
        end: sample.points[(i + 1) % sample.points.length],
      });
    });
    const anchor = groundToImage(center, p);
    if (anchor) addLabel(anchor, name, key, color, 12, 18);
  };
  const scale = scaleFactor(doc);
  for (const guide of doc.guides) {
    const center = resolveCenter(doc, guide.center);
    if (center && scale)
      circle(
        center,
        guide.radiusGame / scale,
        `guide:${guide.id}`,
        `半径 ${formatDistance(guide.radiusGame, doc)}`,
        "#e5a63f",
      );
  }
  if (doc.reference) {
    const r = doc.reference;
    circle(
      r.center,
      r.radiusGround,
      "reference",
      `基準円 ${r.radiusGame === null ? "距離スケール未設定" : formatDistance(r.radiusGame, doc)}`,
      "#e875b9",
    );
  }
  for (const measurement of doc.measurements) {
    const a = resolveCenter(doc, measurement.from),
      b = resolveCenter(doc, measurement.to);
    if (!a || !b) continue;
    const start = groundToImage(a, p),
      end = groundToImage(b, p),
      mid = groundToImage(groundPoint((a.x + b.x) / 2, (a.y + b.y) / 2), p);
    if (!start || !end || !mid) continue;
    const key = `measurement:${measurement.id}`,
      name = `${endpointName(doc, measurement.from)} → ${endpointName(doc, measurement.to)}`;
    labelLines.push({ start, end });
    lines.push({ key, name, start, end });
    addLabel(
      mid,
      formatDistance(measuredDistance(doc, measurement), doc),
      key,
      "#56c7e9",
      6,
      -8,
      name,
    );
  }
  const marker = (
    point: ImagePoint,
    key: string,
    name: string,
    color: string,
    shape: Marker["shape"],
    movable = false,
  ) => {
    const hit = (coarse ? 22 : 16) / zoom;
    obstacles.push({
      x: point.x - hit,
      y: point.y - hit,
      width: 2 * hit,
      height: 2 * hit,
    });
    markers.push({ point, key, name, color, shape, movable });
    addLabel(point, name, key, color);
  };
  for (const group of doc.groups) {
    const center = centroid(doc, group.id),
      point = center && groundToImage(center, p);
    if (point)
      marker(
        point,
        `group:${group.id}`,
        group.name || "グループ",
        "#7e9efa",
        "diamond",
      );
  }
  for (const pin of doc.pins) {
    const point = groundToImage(pin.point, p);
    if (point)
      marker(
        point,
        `pin:${pin.id}`,
        pin.name || "ピン",
        "#18b69b",
        "cross",
        true,
      );
  }
  const layout = layoutLabels(
    labels,
    p.renderArea,
    zoom,
    obstacles,
    measure,
    labelLines,
  );
  if (layout.crowded) warnings.push(DENSE_LABELS);
  return { circles, lines, markers, labels: layout.boxes, warnings };
}

export function referenceHandles(
  doc: AnalysisDocument,
  p: Projection,
  selected: string,
  scene: Annotations,
  visible?: { left: number; top: number; right: number; bottom: number },
): Marker[] {
  const controls: Marker[] = [];
  if (selected.startsWith("guide:")) {
    const guide = doc.guides.find((g) => `guide:${g.id}` === selected);
    const point =
      guide?.center.kind === "point" && scaleFactor(doc)
        ? groundToImage(guide.center.point, p)
        : null;
    if (point)
      controls.push({
        point,
        key: selected,
        name: "中心",
        color: "#e5a63f",
        shape: "cross",
        movable: true,
      });
  }
  if (selected !== "reference" || !doc.reference) return controls;
  const r = doc.reference,
    center = groundToImage(r.center, p);
  const add = (
    point: ImagePoint,
    handle: "center" | "radius",
    angle?: number,
  ) =>
    controls.push({
      point,
      key: "reference",
      name: handle === "center" ? "中心" : "半径",
      color: "#e875b9",
      shape: handle === "center" ? "cross" : "circle",
      handle,
      angle,
    });
  if (center) add(center, "center");
  const isVisible = (q: ImagePoint) =>
    !visible ||
    (q.x >= visible.left &&
      q.x <= visible.right &&
      q.y >= visible.top &&
      q.y <= visible.bottom);
  let handles = 0;
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2,
      point = groundToImage(circlePoint(r.center, r.radiusGround, angle), p);
    if (point && isVisible(point)) {
      add(point, "radius", angle);
      handles++;
    }
  }
  const points = scene.circles.find((c) => c.key === "reference")?.points ?? [];
  if (!handles && points.length) {
    let run: ImagePoint[] = [],
      best: ImagePoint[] = [];
    for (const point of [...points, ...points]) {
      if (isVisible(point)) {
        run.push(point);
        if (run.length > best.length) best = run.slice();
      } else run = [];
    }
    const point = best[Math.floor(best.length / 2)];
    if (point) add(point, "radius");
  }
  return controls;
}

export function captionVisible(
  marker: Marker,
  labels: LabelBox[],
  zoom: number,
  measure: MeasureLabel,
) {
  const m = measure(marker.name);
  const rect = {
    x: marker.point.x * zoom + 8,
    y: marker.point.y * zoom - 12 - m.ascent,
    width: m.width + 4,
    height: m.ascent + m.descent + 4,
  };
  return !labels.some((box) => overlapArea(rect, box) > 0);
}
export const crossPath = (q: ImagePoint, z: number) =>
  `M${q.x - 6 / z},${q.y - 6 / z}l${12 / z},${12 / z}M${q.x - 6 / z},${q.y + 6 / z}l${12 / z},${-12 / z}`;
export const diamondPath = (q: ImagePoint, z: number) =>
  `M${q.x},${q.y - 7 / z}l${7 / z},${7 / z}l${-7 / z},${7 / z}l${-7 / z},${-7 / z}Z`;
export function boundaryPath(p: Projection) {
  const a = p.renderArea,
    right = a.x + a.width,
    bottom = a.y + a.height;
  return [
    a.x > 0 ? `M${a.x},0V${p.size.height}` : "",
    right < p.size.width ? `M${right},0V${p.size.height}` : "",
    a.y > 0 ? `M0,${a.y}H${p.size.width}` : "",
    bottom < p.size.height ? `M0,${bottom}H${p.size.width}` : "",
  ].join("");
}
export const previewPath = (p: Projection, a: Projection["renderArea"]) =>
  `M0,0H${p.size.width}V${p.size.height}H0ZM${a.x},${a.y}h${a.width}v${a.height}h${-a.width}Z`;
