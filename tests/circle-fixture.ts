import {
  buildProjection,
  DEFAULT_CALIBRATION,
  distance,
  type GroundPoint,
  groundToImage,
  imagePoint,
  imageToGround,
  type Projection,
} from "../src/geometry";

export interface FixtureCircle {
  center: GroundPoint;
  radius: number;
}
export function fixtureCircle(
  p: Projection,
  x: number,
  y: number,
  radiusPixels: number,
): FixtureCircle {
  const center = imageToGround(imagePoint(x, y), p);
  const edge = imageToGround(imagePoint(x + radiusPixels, y), p);
  if (!center || !edge) throw new Error("Invalid fixture");
  return { center, radius: distance(center, edge) };
}
export const fixtureProjection = () =>
  buildProjection(DEFAULT_CALIBRATION, { width: 640, height: 420 });

export function circlePixels(
  p: Projection,
  circles: FixtureCircle[],
  options: {
    noise?: boolean;
    occluded?: boolean;
    fragmented?: boolean;
    transparent?: boolean;
    rectangle?: boolean;
  } = {},
) {
  const { width, height } = p.renderArea;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 91;
  for (let i = 0; i < width * height; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const n = options.noise ? seed % 25 : 0;
    data.set([40 + n, 60 + n, 80 + n, options.transparent ? 0 : 255], i * 4);
  }
  const dab = (x: number, y: number, color: number[]) => {
    for (
      let py = Math.max(0, Math.floor(y - 2));
      py <= Math.min(height - 1, Math.ceil(y + 2));
      py++
    )
      for (
        let px = Math.max(0, Math.floor(x - 2));
        px <= Math.min(width - 1, Math.ceil(x + 2));
        px++
      )
        if (Math.hypot(px - x, py - y) <= 1.5)
          data.set(color, (py * width + px) * 4);
  };
  for (const [index, c] of circles.entries()) {
    for (let step = 0; step < 6000; step++) {
      const t = (step * 2 * Math.PI) / 6000;
      if (options.occluded && t > 0.2 && t < 1.5) continue;
      if (options.fragmented && t > Math.PI * 0.9 && step % 125 > 5) continue;
      const point = groundToImage(
        {
          x: c.center.x + c.radius * Math.cos(t),
          y: c.center.y + c.radius * Math.sin(t),
          space: "ground",
        },
        p,
      );
      if (point)
        dab(
          point.x - p.renderArea.x - 0.5,
          point.y - p.renderArea.y - 0.5,
          index % 2 ? [245, 100, 45, 255] : [40, 245, 220, 255],
        );
    }
  }
  if (options.rectangle) {
    for (let x = 80; x <= 560; x++) {
      dab(x, 90, [240, 240, 240, 255]);
      dab(x, 310, [240, 240, 240, 255]);
    }
    for (let y = 90; y <= 310; y++) {
      dab(80, y, [240, 240, 240, 255]);
      dab(560, y, [240, 240, 240, 255]);
    }
  }
  return { width, height, data };
}

export function glowingCirclePixels(p: Projection, circle: FixtureCircle) {
  const pixels = circlePixels(p, [], { noise: true });
  for (let y = 0; y < pixels.height; y++)
    for (let x = 0; x < pixels.width; x++) {
      const point = imageToGround(imagePoint(x + 0.5, y + 0.5), p);
      if (!point) continue;
      const radius = distance(point, circle.center) / circle.radius;
      const glow = Math.max(0, 1 - Math.abs(radius - 0.94) / 0.035);
      const rim = Math.max(0, 1 - Math.abs(radius - 1) / 0.01);
      const i = (y * pixels.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const fill = radius < 1 ? [30, 70, 90][c] : 0;
        pixels.data[i + c] = Math.min(
          255,
          pixels.data[i + c] +
            fill +
            glow * [30, 60, 100][c] +
            rim * [100, 130, 130][c],
        );
      }
    }
  return pixels;
}
