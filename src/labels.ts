import type { ImagePoint, ImageRect } from "./geometry";

export const LABEL_FONT = "12px system-ui, sans-serif";
export const DENSE_LABELS =
  "ラベルが密集しています。拡大するかオブジェクト一覧で確認してください。";
export type MeasureLabel = (text: string) => {
  width: number;
  ascent: number;
  descent: number;
};
export function canvasLabelMeasure(
  ctx: CanvasRenderingContext2D,
): MeasureLabel {
  return (text) => {
    ctx.font = LABEL_FONT;
    const m = ctx.measureText(text);
    return {
      width: Math.max(
        m.width,
        m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
      ),
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
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
  baseline: number;
  shifted: boolean;
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

export function layoutLabels(
  labels: readonly Label[],
  area: ImageRect,
  zoom: number,
  obstacles: readonly ImageRect[],
  measure: MeasureLabel,
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
    const originalX = ax + label.dx - 5.5,
      originalY = ay + label.dy - metrics.ascent - 5.5;
    let right = originalX;
    for (const obstacle of blockers) {
      if (
        ax >= obstacle.x &&
        ax <= obstacle.x + obstacle.width &&
        ay >= obstacle.y &&
        ay <= obstacle.y + obstacle.height
      )
        right = Math.max(right, obstacle.x + obstacle.width + 4);
    }
    const left = ax - (right - ax) - width;
    const sides =
      right + width <= bounds.x + bounds.width ? [right, left] : [left, right];
    let best: ImageRect | null = null,
      bestScore = Infinity;
    // ponytail: at most 256 candidates per label, O(n²) for small documents; use a spatial index/packing if dense maps become common.
    for (const side of sides) {
      const x = Math.max(
        bounds.x,
        Math.min(side, bounds.x + bounds.width - width),
      );
      const startY = Math.max(
        bounds.y,
        Math.min(originalY, bounds.y + bounds.height - height),
      );
      for (let i = 0; i < 128; i++) {
        const offset = i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 ? 1 : -1);
        const y = startY + offset * (height + 4);
        if (
          y < bounds.y ||
          y + height > bounds.y + bounds.height ||
          width > bounds.width
        )
          continue;
        const candidate = { x, y, width, height };
        let score = 0;
        for (const obstacle of blockers)
          score += overlapArea(candidate, obstacle, 4);
        for (const box of boxes) score += overlapArea(candidate, box, 4);
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
        if (score === 0) break;
      }
      if (bestScore === 0) break;
    }
    crowded ||= bestScore !== 0;
    const rect = best ?? { x: bounds.x, y: bounds.y, width, height };
    boxes.push({
      ...rect,
      label,
      text,
      baseline: rect.y + 5.5 + metrics.ascent,
      shifted:
        Math.abs(rect.x - originalX) > 0.1 ||
        Math.abs(rect.y - originalY) > 0.1,
    });
  }
  return { boxes, crowded };
}
