// Adapted from image-rect-picker.
import type { ImageRect, Size } from "./geometry";

export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 50_000_000;

export interface LoadedImage extends Size {
  renderArea: ImageRect;
  url: string;
  name: string;
  file: File;
  image: HTMLImageElement;
}

/** Detect paired, nearly uniform black/solid or blue patterned game borders. */
export function detectRenderArea(
  pixels: Pick<ImageData, "width" | "height" | "data">,
): ImageRect {
  const { width, height, data } = pixels;
  let left = 0,
    right = width,
    top = 0,
    bottom = height;
  const bandColor = (
    line: number,
    horizontal: boolean,
    blueOnly = false,
  ): number[] | null => {
    const start = horizontal ? left : top,
      end = horizontal ? right : bottom;
    const sums = [0, 0, 0],
      squares = [0, 0, 0];
    const samples: number[][] = [];
    let count = 0;
    for (let i = start; i < end; i++) {
      // Sample both sides, avoiding the central home indicator.
      if (
        blueOnly &&
        i >= start + (end - start) * 0.25 &&
        i < start + (end - start) * 0.75
      )
        continue;
      const offset = 4 * (horizontal ? line * width + i : i * width + line);
      if (data[offset + 3] < 250) return null;
      if (
        blueOnly &&
        (data[offset + 2] - data[offset] <= 25 ||
          data[offset + 1] - data[offset] <= 8)
      )
        continue;
      count++;
      if (blueOnly)
        samples.push([data[offset], data[offset + 1], data[offset + 2]]);
      for (let channel = 0; channel < 3; channel++) {
        const value = data[offset + channel];
        sums[channel] += value;
        squares[channel] += value * value;
      }
    }
    if (blueOnly && samples.length) {
      // ponytail: reject small cursor overlays; large/ambiguous frames need manual bounds.
      const median = [0, 1, 2].map(
        (channel) =>
          samples.map((color) => color[channel]).sort((a, b) => a - b)[
            Math.floor(samples.length / 2)
          ],
      );
      count = 0;
      sums.fill(0);
      squares.fill(0);
      for (const color of samples) {
        if (
          color.some((value, channel) => Math.abs(value - median[channel]) > 32)
        )
          continue;
        count++;
        for (let channel = 0; channel < 3; channel++) {
          sums[channel] += color[channel];
          squares[channel] += color[channel] ** 2;
        }
      }
    }
    if (!count || (blueOnly && count < (end - start) * 0.5 * 0.7)) return null;
    const mean = sums.map((sum) => sum / count);
    const variance = Math.max(
      ...squares.map((sum, i) => sum / count - mean[i] ** 2),
    );
    return variance <= 4 ||
      (variance <= 144 && mean[2] - mean[0] > 25 && mean[1] - mean[0] > 8)
      ? mean
      : null;
  };
  const edges = (
    length: number,
    horizontal: boolean,
    blueOnly = false,
  ): [number, number] => {
    const limit = Math.floor(length * 0.22),
      minimum = Math.max(2, length * 0.01);
    // ponytail: blue bands sample the outer quarters and skip at most 4% outer chrome;
    // use an explicit render-area control for larger or ambiguous app frames.
    const insetLimit = blueOnly ? Math.floor(length * 0.04) : 0;
    const scan = (
      reverse: boolean,
      expectedThickness = 0,
    ): [number, number] => {
      const colorAt = (offset: number) =>
        bandColor(reverse ? length - offset - 1 : offset, horizontal, blueOnly);
      let previousEdge: number[] | null = null;
      for (let inset = 0; inset <= insetLimit; inset++) {
        const edge = colorAt(inset);
        if (!edge) {
          previousEdge = null;
          continue;
        }
        // Do not trim a uniform, mismatched band until its thickness happens to fit.
        if (previousEdge?.every((value, i) => Math.abs(value - edge[i]) <= 8))
          continue;
        previousEdge = edge;
        let end = inset;
        while (end < limit) {
          const color = colorAt(end);
          if (!color?.every((value, i) => Math.abs(value - edge[i]) <= 32))
            break;
          end++;
        }
        if (
          end - inset >= minimum &&
          (!expectedThickness ||
            Math.abs(end - inset - expectedThickness) <=
              Math.max(2, expectedThickness * 0.15))
        )
          return [inset, end];
      }
      return [0, 0];
    };
    const [firstInset, start] = scan(false),
      [lastInset, end] = scan(true, blueOnly ? start - firstInset : 0);
    // ponytail: recognize paired borders only; keep the full image if the border is ambiguous.
    const firstThickness = start - firstInset,
      lastThickness = end - lastInset;
    return firstThickness >= minimum &&
      lastThickness >= minimum &&
      start < limit &&
      end < limit &&
      Math.abs(firstThickness - lastThickness) <=
        Math.max(2, Math.max(firstThickness, lastThickness) * 0.15)
      ? [start, length - end]
      : [0, length];
  };
  [left, right] = edges(width, false);
  [top, bottom] = edges(height, true);
  if (top === 0 && bottom === height) [top, bottom] = edges(height, true, true);
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

export function validateSignature(type: string, bytes: Uint8Array): void {
  const startsWith = (signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const text = String.fromCharCode(...bytes);
  const matches: Record<string, boolean> = {
    "image/png": startsWith([137, 80, 78, 71, 13, 10, 26, 10]),
    "image/jpeg": startsWith([255, 216, 255]),
    "image/webp": text.startsWith("RIFF") && text.slice(8, 12) === "WEBP",
  };
  if (!matches[type])
    throw new Error(
      "画像の内容がファイル形式と一致しません。SVGは利用できません。",
    );
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
  validateSignature(
    file.type,
    new Uint8Array(header.buffer, header.byteOffset, header.byteLength),
  );
  switch (file.type) {
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

export async function loadImage(file: File): Promise<LoadedImage> {
  // EXIF rotation can swap axes, but leaves the pixel count unchanged.
  validateSize(await readImageSize(file));
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
    const size = { width: image.naturalWidth, height: image.naturalHeight };
    validateSize(size);
    return {
      ...size,
      renderArea: readRenderArea(image, size),
      url,
      name: file.name,
      file,
      image,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
