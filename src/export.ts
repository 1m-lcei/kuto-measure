import type { Projection } from "./geometry";
import type { LoadedImage } from "./image";
import { canvasLabelMeasure } from "./labels";
import type { AnalysisDocument } from "./model";
import { renderAnnotations } from "./render";

export async function exportPng(
  image: LoadedImage,
  doc: AnalysisDocument,
  p: Projection | null,
): Promise<{ blob: Blob; warnings: string[] }> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PNG出力用のメモリを確保できませんでした。");
  const warnings: string[] = [];
  try {
    ctx.drawImage(image.image, 0, 0);
    if (p) {
      const result = renderAnnotations(doc, p, {
        zoom: 1,
        selection: null,
        interactive: false,
        measureLabel: canvasLabelMeasure(ctx),
      });
      const { markup } = result;
      warnings.push(...result.warnings);
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
    const blob = await new Promise<Blob>((resolve, reject) =>
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
    return { blob, warnings };
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
