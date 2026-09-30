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
  getViewport: () => HTMLElement,
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
  const display = $state({ ...state });
  let dimensions = $state.raw({ width: 0, height: 0 });
  const fitScale = () =>
    size
      ? Math.min(
          1,
          Math.max(1, getViewport().clientWidth - 48) / size.width,
          Math.max(1, getViewport().clientHeight - 48) / size.height,
        )
      : 1;
  const snapshot = (): ViewportSnapshot => {
    const r = getViewport().getBoundingClientRect();
    return {
      origin: clientPoint(
        r.left + getViewport().clientLeft + state.x,
        r.top + getViewport().clientTop + state.y,
      ),
      zoom: state.zoom,
    };
  };
  const center = (): ClientPoint => {
    const r = getViewport().getBoundingClientRect();
    return clientPoint(
      r.left + getViewport().clientLeft + getViewport().clientWidth / 2,
      r.top + getViewport().clientTop + getViewport().clientHeight / 2,
    );
  };
  const render = onChange;
  const flush = () => Object.assign(display, state);
  const fit = () => {
    if (!size) return;
    state.fit = true;
    state.zoom = fitScale();
    state.x = (getViewport().clientWidth - size.width * state.zoom) / 2;
    state.y = (getViewport().clientHeight - size.height * state.zoom) / 2;
    flush();
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
  return {
    state,
    get display() {
      return display;
    },
    flush,
    resize() {
      onResize();
      dimensions = {
        width: getViewport().clientWidth,
        height: getViewport().clientHeight,
      };
      if (state.fit) fit();
      else onChange();
    },
    wheel(e: WheelEvent) {
      if (!size || e.ctrlKey || e.metaKey || e.deltaY === 0) return;
      e.preventDefault();
      zoom(
        state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1),
        clientPoint(e.clientX, e.clientY),
      );
    },
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
      const { x, y, zoom } = display;
      return {
        left: Math.max(0, -x / zoom),
        top: Math.max(0, -y / zoom),
        right: Math.min(size?.width ?? 0, (dimensions.width - x) / zoom),
        bottom: Math.min(size?.height ?? 0, (dimensions.height - y) / zoom),
      };
    },
  };
}
