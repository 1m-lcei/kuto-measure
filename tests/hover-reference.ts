// Independent oracle copied from App.svelte at 10d418a; retain the original hit semantics.
export function referenceHover(
  overlay: SVGSVGElement,
  point: DOMPoint,
): Set<string> {
  const overlapped = new Set<string>();
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
  return overlapped;
}
