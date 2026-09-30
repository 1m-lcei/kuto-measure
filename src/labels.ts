import type { ImagePoint, ImageRect } from "./geometry";

export const LABEL_FONT = "12px system-ui, sans-serif";
export const DENSE_LABELS =
  "ラベルが密集しています。拡大するかオブジェクト一覧で確認してください。";
export type MeasureLabel = (text: string) => {
  width: number;
  ascent: number;
  descent: number;
  left?: number;
};
export function canvasLabelMeasure(
  ctx: CanvasRenderingContext2D,
): MeasureLabel {
  return (text) => {
    ctx.font = LABEL_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const m = ctx.measureText(text);
    return {
      width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
      left: m.actualBoundingBoxLeft,
    };
  };
}
export interface Label {
  key: string;
  text: string;
  name: string;
  color: string;
  anchor: ImagePoint;
  dx: number;
  dy: number;
}
export interface LabelBox extends ImageRect {
  label: Label;
  text: string;
  textX: number;
  baseline: number;
  leader: LabelLine | null;
}
type Point = Pick<ImagePoint, "x" | "y">;
export interface LabelLine {
  start: Point;
  end: Point;
}
export const overlapArea = (a: ImageRect, b: ImageRect, gap = 0): number =>
  Math.max(
    0,
    Math.min(a.x + a.width + gap, b.x + b.width) - Math.max(a.x - gap, b.x),
  ) *
  Math.max(
    0,
    Math.min(a.y + a.height + gap, b.y + b.height) - Math.max(a.y - gap, b.y),
  );

// Clip a segment against the padded rectangle (including parallel/zero-length lines).
export function lineHitsRect(
  line: LabelLine,
  rect: ImageRect,
  gap = 0,
): boolean {
  let low = 0,
    high = 1;
  for (const axis of ["x", "y"] as const) {
    const start = line.start[axis],
      delta = line.end[axis] - start,
      min = rect[axis] - gap,
      max = rect[axis] + (axis === "x" ? rect.width : rect.height) + gap;
    if (Math.abs(delta) < 1e-9) {
      if (start < min || start > max) return false;
    } else {
      const a = (min - start) / delta,
        b = (max - start) / delta;
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
      if (low > high) return false;
    }
  }
  return true;
}

function linesOverlap(a: LabelLine, b: LabelLine): boolean {
  const dx = b.end.x - b.start.x,
    dy = b.end.y - b.start.y,
    length = Math.hypot(dx, dy);
  if (length < 1e-9)
    return lineHitsRect(a, { ...b.start, width: 0, height: 0 }, 2);
  const local = (p: Point) => ({
    x: ((p.x - b.start.x) * dx + (p.y - b.start.y) * dy) / length,
    y: ((p.y - b.start.y) * dx - (p.x - b.start.x) * dy) / length,
  });
  return lineHitsRect(
    { start: local(a.start), end: local(a.end) },
    { x: 0, y: 0, width: length, height: 0 },
    2,
  );
}

export function layoutLabels(
  labels: readonly Label[],
  area: ImageRect,
  zoom: number,
  obstacles: readonly ImageRect[],
  measure: MeasureLabel,
  lines: readonly LabelLine[] = [],
): { boxes: LabelBox[]; crowded: boolean } {
  const boxes: LabelBox[] = [];
  let crowded = false;
  const bounds = {
    x: area.x * zoom + 4,
    y: area.y * zoom + 4,
    width: Math.max(0, area.width * zoom - 8),
    height: Math.max(0, area.height * zoom - 8),
  };
  const blockers = obstacles.map((r) => ({
    x: r.x * zoom,
    y: r.y * zoom,
    width: r.width * zoom,
    height: r.height * zoom,
  }));
  const scaled = (point: Point) => ({ x: point.x * zoom, y: point.y * zoom });
  const strokes = lines.map((line) => ({
    start: scaled(line.start),
    end: scaled(line.end),
  }));
  const rank: Record<string, number> = {
    pin: 0,
    group: 1,
    measurement: 2,
    reference: 3,
    guide: 4,
  };
  const ordered = [...labels].sort(
    (a, b) => rank[a.key.split(":")[0]] - rank[b.key.split(":")[0]],
  );
  for (const label of ordered) {
    let text = label.text,
      metrics = measure(text);
    if (metrics.width + 11 > bounds.width) {
      const segments = [
        ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
      ].map((s) => s.segment);
      let low = 0,
        high = segments.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (
          measure(`${segments.slice(0, mid).join("")}…`).width + 11 <=
          bounds.width
        )
          low = mid;
        else high = mid - 1;
      }
      text = `${segments.slice(0, low).join("")}…`;
      metrics = measure(text);
    }
    const width = Math.max(24, metrics.width + 11),
      height = Math.max(24, metrics.ascent + metrics.descent + 11);
    const ax = label.anchor.x * zoom,
      ay = label.anchor.y * zoom;
    const padX = (width - metrics.width) / 2,
      padY = (height - metrics.ascent - metrics.descent) / 2,
      originalX = ax + label.dx - padX,
      originalY = ay + label.dy - metrics.ascent - padY;
    const makeBox = (x: number, y: number): LabelBox => {
      x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width));
      y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height));
      // Connect to the visible text halo, not the larger invisible hit target.
      const end = {
        x: Math.max(x + padX - 2, Math.min(ax, x + padX + metrics.width + 2)),
        y: Math.max(y + padY - 2, Math.min(ay, y + height - padY + 2)),
      };
      const length = Math.hypot(end.x - ax, end.y - ay);
      const shifted =
        Math.abs(x - originalX) > 0.1 || Math.abs(y - originalY) > 0.1;
      return {
        x,
        y,
        width,
        height,
        label,
        text,
        textX: x + padX + (metrics.left ?? 0),
        baseline: y + padY + metrics.ascent,
        leader:
          shifted && length > 9
            ? {
                start: { x: ax, y: ay },
                end,
              }
            : null,
      };
    };
    let best = makeBox(originalX, originalY),
      bestScore = Infinity,
      bestOverlap = Infinity;
    const consider = (candidate: LabelBox) => {
      let leader = candidate.leader;
      const dx = leader ? leader.end.x - ax : 0,
        dy = leader ? leader.end.y - ay : 0,
        length = Math.hypot(dx, dy);
      // Prefer oblique leaders so coincident pins do not look like coordinate axes.
      // Collisions still cost much more; horizontal/vertical routes remain fallbacks.
      const angleCost = leader
        ? 30 * (1 - (2 * Math.abs(dx * dy)) / length ** 2)
        : 0;
      const travel =
        Math.hypot(candidate.x - originalX, candidate.y - originalY) * 0.25 +
        length +
        angleCost;
      if (travel >= bestScore) return;
      if (leader) {
        // Ignore unavoidable contact at the shared anchor when scoring routes.
        leader = {
          start: { x: ax + (dx * 9) / length, y: ay + (dy * 9) / length },
          end: leader.end,
        };
      }
      let overlap = 0,
        crossings = 0;
      for (const obstacle of blockers) {
        overlap += overlapArea(candidate, obstacle, 4);
        const ownsAnchor =
          ax >= obstacle.x &&
          ax <= obstacle.x + obstacle.width &&
          ay >= obstacle.y &&
          ay <= obstacle.y + obstacle.height;
        if (leader && !ownsAnchor && lineHitsRect(leader, obstacle, 2))
          crossings++;
        // Remaining penalties are nonnegative: this candidate cannot beat best.
        if (overlap * 1000 + crossings * 200 + travel >= bestScore) return;
      }
      for (const box of boxes) {
        overlap += overlapArea(candidate, box, 4);
        if (leader && lineHitsRect(leader, box, 2)) crossings++;
        if (box.leader && lineHitsRect(box.leader, candidate, 2)) crossings++;
        if (leader && box.leader && linesOverlap(leader, box.leader))
          crossings++;
        if (overlap * 1000 + crossings * 200 + travel >= bestScore) return;
      }
      for (const line of strokes) {
        if (lineHitsRect(line, candidate, 3)) crossings += 4;
        if (leader && linesOverlap(leader, line)) crossings++;
        if (overlap * 1000 + crossings * 200 + travel >= bestScore) return;
      }
      const score = overlap * 1000 + crossings * 200 + travel;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
        bestOverlap = overlap;
      }
    };
    consider(best);
    // ponytail: bounded greedy search (257 candidates), not global packing; add a spatial index/optimizer if large dense documents need it.
    for (let ring = 0; ring < 16; ring++) {
      const gap = 12 + ring * 16;
      for (let direction = 0; direction < 16; direction++) {
        const angle = -Math.PI / 4 + (direction * Math.PI) / 8,
          dx = Math.cos(angle),
          dy = Math.sin(angle);
        consider(
          makeBox(
            ax +
              (Math.abs(dx) < 1e-9
                ? -width / 2
                : dx * gap - (dx < 0 ? width : 0)),
            ay +
              (Math.abs(dy) < 1e-9
                ? -height / 2
                : dy * gap - (dy < 0 ? height : 0)),
          ),
        );
      }
    }
    crowded ||=
      bestOverlap > 0 || width > bounds.width || height > bounds.height;
    boxes.push(best);
  }
  return { boxes, crowded };
}
