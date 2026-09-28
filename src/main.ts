import { download, exportPng } from "./export";
import {
  buildProjection,
  circleValid,
  clientPoint,
  clientToImage,
  DEFAULT_CALIBRATION,
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
  undo,
} from "./model";
import { createPanels, element, showState } from "./panels";
import { fitProjectArea, parseProject, serializeProject } from "./project";
import { renderAnnotations } from "./render";
import { createViewport } from "./viewport";

type Tool = "select" | "pan" | "pin" | "reference" | "measure" | "guide";
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
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
}
let history = newHistory(),
  resource: LoadedImage | null = null,
  projection: Projection | null = null;
let selection: Selection | null = null,
  tool: Tool = "select",
  drag: Drag | null = null,
  space = false;
let referenceStart: GroundPoint | null = null,
  measureStart: Endpoint | null = null,
  pendingGuide: CircleCenter | null = null;
let cursor: ImagePoint | null = null,
  frame = 0,
  loadRequest = 0,
  loading = false,
  exporting = false;
let areaPreview: ImageRect | null = null;
let initialDocument = history.present,
  exportName = "";
const presetKey = "kuto-measure.reference-preset";
let savedPreset: ReferencePreset | null = null,
  savedExists = false,
  presetError = "";
let hoverPoint: { x: number; y: number } | null = null,
  keyboardHover = false;
const viewport = element("viewport"),
  stage = element("stage"),
  overlay = element<SVGSVGElement>("overlay"),
  image = element<HTMLImageElement>("image");
const coarse = matchMedia("(pointer: coarse)");
const labelContext = document.createElement("canvas").getContext("2d");
if (!labelContext)
  throw new Error("ラベル描画用のメモリを確保できませんでした。");
const measureLabel = canvasLabelMeasure(labelContext);
const showError = (error: unknown) => {
  const box = element("error");
  box.textContent = error instanceof Error ? error.message : String(error);
  box.hidden = !box.textContent;
};
const status = (message: string) => {
  element("status").textContent = message;
};
const panels = createPanels({
  edit: editDocument,
  select: selectObject,
  error: showError,
  measure: addMeasurement,
  previewArea: (bounds) => {
    areaPreview = bounds;
    schedule();
  },
  automaticArea: () => {
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
  },
});
const view = createViewport(
  viewport,
  stage,
  schedule,
  () => {
    if (drag) finishDrag(true);
  },
  () => !!drag,
);
const modeHints: Record<Tool, string> = {
  select: "対象をクリックして選択。ドラッグで位置を調整できます。",
  pan: "ドラッグして表示位置を移動します。",
  pin: "画像上をクリックしてピンを配置します。",
  reference: "円の中心、円周の点を順に指定してください。",
  measure: "2つのピンまたはグループ中心を選択してください。",
  guide: "補助円の中心にする対象、または地面を選択してください。",
};

function schedule() {
  if (!frame) frame = requestAnimationFrame(draw);
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
function renderSavedReference() {
  const doc = history.present;
  const canSave = !!resource && !!doc.reference?.radiusGame && !loading;
  element<HTMLButtonElement>("save-reference").disabled = !canSave;
  showState("save-reference", savedExists ? "overwrite" : "new");
  showState("save-reference-hint", canSave ? "available" : "unavailable");
  element<HTMLButtonElement>("delete-saved-reference").disabled =
    !savedExists && !presetError;
  element<HTMLButtonElement>("reset-reference").disabled =
    !resource ||
    loading ||
    (!doc.reference && sameCalibration(doc.calibration, DEFAULT_CALIBRATION));
  element("saved-reference-error").textContent = presetError;
  element("saved-reference-detail").textContent = savedPreset
    ? `保存したゲーム内半径：${savedPreset.reference.radiusGame}（カメラ設定を含む）`
    : "";
  showState(
    "saved-reference-state",
    !savedPreset
      ? savedExists
        ? "invalid"
        : presetError
          ? "error"
          : "none"
      : !resource
        ? "ready"
        : !doc.reference
          ? "unused"
          : doc.reference.radiusGame &&
              JSON.stringify(referencePreset(doc)) ===
                JSON.stringify(savedPreset)
            ? "active"
            : "changed",
  );
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
  for (const node of overlay.querySelectorAll<SVGElement>("[data-key]")) {
    node.classList.toggle("candidate", !!key && node.dataset.key === key);
    node.classList.toggle(
      "pin-overlap",
      overlapped.has(node.dataset.key ?? ""),
    );
  }
}
function clearHover() {
  hoverPoint = null;
  keyboardHover = false;
  updateHover();
}
function draw() {
  frame = 0;
  const focusHover = keyboardHover;
  element<HTMLOutputElement>("zoom").value = resource
    ? `${Number((view.state.zoom * 100).toFixed(1))}%`
    : "—";
  if (!projection) {
    overlay.replaceChildren();
    return;
  }
  const doc = drag?.preview ?? history.present;
  const active =
    document.activeElement instanceof SVGElement
      ? document.activeElement
      : null;
  const activeKey = active?.getAttribute("data-key"),
    activePart = active?.getAttribute("data-part"),
    activeHandle = active?.getAttribute("data-handle"),
    activeAngle = active?.getAttribute("data-angle");
  const result = renderAnnotations(doc, projection, {
    zoom: view.state.zoom,
    selection: tool === "pin" ? null : selection,
    interactive: true,
    measureLabel,
    selectLabels: tool === "select",
    coarse: coarse.matches,
    visible: view.visible(),
    cursor,
    areaPreview,
    referenceStart: referenceStart
      ? groundToImage(referenceStart, projection)
      : null,
  });
  overlay.innerHTML = result.markup;
  overlay.style.setProperty("--hover-inner", `${1 / view.state.zoom}px`);
  overlay.style.setProperty("--hover-outer", `${2 / view.state.zoom}px`);
  if (activeKey) {
    const next = [...overlay.querySelectorAll<SVGElement>("[data-key]")].find(
      (el) =>
        el.dataset.key === activeKey &&
        el.getAttribute("data-part") === activePart &&
        el.getAttribute("data-handle") === activeHandle &&
        el.getAttribute("data-angle") === activeAngle,
    );
    next?.focus({ preventScroll: true });
  }
  keyboardHover = focusHover;
  updateHover();
  if (result.warnings.length) status(result.warnings[0]);
}
function refresh() {
  if (resource) {
    try {
      projection = buildProjection(
        history.present.calibration,
        resource,
        history.present.renderArea?.bounds ?? resource.renderArea,
      );
    } catch (e) {
      projection = null;
      showError(e);
    }
  }
  if (selection && !exists(history.present, selection)) selection = null;
  panels.render(history, selection, projection, !!resource);
  if (projection) {
    const area = projection.renderArea;
    const fullImage =
      area.x === 0 &&
      area.y === 0 &&
      area.width === projection.size.width &&
      area.height === projection.size.height;
    element("game-size").textContent =
      `ゲーム領域 ${fullImage ? "画像全体" : `${area.width} × ${area.height} px`}（${(area.width / area.height).toFixed(3)}:1）`;
    element("game-size").hidden = false;
  }
  renderSavedReference();
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-tool]",
  )) {
    const mode = button.dataset.tool as Tool;
    button.disabled =
      mode === "pan"
        ? !resource
        : !projection || (mode === "guide" && !scaleFactor(history.present));
    button.setAttribute("aria-pressed", String(tool === mode));
  }
  for (const id of ["fit", "actual", "zoom-in", "zoom-out"])
    element<HTMLButtonElement>(id).disabled = !resource;
  element<HTMLButtonElement>("export").disabled =
    !resource || exporting || loading;
  for (const id of ["save-project", "load-project"])
    element<HTMLButtonElement>(id).disabled = !resource || loading;
  viewport.dataset.mode = tool;
  viewport.classList.toggle("pan-ready", space);
  viewport.classList.toggle("panning", !!drag?.pan);
  updateHover();
  schedule();
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
  if (next.kind === "reference")
    element<HTMLDetailsElement>("reference-panel").open = true;
  cursor = null;
  refresh();
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
    refresh();
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
  if (next === "reference")
    element<HTMLDetailsElement>("reference-panel").open = true;
  if (next === "reference" && history.present.reference) {
    tool = "select";
    selection = { kind: "reference" };
  } else tool = next;
  status(modeHints[tool]);
  refresh();
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-tool]",
))
  button.addEventListener("click", () => {
    setTool(button.dataset.tool as Tool);
    viewport.focus({ preventScroll: true });
  });
function addMeasurement(a: Endpoint, b: Endpoint) {
  if (sameEndpoint(a, b)) {
    showError("異なる2つの対象を指定してください。");
    return;
  }
  const id = crypto.randomUUID();
  editDocument({ type: "measurement", value: { id, from: a, to: b } });
  selection = { kind: "measurement", id };
  tool = "select";
  measureStart = null;
  refresh();
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
  refresh();
  status(
    direction === "undo" ? "編集を元に戻しました。" : "編集をやり直しました。",
  );
}
element("undo").addEventListener("click", () => performHistory("undo"));
element("redo").addEventListener("click", () => performHistory("redo"));
element("fit").addEventListener("click", () => {
  if (!drag) view.fit();
});
element("actual").addEventListener("click", () => view.zoom(1));
element("zoom-in").addEventListener("click", () =>
  view.zoom(view.state.zoom * 1.1),
);
element("zoom-out").addEventListener("click", () =>
  view.zoom(view.state.zoom / 1.1),
);

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
function beginGuide(center: CircleCenter) {
  pendingGuide = center;
  const dialog = element<HTMLDialogElement>("guide-dialog");
  element("guide-error").textContent = "";
  element<HTMLInputElement>("new-guide-radius").value = "350";
  dialog.showModal();
  element<HTMLInputElement>("new-guide-radius").focus();
}
element("guide-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pendingGuide || !projection) return;
  try {
    const input = element<HTMLInputElement>("new-guide-radius");
    if (!input.value.trim()) throw new Error("半径を入力してください。");
    const radius = gameDistance(Number(input.value)),
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
    tool = "select";
    pendingGuide = null;
    element<HTMLDialogElement>("guide-dialog").close();
    refresh();
    status("補助円を追加しました。");
  } catch (e) {
    element("guide-error").textContent =
      e instanceof Error ? e.message : String(e);
  }
});
element("guide-dialog").addEventListener("close", () => {
  if (element<HTMLDialogElement>("guide-dialog").open) return;
  pendingGuide = null;
  viewport.focus({ preventScroll: true });
});
function activate(point: ImagePoint, target: Selection | null) {
  if (!projection) return;
  const ground = groundAt(point);
  if (tool === "select") {
    selection = target;
    refresh();
    return;
  }
  if (tool === "measure") {
    if (target?.kind !== "pin" && target?.kind !== "group") return;
    if (!resolveCenter(history.present, target)) return;
    if (measureStart) addMeasurement(measureStart, target);
    else {
      measureStart = target;
      selection = target;
      refresh();
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
    refresh();
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
        refresh();
        element<HTMLDetailsElement>("reference-panel").open = true;
        element<HTMLInputElement>("reference-radius").focus();
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
viewport.addEventListener("pointerdown", (event) => {
  if (
    !resource ||
    drag ||
    loading ||
    !event.isPrimary ||
    ![0, 1].includes(event.button)
  )
    return;
  const pan = tool === "pan" || space || event.button === 1;
  if (!pan && !projection) return;
  if (event.pointerType === "touch") clearHover();
  event.preventDefault();
  const node = event.target instanceof Element ? event.target : null;
  const target = parseSelection(node),
    label =
      tool === "select" &&
      node?.closest("[data-part]")?.getAttribute("data-part") === "label",
    handle =
      node?.closest("[data-handle]")?.getAttribute("data-handle") ?? null;
  const start = pointAt(event.clientX, event.clientY);
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
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
    moved: false,
  };
  if (!pan && tool === "select" && !label) selection = target;
  viewport.focus({ preventScroll: true });
  viewport.setPointerCapture(event.pointerId);
  refresh();
});
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
  const d = drag;
  if (!d || event.pointerId !== d.pointerId) return;
  if (
    Math.hypot(
      event.clientX - d.startClient.x,
      event.clientY - d.startClient.y,
    ) >= 3
  )
    d.moved = true;
  if (d.pan) {
    viewport.scrollLeft = d.scrollLeft - (event.clientX - d.startClient.x);
    viewport.scrollTop = d.scrollTop - (event.clientY - d.startClient.y);
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
viewport.addEventListener("pointermove", updateDrag);
viewport.addEventListener("pointermove", (event) => {
  keyboardHover = false;
  hoverPoint =
    event.pointerType === "touch"
      ? null
      : { x: event.clientX, y: event.clientY };
  updateHover();
});
viewport.addEventListener("pointerleave", () => {
  clearHover();
});
overlay.addEventListener("focusin", () => {
  keyboardHover = true;
  updateHover();
});
overlay.addEventListener("focusout", () => queueMicrotask(updateHover));
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    hoverPoint = null;
    keyboardHover = true;
  }
});
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("toggle", clearHover);
function finishDrag(cancel: boolean, event?: PointerEvent) {
  if (!drag) return;
  const previous = drag;
  drag = null;
  if (viewport.hasPointerCapture(previous.pointerId))
    viewport.releasePointerCapture(previous.pointerId);
  if (cancel) {
    if (previous.pan)
      viewport.scrollTo(previous.scrollLeft, previous.scrollTop);
    status("操作を取り消しました。");
  } else if (!previous.pan) {
    if (previous.moved && !previous.label) {
      history = commit(history, previous.preview);
      status("位置を更新しました。");
    } else if (!previous.moved && event)
      activate(pointAt(event.clientX, event.clientY), previous.target);
  }
  refresh();
}
viewport.addEventListener("pointerup", (event) => {
  if (event.pointerId !== drag?.pointerId) return;
  updateDrag(event);
  finishDrag(false, event);
});
for (const type of ["pointercancel", "lostpointercapture"])
  viewport.addEventListener(type, (event) => {
    if ((event as PointerEvent).pointerId === drag?.pointerId) finishDrag(true);
  });
viewport.addEventListener("auxclick", (event) => {
  if (event.button === 1) event.preventDefault();
});
window.addEventListener("blur", () => {
  space = false;
  clearHover();
  finishDrag(true);
  refresh();
});

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
  if (tool !== "select" && tool !== "pan") {
    const old = cursor ?? view.imageCenter(),
      next = imagePoint(old.x + d[0], old.y + d[1]);
    if (inImage(next, resource)) {
      cursor = next;
      schedule();
    }
    event.preventDefault();
    return;
  }
  if (tool !== "select" || !selection) return;
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
  refresh();
}
document.addEventListener("keydown", (event) => {
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
    refresh();
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
});
document.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    space = false;
    refresh();
  }
});

async function openFiles(files: FileList | File[]) {
  const request = ++loadRequest;
  finishDrag(true);
  showError("");
  if (files.length !== 1) {
    loading = false;
    refresh();
    showError("画像は一度に1枚だけ選択してください。");
    return;
  }
  if (
    resource &&
    hasEdits() &&
    !window.confirm("現在の編集内容を破棄して別の画像を開きますか？")
  ) {
    loading = false;
    refresh();
    return;
  }
  loading = true;
  viewport.setAttribute("aria-busy", "true");
  refresh();
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
    if (doc.reference)
      element<HTMLDetailsElement>("reference-panel").open = true;
    clearHover();
    referenceStart = null;
    measureStart = null;
    cursor = null;
    tool = "select";
    image.src = next.url;
    image.alt = next.name;
    stage.hidden = false;
    element("empty").hidden = true;
    overlay.setAttribute("viewBox", `0 0 ${next.width} ${next.height}`);
    try {
      projection = buildProjection(
        history.present.calibration,
        next,
        next.renderArea,
      );
    } catch (e) {
      projection = null;
      showError(e);
    }
    element("image-size").textContent =
      `画像 ${next.width} × ${next.height} px`;
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
      viewport.setAttribute("aria-busy", "false");
      refresh();
    }
  }
}
const fileInput = element<HTMLInputElement>("file");
element("save-project").addEventListener("click", () => {
  if (!resource || loading) return;
  finishDrag(true);
  try {
    download(
      new Blob([serializeProject(history.present, resource)], {
        type: "application/json",
      }),
      `${resource.name.replace(/\.[^.]+$/, "")}-measure.json`,
    );
    element("header-menu").hidePopover();
    showError("");
    status("編集JSONのダウンロードを開始しました。");
  } catch (e) {
    showError(e);
  }
});
const projectInput = element<HTMLInputElement>("project-file");
element("load-project").addEventListener("click", () => {
  if (resource && !loading) projectInput.click();
});
let projectRequest = 0;
projectInput.addEventListener("change", async () => {
  const file = projectInput.files?.[0];
  projectInput.value = "";
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
    element("header-menu").hidePopover();
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
});
fileInput.addEventListener("change", () => {
  if (fileInput.files) void openFiles(fileInput.files);
  fileInput.value = "";
});
viewport.addEventListener("dragover", (event) => {
  event.preventDefault();
  viewport.classList.add("drop-over");
});
viewport.addEventListener("dragleave", () =>
  viewport.classList.remove("drop-over"),
);
viewport.addEventListener("drop", (event) => {
  event.preventDefault();
  viewport.classList.remove("drop-over");
  if (event.dataTransfer) void openFiles(event.dataTransfer.files);
});
for (const type of ["dragover", "drop"])
  document.addEventListener(type, (event) => event.preventDefault());
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption: boolean;
}) => Promise<FileSystemFileHandle>;
element("export").addEventListener("click", () => {
  if (!resource || exporting || loading) return;
  finishDrag(true);
  clearHover();
  const name =
    exportName || `${resource.name.replace(/\.[^.]+$/, "")}-measure.png`;
  const picker = (window as Window & { showSaveFilePicker?: SavePicker })
    .showSaveFilePicker;
  void saveExport(name, picker?.bind(window));
});
async function saveExport(name: string, picker?: SavePicker) {
  if (!resource) return;
  exporting = true;
  showError("");
  status("PNGを生成しています…");
  refresh();
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
    refresh();
  }
}
element("save-reference").addEventListener("click", () => {
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
  renderSavedReference();
});
element("delete-saved-reference").addEventListener("click", () => {
  try {
    localStorage.removeItem(presetKey);
    savedPreset = null;
    savedExists = false;
    presetError = "";
    status("保存した基準を削除しました。現在の画像の基準は保持しています。");
  } catch (e) {
    presetError = `保存した基準を削除できませんでした。${e instanceof Error ? e.message : String(e)}`;
  }
  renderSavedReference();
});
element("reset-reference").addEventListener("click", () => {
  if (!resource || loading) return;
  editDocument({
    type: "reset-reference",
    size: resource,
    renderArea: history.present.renderArea?.bounds ?? resource.renderArea,
  });
});
window.addEventListener("storage", (event) => {
  if (event.key === presetKey || event.key === null) {
    readSavedReference();
    renderSavedReference();
  }
});
const choices = document.querySelectorAll<HTMLInputElement>(
    'input[name="theme"]',
  ),
  settingsKey = "kuto-measure.preferences",
  systemTheme = matchMedia("(prefers-color-scheme: dark)");
let theme = "system";
try {
  const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
  if (
    settings?.version === 1 &&
    ["system", "light", "dark"].includes(settings.theme)
  )
    theme = settings.theme;
} catch {
  /* Storage is optional. */
}
function applyTheme() {
  for (const choice of choices) choice.checked = choice.value === theme;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="color-scheme"]',
  );
  if (meta) meta.content = theme === "system" ? "light dark" : theme;
}
applyTheme();
function saveTheme() {
  applyTheme();
  try {
    localStorage.setItem(settingsKey, JSON.stringify({ version: 1, theme }));
  } catch {
    /* Keep theme switching usable without storage. */
  }
}
for (const choice of choices)
  choice.addEventListener("change", () => {
    theme = choice.value;
    saveTheme();
  });
element("theme-toggle").addEventListener("click", () => {
  const dark = theme === "dark" || (theme === "system" && systemTheme.matches);
  const next = dark ? "light" : "dark";
  theme = next === (systemTheme.matches ? "dark" : "light") ? "system" : next;
  saveTheme();
});
element("theme-toggle").hidden = false;
const header = element("header"),
  headerIcons = element("header-icons"),
  narrowHeader = matchMedia("(width < 780px)");
function arrangeHeader() {
  const focused = document.activeElement;
  // Keep keyboard and reading order aligned with the visible layout.
  header.insertBefore(
    headerIcons,
    narrowHeader.matches ? header.firstElementChild : null,
  );
  if (focused instanceof HTMLElement && headerIcons.contains(focused))
    focused.focus({ preventScroll: true });
}
arrangeHeader();
narrowHeader.addEventListener("change", arrangeHeader);
element("about-trigger").addEventListener("click", () =>
  element("header-menu").hidePopover(),
);
element("about").addEventListener("close", () =>
  element("menu-trigger").focus(),
);
if (!("commandForElement" in HTMLButtonElement.prototype)) {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "button[commandfor]",
  ))
    button.addEventListener("click", () => {
      const id = button.getAttribute("commandfor"),
        dialog = id ? element<HTMLDialogElement>(id) : null;
      dialog?.showModal();
    });
}
if (!("closedBy" in HTMLDialogElement.prototype)) {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>(
    'dialog[closedby="any"]',
  )) {
    const outside = (event: MouseEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.target === dialog &&
        (event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom)
      );
    };
    let startedOutside = false;
    dialog.addEventListener("pointerdown", (event) => {
      startedOutside = outside(event);
    });
    dialog.addEventListener("click", (event) => {
      if (startedOutside && outside(event)) dialog.close();
      startedOutside = false;
    });
  }
}
window.addEventListener("beforeunload", (event) => {
  if (hasEdits()) event.preventDefault();
});
readSavedReference();
refresh();
