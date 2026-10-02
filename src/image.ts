// Adapted from image-rect-picker.
import type { ImageRect, Size } from "./geometry";

export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 50_000_000;

export interface LoadedImage extends Size {
  renderArea: ImageRect;
  url: string;
  name: string;
  image: HTMLImageElement;
}

/** Find border candidates, then accept symmetric pairs or a bounded window frame. */
export function detectRenderArea(
  pixels: Pick<ImageData, "width" | "height" | "data">,
): ImageRect {
  const { width, height, data } = pixels;
  let left = 0,
    right = width,
    top = 0,
    bottom = height;
  // Reuse scratch storage across rows; returned colors belong to the line cache.
  const histogram = new Uint32Array(3 * 256),
    samples = new Uint8Array(3 * Math.max(width, height)),
    median = new Uint8Array(3);
  const bandColor = (
    line: number,
    horizontal: boolean,
    blueOnly = false,
  ): number[] | null => {
    const start = horizontal ? left : top,
      end = horizontal ? right : bottom,
      middleStart = start + (end - start) * 0.25,
      middleEnd = start + (end - start) * 0.75,
      stride = horizontal ? 4 : width * 4;
    if (blueOnly) histogram.fill(0);
    let count = 0,
      sumR = 0,
      sumG = 0,
      sumB = 0,
      squareR = 0,
      squareG = 0,
      squareB = 0;
    for (
      let i = start,
        offset = 4 * (horizontal ? line * width + start : start * width + line);
      i < end;
      i++, offset += stride
    ) {
      // Sample both sides, avoiding the central home indicator.
      if (blueOnly && i >= middleStart && i < middleEnd) continue;
      if (data[offset + 3] < 250) return null;
      const r = data[offset],
        g = data[offset + 1],
        b = data[offset + 2];
      if (blueOnly) {
        if (b - r <= 25 || g - r <= 8) continue;
        histogram[r]++;
        histogram[256 + g]++;
        histogram[512 + b]++;
        samples[count * 3] = r;
        samples[count * 3 + 1] = g;
        samples[count * 3 + 2] = b;
        count++;
        continue;
      }
      count++;
      sumR += r;
      sumG += g;
      sumB += b;
      squareR += r * r;
      squareG += g * g;
      squareB += b * b;
    }
    if (!count || (blueOnly && count < (end - start) * 0.5 * 0.7)) return null;
    if (blueOnly) {
      // ponytail: reject small cursor overlays; large/ambiguous frames need manual bounds.
      for (let channel = 0; channel < 3; channel++) {
        // Match sorted[floor(count / 2)], including an even sample count.
        let rank = Math.floor(count / 2);
        for (let value = 0; value < 256; value++) {
          rank -= histogram[channel * 256 + value];
          if (rank < 0) {
            median[channel] = value;
            break;
          }
        }
      }
      const sampleEnd = count * 3;
      count = 0;
      for (let offset = 0; offset < sampleEnd; offset += 3) {
        const r = samples[offset],
          g = samples[offset + 1],
          b = samples[offset + 2];
        if (
          Math.abs(r - median[0]) > 32 ||
          Math.abs(g - median[1]) > 32 ||
          Math.abs(b - median[2]) > 32
        )
          continue;
        count++;
        sumR += r;
        sumG += g;
        sumB += b;
        squareR += r * r;
        squareG += g * g;
        squareB += b * b;
      }
    }
    if (!count || (blueOnly && count < (end - start) * 0.5 * 0.7)) return null;
    const r = sumR / count,
      g = sumG / count,
      b = sumB / count;
    const variance = Math.max(
      squareR / count - r * r,
      squareG / count - g * g,
      squareB / count - b * b,
    );
    return variance <= 4 || (variance <= 144 && b - r > 25 && g - r > 8)
      ? [r, g, b]
      : null;
  };
  type Band = { inset: number; end: number };
  const bands = (
    length: number,
    horizontal: boolean,
    reverse: boolean,
    blueOnly: boolean,
    insetLimit: number,
  ): Band[] => {
    const limit = Math.floor(length * 0.22),
      minimum = Math.max(2, length * 0.01);
    const colors: (number[] | null | undefined)[] = [];
    const colorAt = (offset: number) => {
      if (colors[offset] === undefined)
        colors[offset] = bandColor(
          reverse ? length - offset - 1 : offset,
          horizontal,
          blueOnly,
        );
      return colors[offset];
    };
    const candidates: Band[] = [];
    let previousEdge: number[] | null = null;
    for (let inset = 0; inset <= insetLimit; inset++) {
      const edge = colorAt(inset);
      if (!edge) {
        previousEdge = null;
        continue;
      }
      // A uniform band has one start; do not shorten it to fit an acceptance rule.
      if (previousEdge?.every((value, i) => Math.abs(value - edge[i]) <= 8))
        continue;
      previousEdge = edge;
      let end = inset;
      while (end < inset + limit) {
        const color = colorAt(end);
        if (!color?.every((value, i) => Math.abs(value - edge[i]) <= 32)) break;
        end++;
      }
      if (end - inset >= minimum) candidates.push({ inset, end });
    }
    return candidates;
  };
  const symmetric = (
    length: number,
    first: Band | undefined,
    last: Band | undefined,
  ): [number, number] | null => {
    if (!first || !last) return null;
    const a = first.end - first.inset,
      b = last.end - last.inset;
    return first.end < Math.floor(length * 0.22) &&
      last.end < Math.floor(length * 0.22) &&
      Math.abs(a - b) <= Math.max(2, Math.max(a, b) * 0.15)
      ? [first.end, length - last.end]
      : null;
  };
  const titleBarEnd = (): number | null => {
    // ponytail: recognize thin light/dark neutral title bars, not arbitrary app chrome;
    // colored or larger frames still need manual bounds.
    const start = Math.max(1, Math.ceil(height * 0.002)),
      limit = Math.floor(height * 0.06);
    let end = start,
      tone = 0;
    for (; end <= limit; end++) {
      let light = 0,
        dark = 0,
        count = 0;
      for (
        let x = Math.ceil(left + (right - left) * 0.1);
        x < left + (right - left) * 0.9;
        x++
      ) {
        const offset = (end * width + x) * 4;
        const low = Math.min(data[offset], data[offset + 1], data[offset + 2]),
          high = Math.max(data[offset], data[offset + 1], data[offset + 2]);
        count++;
        if (data[offset + 3] < 250 || high - low > 32) continue;
        if (low >= 180) light++;
        if (high <= 80) dark++;
      }
      const next = light >= count * 0.9 ? 1 : dark >= count * 0.9 ? -1 : 0;
      if (!next || (tone && tone !== next)) break;
      tone = next;
    }
    return end <= limit && end - start >= Math.max(2, height * 0.01)
      ? end
      : null;
  };
  const edges = (length: number, horizontal: boolean): [number, number] => {
    const full: [number, number] = [0, length];
    const plain = symmetric(
      length,
      bands(length, horizontal, false, false, 0)[0],
      bands(length, horizontal, true, false, 0)[0],
    );
    if (plain || !horizontal) return plain ?? full;

    const insetLimit = Math.floor(length * 0.04),
      first = bands(length, true, false, true, Math.floor(length * 0.06)),
      last = bands(length, true, true, true, insetLimit);
    const upper = first.find((band) => band.inset <= insetLimit);
    const paired = symmetric(
      length,
      upper,
      upper
        ? last.find(
            (band) =>
              Math.abs(band.end - band.inset - (upper.end - upper.inset)) <=
              Math.max(2, (upper.end - upper.inset) * 0.15),
          )
        : undefined,
    );
    if (paired) return paired;

    const titleEnd = titleBarEnd();
    if (titleEnd === null) return full;
    const windowTop = first.find(
      (band) =>
        Math.abs(band.inset - titleEnd) <= 2 &&
        !bandColor(band.end, true, true),
    );
    // Require a scene boundary beyond the outer chrome, not a footer fragment or
    // a color transition between two blue bands.
    const windowBottom = last
      .filter(
        (band) =>
          band.end > insetLimit &&
          !bandColor(length - band.end - 1, true, true),
      )
      .reduce<Band | undefined>(
        (best, band) =>
          !best || band.end - band.inset > best.end - best.inset ? band : best,
        undefined,
      );
    const bounded = (band: Band | undefined): band is Band =>
      !!band && band.end - band.inset < Math.floor(length * 0.22);
    return bounded(windowTop) && bounded(windowBottom)
      ? [windowTop.end, length - windowBottom.end]
      : full;
  };
  [left, right] = edges(width, false);
  [top, bottom] = edges(height, true);
  [left, right] = edges(width, false);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function readRenderArea(image: HTMLImageElement, size: Size): ImageRect {
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(size.width, 256);
  canvas.height = Math.min(size.height, 1024);
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("画像の表示領域を読み取れませんでした。");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const area = detectRenderArea(
      ctx.getImageData(0, 0, canvas.width, canvas.height),
    );
    const x = Math.round((area.x * size.width) / canvas.width);
    const y = Math.round((area.y * size.height) / canvas.height);
    return {
      x,
      y,
      width:
        Math.round(((area.x + area.width) * size.width) / canvas.width) - x,
      height:
        Math.round(((area.y + area.height) * size.height) / canvas.height) - y,
    };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export function validateFile(file: Pick<File, "type" | "size">): void {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    throw new Error("PNG、JPEG、WebPの画像を選択してください。");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("画像ファイルは256 MiB以下にしてください。");
  }
}

export function validateSize(size: Size): void {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1
  ) {
    throw new Error("画像の寸法を読み取れませんでした。");
  }
  if (size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new Error("画像サイズは50メガピクセル以下にしてください。");
  }
}

function detectImageType(bytes: Uint8Array): string {
  const startsWith = (signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const text = String.fromCharCode(...bytes);
  const matches: Record<string, boolean> = {
    "image/png": startsWith([137, 80, 78, 71, 13, 10, 26, 10]),
    "image/jpeg": startsWith([255, 216, 255]),
    "image/webp": text.startsWith("RIFF") && text.slice(8, 12) === "WEBP",
  };
  const type = ACCEPTED_TYPES.find((type) => matches[type]);
  if (!type)
    throw new Error(
      "PNG、JPEG、WebPの画像データを確認できませんでした。SVGは利用できません。",
    );
  return type;
}

// Read dimensions without decoding pixels or buffering the entire file.
export async function readImageSize(file: File): Promise<Size> {
  validateFile(file);
  let buffer = new ArrayBuffer(0);
  let start = 0;
  const invalid = () => new Error("画像の寸法を読み取れませんでした。");
  const read = async (offset: number, length: number): Promise<DataView> => {
    if (offset < 0 || offset + length > file.size) throw invalid();
    if (offset < start || offset + length > start + buffer.byteLength) {
      start = offset;
      buffer = await file.slice(offset, offset + 65536).arrayBuffer();
    }
    return new DataView(buffer, offset - start, length);
  };
  const header = await read(0, 12);
  // File.type can reflect the extension rather than the actual image format.
  const type = detectImageType(
    new Uint8Array(header.buffer, header.byteOffset, header.byteLength),
  );
  switch (type) {
    case "image/png": {
      const data = await read(12, 12);
      if (header.getUint32(8) !== 13 || data.getUint32(0) !== 0x49484452)
        throw invalid();
      const size = { width: data.getUint32(4), height: data.getUint32(8) };
      validateSize(size);
      let offset = 33;
      while (offset + 8 <= file.size) {
        const chunk = await read(offset, 8);
        const length = chunk.getUint32(0),
          type = chunk.getUint32(4);
        if (offset + 12 + length > file.size) throw invalid();
        if (type === 0x6163544c)
          throw new Error("アニメーション画像は使用できません。");
        if (type === 0x49444154 || type === 0x49454e44) break;
        offset += 12 + length;
      }
      return size;
    }
    case "image/webp": {
      const chunk = await read(12, 8);
      const length = chunk.getUint32(4, true);
      if (
        20 + length > file.size ||
        20 + length > header.getUint32(4, true) + 8
      )
        throw invalid();
      switch (chunk.getUint32(0)) {
        case 0x56503858: {
          // VP8X: extended canvas. Animated input is deliberately rejected.
          if (length !== 10) throw invalid();
          const data = await read(20, 10);
          if (data.getUint8(0) & 2)
            throw new Error("アニメーション画像は使用できません。");
          return {
            width: 1 + data.getUint16(4, true) + (data.getUint8(6) << 16),
            height: 1 + data.getUint16(7, true) + (data.getUint8(9) << 16),
          };
        }
        case 0x56503820: {
          // VP8: lossy key frame.
          if (length < 10) throw invalid();
          const data = await read(20, 10);
          if (
            data.getUint8(0) & 1 ||
            data.getUint8(3) !== 0x9d ||
            data.getUint16(4) !== 0x012a
          )
            throw invalid();
          return {
            width: data.getUint16(6, true) & 0x3fff,
            height: data.getUint16(8, true) & 0x3fff,
          };
        }
        case 0x5650384c: {
          // VP8L: lossless dimensions packed into 28 bits.
          if (length < 5) throw invalid();
          const data = await read(20, 5);
          if (data.getUint8(0) !== 0x2f) throw invalid();
          const bits = data.getUint32(1, true);
          if (bits >>> 29) throw invalid();
          return {
            width: (bits & 0x3fff) + 1,
            height: ((bits >>> 14) & 0x3fff) + 1,
          };
        }
      }
      throw invalid();
    }
    case "image/jpeg": {
      let offset = 2;
      while (offset < file.size) {
        if ((await read(offset++, 1)).getUint8(0) !== 0xff) throw invalid();
        let marker = (await read(offset++, 1)).getUint8(0);
        while (marker === 0xff) marker = (await read(offset++, 1)).getUint8(0);
        if (marker === 0xd9 || marker === 0xda || marker === 0) throw invalid();
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = (await read(offset, 2)).getUint16(0);
        if (length < 2 || offset + length > file.size) throw invalid();
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          ![0xc4, 0xc8, 0xcc].includes(marker)
        ) {
          if (length < 8) throw invalid();
          const frame = await read(offset + 2, 5);
          return { width: frame.getUint16(3), height: frame.getUint16(1) };
        }
        offset += length;
      }
    }
  }
  throw invalid();
}

export async function loadImage(
  file: File,
  isCurrent: () => boolean,
): Promise<LoadedImage | null> {
  // EXIF rotation can swap axes, but leaves the pixel count unchanged.
  validateSize(await readImageSize(file));
  if (!isCurrent()) return null;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error(
        "画像を読み込めませんでした。ファイルが破損していないか確認してください。",
      );
    }
    if (!isCurrent()) {
      URL.revokeObjectURL(url);
      return null;
    }
    const size = { width: image.naturalWidth, height: image.naturalHeight };
    validateSize(size);
    return {
      ...size,
      renderArea: readRenderArea(image, size),
      url,
      name: file.name,
      image,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
