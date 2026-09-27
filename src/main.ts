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
  imagePoint,
  imageToGround,
  inImage,
  inRect,
  type Projection,
} from "./geometry";
import { type LoadedImage, loadImage } from "./image";
import {
  type AnalysisDocument,
  applyEdit,
  type CircleCenter,
  commit,
  type Edit,
  type Endpoint,
  exists,
  newHistory,
  redo,
  resolveCenter,
  type Selection,
  sameEndpoint,
  scaleFactor,
  undo,
} from "./model";
import { createPanels, element } from "./panels";
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
const viewport = element("viewport"),
  stage = element("stage"),
  overlay = element<SVGSVGElement>("overlay"),
  image = element<HTMLImageElement>("image");
const coarse = matchMedia("(pointer: coarse)");
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
function draw() {
  frame = 0;
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
    activeHandle = active?.getAttribute("data-handle"),
    activeAngle = active?.getAttribute("data-angle");
  const result = renderAnnotations(doc, projection, {
    zoom: view.state.zoom,
    selection,
    interactive: true,
    coarse: coarse.matches,
    visible: view.visible(),
    cursor,
    referenceStart: referenceStart
      ? groundToImage(referenceStart, projection)
      : null,
  });
  overlay.innerHTML = result.markup;
  if (activeKey) {
    const next = [...overlay.querySelectorAll<SVGElement>("[data-key]")].find(
      (el) =>
        el.dataset.key === activeKey &&
        el.getAttribute("data-handle") === activeHandle &&
        el.getAttribute("data-angle") === activeAngle,
    );
    next?.focus({ preventScroll: true });
  }
  if (result.warnings.length) status(result.warnings[0]);
}
function refresh() {
  if (resource) {
    try {
      projection = buildProjection(
        history.present.calibration,
        resource,
        resource.renderArea,
      );
    } catch (e) {
      projection = null;
      showError(e);
    }
  }
  if (selection && !exists(history.present, selection)) selection = null;
  panels.render(history, selection, projection, !!resource);
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
  viewport.dataset.mode = tool;
  viewport.classList.toggle("pan-ready", space);
  viewport.classList.toggle("panning", !!drag?.pan);
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
    if (edit.type === "calibration") {
      referenceStart = null;
      measureStart = null;
      pendingGuide = null;
      cursor = null;
    }
    showError("");
    refresh();
  } catch (e) {
    showError(e);
  }
}
function setTool(next: Tool) {
  finishDrag(true);
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
  event.preventDefault();
  const node = event.target instanceof Element ? event.target : null;
  const target = parseSelection(node),
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
    pan,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
    moved: false,
  };
  if (!pan && tool === "select") selection = target;
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
    if (previous.moved) {
      history = commit(history, previous.preview);
      status("位置を更新しました。");
    } else if (event)
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
  finishDrag(true);
  refresh();
});

function keyboardMove(event: KeyboardEvent) {
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
    (history.present.pins.length ||
      history.present.calibration !== DEFAULT_CALIBRATION ||
      history.present.groups.length ||
      history.present.reference ||
      history.present.guides.length ||
      history.present.measurements.length) &&
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
    history = newHistory();
    selection = null;
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
    for (const [id, label, size] of [
      ["image-size", "画像", next],
      ["game-size", "ゲーム領域", next.renderArea],
    ] as const) {
      element(id).textContent =
        `${label} ${size.width} × ${size.height} px（${(size.width / size.height).toFixed(3)}:1）`;
      element(id).hidden = false;
    }
    view.setImage(next);
    if (previous) URL.revokeObjectURL(previous.url);
    status(
      projection
        ? "画像を開きました。基準円を合わせるか、ピンを配置してください。"
        : "投影を設定できないため、表示のみ利用できます。",
    );
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
element("export").addEventListener("click", async () => {
  if (!resource || exporting) return;
  finishDrag(true);
  exporting = true;
  refresh();
  const source = resource,
    doc = history.present,
    p = projection;
  try {
    await document.fonts.ready;
    download(
      await exportPng(source, doc, p),
      `${source.name.replace(/\.[^.]+$/, "")}-measure.png`,
    );
    status("元の画像サイズでPNGを書き出しました。");
  } catch (e) {
    showError(e);
  } finally {
    exporting = false;
    refresh();
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
  if (
    history.present.pins.length ||
    history.present.groups.length ||
    history.present.reference ||
    history.present.guides.length ||
    history.present.measurements.length
  )
    event.preventDefault();
});
refresh();
