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
  scrollLeft: number;
  scrollTop: number;
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
    scrollLeft: 0,
    scrollTop: 0,
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
    const r = stage.getBoundingClientRect();
    return { origin: clientPoint(r.left, r.top), zoom: state.zoom };
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
    onChange();
  };
  const fit = () => {
    if (!size) return;
    state.fit = true;
    state.zoom = fitScale();
    render();
    viewport.scrollTo(0, 0);
  };
  const zoom = (next: number, anchor = center()) => {
    if (!size || isEditing()) return;
    const before = clientToImage(anchor, snapshot());
    state.zoom = Math.max(Math.min(0.1, fitScale()), Math.min(10, next));
    state.fit = false;
    render();
    const after = snapshot();
    viewport.scrollLeft += after.origin.x + before.x * state.zoom - anchor.x;
    viewport.scrollTop += after.origin.y + before.y * state.zoom - anchor.y;
    onChange();
  };
  viewport.addEventListener(
    "scroll",
    () => {
      state.scrollLeft = viewport.scrollLeft;
      state.scrollTop = viewport.scrollTop;
      onChange();
    },
    { passive: true },
  );
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
  }).observe(viewport);
  return {
    state,
    snapshot,
    center,
    fit,
    zoom,
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
