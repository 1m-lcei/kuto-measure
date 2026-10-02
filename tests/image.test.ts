import { expect, test } from "bun:test";
import {
  detectRenderArea,
  readImageSize,
  validateFile,
  validateSize,
} from "../src/image";

function pixels(
  border: (x: number, y: number) => number[] | null,
  width = 200,
  height = 100,
) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color = border(x, y) ?? [
        (x * 17) % 256,
        (y * 19 + x * 3) % 256,
        (x * 29) % 256,
      ];
      data.set([...color, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

test("blue-band statistics handle odd/even samples and reuse buffers across the full color range", () => {
  for (const width of [199, 200, 201]) {
    const low = [0, 9, 26],
      high = [205, 225, 255];
    const image = pixels((x, y) => {
      if (y >= 10 && y < 90) return null;
      // Opposite-color cursor pixels force the robust blue-band path on both edges.
      return y < 10 !== x < 5 ? low : high;
    }, width);
    expect(detectRenderArea(image)).toEqual({ x: 0, y: 10, width, height: 80 });
  }
});

test("paired game borders are detected without treating scene content or a solid image as borders", () => {
  const width = 200,
    height = 100;
  const full = { x: 0, y: 0, width, height };
  expect(detectRenderArea(pixels(() => null))).toEqual(full);
  expect(detectRenderArea(pixels(() => [55, 105, 155]))).toEqual(full);
  expect(
    detectRenderArea(
      pixels((_x, y) => (y < 10 || y >= 90 ? [0, 0, 0] : [90, 95, 100])),
    ),
  ).toEqual({ x: 0, y: 10, width, height: 80 });
  expect(
    detectRenderArea(
      pixels((x, y) =>
        y < 8 || y >= 92
          ? [50, 100, 150].map((value) => value + (x % 2 ? 12 : -12))
          : null,
      ),
    ),
  ).toEqual({ x: 0, y: 8, width, height: 84 });
  expect(
    detectRenderArea(
      pixels((x, y) =>
        y < 8 || y >= 92
          ? [50 + (x % 10), 100 + (x % 10), 150 + (x % 10)]
          : null,
      ),
    ),
  ).toEqual({ x: 0, y: 8, width, height: 84 });
  expect(
    detectRenderArea(
      pixels((x, y) =>
        x < 20 || x >= 180 || y < 10 || y >= 90 ? [0, 0, 0] : null,
      ),
    ),
  ).toEqual({ x: 20, y: 10, width: 160, height: 80 });
  expect(
    detectRenderArea(pixels((_x, y) => (y < 10 ? [0, 0, 0] : null))),
  ).toEqual(full);
  // A home indicator in the lower band must not change the projection area.
  expect(
    detectRenderArea(
      pixels((x, y) => {
        if (y >= 96 && y <= 97 && x >= 75 && x < 125) return [245, 245, 245];
        return y < 15 || y >= 85 ? [55, 105, 155] : null;
      }),
    ),
  ).toEqual({ x: 0, y: 15, width, height: 70 });
  // A thin app footer is outside the paired blue bands, not part of their thickness.
  expect(
    detectRenderArea(
      pixels((_x, y) => {
        if (y === 99) return [55, 105, 155];
        if (y >= 98) return [20, 30, 35];
        if (y >= 96) return [40, 80, 120]; // Resampled footer/band transition.
        return y < 10 || y >= 88 ? [55, 105, 155] : null;
      }),
    ),
  ).toEqual({ x: 0, y: 10, width, height: 78 });
  // Cyan cursor pixels pass the blue filter, but must not terminate an entire band.
  for (const cursorX of [0, 30, 98, 160, 195]) {
    for (const cursorY of [0, 90, 96]) {
      expect(
        detectRenderArea(
          pixels((x, y) => {
            if (
              x >= cursorX &&
              x < cursorX + 5 &&
              y >= cursorY &&
              y < cursorY + 8
            )
              return [200, 235, 255];
            return y < 10 || y >= 90
              ? [55 + (x % 8), 105 + (x % 8), 155 + (x % 8)]
              : null;
          }),
        ),
      ).toEqual({ x: 0, y: 10, width, height: 80 });
    }
  }
  expect(
    detectRenderArea(
      pixels((x, y) => {
        if (y >= 90 && (x < 50 || x >= 150)) return [245, 245, 245];
        return y < 10 || y >= 90 ? [55, 105, 155] : null;
      }),
    ),
  ).toEqual(full);
  for (const border of [
    (_x: number, y: number) => (y < 10 ? [55, 105, 155] : null),
    (_x: number, y: number) => (y < 10 || y >= 85 ? [55, 105, 155] : null),
    (_x: number, y: number) => (y < 30 || y >= 70 ? [55, 105, 155] : null),
    (x: number, y: number) => {
      if (y < 6 || y >= 94) return [(x * 31) % 256, 10, 10];
      return y < 16 || y >= 84 ? [55, 105, 155] : null;
    },
  ])
    expect(detectRenderArea(pixels(border))).toEqual(full);
});

test("a thin neutral title bar permits asymmetric blue bands without changing ordinary detection", () => {
  for (const scale of [1, 2, 4]) {
    const width = 200 * scale,
      height = 100 * scale;
    for (const title of [
      [235, 240, 245],
      [35, 35, 35],
    ]) {
      const image = pixels(
        (x, y) => {
          if (y < Math.max(1, Math.ceil(height * 0.002))) return [20, 20, 20];
          if (y < 5 * scale) {
            // Title text/icons, plus small marks within the sampled center.
            return x < 20 * scale ||
              x > 185 * scale ||
              (x > 80 * scale && x < 85 * scale)
              ? [120, 120, 120]
              : title;
          }
          // The top boundary exceeds 22% of image height, but the blue band does not.
          return y < 23 * scale || y >= 90 * scale
            ? [55, 105, 155].map((value) => value + (x % 8))
            : null;
        },
        width,
        height,
      );
      expect(detectRenderArea(image)).toEqual({
        x: 0,
        y: 23 * scale,
        width,
        height: 67 * scale,
      });
    }
  }
  // The main lower band wins over fragments below a footer, cursor and home indicator.
  expect(
    detectRenderArea(
      pixels((x, y) => {
        if (y < 5) return [235, 240, 245];
        if (y >= 99) return [55, 105, 155];
        if (y >= 98) return [20, 30, 35];
        if (y >= 96) return [40, 80, 120];
        if (y >= 90 && y < 93 && x >= 75 && x < 125) return [245, 245, 245];
        if (y >= 90 && y < 94 && x < 5) return [200, 235, 255];
        return y < 23 || y >= 88 ? [55, 105, 155] : null;
      }),
    ),
  ).toEqual({ x: 0, y: 23, width: 200, height: 65 });

  const full = { x: 0, y: 0, width: 200, height: 100 };
  // If a footer hides the main band's start beyond the allowed inset, do not use
  // its small blue fragments as a substitute for the game boundary.
  expect(
    detectRenderArea(
      pixels((_x, y) => {
        if (y < 5) return [235, 240, 245];
        if (y >= 98) return [55, 105, 155];
        if (y >= 96) return [20, 30, 35];
        if (y >= 94) return [40, 80, 120];
        return y < 23 || y >= 88 ? [55, 105, 155] : null;
      }),
    ),
  ).toEqual(full);
  for (const border of [
    (_x: number, y: number) => (y < 5 ? [235, 240, 245] : null),
    (_x: number, y: number) =>
      y < 5 ? [235, 240, 245] : y < 23 ? [55, 105, 155] : null,
    (_x: number, y: number) =>
      y < 5 ? [235, 240, 245] : y >= 90 ? [55, 105, 155] : null,
    (_x: number, y: number) =>
      y < 9 ? [235, 240, 245] : y < 23 || y >= 94 ? [55, 105, 155] : null,
    (_x: number, y: number) =>
      y < 5 ? [150, 70, 55] : y < 23 || y >= 90 ? [55, 105, 155] : null,
    (x: number, y: number) =>
      y < 5
        ? [(x * 31) % 256, 10, 10]
        : y < 23 || y >= 90
          ? [55, 105, 155]
          : null,
    // A neutral strip separated from the blue band by scene content is not a title bar.
    (_x: number, y: number) =>
      y < 5
        ? [235, 240, 245]
        : (y >= 10 && y < 23) || y >= 90
          ? [55, 105, 155]
          : null,
    // Keep rejecting oversized and asymmetric bands without title-bar evidence.
    (_x: number, y: number) =>
      y < 5 ? [235, 240, 245] : y < 30 || y >= 90 ? [55, 105, 155] : null,
    (_x: number, y: number) => (y < 18 || y >= 90 ? [55, 105, 155] : null),
  ])
    expect(detectRenderArea(pixels(border))).toEqual(full);
});

function png(width: number, height: number, animated = false): File {
  const b = new Uint8Array(animated ? 65 : 45),
    v = new DataView(b.buffer);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  v.setUint32(8, 13);
  v.setUint32(12, 0x49484452);
  v.setUint32(16, width);
  v.setUint32(20, height);
  v.setUint32(33, animated ? 8 : 0);
  v.setUint32(37, animated ? 0x6163544c : 0x49444154);
  return new File([b], "test.png", { type: "image/png" });
}
test("PNG dimensions are validated before decoding", async () => {
  expect(await readImageSize(png(1536, 709))).toEqual({
    width: 1536,
    height: 709,
  });
  await expect(readImageSize(png(100000, 100000))).rejects.toThrow();
  await expect(readImageSize(png(1536, 709, true))).rejects.toThrow(
    "アニメーション",
  );
});
test("image content determines the parser even when the declared format differs", async () => {
  const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 100, 0, 200, 0]);
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    for (const data of [png(200, 100), jpeg]) {
      expect(
        await readImageSize(new File([data], "test.jpg", { type })),
      ).toEqual({
        width: 200,
        height: 100,
      });
    }
    await expect(
      readImageSize(new File([png(200, 100, true)], "test.jpg", { type })),
    ).rejects.toThrow("アニメーション");
    await expect(
      readImageSize(new File([png(100000, 100000)], "test.jpg", { type })),
    ).rejects.toThrow("50メガピクセル");
    await expect(
      readImageSize(
        new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "test.jpg", {
          type,
        }),
      ),
    ).rejects.toThrow("SVG");
  }
});
test("unsupported, oversized, malformed and zero-sized images are rejected", async () => {
  expect(() => validateFile({ type: "image/svg+xml", size: 100 })).toThrow();
  expect(() =>
    validateFile({ type: "image/png", size: 256 * 1024 * 1024 + 1 }),
  ).toThrow();
  expect(() => validateSize({ width: 0, height: 1 })).toThrow();
  expect(() => validateSize({ width: 1.1, height: 1 })).toThrow();
  await expect(
    readImageSize(
      new File(["not a png image"], "bad.png", { type: "image/png" }),
    ),
  ).rejects.toThrow();
  await expect(
    readImageSize(
      new File([new Uint8Array([255, 216, 255])], "bad.jpg", {
        type: "image/jpeg",
      }),
    ),
  ).rejects.toThrow();
});
test("WebP animation flag is rejected", async () => {
  const b = new Uint8Array(30),
    v = new DataView(b.buffer);
  b.set(new TextEncoder().encode("RIFF"));
  v.setUint32(4, 22, true);
  b.set(new TextEncoder().encode("WEBPVP8X"), 8);
  v.setUint32(16, 10, true);
  b[20] = 2;
  await expect(
    readImageSize(new File([b], "animated.webp", { type: "image/webp" })),
  ).rejects.toThrow("アニメーション");
});
