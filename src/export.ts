import type { Projection } from "./geometry";
import type { LoadedImage } from "./image";
import type { AnalysisDocument } from "./model";
import { renderAnnotations } from "./render";

export async function exportPng(
  image: LoadedImage,
  doc: AnalysisDocument,
  p: Projection | null,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PNG出力用のメモリを確保できませんでした。");
  ctx.drawImage(image.image, 0, 0);
  if (p) {
    const { markup } = renderAnnotations(doc, p, {
      zoom: 1,
      selection: null,
      interactive: false,
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}">${markup}</svg>`;
    const url = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    try {
      const overlay = new Image();
      overlay.src = url;
      await overlay.decode();
      ctx.drawImage(overlay, 0, 0);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  try {
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(
                new Error(
                  "PNGを生成できませんでした。画像が大きすぎる可能性があります。",
                ),
              ),
        "image/png",
      ),
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
