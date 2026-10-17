import type { ImageRect } from "./geometry";

export interface LabelLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface LabelSimd {
  memory: WebAssembly.Memory;
  count: (
    length: number,
    x: number,
    y: number,
    width: number,
    height: number,
    leader: number,
    sx: number,
    sy: number,
    ex: number,
    ey: number,
    crossings: number,
    overlap: number,
    travel: number,
    best: number,
  ) => number;
}
export let labelSimd: LabelSimd | undefined;
let residentData: Float64Array | undefined;
let residentMemory: ArrayBuffer | undefined;

export async function loadLabelSimd(
  bytes: BufferSource,
): Promise<LabelSimd | undefined> {
  try {
    if (!WebAssembly.validate(bytes)) return undefined;
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(bytes),
    );
    if (
      !(instance.exports.memory instanceof WebAssembly.Memory) ||
      typeof instance.exports.count !== "function"
    )
      return undefined;
    labelSimd = instance.exports as unknown as LabelSimd;
    return labelSimd;
  } catch {
    return undefined;
  }
}

// Keep the clipping order and parallel/zero-length behavior identical to the layout scorer.
export function lineHitsRect(
  line: LabelLine,
  rect: ImageRect,
  gap = 0,
): boolean {
  let low = 0,
    high = 1;
  const dx = line.end.x - line.start.x,
    dy = line.end.y - line.start.y;
  if (Math.abs(dx) < 1e-9) {
    if (line.start.x < rect.x - gap || line.start.x > rect.x + rect.width + gap)
      return false;
  } else {
    const a = (rect.x - gap - line.start.x) / dx,
      b = (rect.x + rect.width + gap - line.start.x) / dx;
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
    if (low > high) return false;
  }
  if (Math.abs(dy) < 1e-9) {
    if (
      line.start.y < rect.y - gap ||
      line.start.y > rect.y + rect.height + gap
    )
      return false;
  } else {
    const a = (rect.y - gap - line.start.y) / dy,
      b = (rect.y + rect.height + gap - line.start.y) / dy;
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
    if (low > high) return false;
  }
  return true;
}

function prepareLine(line: LabelLine) {
  const dx = line.end.x - line.start.x,
    dy = line.end.y - line.start.y;
  return { ...line, dx, dy, length: Math.hypot(dx, dy) };
}

export function linesOverlap(
  a: LabelLine,
  b: LabelLine,
  frame = prepareLine(b),
): boolean {
  const { dx, dy, length } = frame;
  if (length < 1e-9)
    return lineHitsRect(a, { ...b.start, width: 0, height: 0 }, 2);
  const local = (p: LabelLine["start"]) => ({
    x: ((p.x - b.start.x) * dx + (p.y - b.start.y) * dy) / length,
    y: ((p.y - b.start.y) * dx - (p.x - b.start.x) * dy) / length,
  });
  return lineHitsRect(
    { start: local(a.start), end: local(a.end) },
    { x: 0, y: 0, width: length, height: 0 },
    2,
  );
}

export function labelStrokeScorer(
  lines: readonly LabelLine[],
  simd: LabelSimd | undefined,
) {
  const strokes = lines.map(prepareLine);
  const n = lines.length + (lines.length % 2);
  // Each layout owns its buffer so a nested layout from a text measurer cannot overwrite it.
  let data: Float64Array | undefined;
  if (simd && n) {
    try {
      const bytes = n * 40;
      if (simd.memory.buffer.byteLength < bytes)
        simd.memory.grow(
          Math.ceil((bytes - simd.memory.buffer.byteLength) / 65536),
        );
      data = new Float64Array(n * 5);
      for (let i = 0; i < strokes.length; i++) {
        const line = strokes[i];
        data[i] = line.start.x;
        data[n + i] = line.start.y;
        data[n * 2 + i] = line.dx;
        data[n * 3 + i] = line.dy;
        data[n * 4 + i] = line.length;
      }
    } catch {
      data = undefined;
    }
  }
  return (
    rect: ImageRect,
    leader: LabelLine | null,
    crossings: number,
    overlap: number,
    travel: number,
    best: number,
  ): number => {
    if (simd && data) {
      if (residentData !== data || residentMemory !== simd.memory.buffer) {
        new Float64Array(simd.memory.buffer, 0, data.length).set(data);
        residentData = data;
        residentMemory = simd.memory.buffer;
      }
      return simd.count(
        lines.length,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        Number(!!leader),
        leader?.start.x ?? 0,
        leader?.start.y ?? 0,
        leader?.end.x ?? 0,
        leader?.end.y ?? 0,
        crossings,
        overlap,
        travel,
        best,
      );
    }
    for (const line of strokes) {
      if (lineHitsRect(line, rect, 3)) crossings += 4;
      if (leader && linesOverlap(leader, line, line)) crossings++;
      if (overlap * 1000 + crossings * 200 + travel >= best) break;
    }
    return crossings;
  };
}
