export function overlappingAnnotations(
  overlay: SVGSVGElement,
  point: DOMPoint,
): Set<string> {
  const result = new Set<string>();
  const matrix = overlay.getScreenCTM();
  if (!matrix) return result;
  const local = point.matrixTransform(matrix.inverse());
  // Visible strokes are at most 4 CSS px (4 SVG units on keyboard focus),
  // with the default miter limit of 4. All annotation groups share the SVG CTM.
  // Include their full extent; transparent selection targets are not hits.
  const padding =
    8 *
    Math.max(1, Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
  for (const node of overlay.querySelectorAll<SVGElement>("[data-key]")) {
    const box = node.getBoundingClientRect();
    if (
      point.x < box.left - padding ||
      point.x > box.right + padding ||
      point.y < box.top - padding ||
      point.y > box.bottom + padding
    )
      continue;
    for (const shape of node.querySelectorAll(
      "path, circle, line, rect, text",
    )) {
      if (shape.matches(".hit, .line-hit, .label-hit")) continue;
      let hit = false;
      if (shape instanceof SVGGeometryElement) {
        const style = getComputedStyle(shape);
        hit =
          (style.fill !== "none" && shape.isPointInFill(local)) ||
          (style.stroke !== "none" && shape.isPointInStroke(local));
      } else if (shape instanceof SVGTextElement) {
        const text = shape.getBoundingClientRect();
        hit =
          point.x >= text.left &&
          point.x <= text.right &&
          point.y >= text.top &&
          point.y <= text.bottom;
      }
      if (hit && node.dataset.key) {
        result.add(node.dataset.key);
        break;
      }
    }
  }
  return result;
}
