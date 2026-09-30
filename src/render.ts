import { crossPath, diamondPath, prepareAnnotations } from "./annotations";
import type { ImagePoint, Projection } from "./geometry";
import type { MeasureLabel } from "./labels";
import type { AnalysisDocument } from "./model";

const escapeXml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] as string,
  );
// SVG serialization is only used for the exported image. The live UI is Svelte.
export function renderAnnotations(
  doc: AnalysisDocument,
  p: Projection,
  measureLabel: MeasureLabel,
): { markup: string; warnings: string[] } {
  const z = 1,
    scene = prepareAnnotations(doc, p, z, measureLabel, false);
  const stroke = (color: string, width = 2) =>
    `stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke" fill="none"`;
  const text = (point: ImagePoint, label: string) =>
    `<text x="${point.x}" y="${point.y}" font-size="${12 / z}" font-family="system-ui, sans-serif" fill="#ffffff" stroke="#17313e" stroke-width="${3 / z}" stroke-linejoin="round" paint-order="stroke" pointer-events="none">${escapeXml(label)}</text>`;
  const circles = scene.circles
    .map(
      (c) =>
        `<g><path d="${c.path}" ${stroke(c.color)} ${c.key.startsWith("guide:") ? 'stroke-dasharray="7 5"' : ""}/></g>`,
    )
    .join("");
  const lines = scene.lines
    .map(
      (l) =>
        `<g><line x1="${l.start.x}" y1="${l.start.y}" x2="${l.end.x}" y2="${l.end.y}" ${stroke("#56c7e9")}/></g>`,
    )
    .join("");
  const markers = scene.markers
    .map(
      (m) =>
        `<g>${m.shape === "cross" ? `<path d="${crossPath(m.point, z)}" ${stroke("#ffffff", 4)} pointer-events="none"/><path class="visual" d="${crossPath(m.point, z)}" ${stroke(m.color)} pointer-events="none"/>` : `<path class="visual" d="${diamondPath(m.point, z)}" fill="${m.color}" stroke="#fff" stroke-width="${1.5 / z}"/>`}</g>`,
    )
    .join("");
  const labels = scene.labels
    .map((box) => {
      const l = box.label,
        leader = box.leader;
      return `<g class="annotation-label" pointer-events="none">${leader ? `<line class="label-leader" x1="${leader.start.x / z}" y1="${leader.start.y / z}" x2="${leader.end.x / z}" y2="${leader.end.y / z}" ${stroke(l.color, 1)} pointer-events="none"/>` : ""}${text({ x: box.textX / z, y: box.baseline / z, space: "image" }, box.text)}</g>`;
    })
    .join("");
  const area = p.renderArea;
  const markup = `<defs><clipPath id="image-clip"><rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}"/></clipPath></defs><g clip-path="url(#image-clip)">${circles}${lines}${markers}${labels}</g>`;
  return { markup, warnings: scene.warnings };
}
