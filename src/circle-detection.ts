import {
  type CircleFit,
  type CircleSimd,
  circleScorer,
  type EdgePoint,
  onCircle,
} from "./circle-score";
import {
  circlePoint,
  circleValid,
  distance,
  type GroundLength,
  type GroundPoint,
  groundLength,
  groundPoint,
  groundToImage,
  imagePoint,
  imageToGround,
  inRect,
  type Projection,
} from "./geometry";

export interface DetectedCircle {
  center: GroundPoint;
  radiusGround: GroundLength;
  coverage: number;
}
export const DETECTION_MAX_SIDE = 1000;
interface Edge extends EdgePoint {
  nx: number;
  ny: number;
}

// Centered least squares avoids cancellation for circles far from the ground origin.
function fitCircle(points: readonly EdgePoint[]): CircleFit | null {
  if (points.length < 3) return null;
  let mx = 0,
    my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;
  let xx = 0,
    xy = 0,
    yy = 0,
    xz = 0,
    yz = 0;
  for (const p of points) {
    const x = p.x - mx,
      y = p.y - my,
      z = x * x + y * y;
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xz += x * z;
    yz += y * z;
  }
  const determinant = xx * yy - xy * xy;
  if (determinant <= (xx + yy) ** 2 * 1e-6) return null;
  const x = (yy * xz - xy * yz) / (2 * determinant);
  const y = (xx * yz - xy * xz) / (2 * determinant);
  const radius = Math.sqrt((xx + yy) / points.length + x * x + y * y);
  return Number.isFinite(radius) && radius > 0
    ? { x: mx + x, y: my + y, radius }
    : null;
}

function fitNormalCircle(a: Edge, b: Edge): CircleFit | null {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    denominator = 2 * (dx * a.nx + dy * a.ny);
  if (Math.abs(denominator) < Math.hypot(dx, dy) * 0.2) return null;
  const offset = (dx * dx + dy * dy) / denominator;
  if (!Number.isFinite(offset)) return null;
  return {
    x: a.x + offset * a.nx,
    y: a.y + offset * a.ny,
    radius: Math.abs(offset),
  };
}

export function detectCircles(
  pixels: Pick<ImageData, "width" | "height" | "data">,
  projection: Projection,
  simd?: CircleSimd,
): DetectedCircle[] {
  const { width, height, data } = pixels,
    area = projection.renderArea;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 3 ||
    height < 3 ||
    width > DETECTION_MAX_SIDE ||
    height > DETECTION_MAX_SIDE ||
    data.length !== width * height * 4
  )
    throw new Error("円検出用の画像サイズが不正です。");
  const sx = area.width / width,
    sy = area.height / height;
  const toGround = (x: number, y: number) =>
    imageToGround(
      imagePoint(area.x + (x + 0.5) * sx, area.y + (y + 0.5) * sy),
      projection,
    );
  const strength = new Float32Array(width * height);
  const gx = new Float32Array(strength.length),
    gy = new Float32Array(strength.length);
  // RGB gradients also retain colored outlines with little luminance contrast.
  const channel = (i: number, c: number) =>
    (data[i * 4 + c] * data[i * 4 + 3]) / 255;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      for (let c = 0; c < 3; c++) {
        const dx =
          (channel(i - width + 1, c) +
            2 * channel(i + 1, c) +
            channel(i + width + 1, c) -
            channel(i - width - 1, c) -
            2 * channel(i - 1, c) -
            channel(i + width - 1, c)) /
          8;
        const dy =
          (channel(i + width - 1, c) +
            2 * channel(i + width, c) +
            channel(i + width + 1, c) -
            channel(i - width - 1, c) -
            2 * channel(i - width, c) -
            channel(i - width + 1, c)) /
          8;
        const magnitude = Math.hypot(dx, dy);
        if (magnitude > strength[i]) {
          strength[i] = magnitude;
          gx[i] = dx;
          gy[i] = dy;
        }
      }
    }
  const edges: Edge[] = [],
    grid = new Int32Array(strength.length);
  grid.fill(-1);
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x,
        magnitude = strength[i];
      if (magnitude < 14) continue;
      const dx = gx[i] / magnitude,
        dy = gy[i] / magnitude;
      const step = Math.round(dy) * width + Math.round(dx);
      if (magnitude < strength[i - step] || magnitude < strength[i + step])
        continue;
      const p = toGround(x, y),
        tangent = toGround(x - dy, y + dx),
        normal = toGround(x + dx, y + dy);
      if (!p || !tangent || !normal) continue;
      const length = distance(p, tangent);
      if (!length) continue;
      const nx = (tangent.y - p.y) / length,
        ny = (p.x - tangent.x) / length;
      const tolerance =
        1.8 * Math.abs((normal.x - p.x) * nx + (normal.y - p.y) * ny);
      if (!Number.isFinite(tolerance) || tolerance <= 0) continue;
      grid[i] = edges.length;
      edges.push({ x: p.x, y: p.y, tolerance, nx, ny });
    }
  const components: Edge[][] = [],
    visited = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < 0 || visited[i]) continue;
    const queue = [i],
      component: Edge[] = [];
    visited[i] = 1;
    for (let j = 0; j < queue.length; j++) {
      const index = queue[j];
      component.push(edges[grid[index]]);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const next = index + dy * width + dx;
          if (grid[next] >= 0 && !visited[next]) {
            visited[next] = 1;
            queue.push(next);
          }
        }
    }
    if (component.length >= 20) components.push(component);
  }
  const sample = (points: Edge[], limit: number) =>
    points.length <= limit
      ? points
      : Array.from(
          { length: limit },
          (_, i) => points[Math.floor((i * points.length) / limit)],
        );
  const all = sample(edges, 16000);
  const candidates: DetectedCircle[] = [];
  let seed = 123456789;
  const random = (length: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % length;
  };
  function accept(initial: CircleFit) {
    let circle = initial;
    let inliers: Edge[] = [];
    for (let pass = 0; pass < 3; pass++) {
      inliers = all.filter(
        (p) =>
          onCircle(p, circle) &&
          Math.abs((p.x - circle.x) * p.nx + (p.y - circle.y) * p.ny) >
            circle.radius * 0.8,
      );
      const fitted = fitCircle(inliers);
      if (!fitted) return;
      circle = fitted;
    }
    const center = groundPoint(circle.x, circle.y),
      r = circle.radius;
    const imageCenter = groundToImage(center, projection);
    if (
      !imageCenter ||
      !inRect(imageCenter, area) ||
      !circleValid(center, r, projection)
    )
      return;
    const bins = new Uint8Array(48);
    for (const p of inliers) {
      if (onCircle(p, circle))
        bins[
          Math.min(
            47,
            Math.floor(
              ((Math.atan2(p.y - circle.y, p.x - circle.x) + Math.PI) * 48) /
                (2 * Math.PI),
            ),
          )
        ] = 1;
    }
    const coverage = bins.reduce((a, b) => a + b, 0) / bins.length;
    const tolerance =
      inliers.reduce((sum, p) => sum + p.tolerance, 0) / inliers.length;
    if (coverage < 0.65 || inliers.length < 32 || r < tolerance * 8) return;
    const duplicate = candidates.findIndex(
      (c) =>
        distance(c.center, center) < Math.max(r * 0.06, tolerance * 3) &&
        Math.abs(c.radiusGround - r) < Math.max(r * 0.06, tolerance * 3),
    );
    const result = { center, radiusGround: groundLength(r), coverage };
    if (duplicate < 0) candidates.push(result);
    else if (coverage > candidates[duplicate].coverage)
      candidates[duplicate] = result;
  }
  // shortcut: bounded contour sampling targets visible outlines; use multiscale fitting if tiny/dense circles are needed.
  const contours = components.sort((a, b) => b.length - a.length).slice(0, 160);
  for (const component of contours) search(component, false);
  // Merged contours need fewer same-circle samples; keep the original search sequence intact.
  for (const component of contours)
    if (component.length > 512) search(component, true);

  function search(component: Edge[], useNormals: boolean) {
    let points = sample(component, 512);
    for (let round = 0; round < 3 && points.length >= 20; round++) {
      const score = circleScorer(points, simd);
      let best = fitCircle(points),
        bestScore = best ? score(best) : 0;
      for (let trial = 0; trial < (useNormals ? 384 : 96); trial++) {
        const a = points[random(points.length)],
          b = points[random(points.length)];
        const circle = useNormals
          ? fitNormalCircle(a, b)
          : fitCircle([a, b, points[random(points.length)]]);
        if (!circle) continue;
        const count = score(circle);
        if (count > bestScore) {
          best = circle;
          bestScore = count;
        }
      }
      if (!best || bestScore < 20) break;
      accept(best);
      const circle = best;
      points = points.filter((p) => !onCircle(p, circle));
    }
  }
  return candidates
    .sort((a, b) => b.coverage - a.coverage || b.radiusGround - a.radiusGround)
    .slice(0, 20)
    .map(refineBrightRim)
    .filter(hasContourSupport)
    .filter(
      (circle, i, circles) =>
        !circles
          .slice(0, i)
          .some(
            (other) =>
              distance(circle.center, other.center) <
                circle.radiusGround * 0.04 &&
              Math.abs(circle.radiusGround - other.radiusGround) <
                circle.radiusGround * 0.04,
          ),
    );

  function hasContourSupport(circle: DetectedCircle): boolean {
    let supported = 0;
    // Sparse texture can fill all coarse bins without actually tracing a circle.
    for (let i = 0; i < 720; i++) {
      const angle = (i * Math.PI) / 360;
      const p = groundToImage(
        circlePoint(circle.center, circle.radiusGround, angle),
        projection,
      );
      const q = groundToImage(
        circlePoint(circle.center, circle.radiusGround, angle + 0.001),
        projection,
      );
      if (!p || !q) continue;
      const x = (p.x - area.x) / sx - 0.5,
        y = (p.y - area.y) / sy - 0.5;
      const tx = (q.x - p.x) / sx,
        ty = (q.y - p.y) / sy,
        length = Math.hypot(tx, ty);
      if (!length) continue;
      const nx = ty / length,
        ny = -tx / length;
      for (let d = -1.5; d <= 1.5; d += 0.5) {
        const px = Math.round(x + d * nx),
          py = Math.round(y + d * ny);
        if (px < 1 || py < 1 || px >= width - 1 || py >= height - 1) continue;
        const index = py * width + px;
        if (
          strength[index] >= 14 &&
          Math.abs(gx[index] * nx + gy[index] * ny) > strength[index] * 0.94
        ) {
          supported++;
          break;
        }
      }
    }
    return supported >= 720 * 0.65;
  }

  function refineBrightRim(candidate: DetectedCircle): DetectedCircle {
    const brightness = (x: number, y: number): number => {
      const ix = Math.floor(x),
        iy = Math.floor(y);
      if (ix < 0 || iy < 0 || ix + 1 >= width || iy + 1 >= height) return 0;
      let value = 0;
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const i = ((iy + dy) * width + ix + dx) * 4;
          value +=
            (((data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) *
              data[i + 3]) /
              255) *
            (dx ? x - ix : 1 - x + ix) *
            (dy ? y - iy : 1 - y + iy);
        }
      return value;
    };
    let points: EdgePoint[] = [];
    for (let i = 0; i < 96; i++) {
      const angle = (i * Math.PI) / 48;
      const p = groundToImage(
        circlePoint(candidate.center, candidate.radiusGround, angle),
        projection,
      );
      const q = groundToImage(
        circlePoint(candidate.center, candidate.radiusGround, angle + 0.001),
        projection,
      );
      if (!p || !q) continue;
      const x = (p.x - area.x) / sx - 0.5,
        y = (p.y - area.y) / sy - 0.5;
      if (x < 8 || y < 8 || x >= width - 9 || y >= height - 9) continue;
      const tx = (q.x - p.x) / sx,
        ty = (q.y - p.y) / sy,
        length = Math.hypot(tx, ty);
      const nx = ty / length,
        ny = -tx / length;
      const intensity = (offset: number) =>
        brightness(x + offset * nx, y + offset * ny);
      let best = 8,
        offset = 0;
      // A narrow brightness ridge identifies the rim, rather than the edge of its glow.
      for (let d = -6; d <= 6; d += 0.5) {
        const peak = intensity(d);
        if (peak <= Math.max(intensity(d - 0.5), intensity(d + 0.5)) + 0.25)
          continue;
        const value = peak - (intensity(d - 1) + intensity(d + 1)) / 2;
        if (value > best) {
          best = value;
          offset = d;
        }
      }
      if (best === 8) continue;
      const point = toGround(x + offset * nx, y + offset * ny);
      const neighbor = toGround(x + (offset + 1) * nx, y + (offset + 1) * ny);
      if (point && neighbor)
        points.push({ ...point, tolerance: distance(point, neighbor) });
    }
    if (points.length < 48) return candidate;
    let fit = fitCircle(points);
    if (!fit) return candidate;
    for (let pass = 0; pass < 2; pass++) {
      const current = fit;
      points.sort(
        (a, b) =>
          Math.abs(
            Math.hypot(a.x - current.x, a.y - current.y) - current.radius,
          ) /
            a.tolerance -
          Math.abs(
            Math.hypot(b.x - current.x, b.y - current.y) - current.radius,
          ) /
            b.tolerance,
      );
      points = points.slice(0, Math.ceil(points.length * 0.8));
      fit = fitCircle(points);
      if (!fit) return candidate;
    }
    const center = groundPoint(fit.x, fit.y);
    const imageCenter = groundToImage(center, projection);
    const refined = fit;
    if (
      points.filter((point) => onCircle(point, refined)).length <
      points.length * 0.8
    )
      return candidate;
    if (
      distance(center, candidate.center) > candidate.radiusGround * 0.1 ||
      Math.abs(fit.radius / candidate.radiusGround - 1) > 0.1 ||
      !imageCenter ||
      !inRect(imageCenter, area) ||
      !circleValid(center, fit.radius, projection)
    )
      return candidate;
    const result = {
      ...candidate,
      center,
      radiusGround: groundLength(fit.radius),
    };
    return hasContourSupport(result) ? result : candidate;
  }
}
