import {
  circlePoint,
  groundPoint,
  groundToImage,
  type ImagePoint,
  type Projection,
  projectCircle,
} from "./geometry";
import {
  DENSE_LABELS,
  type Label,
  layoutLabels,
  type MeasureLabel,
  overlapArea,
} from "./labels";
import {
  type AnalysisDocument,
  centroid,
  endpointName,
  formatDistance,
  measuredDistance,
  resolveCenter,
  type Selection,
  scaleFactor,
  selectionKey,
} from "./model";

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
export interface RenderOptions {
  zoom: number;
  selection: Selection | null;
  interactive: boolean;
  measureLabel: MeasureLabel;
  selectLabels?: boolean;
  coarse?: boolean;
  visible?: { left: number; top: number; right: number; bottom: number };
  cursor?: ImagePoint | null;
  areaPreview?: Projection["renderArea"] | null;
  referenceStart?: ImagePoint | null;
}
export function renderAnnotations(
  doc: AnalysisDocument,
  p: Projection,
  o: RenderOptions,
): { markup: string; warnings: string[] } {
  const z = o.zoom,
    hit = (o.coarse ? 22 : 16) / z;
  const warnings: string[] = [];
  const selected =
    o.interactive && o.selection ? selectionKey(o.selection) : "";
  const attrs = (key: string, label: string, extra = "", part = "body") =>
    o.interactive
      ? `data-key="${key}" data-part="${part}" ${extra} tabindex="0" role="button" aria-pressed="${key === selected}" aria-label="${escapeXml(label)}"`
      : "";
  const stroke = (color: string, width = 2) =>
    `stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke" fill="none"`;
  const text = (point: ImagePoint, label: string, dx = 10, dy = -10) =>
    `<text x="${point.x + dx / z}" y="${point.y + dy / z}" font-size="${12 / z}" font-family="system-ui, sans-serif" fill="#ffffff" stroke="#17313e" stroke-width="${3 / z}" stroke-linejoin="round" paint-order="stroke" pointer-events="none">${escapeXml(label)}</text>`;
  const labels: Label[] = [],
    obstacles: { x: number; y: number; width: number; height: number }[] = [];
  const captions: { token: string; point: ImagePoint; label: string }[] = [];
  const typeNames: Record<string, string> = {
    pin: "ピン",
    group: "グループ",
    measurement: "測距線",
    reference: "基準円",
    guide: "補助円",
  };
  const addLabel = (
    point: ImagePoint,
    label: string,
    key: string,
    color: string,
    dx = 10,
    dy = -10,
    detail = "",
  ) => {
    labels.push({
      key,
      text: label,
      name: `${typeNames[key.split(":")[0]]} ${detail} ${label}`.trim(),
      anchor: point,
      color,
      dx,
      dy,
    });
    return "";
  };
  const caption = (point: ImagePoint, label: string) => {
    const token = `<!--caption-${captions.length}-->`;
    captions.push({ token, point, label });
    return token;
  };
  const marker = (
    point: ImagePoint,
    key: string,
    label: string,
    color: string,
    diamond = false,
    extra = "",
  ) => {
    const control = key === "reference" || key.startsWith("guide:");
    if (!control)
      obstacles.push({
        x: point.x - hit,
        y: point.y - hit,
        width: 2 * hit,
        height: 2 * hit,
      });
    return `<g ${attrs(key, label, extra, control ? "handle" : "body")}>${o.interactive ? `<circle class="hit" cx="${point.x}" cy="${point.y}" r="${hit}" fill="transparent"/>` : ""}${key === selected ? `<circle cx="${point.x}" cy="${point.y}" r="${10 / z}" ${stroke("#ffffff", 2)}/>` : ""}${key.startsWith("pin:") || extra === 'data-handle="center"' || (key.startsWith("guide:") && extra === 'data-movable="true"') ? `<path d="M${point.x - 6 / z},${point.y - 6 / z}l${12 / z},${12 / z}M${point.x - 6 / z},${point.y + 6 / z}l${12 / z},${-12 / z}" ${stroke("#ffffff", 4)} pointer-events="none"/><path class="visual" d="M${point.x - 6 / z},${point.y - 6 / z}l${12 / z},${12 / z}M${point.x - 6 / z},${point.y + 6 / z}l${12 / z},${-12 / z}" ${stroke(color, 2)} pointer-events="none"/>` : diamond ? `<path class="visual" d="M${point.x},${point.y - 7 / z}l${7 / z},${7 / z}l${-7 / z},${7 / z}l${-7 / z},${-7 / z}Z" fill="${color}" stroke="#fff" stroke-width="${1.5 / z}"/>` : `<circle class="visual" cx="${point.x}" cy="${point.y}" r="${6 / z}" fill="${color}" stroke="#fff" stroke-width="${1.5 / z}"/>`}${control ? caption(point, label) : addLabel(point, label, key, color)}</g>`;
  };
  const circle = (
    center: Parameters<typeof projectCircle>[0],
    radius: number,
    key: string,
    label: string,
    color: string,
  ) => {
    const sample = projectCircle(
      center,
      radius,
      p,
      o.interactive ? 0.5 / z : 0.25,
    );
    if (!sample) {
      warnings.push(`${label}：円がカメラ前方に収まりません。`);
      return { markup: "", points: [] as ImagePoint[] };
    }
    if (sample.limited)
      warnings.push(`${label}：円の描画精度が分割上限に達しました。`);
    const path = `M${sample.points.map((q) => `${q.x},${q.y}`).join("L")}Z`;
    const centerImage = groundToImage(center, p);
    return {
      points: sample.points,
      markup: `<g ${attrs(key, label)}>${o.interactive ? `<path class="line-hit" d="${path}" ${stroke("transparent", 12)}/>` : ""}<path d="${path}" ${stroke(color, key === selected ? 3 : 2)} ${key.startsWith("guide:") ? 'stroke-dasharray="7 5"' : ""}/>${centerImage ? addLabel(centerImage, label, key, color, 12, 18) : ""}</g>`,
    };
  };
  const guides: string[] = [],
    lines: string[] = [],
    groups: string[] = [],
    pins: string[] = [],
    controls: string[] = [];
  const scale = scaleFactor(doc);
  for (const g of doc.guides) {
    const center = resolveCenter(doc, g.center);
    if (!center || !scale) continue;
    guides.push(
      circle(
        center,
        g.radiusGame / scale,
        `guide:${g.id}`,
        `半径 ${formatDistance(g.radiusGame, doc)}`,
        "#e5a63f",
      ).markup,
    );
    if (
      o.interactive &&
      selected === `guide:${g.id}` &&
      g.center.kind === "point"
    ) {
      const point = groundToImage(center, p);
      if (point)
        controls.push(
          marker(
            point,
            `guide:${g.id}`,
            "中心",
            "#e5a63f",
            false,
            'data-movable="true"',
          ),
        );
    }
  }
  let reference = "";
  if (doc.reference) {
    const r = doc.reference,
      label = `基準円 ${r.radiusGame === null ? "距離スケール未設定" : formatDistance(r.radiusGame, doc)}`;
    const result = circle(
      r.center,
      r.radiusGround,
      "reference",
      label,
      "#e875b9",
    );
    reference = result.markup;
    if (o.interactive && selected === "reference") {
      const center = groundToImage(r.center, p);
      if (center)
        controls.push(
          marker(
            center,
            "reference",
            "中心",
            "#e875b9",
            false,
            'data-handle="center"',
          ),
        );
      const visible = (q: ImagePoint) =>
        !o.visible ||
        (q.x >= o.visible.left &&
          q.x <= o.visible.right &&
          q.y >= o.visible.top &&
          q.y <= o.visible.bottom);
      let handles = 0;
      for (let i = 0; i < 4; i++) {
        const q = groundToImage(
          circlePoint(r.center, r.radiusGround, (i * Math.PI) / 2),
          p,
        );
        if (q && visible(q)) {
          controls.push(
            marker(
              q,
              "reference",
              "半径",
              "#e875b9",
              false,
              `data-handle="radius" data-angle="${(i * Math.PI) / 2}"`,
            ),
          );
          handles++;
        }
      }
      if (!handles && result.points.length) {
        let run: ImagePoint[] = [],
          best: ImagePoint[] = [];
        for (const q of [...result.points, ...result.points]) {
          if (visible(q)) {
            run.push(q);
            if (run.length > best.length) best = run.slice();
          } else run = [];
        }
        const q = best[Math.floor(best.length / 2)];
        if (q)
          controls.push(
            marker(
              q,
              "reference",
              "半径",
              "#e875b9",
              false,
              'data-handle="radius"',
            ),
          );
      }
    }
  }
  for (const m of doc.measurements) {
    const a = resolveCenter(doc, m.from),
      b = resolveCenter(doc, m.to);
    if (!a || !b) continue;
    const start = groundToImage(a, p),
      end = groundToImage(b, p),
      mid = groundToImage(groundPoint((a.x + b.x) / 2, (a.y + b.y) / 2), p);
    if (!start || !end || !mid) continue;
    const key = `measurement:${m.id}`,
      coords = `x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}"`;
    lines.push(
      `<g ${attrs(key, `${endpointName(doc, m.from)} → ${endpointName(doc, m.to)}`)}>${o.interactive ? `<line class="line-hit" ${coords} ${stroke("transparent", 14)}/>` : ""}<line ${coords} ${stroke("#56c7e9", key === selected ? 3 : 2)}/>${addLabel(mid, formatDistance(measuredDistance(doc, m), doc), key, "#56c7e9", 6, -8, `${endpointName(doc, m.from)} → ${endpointName(doc, m.to)}`)}</g>`,
    );
  }
  for (const g of doc.groups) {
    const center = centroid(doc, g.id),
      q = center && groundToImage(center, p);
    if (q)
      groups.push(
        marker(q, `group:${g.id}`, g.name || "グループ", "#7e9efa", true),
      );
  }
  for (const pin of doc.pins) {
    const q = groundToImage(pin.point, p);
    if (q)
      pins.push(
        marker(
          q,
          `pin:${pin.id}`,
          pin.name || "ピン",
          "#18b69b",
          false,
          'data-movable="true"',
        ),
      );
  }
  for (const q of [o.cursor, o.referenceStart])
    if (q)
      controls.push(
        `<path d="M${q.x - 6 / z},${q.y - 6 / z}l${12 / z},${12 / z}M${q.x - 6 / z},${q.y + 6 / z}l${12 / z},${-12 / z}" ${stroke("#ffffff")} pointer-events="none"/>`,
      );
  const area = p.renderArea,
    right = area.x + area.width,
    bottom = area.y + area.height;
  const boundary = [
    area.x > 0 ? `M${area.x},0V${p.size.height}` : "",
    right < p.size.width ? `M${right},0V${p.size.height}` : "",
    area.y > 0 ? `M0,${area.y}H${p.size.width}` : "",
    bottom < p.size.height ? `M0,${bottom}H${p.size.width}` : "",
  ].join("");
  if (o.interactive && boundary && !o.areaPreview)
    controls.unshift(
      `<path class="excluded-boundary" d="${boundary}" ${stroke("#ef4444", 1)} opacity="0.65" pointer-events="none" role="img" aria-label="ゲーム領域の境界"><title>赤線の外側は測距から除外されています</title></path>`,
    );
  if (o.interactive && o.areaPreview) {
    const draft = o.areaPreview;
    const rect = `x="${draft.x}" y="${draft.y}" width="${draft.width}" height="${draft.height}"`;
    controls.push(
      `<g class="area-preview" pointer-events="none" role="img" aria-label="未適用のゲーム領域"><title>赤い破線の内側が適用予定のゲーム領域です。暗い部分は除外予定です。</title><path d="M0,0H${p.size.width}V${p.size.height}H0ZM${draft.x},${draft.y}h${draft.width}v${draft.height}h${-draft.width}Z" fill="#000" fill-opacity="0.3" fill-rule="evenodd"/><rect class="area-preview-boundary" ${rect} ${stroke("#ef4444", 1)} stroke-dasharray="8 5"/></g>`,
    );
  }
  const layout = layoutLabels(labels, area, z, obstacles, o.measureLabel);
  if (layout.crowded) warnings.push(DENSE_LABELS);
  const labelMarkup = layout.boxes
    .map((box) => {
      const l = box.label,
        active = o.interactive && o.selectLabels !== false;
      const x = box.x / z,
        y = box.y / z,
        w = box.width / z,
        h = box.height / z;
      const tx = Math.max(x, Math.min(l.anchor.x, x + w)),
        ty = Math.max(y, Math.min(l.anchor.y, y + h));
      const attributes = active
        ? attrs(l.key, l.name, "", "label")
        : o.interactive
          ? `data-key="${l.key}" data-part="label" aria-hidden="true"`
          : "";
      return `<g ${attributes} class="annotation-label" pointer-events="none">${box.shifted ? `<line class="label-leader" x1="${l.anchor.x}" y1="${l.anchor.y}" x2="${tx}" y2="${ty}" ${stroke(l.color, 1)} pointer-events="none"/>` : ""}${active ? `<rect class="label-hit" x="${x}" y="${y}" width="${w}" height="${h}" rx="${3 / z}" fill="transparent" stroke="none" stroke-width="${1 / z}" pointer-events="all"/>` : ""}${text(l.anchor, box.text, box.x + 5.5 - l.anchor.x * z, box.baseline - l.anchor.y * z)}</g>`;
    })
    .join("");
  let markup = `<defs><clipPath id="image-clip"><rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}"/></clipPath></defs><g clip-path="url(#image-clip)">${guides.join("")}${reference}${lines.join("")}${groups.join("")}${pins.join("")}${labelMarkup}</g>${controls.join("")}`;
  for (const c of captions) {
    const m = o.measureLabel(c.label),
      rect = {
        x: c.point.x * z + 10 - 2,
        y: c.point.y * z - 10 - m.ascent - 2,
        width: m.width + 4,
        height: m.ascent + m.descent + 4,
      };
    markup = markup.replace(
      c.token,
      layout.boxes.some((box) => overlapArea(rect, box) > 0)
        ? ""
        : text(c.point, c.label),
    );
  }
  return {
    markup,
    warnings,
  };
}
