<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import { on } from "svelte/events";
import { MediaQuery } from "svelte/reactivity";
import Annotations from "./Annotations.svelte";
import Dialog from "./Dialog.svelte";
import { download, exportPng } from "./export";
import {
  buildProjection,
  type ClientPoint,
  circleValid,
  clientPoint,
  clientToImage,
  distance,
  type GroundPoint,
  gameDistance,
  groundLength,
  groundPoint,
  groundToImage,
  type ImagePoint,
  type ImageRect,
  imagePoint,
  imageToGround,
  inImage,
  inRect,
  type Projection,
} from "./geometry";
import Header from "./Header.svelte";
import { type LoadedImage, loadImage } from "./image";
import { canvasLabelMeasure } from "./labels";
import {
  type AnalysisDocument,
  applyEdit,
  automaticRenderArea,
  type CircleCenter,
  commit,
  documentFromPreset,
  type Edit,
  type Endpoint,
  emptyDocument,
  exists,
  newHistory,
  parseReferencePreset,
  type ReferencePreset,
  redo,
  referencePreset,
  resolveCenter,
  type Selection,
  sameCalibration,
  sameEndpoint,
  scaleFactor,
  selectionKey,
  undo,
} from "./model";
import Panels from "./Panels.svelte";

import { fitProjectArea, parseProject, serializeProject } from "./project";

import { createViewport } from "./viewport.svelte";

const tools = [
  ["select", "↖", "選択"],
  ["pin", "⊕", "ピン"],
  ["reference", "◎", "基準円"],
  ["measure", "↔", "測距線"],
  ["guide", "◌", "補助円"],
] as const;
type Tool = (typeof tools)[number][0];
interface Drag {
  pointerId: number;
  startClient: { x: number; y: number };
  startGround: GroundPoint | null;
  base: AnalysisDocument;
  preview: AnalysisDocument;
  target: Selection | null;
  handle: string | null;
  label: boolean;
  pan: boolean;
  activateOnClick: boolean;
  viewX: number;
  viewY: number;
  moved: boolean;
}

let history = $state.raw(newHistory());
let resource = $state.raw<LoadedImage | null>(null);
const doc = $derived(history.present);
const calibration = $derived(doc.calibration);
const renderArea = $derived(doc.renderArea?.bounds);
const projection = $derived.by((): Projection | null => {
  if (!resource) return null;
  try {
    return buildProjection(
      calibration,
      resource,
      renderArea ?? resource.renderArea,
    );
  } catch {
    return null;
  }
});
let selection = $state.raw<Selection | null>(null),
  tool = $state<Tool>("select"),
  drag = $state.raw<Drag | null>(null),
  space = $state(false);
let preview = $state.raw<AnalysisDocument | null>(null);
const touches = new Map<number, ClientPoint>();
const TOUCH_SLOP = 8;
let touchNavigation = false;
let pinch: { distance: number; center: ClientPoint; zooming?: boolean } | null =
  null;
const synchronizedTouch = "ontouchstart" in window;
let touchSample: ReturnType<typeof touchSpan> = null;
let referenceStart = $state.raw<GroundPoint | null>(null),
  measureStart: Endpoint | null = null,
  pendingGuide: CircleCenter | null = null;
let cursor = $state.raw<ImagePoint | null>(null),
  areaPreview = $state.raw<ImageRect | null>(null);
let frame = 0,
  loadRequest = 0,
  projectRequest = 0;
let pendingMove: PointerEvent | null = null;
let loading = $state(false),
  exporting = $state(false),
  dropOver = $state(false);
let initialDocument = emptyDocument(),
  exportName = "";
const presetKey = "kuto-measure.reference-preset";
let savedPreset = $state.raw<ReferencePreset | null>(null),
  savedExists = $state(false),
  presetError = $state("");
let hoverPoint: { x: number; y: number } | null = null,
  keyboardHover = false;
let candidate = $state<string | null>(null),
  overlapKeys = $state.raw<ReadonlySet<string>>(new Set());
let viewport: HTMLDivElement,
  overlay: SVGSVGElement,
  panels: Panels,
  header: Header;
let referenceOpen = $state(false),
  advanced = $state(false);
let guideOpen = $state(false),
  guideRadius = $state<number | undefined>(0),
  guideError = $state("");
let errorMessage = $state(""),
  statusMessage = $state("画像を開いてください。");
const coarse = new MediaQuery("(pointer: coarse)");
const labelContext = document.createElement("canvas").getContext("2d");
if (!labelContext)
  throw new Error("ラベル描画用のメモリを確保できませんでした。");
const measureLabel = canvasLabelMeasure(labelContext);
const showError = (error: unknown) => {
  errorMessage = error instanceof Error ? error.message : String(error);
};
const status = (message: string) => {
  statusMessage = message;
};
const view = createViewport(
  () => viewport,
  schedule,
  () => {
    if (drag || pinch) finishDrag(true);
  },
  () => !!drag,
);
const shown = $derived(preview ?? doc);
const selected = $derived(
  tool !== "pin" && selection ? selectionKey(selection) : "",
);
const scale = $derived(scaleFactor(doc));
const gameSize = $derived.by(() => {
  if (!projection) return "";
  const area = projection.renderArea;
  const full =
    area.x === 0 &&
    area.y === 0 &&
    area.width === projection.size.width &&
    area.height === projection.size.height;
  return `ゲーム領域 ${full ? "画像全体" : `${area.width} × ${area.height} px`}（${(area.width / area.height).toFixed(3)}:1）`;
});
$effect(() => {
  if (selection && !exists(doc, selection)) selection = null;
});
// Hit-testing uses the rendered SVG geometry, after Svelte has updated its nodes.
$effect(() => {
  doc;
  selection;
  tool;
  space;
  untrack(updateHover);
});
const modeHints: Record<Tool, string> = {
  select:
    "ドラッグで表示位置を移動、クリック・タップで対象を選択。選択済みのピンやハンドルはドラッグで調整できます。",
  pin: "画像上をクリックしてピンを配置します。",
  reference: "円の中心、円周の点を順に指定してください。",
  measure: "2つのピンまたはグループ中心を選択してください。",
  guide: "補助円の中心にする対象、または地面を選択してください。",
};

function schedule() {
  if (!frame) frame = requestAnimationFrame(flushFrame);
}
function flushFrame() {
  updatePinch();
  if (pendingMove) {
    const event = pendingMove;
    pendingMove = null;
    updateDrag(event);
  }
  preview = drag && !drag.pan ? drag.preview : null;
  view.flush();
  frame = 0;
  void tick().then(updateHover);
}
function queueDrag(event: PointerEvent) {
  if (touches.has(event.pointerId))
    touches.set(event.pointerId, clientPoint(event.clientX, event.clientY));
  if (!drag && !pinch) return;
  pendingMove = event;
  schedule();
}
function automaticArea() {
  if (!resource) return false;
  return editDocument({
    type: "render-area",
    value: {
      ...automaticRenderArea(resource, resource.renderArea),
      confirmed: true,
    },
    size: resource,
    renderArea: resource.renderArea,
  });
}
function readSavedReference() {
  savedPreset = null;
  savedExists = false;
  presetError = "";
  try {
    const raw = localStorage.getItem(presetKey);
    savedExists = raw !== null;
    if (raw !== null) savedPreset = parseReferencePreset(raw);
  } catch (e) {
    presetError = `保存した基準を読み込めません。${e instanceof Error ? e.message : String(e)}`;
  }
}
function hasEdits() {
  return (
    !sameCalibration(
      history.present.calibration,
      initialDocument.calibration,
    ) ||
    JSON.stringify({
      ...history.present,
      calibration: initialDocument.calibration,
      renderArea: history.present.renderArea && {
        ...history.present.renderArea,
        confirmed: initialDocument.renderArea?.confirmed ?? false,
      },
    }) !== JSON.stringify(initialDocument)
  );
}
function updateHover() {
  if (!viewport || !overlay) return;
  let key: string | null = null;
  const overlapped = new Set<string>();
  if (
    tool === "pin" &&
    hoverPoint &&
    projection &&
    !space &&
    !drag?.pan &&
    !document.querySelector("dialog[open], :popover-open") &&
    inRect(pointAt(hoverPoint.x, hoverPoint.y), projection.renderArea)
  ) {
    const point = new DOMPoint(hoverPoint.x, hoverPoint.y);
    for (const node of overlay.querySelectorAll<SVGElement>("[data-key]")) {
      for (const shape of node.querySelectorAll(
        "path, circle, line, rect, text",
      )) {
        if (shape.matches(".hit, .line-hit, .label-hit")) continue;
        let hit = false;
        if (shape instanceof SVGGeometryElement) {
          const matrix = shape.getScreenCTM();
          if (!matrix) continue;
          const local = point.matrixTransform(matrix.inverse());
          const style = getComputedStyle(shape);
          hit =
            (style.fill !== "none" && shape.isPointInFill(local)) ||
            (style.stroke !== "none" && shape.isPointInStroke(local));
        } else if (shape instanceof SVGTextElement) {
          const box = shape.getBoundingClientRect();
          hit =
            point.x >= box.left &&
            point.x <= box.right &&
            point.y >= box.top &&
            point.y <= box.bottom;
        }
        if (hit && node.dataset.key) {
          overlapped.add(node.dataset.key);
          break;
        }
      }
    }
  }
  if (
    tool === "select" &&
    !space &&
    !drag &&
    !document.querySelector("dialog[open], :popover-open")
  ) {
    const node = keyboardHover
      ? document.activeElement
      : hoverPoint
        ? document.elementFromPoint(hoverPoint.x, hoverPoint.y)
        : null;
    if (node instanceof Element && overlay.contains(node))
      key = node.closest("[data-key]")?.getAttribute("data-key") ?? null;
  }
  candidate = key;
  if (
    overlapped.size !== overlapKeys.size ||
    [...overlapped].some((key) => !overlapKeys.has(key))
  )
    overlapKeys = overlapped;
}
function clearHover() {
  hoverPoint = null;
  keyboardHover = false;
  updateHover();
}
function selectObject(next: Selection) {
  finishDrag(true);
  if (
    (tool === "measure" || tool === "guide") &&
    (next.kind === "pin" || next.kind === "group") &&
    projection
  ) {
    const center = resolveCenter(history.present, next);
    const point = center && groundToImage(center, projection);
    if (point) activate(point, next);
    return;
  }
  selection = next;
  referenceOpen = false;
  cursor = null;
}
function editDocument(edit: Edit) {
  finishDrag(true);
  try {
    const next = applyEdit(history.present, edit);
    if (
      edit.type !== "calibration" &&
      edit.type !== "render-area" &&
      projection &&
      next.reference &&
      !circleValid(
        next.reference.center,
        next.reference.radiusGround,
        projection,
      )
    )
      throw new Error("基準円がカメラ前方に収まりません。");
    history = commit(history, next);
    if (
      edit.type === "calibration" ||
      edit.type === "reset-reference" ||
      edit.type === "render-area"
    ) {
      referenceStart = null;
      measureStart = null;
      pendingGuide = null;
      cursor = null;
    }
    showError("");
    if (edit.type === "render-area")
      status("ゲーム領域を更新しました。基準円の位置と形を確認してください。");
    if (edit.type === "confirm-area")
      status("ゲーム領域を確認済みにしました。");
    if (edit.type === "reorder")
      status(
        "並び順を変更しました。" +
          (edit.target.kind === "measurement" && !next.reference?.radiusGame
            ? "先頭の測距線を相対距離の基準にしています。"
            : ""),
      );
    return true;
  } catch (e) {
    showError(e);
    return false;
  }
}
function setTool(next: Tool) {
  finishDrag(true);
  clearHover();
  referenceStart = null;
  measureStart = null;
  pendingGuide = null;
  cursor = null;
  referenceOpen = next === "reference";
  if (next === "reference" && history.present.reference) {
    tool = "select";
    selection = { kind: "reference" };
  } else tool = next;
  status(modeHints[tool]);
}
function addMeasurement(a: Endpoint, b: Endpoint) {
  if (sameEndpoint(a, b)) {
    showError("異なる2つの対象を指定してください。");
    return;
  }
  const id = crypto.randomUUID();
  editDocument({ type: "measurement", value: { id, from: a, to: b } });
  selection = { kind: "measurement", id };
  if (tool !== "measure") tool = "select";
  measureStart = null;
  status("測距線を追加しました。");
}
function performHistory(direction: "undo" | "redo") {
  finishDrag(true);
  panels.cancelArea();
  referenceStart = null;
  measureStart = null;
  cursor = null;
  history = direction === "undo" ? undo(history) : redo(history);
  showError("");
  status(
    direction === "undo" ? "編集を元に戻しました。" : "編集をやり直しました。",
  );
}
function pointAt(x: number, y: number): ImagePoint {
  return clientToImage(clientPoint(x, y), view.snapshot());
}
function groundAt(point: ImagePoint): GroundPoint | null {
  return projection && resource && inRect(point, projection.renderArea)
    ? imageToGround(point, projection)
    : null;
}
function parseSelection(node: Element | null): Selection | null {
  const key = node?.closest("[data-key]")?.getAttribute("data-key");
  if (!key) return null;
  if (key === "reference") return { kind: "reference" };
  const [kind, id] = key.split(":");
  if (!id || !["pin", "group", "measurement", "guide"].includes(kind))
    return null;
  return { kind, id } as Selection;
}
function activate(point: ImagePoint, target: Selection | null) {
  if (!projection) return;
  const ground = groundAt(point);
  if (tool === "select") {
    selection = target;
    if (target) referenceOpen = false;
    return;
  }
  if (tool === "measure") {
    if (target?.kind !== "pin" && target?.kind !== "group") return;
    if (!resolveCenter(history.present, target)) return;
    if (measureStart) addMeasurement(measureStart, target);
    else {
      measureStart = target;
      selection = target;
      status("終点にするピンまたはグループ中心を選択してください。");
    }
    return;
  }
  if (!ground) return;
  if (tool === "pin") {
    const id = crypto.randomUUID();
    editDocument({
      type: "pin",
      value: {
        id,
        name: `ピン${history.present.pins.length + 1}`,
        point: ground,
        groupId: null,
      },
    });
    selection = { kind: "pin", id };
    status("ピンを追加しました。");
  } else if (tool === "reference") {
    if (!referenceStart) {
      referenceStart = ground;
      status("円周上の点を指定してください。");
      schedule();
    } else {
      try {
        const radius = groundLength(distance(referenceStart, ground));
        if (!circleValid(referenceStart, radius, projection))
          throw new Error("円がカメラ前方に収まりません。");
        editDocument({
          type: "reference",
          value: {
            center: referenceStart,
            radiusGround: radius,
            radiusGame: null,
          },
        });
        referenceStart = null;
        selection = { kind: "reference" };
        tool = "select";
        referenceOpen = true;
        void panels.focusRadius();
        status("基準円のゲーム内半径を入力してください。");
      } catch (e) {
        showError(e);
      }
    }
  } else if (tool === "guide" && scaleFactor(history.present))
    beginGuide(
      target?.kind === "pin" || target?.kind === "group"
        ? target
        : { kind: "point", point: ground },
    );
}
function touchSpan(points: Iterable<ClientPoint> = touches.values()) {
  const [a, b] = points;
  return !a
    ? null
    : b
      ? {
          center: clientPoint((a.x + b.x) / 2, (a.y + b.y) / 2),
          distance: Math.hypot(a.x - b.x, a.y - b.y),
        }
      : { center: a, distance: 0 };
}
function updatePinch() {
  const span = synchronizedTouch ? touchSample : touchSpan();
  if (!pinch || !span) return;
  if (
    pinch.distance === span.distance &&
    pinch.center.x === span.center.x &&
    pinch.center.y === span.center.y
  )
    return;
  // Ignore spacing jitter during a pan; cross the threshold without a zoom jump.
  if (!pinch.zooming && Math.abs(span.distance - pinch.distance) > TOUCH_SLOP) {
    pinch.distance += Math.sign(span.distance - pinch.distance) * TOUCH_SLOP;
    pinch.zooming = true;
  }
  const ratio =
    pinch.zooming && pinch.distance > 1 && span.distance > 1
      ? span.distance / pinch.distance
      : 1;
  view.zoom(view.state.zoom * ratio, pinch.center, span.center);
  pinch.center = span.center;
  if (pinch.zooming) pinch.distance = span.distance;
}
function moveEdit(
  base: AnalysisDocument,
  target: Selection,
  handle: string | null,
  start: GroundPoint,
  current: GroundPoint,
): AnalysisDocument | null {
  if (!projection) return null;
  const translate = (point: GroundPoint) =>
    groundPoint(
      point.x + (current.x - start.x),
      point.y + (current.y - start.y),
    );
  let edit: Edit | null = null;
  if (target.kind === "pin") {
    const p = base.pins.find((p) => p.id === target.id);
    if (p) edit = { type: "pin", value: { ...p, point: translate(p.point) } };
  } else if (target.kind === "reference" && base.reference) {
    const r = base.reference;
    if (handle === "radius") {
      const length = distance(r.center, current);
      if (length <= 0) return null;
      edit = {
        type: "reference",
        value: { ...r, radiusGround: groundLength(length) },
      };
    } else if (handle === "center")
      edit = {
        type: "reference",
        value: { ...r, center: translate(r.center) },
      };
  } else if (target.kind === "guide") {
    const g = base.guides.find((g) => g.id === target.id);
    if (g?.center.kind === "point")
      edit = {
        type: "guide",
        value: {
          ...g,
          center: { kind: "point", point: translate(g.center.point) },
        },
      };
  }
  if (!edit) return base;
  const next = applyEdit(base, edit);
  if (
    next.reference &&
    !circleValid(next.reference.center, next.reference.radiusGround, projection)
  )
    return null;
  const movedPoint =
    edit.type === "pin"
      ? edit.value.point
      : edit.type === "reference"
        ? edit.value?.center
        : edit.type === "guide" && edit.value.center.kind === "point"
          ? edit.value.center.point
          : null;
  if (movedPoint) {
    const projected = groundToImage(movedPoint, projection);
    if (!projected || !inRect(projected, projection.renderArea)) return null;
  }
  return next;
}
function updateDrag(event: PointerEvent) {
  if (touches.has(event.pointerId)) {
    touches.set(event.pointerId, clientPoint(event.clientX, event.clientY));
    if (pinch) {
      if (!synchronizedTouch) schedule();
      return;
    }
  }
  const d = drag;
  if (!d || event.pointerId !== d.pointerId) return;
  if (
    Math.hypot(
      event.clientX - d.startClient.x,
      event.clientY - d.startClient.y,
    ) >= (event.pointerType === "touch" ? TOUCH_SLOP : 3)
  )
    d.moved = true;
  if (d.pan) {
    if (d.moved) {
      view.move(
        d.viewX + event.clientX - d.startClient.x,
        d.viewY + event.clientY - d.startClient.y,
      );
    }
    return;
  }
  if (d.label) return;
  if (!d.moved || tool !== "select" || !d.target || !d.startGround) return;
  const current = groundAt(pointAt(event.clientX, event.clientY));
  if (!current) return;
  const next = moveEdit(d.base, d.target, d.handle, d.startGround, current);
  if (next !== null) {
    d.preview = next;
    schedule();
  }
}
function finishDrag(cancel: boolean, event?: PointerEvent) {
  pendingMove = null;
  if (cancel) {
    pinch = null;
    touchSample = null;
    touchNavigation = touches.size > 0;
  }
  if (!drag) return;
  const previous = drag;
  drag = null;
  preview = null;
  pendingMove = null;
  if (
    !touches.has(previous.pointerId) &&
    viewport.hasPointerCapture(previous.pointerId)
  )
    viewport.releasePointerCapture(previous.pointerId);
  if (cancel) {
    if (previous.pan && touches.size < 2)
      view.move(previous.viewX, previous.viewY);
    status("操作を取り消しました。");
  } else if (!previous.moved && event && previous.activateOnClick) {
    activate(pointAt(event.clientX, event.clientY), previous.target);
  } else if (!previous.pan && previous.moved && !previous.label) {
    history = commit(history, previous.preview);
    status("位置を更新しました。");
  }
  view.flush();
}
function keyboardMove(event: KeyboardEvent) {
  if (
    event.target instanceof Element &&
    event.target.closest('[data-part="label"]')
  )
    return;
  if (!projection || !resource) return;
  const step = event.shiftKey ? 10 : 1;
  const delta: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const d = delta[event.key];
  if (!d) return;
  if (tool !== "select") {
    const old = cursor ?? view.imageCenter(),
      next = imagePoint(old.x + d[0], old.y + d[1]);
    if (inImage(next, resource)) {
      cursor = next;
      schedule();
    }
    event.preventDefault();
    return;
  }
  if (!selection) {
    event.preventDefault();
    const panStep = event.shiftKey ? 200 : 40;
    view.move(
      view.state.x - Math.sign(d[0]) * panStep,
      view.state.y - Math.sign(d[1]) * panStep,
    );
    view.flush();
    return;
  }
  const node =
    event.target instanceof Element ? event.target.closest("[data-key]") : null;
  const handle =
    node?.getAttribute("data-handle") ??
    (selection.kind === "reference" ? "center" : null);
  let start: GroundPoint | null = null;
  if (handle === "radius") {
    const circle = node?.querySelector("circle.visual");
    if (circle)
      start = imageToGround(
        imagePoint(
          Number(circle.getAttribute("cx")),
          Number(circle.getAttribute("cy")),
        ),
        projection,
      );
  } else if (selection.kind === "pin" || selection.kind === "group")
    start = resolveCenter(history.present, selection);
  else if (selection.kind === "reference")
    start = history.present.reference?.center ?? null;
  else if (selection.kind === "guide") {
    const guide = history.present.guides.find(
      (g) => selection?.kind === "guide" && g.id === selection.id,
    );
    if (guide?.center.kind === "point") start = guide.center.point;
  }
  const imageStart = start && groundToImage(start, projection);
  if (!imageStart || !start) return;
  const current = groundAt(
    imagePoint(imageStart.x + d[0], imageStart.y + d[1]),
  );
  if (!current) return;
  event.preventDefault();
  history = commit(
    history,
    moveEdit(history.present, selection, handle, start, current) ??
      history.present,
  );
}
async function openFiles(files: FileList | File[]) {
  const request = ++loadRequest;
  finishDrag(true);
  showError("");
  if (files.length !== 1) {
    loading = false;
    showError("画像は一度に1枚だけ選択してください。");
    return;
  }
  if (
    resource &&
    hasEdits() &&
    !window.confirm("現在の編集内容を破棄して別の画像を開きますか？")
  ) {
    loading = false;
    return;
  }
  loading = true;

  status("画像を読み込んでいます…");
  try {
    const next = await loadImage(files[0]);
    if (request !== loadRequest) {
      URL.revokeObjectURL(next.url);
      return;
    }
    finishDrag(true);
    const previous = resource;
    resource = next;
    readSavedReference();
    let doc = emptyDocument(),
      applicationError = presetError;
    if (savedPreset) {
      try {
        doc = documentFromPreset(savedPreset, next, next.renderArea);
      } catch (e) {
        applicationError = e instanceof Error ? e.message : String(e);
      }
    }
    doc = { ...doc, renderArea: automaticRenderArea(next, next.renderArea) };
    history = newHistory(doc);
    initialDocument = doc;
    exportName = "";
    selection = doc.reference ? { kind: "reference" } : null;
    if (doc.reference) referenceOpen = true;
    clearHover();
    referenceStart = null;
    measureStart = null;
    cursor = null;
    tool = "select";
    view.setImage(next);
    if (previous) URL.revokeObjectURL(previous.url);
    status(
      applicationError
        ? "保存した基準を適用せず、初期設定で画像を開きました。"
        : doc.reference
          ? "保存した基準を使用中です。円の位置と大きさを確認してください。"
          : projection
            ? "画像を開きました。基準円を合わせるか、ピンを配置してください。"
            : "投影を設定できないため、表示のみ利用できます。",
    );
    if (applicationError)
      showError(`${applicationError} 初期設定で画像を開きました。`);
  } catch (e) {
    if (request === loadRequest) {
      showError(e);
      status("画像を読み込めませんでした。現在の編集は保持しています。");
    }
  } finally {
    if (request === loadRequest) {
      loading = false;
    }
  }
}
async function saveExport(name: string, picker?: SavePicker) {
  if (!resource) return;
  exporting = true;
  showError("");
  status("PNGを生成しています…");
  const source = resource,
    doc = history.present,
    p = projection;
  try {
    let handle: FileSystemFileHandle | undefined;
    if (picker) {
      try {
        handle = await picker({
          suggestedName: name,
          types: [
            { description: "PNG画像", accept: { "image/png": [".png"] } },
          ],
          excludeAcceptAllOption: true,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          status("PNGの保存をキャンセルしました。");
          return;
        }
        throw e;
      }
      if (resource === source) exportName = handle.name;
    }
    await document.fonts.ready;
    const result = await exportPng(source, doc, p);
    if (handle) {
      const writable = await handle.createWritable();
      try {
        await writable.write(result.blob);
        await writable.close();
      } catch (e) {
        await writable.abort().catch(() => {});
        throw e;
      }
      status(`PNGを保存しました。${result.warnings.join(" ")}`);
    } else {
      download(result.blob, name);
      status(`PNGのダウンロードを開始しました。${result.warnings.join(" ")}`);
    }
  } catch (e) {
    showError(e);
  } finally {
    exporting = false;
  }
}
const onGuideSubmit = (event: SubmitEvent) => {
  event.preventDefault();
  if (!pendingGuide || !projection) return;
  try {
    if (guideRadius === undefined) throw new Error("半径を入力してください。");
    const radius = gameDistance(guideRadius),
      center = resolveCenter(history.present, pendingGuide),
      scale = scaleFactor(history.present);
    if (!center || !scale || !circleValid(center, radius / scale, projection))
      throw new Error("円がカメラ前方に収まる半径を指定してください。");
    const id = crypto.randomUUID();
    editDocument({
      type: "guide",
      value: { id, center: pendingGuide, radiusGame: radius },
    });
    selection = { kind: "guide", id };
    pendingGuide = null;
    guideOpen = false;
    status("補助円を追加しました。");
  } catch (e) {
    guideError = e instanceof Error ? e.message : String(e);
  }
};
const onPointerDown = (event: PointerEvent) => {
  if (!resource || loading || ![0, 1].includes(event.button)) return;
  if (event.pointerType === "touch") {
    event.preventDefault();
    clearHover();
  }
  if (drag || touchNavigation || !event.isPrimary) return;
  event.preventDefault();
  const node = event.target instanceof Element ? event.target : null;
  const target = parseSelection(node),
    label =
      tool === "select" &&
      node?.closest("[data-part]")?.getAttribute("data-part") === "label",
    handle =
      node?.closest("[data-handle]")?.getAttribute("data-handle") ?? null;
  const start = pointAt(event.clientX, event.clientY);
  const selected =
    target && selection && selectionKey(target) === selectionKey(selection);
  const movable = node?.closest("[data-movable], [data-handle]");
  const pan =
    space ||
    event.button === 1 ||
    tool !== "select" ||
    !selected ||
    !movable ||
    label;
  drag = {
    pointerId: event.pointerId,
    startClient: { x: event.clientX, y: event.clientY },
    startGround: groundAt(start),
    base: history.present,
    preview: history.present,
    target,
    handle,
    label,
    pan,
    activateOnClick: !space && event.button === 0,
    viewX: view.state.x,
    viewY: view.state.y,
    moved: false,
  };
  viewport.focus({ preventScroll: true });
  viewport.setPointerCapture(event.pointerId);
};
const onHoverMove = (event: PointerEvent) => {
  keyboardHover = false;
  hoverPoint =
    event.pointerType === "touch"
      ? null
      : { x: event.clientX, y: event.clientY };
  schedule();
};
const onFocusIn = () => {
  keyboardHover = true;
  updateHover();
};
const onPointerUp = (event: PointerEvent) => {
  updateDrag(event);
  updatePinch();
  if (touches.delete(event.pointerId)) {
    if (pinch) touchSample = pinch = touchSpan();
    touchNavigation = touchNavigation && touches.size > 0;
  }
  if (event.pointerId !== drag?.pointerId) return;
  finishDrag(false, event);
};
const onPointerCancel = (event: PointerEvent) => {
  if (touches.delete(event.pointerId) || event.pointerId === drag?.pointerId)
    finishDrag(true);
};
const onLostCapture = (event: PointerEvent) => {
  // Ignore capture transfers from SVG children to the workspace itself.
  if (
    event.target === viewport &&
    !viewport.hasPointerCapture(event.pointerId) &&
    (touches.has(event.pointerId) || event.pointerId === drag?.pointerId)
  )
    finishDrag(true);
};
const onBlur = () => {
  space = false;
  clearHover();
  finishDrag(true);
  for (const id of touches.keys())
    if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
  touches.clear();
  touchNavigation = false;
};
const onKeyDown = (event: KeyboardEvent) => {
  if (event.key === "Tab") {
    hoverPoint = null;
    keyboardHover = true;
  }
  if (document.querySelector("dialog[open], :popover-open")) return;
  if (
    event.target instanceof Element &&
    event.target.closest("input,select,textarea,[contenteditable]")
  )
    return;
  if (event.key === "Escape") {
    event.preventDefault();
    panels.cancelArea();
    finishDrag(true);
    referenceStart = null;
    measureStart = null;
    cursor = null;
    setTool("select");
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    performHistory(event.shiftKey ? "redo" : "undo");
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    performHistory("redo");
    return;
  }
  if (event.key === "Delete" && selection) {
    event.preventDefault();
    editDocument({ type: "delete", target: selection });
    return;
  }
  if (
    event.code === "Space" &&
    tool === "select" &&
    event.target instanceof Element &&
    event.target.closest('[data-part="label"]') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    event.preventDefault();
    const target = parseSelection(event.target);
    if (target && !event.repeat) selectObject(target);
    return;
  }
  if (
    event.code === "Space" &&
    event.target instanceof Element &&
    viewport.contains(event.target)
  ) {
    event.preventDefault();
    space = true;
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof Element && viewport.contains(event.target)) {
    if (event.key === "Enter") {
      event.preventDefault();
      const target = parseSelection(event.target);
      if (tool === "select" && target) selectObject(target);
      else activate(cursor ?? view.imageCenter(), target);
      return;
    }
    keyboardMove(event);
  }
};
const onKeyUp = (event: KeyboardEvent) => {
  if (event.code === "Space") {
    space = false;
  }
};
const saveProject = () => {
  if (!resource || loading) return;
  finishDrag(true);
  try {
    download(
      new Blob([serializeProject(history.present, resource)], {
        type: "application/json",
      }),
      `${resource.name.replace(/\.[^.]+$/, "")}-measure.json`,
    );
    header.closeMenu();
    showError("");
    status("編集JSONのダウンロードを開始しました。");
  } catch (e) {
    showError(e);
  }
};
const loadProject = async (
  event: Event & { currentTarget: HTMLInputElement },
) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file || !resource || loading) return;
  const source = resource,
    imageRequest = loadRequest,
    request = ++projectRequest;
  try {
    const saved = parseProject(await file.text());
    if (
      source !== resource ||
      imageRequest !== loadRequest ||
      request !== projectRequest ||
      loading
    )
      return;
    const mismatch =
      saved.imageSize.width !== source.width ||
      saved.imageSize.height !== source.height;
    if (
      mismatch &&
      !window.confirm(
        `画像サイズが異なります。\n保存時：${saved.imageSize.width} × ${saved.imageSize.height} px\n現在：${source.width} × ${source.height} px\nゲーム領域を画像サイズの比率に合わせて、現在の編集を置き換えて読み込みますか？`,
      )
    )
      return;
    if (
      !mismatch &&
      hasEdits() &&
      !window.confirm(
        "現在の編集内容をJSONの内容に置き換えますか？（元に戻すことができます）",
      )
    )
      return;
    const next = fitProjectArea(saved.document, saved.imageSize, source);
    buildProjection(
      next.calibration,
      source,
      next.renderArea?.bounds ?? source.renderArea,
    );
    finishDrag(true);
    panels.cancelArea();
    history = commit(history, next);
    selection = null;
    setTool("select");
    header.closeMenu();
    showError("");
    status(
      "編集JSONを読み込みました。位置とゲーム領域を確認してください。元に戻すこともできます。",
    );
  } catch (e) {
    if (
      source === resource &&
      imageRequest === loadRequest &&
      request === projectRequest
    )
      showError(e);
  }
};
const exportImage = () => {
  if (!resource || exporting || loading) return;
  finishDrag(true);
  clearHover();
  const name =
    exportName || `${resource.name.replace(/\.[^.]+$/, "")}-measure.png`;
  const picker = (window as Window & { showSaveFilePicker?: SavePicker })
    .showSaveFilePicker;
  void saveExport(name, picker?.bind(window));
};
const saveReference = () => {
  if (!resource || loading) return;
  finishDrag(true);
  try {
    const preset = referencePreset(history.present);
    parseReferencePreset(JSON.stringify(preset));
    documentFromPreset(
      preset,
      resource,
      history.present.renderArea?.bounds ?? resource.renderArea,
    );
    localStorage.setItem(presetKey, JSON.stringify(preset));
    savedPreset = preset;
    savedExists = true;
    presetError = "";
    status("現在の基準円とカメラ設定をブラウザに保存しました。");
  } catch (e) {
    presetError = `基準を保存できませんでした。${e instanceof Error ? e.message : String(e)}`;
  }
};
const deleteSavedReference = () => {
  try {
    localStorage.removeItem(presetKey);
    savedPreset = null;
    savedExists = false;
    presetError = "";
    status("保存した基準を削除しました。現在の画像の基準は保持しています。");
  } catch (e) {
    presetError = `保存した基準を削除できませんでした。${e instanceof Error ? e.message : String(e)}`;
  }
};
const resetReference = () => {
  if (!resource || loading) return;
  editDocument({
    type: "reset-reference",
    size: resource,
    renderArea: history.present.renderArea?.bounds ?? resource.renderArea,
  });
};
const onStorage = (event: StorageEvent) => {
  if (event.key === presetKey || event.key === null) {
    readSavedReference();
  }
};
const onBeforeUnload = (event: BeforeUnloadEvent) => {
  if (hasEdits()) event.preventDefault();
};
const onTouchPointerDown = (event: PointerEvent) => {
  if (event.pointerType !== "touch") return;
  updatePinch();
  touches.set(event.pointerId, clientPoint(event.clientX, event.clientY));
  if (touches.size < 2) return;
  const active = !!drag || !!pinch;
  finishDrag(true);
  if (
    active &&
    event.target instanceof Node &&
    viewport.contains(event.target)
  ) {
    viewport.setPointerCapture(event.pointerId);
    pinch = touchSpan();
    touchSample = pinch;
    status("2本指で表示位置を移動・拡大縮小できます。");
  }
};
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption: boolean;
}) => Promise<FileSystemFileHandle>;
function beginGuide(center: CircleCenter) {
  pendingGuide = center;
  guideError = "";
  guideRadius = 0;
  guideOpen = true;
}
function onTouch(event: TouchEvent) {
  if (!pinch) return;
  touchSample = touchSpan(
    Array.from(event.touches)
      .sort((a, b) => a.identifier - b.identifier)
      .map((touch) => clientPoint(touch.clientX, touch.clientY)),
  );
  if (event.type === "touchmove") schedule();
  else pinch = touchSample;
}
onMount(() => {
  readSavedReference();
  const observer = new ResizeObserver(() => view.resize());
  observer.observe(viewport, { box: "border-box" });
  const off = on(viewport, "wheel", view.wheel, { passive: false });
  return () => {
    observer.disconnect();
    off();
    cancelAnimationFrame(frame);
    loadRequest++;
    projectRequest++;
    if (resource) URL.revokeObjectURL(resource.url);
  };
});
</script>

<svelte:document
  onpointerdowncapture={onTouchPointerDown}
  onpointermove={queueDrag}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
  onkeydown={onKeyDown}
  onkeyup={onKeyUp}
  ontouchstart={onTouch}
  ontouchmove={onTouch}
  ontouchend={onTouch}
  ondragover={(event) => event.preventDefault()}
  ondrop={(event) => event.preventDefault()}
/>
<svelte:window
  onblur={onBlur}
  onstorage={onStorage}
  onbeforeunload={onBeforeUnload}
/>
<Header
  bind:this={header}
  unavailable={!resource || loading}
  {exporting}
  {openFiles}
  {exportImage}
  {saveProject}
  {loadProject}
  {clearHover}
  bind:advanced
  bind:referenceOpen
/>
<main>
  <div class="toolbar">
    <fieldset class="tools">
      <legend class="sr-only">操作モード</legend>
      {#each tools as [value, symbol, label] (value)}
        <button
          type="button"
          data-tool={value}
          aria-pressed={tool === value}
          disabled={!projection || (value === "guide" && !scale)}
          onclick={() => {
  setTool(value);
  viewport.focus({ preventScroll: true });
}}
        >
          <span>{symbol}</span>{label}
        </button>
      {/each}
    </fieldset>
    <div class="history-tools">
      <button
        type="button"
        id="undo"
        class="icon-button"
        title="元に戻す (Ctrl / Cmd + Z)"
        aria-label="元に戻す"
        onclick={() => performHistory("undo")}
        disabled={!history.past.length}
      >
        ↶
      </button>
      <button
        type="button"
        id="redo"
        class="icon-button"
        title="やり直す"
        aria-label="やり直す"
        onclick={() => performHistory("redo")}
        disabled={!history.future.length}
      >
        ↷
      </button>
    </div>
  </div>
  <div id="error" role="alert" hidden={!errorMessage}>{errorMessage}</div>
  <div class="layout">
    <section class="canvas-panel" aria-label="編集">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -- keyboard-operated image workspace supports arrows and Enter -->
      <div
        id="viewport"
        role="application"
        tabindex="0"
        aria-label="画像表示領域。矢印キーとEnterで作成できます。"
        bind:this={viewport}
        data-mode={tool}
        aria-busy={loading}
        class:pan-ready={space}
        class:panning={!!drag?.pan}
        class:drop-over={dropOver}
        onpointerdown={onPointerDown}
        onpointermove={onHoverMove}
        onpointerleave={clearHover}
        onlostpointercapture={onLostCapture}
        onauxclick={(event) => {
  if (event.button === 1) event.preventDefault();
}}
        ondragover={(event) => {
  event.preventDefault();
  dropOver = true;
}}
        ondragleave={() => {
  dropOver = false;
}}
        ondrop={(event) => {
  event.preventDefault();
  dropOver = false;
  if (event.dataTransfer) void openFiles(event.dataTransfer.files);
}}
      >
        <div id="empty" hidden={!!resource}>
          <div class="empty-intro">
            <h2>スクリーンショットを開く</h2>
            <p>ここへ画像をドロップ、または上の「画像を開く」から選択</p>
            <span class="file-types">PNG · JPEG · WEBP</span>
            <div class="privacy"><span></span>ブラウザ内だけで処理</div>
            <div class="empty-steps">
              <span><b>01</b> 画像を確認する</span>
              <span><b>02</b> ピンを置く</span>
              <span><b>03</b> 距離を測る</span>
            </div>
          </div>
          <ul class="screenshot-hint">
            <li>
              ゲーム画面全体のスクリーンショット画像を使用してください（PC版の場合、F12キーで保存されるもの）
            </li>
            <li>
              他アプリケーションやカーソルが映っていると、正しく測定できない場合があります。
            </li>
          </ul>
        </div>
        <div
          id="stage"
          hidden={!resource}
          style:width={`${(resource?.width ?? 0) * view.display.zoom}px`}
          style:height={`${(resource?.height ?? 0) * view.display.zoom}px`}
          style:translate={`${view.display.x}px ${view.display.y}px`}
        >
          <img
            id="image"
            draggable="false"
            src={resource?.url}
            alt={resource?.name ?? ""}
          >
          <svg
            id="overlay"
            xmlns="http://www.w3.org/2000/svg"
            aria-label="オブジェクト"
            bind:this={overlay}
            viewBox={resource ? `0 0 ${resource.width} ${resource.height}` : undefined}
            style:--hover-inner={`${1 / view.display.zoom}px`}
            style:--hover-outer={`${2 / view.display.zoom}px`}
            onfocusin={onFocusIn}
            onfocusout={() => queueMicrotask(updateHover)}
          >
            <title>オブジェクト</title>
            {#if projection}
              <Annotations
                doc={shown}
                p={projection}
                z={view.display.zoom}
                {selected}
                selectLabels={tool === "select"}
                coarse={coarse.current}
                visible={view.visible()}
                {measureLabel}
                {cursor}
                referenceStart={referenceStart ? groundToImage(referenceStart, projection) : null}
                {areaPreview}
                {candidate}
                overlapped={overlapKeys}
                onwarning={status}
              />
            {/if}
          </svg>
        </div>
      </div>
      <div class="canvas-footer">
        <div class="image-metadata">
          <div class="image-info">
            <span id="image-size"
              >{resource ? `画像 ${resource.width} × ${resource.height} px` : "画像未選択"}</span
            >
            <span
              id="game-size"
              title="アスペクト比は幅:高さ（小数第3位まで）"
              hidden={!projection}
              >{gameSize}</span
            >
          </div>
          <div
            id="area-warning"
            class="area-warning"
            hidden={!doc.renderArea || doc.renderArea.confirmed}
          >
            <p
              id="area-warning-text"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              ゲーム領域が正しく判定されていない場合、設定の必要があります
            </p>
            <button
              id="area-confirm"
              type="button"
              aria-label="問題なし：ゲーム領域を確認済みにする"
              onclick={() => {
  if (editDocument({ type: "confirm-area" }))
    viewport.focus({ preventScroll: true });
}}
            >
              <svg aria-hidden="true" width="14" height="14">
                <use href={`${import.meta.env.BASE_URL}icons.svg#check`} />
              </svg>
              問題なし
            </button>
            <button
              id="area-open"
              type="button"
              aria-controls="game-area"
              onclick={() => void panels.openArea()}
            >
              ゲーム領域を設定
            </button>
          </div>
        </div>
        <div class="zoom-tools">
          <button
            id="fit"
            type="button"
            class="icon-button"
            aria-label="全体表示"
            title="全体表示"
            disabled={!resource}
            onclick={() => {
  if (!drag) view.fit();
}}
          >
            <svg aria-hidden="true">
              <use href={`${import.meta.env.BASE_URL}icons.svg#fit`} />
            </svg>
          </button>
          <button
            id="actual"
            type="button"
            disabled={!resource}
            onclick={() => {
  view.zoom(1);
  view.flush();
}}
          >
            100%
          </button>
          <button
            id="zoom-out"
            type="button"
            class="icon-button"
            aria-label="縮小"
            disabled={!resource}
            onclick={() => {
  view.zoom(view.state.zoom / 1.1);
  view.flush();
}}
          >
            −
          </button>
          <output id="zoom"
            >{resource ? `${Number((view.display.zoom * 100).toFixed(1))}%` : "—"}</output
          >
          <button
            id="zoom-in"
            type="button"
            class="icon-button"
            aria-label="拡大"
            disabled={!resource}
            onclick={() => {
  view.zoom(view.state.zoom * 1.1);
  view.flush();
}}
          >
            ＋
          </button>
        </div>
      </div>
    </section>
    <Panels
      bind:this={panels}
      {doc}
      {projection}
      {selection}
      hasImage={!!resource}
      {loading}
      {savedPreset}
      {savedExists}
      {presetError}
      edit={editDocument}
      select={selectObject}
      error={showError}
      measure={addMeasurement}
      previewArea={(bounds) => {
  areaPreview = bounds;
}}
      {automaticArea}
      {saveReference}
      {deleteSavedReference}
      {resetReference}
      startTool={(next) => {
  setTool(next);
  viewport.focus({ preventScroll: true });
}}
      bind:advanced
      bind:referenceOpen
    />
  </div>
  <footer class="statusbar">
    <p id="status" role="status" aria-live="polite">{statusMessage}</p>
    <span>編集内容はタブを閉じると失われます</span>
  </footer>
</main>
<Dialog
  id="guide-dialog"
  labelledby="guide-dialog-title"
  bind:open={guideOpen}
  ontoggle={clearHover}
  onclose={() => {
  pendingGuide = null;
  viewport.focus({ preventScroll: true });
}}
>
  <form id="guide-form" onsubmit={onGuideSubmit}>
    <div class="dialog-heading">
      <h2 id="guide-dialog-title">補助円を追加</h2>
    </div>
    <label>
      半径
      <input
        id="new-guide-radius"
        type="number"
        min="0"
        step="any"
        bind:value={guideRadius}
        required
      >
    </label>
    <p id="guide-error" role="alert">{guideError}</p>
    <div class="dialog-actions">
      <button type="submit" class="primary">補助円を追加</button>
    </div>
  </form>
</Dialog>
