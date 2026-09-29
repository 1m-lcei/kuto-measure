import {
  type ClientPoint,
  clientPoint,
  clientToImage,
  type ImagePoint,
  imagePoint,
  type Size,
  type ViewportSnapshot,
} from "./geometry";

export interface ViewportState {
  zoom: number;
  fit: boolean;
  x: number;
  y: number;
}
export function createViewport(
  viewport: HTMLElement,
  stage: HTMLElement,
  onChange: () => void,
  onResize: () => void,
  isEditing: () => boolean,
) {
  const state: ViewportState = {
    zoom: 1,
    fit: true,
    x: 24,
    y: 24,
  };
  let size: Size | null = null;
  const fitScale = () =>
    size
      ? Math.min(
          1,
          Math.max(1, viewport.clientWidth - 48) / size.width,
          Math.max(1, viewport.clientHeight - 48) / size.height,
        )
      : 1;
  const snapshot = (): ViewportSnapshot => {
    const r = viewport.getBoundingClientRect();
    return {
      origin: clientPoint(
        r.left + viewport.clientLeft + state.x,
        r.top + viewport.clientTop + state.y,
      ),
      zoom: state.zoom,
    };
  };
  const center = (): ClientPoint => {
    const r = viewport.getBoundingClientRect();
    return clientPoint(
      r.left + viewport.clientLeft + viewport.clientWidth / 2,
      r.top + viewport.clientTop + viewport.clientHeight / 2,
    );
  };
  const render = () => {
    if (!size) return;
    stage.style.width = `${size.width * state.zoom}px`;
    stage.style.height = `${size.height * state.zoom}px`;
    stage.style.translate = `${state.x}px ${state.y}px`;
    onChange();
  };
  const fit = () => {
    if (!size) return;
    state.fit = true;
    state.zoom = fitScale();
    state.x = (viewport.clientWidth - size.width * state.zoom) / 2;
    state.y = (viewport.clientHeight - size.height * state.zoom) / 2;
    render();
  };
  const zoom = (next: number, anchor = center(), destination = anchor) => {
    if (!size || isEditing()) return;
    const previous = snapshot();
    const before = clientToImage(anchor, previous);
    state.zoom = Math.max(Math.min(0.1, fitScale()), Math.min(10, next));
    state.fit = false;
    state.x += destination.x - previous.origin.x - before.x * state.zoom;
    state.y += destination.y - previous.origin.y - before.y * state.zoom;
    render();
  };
  const move = (x: number, y: number) => {
    state.x = x;
    state.y = y;
    state.fit = false;
    render();
  };
  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!size || e.ctrlKey || e.metaKey || e.deltaY === 0) return;
      e.preventDefault();
      zoom(
        state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1),
        clientPoint(e.clientX, e.clientY),
      );
    },
    { passive: false },
  );
  new ResizeObserver(() => {
    onResize();
    if (state.fit) fit();
    else onChange();
  }).observe(viewport, { box: "border-box" });
  return {
    state,
    snapshot,
    center,
    fit,
    zoom,
    move,
    setImage(next: Size) {
      size = next;
      fit();
    },
    imageCenter(): ImagePoint {
      return size
        ? imagePoint(size.width / 2, size.height / 2)
        : imagePoint(0, 0);
    },
    visible() {
      const r = viewport.getBoundingClientRect(),
        v = snapshot();
      const a = clientToImage(
          clientPoint(r.left + viewport.clientLeft, r.top + viewport.clientTop),
          v,
        ),
        b = clientToImage(
          clientPoint(
            r.left + viewport.clientLeft + viewport.clientWidth,
            r.top + viewport.clientTop + viewport.clientHeight,
          ),
          v,
        );
      return {
        left: Math.max(0, a.x),
        top: Math.max(0, a.y),
        right: Math.min(size?.width ?? b.x, b.x),
        bottom: Math.min(size?.height ?? b.y, b.y),
      };
    },
  };
}
