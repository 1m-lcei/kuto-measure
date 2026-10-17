export interface EdgePoint {
  x: number;
  y: number;
  tolerance: number;
}
export interface CircleFit {
  x: number;
  y: number;
  radius: number;
}
export interface CircleSimd {
  memory: WebAssembly.Memory;
  count: (length: number, x: number, y: number, radius: number) => number;
}

export async function loadCircleSimd(
  bytes: BufferSource,
): Promise<CircleSimd | undefined> {
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
    return instance.exports as unknown as CircleSimd;
  } catch {
    return undefined;
  }
}

export function onCircle(point: EdgePoint, circle: CircleFit): boolean {
  const dx = point.x - circle.x,
    dy = point.y - circle.y,
    t = point.tolerance;
  return (
    Math.abs(dx * dx + dy * dy - circle.radius * circle.radius) <=
    2 * circle.radius * t + t * t
  );
}

export function circleScorer(points: readonly EdgePoint[], simd?: CircleSimd) {
  if (!simd)
    return (circle: CircleFit) => {
      let count = 0;
      for (const point of points) if (onCircle(point, circle)) count++;
      return count;
    };
  const n = points.length + (points.length % 2),
    bytes = n * 24;
  if (simd.memory.buffer.byteLength < bytes)
    simd.memory.grow(
      Math.ceil((bytes - simd.memory.buffer.byteLength) / 65536),
    );
  const data = new Float64Array(simd.memory.buffer, 0, n * 3);
  // The scorer is used only until the next component replaces this shared buffer.
  data.fill(Number.NaN);
  for (let i = 0; i < points.length; i++) {
    data[i] = points[i].x;
    data[n + i] = points[i].y;
    data[n * 2 + i] = points[i].tolerance;
  }
  return (circle: CircleFit) =>
    simd.count(n, circle.x, circle.y, circle.radius);
}
