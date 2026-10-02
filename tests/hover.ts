import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect } from "playwright/test";
import {
  buildProjection,
  gameDistance,
  groundLength,
  imagePoint,
  imageToGround,
} from "../src/geometry";
import { overlappingAnnotations } from "../src/hover";
import { emptyDocument } from "../src/model";
import { serializeProject } from "../src/project";
import { referenceHover } from "./hover-reference";

declare global {
  interface Window {
    hoverFunctions: Record<
      "reference" | "shared" | "current",
      typeof referenceHover
    >;
    hoverPoints: { x: number; y: number }[];
  }
}

export async function prepareHover(page: Page, count: number) {
  const size = { width: 1536, height: 709 };
  const image = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.fillStyle = "#384750";
    ctx.fillRect(0, 0, width, height);
    return canvas.toDataURL().split(",")[1];
  }, size);
  const payload = {
    name: "hover.png",
    mimeType: "image/png",
    buffer: Buffer.from(image, "base64"),
  };
  await page.locator("#file").setInputFiles(payload);
  await expect(page.locator("#viewport")).toHaveAttribute("aria-busy", "false");
  const doc = emptyDocument();
  const projection = buildProjection(doc.calibration, size);
  const ground = (x: number, y: number) => {
    const point = imageToGround(imagePoint(x, y), projection);
    assert(point);
    return point;
  };
  const columns = Math.ceil(Math.sqrt(count * 2)),
    rows = Math.ceil(count / columns);
  const pins = Array.from({ length: count }, (_, i) => {
    const index = i >= count - 2 ? 0 : i;
    return {
      id: `p${i}`,
      name: `Pin ${i}`,
      point: ground(
        280 + (960 * (index % columns)) / (columns - 1),
        220 + (360 * Math.floor(index / columns)) / (rows - 1),
      ),
      groupId: i % 4 === 0 ? `g${i % 2}` : null,
    };
  });
  const center = ground(768, 410),
    edge = ground(848, 410);
  const fixture = {
    ...doc,
    renderArea: {
      bounds: { x: 0, y: 0, ...size },
      source: "manual" as const,
      confirmed: true,
    },
    reference: {
      center,
      radiusGround: groundLength(
        Math.hypot(center.x - edge.x, center.y - edge.y),
      ),
      radiusGame: gameDistance(100),
    },
    pins,
    groups: [{ id: "g0", name: "Group" }],
    measurements: Array.from({ length: Math.floor(count / 3) }, (_, i) => ({
      id: `m${i}`,
      from: { kind: "pin" as const, id: `p${i}` },
      to: {
        kind: "pin" as const,
        id: `p${i === 0 ? 2 : i === 1 ? 1 + columns : (i + 10) % count}`,
      },
    })),
    guides: Array.from({ length: count === 24 ? 3 : 12 }, (_, i) => ({
      id: `c${i}`,
      center: { kind: "pin" as const, id: `p${i * 2}` },
      radiusGame: gameDistance(60),
    })),
  };
  await page.locator("#project-file").setInputFiles({
    name: "hover.json",
    mimeType: "application/json",
    buffer: Buffer.from(serializeProject(fixture, size)),
  });
  await expect(
    page.locator('#object-list [data-object-key^="pin:"]'),
  ).toHaveCount(count, { timeout: 30000 });
  await page.locator('[data-tool="pin"]').click();
  await page.evaluate(() => document.fonts.ready);
  const reference = referenceHover.toString();
  const shared = reference
    .replace("function referenceHover", "function sharedHover")
    .replace(
      "const overlapped = new Set",
      "const sharedMatrix = overlay.getScreenCTM(); if (!sharedMatrix) return new Set(); const sharedPoint = point.matrixTransform(sharedMatrix.inverse());\nconst overlapped = new Set",
    )
    .replace(
      /const matrix = shape.getScreenCTM\(\);\s*if \(!matrix\)\s*continue;\s*const local = point.matrixTransform\(matrix.inverse\(\)\)/,
      "const local = sharedPoint",
    );
  assert(
    !shared.includes("shape.getScreenCTM()"),
    "Shared-CTM comparison must replace per-shape transforms",
  );
  await page.addScriptTag({
    content:
      "window.hoverFunctions = { reference: " +
      reference +
      ", shared: " +
      shared +
      ", current: " +
      overlappingAnnotations.toString() +
      "};",
  });
  return { payload, fixture };
}

export async function hoverPoints(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>("#overlay");
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) throw new Error("overlay");
    const points: { x: number; y: number }[] = [];
    let seed = 20261003;
    for (let i = 0; i < 64; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const x = 80 + (seed / 2 ** 32) * 1376;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const y = 100 + (seed / 2 ** 32) * 550;
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      points.push({ x: point.x, y: point.y });
    }
    const shapes = [
      ...Array.from(
        svg.querySelectorAll<SVGGraphicsElement>(
          "[data-key] path:not(.line-hit):not(.visual), [data-key] line:not(.line-hit)",
        ),
      ).slice(0, 16),
      ...Array.from(
        svg.querySelectorAll<SVGGraphicsElement>("[data-key] .visual"),
      ).slice(0, 8),
      ...Array.from(
        svg.querySelectorAll<SVGGraphicsElement>("[data-key] text"),
      ).slice(0, 8),
    ];
    for (const shape of shapes) {
      const box = shape.getBoundingClientRect();
      points.push({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      points.push({ x: box.left - 0.5, y: box.top });
      if (shape instanceof SVGGeometryElement) {
        const local = shape.getPointAtLength(shape.getTotalLength() * 0.37);
        const ctm = shape.getScreenCTM();
        if (ctm) {
          const point = local.matrixTransform(ctm);
          points.push({ x: point.x, y: point.y });
          points.push({ x: point.x + 0.75, y: point.y + 0.75 });
        }
      }
    }
    window.hoverPoints = points;
    return points;
  });
}

export async function measureHover(page: Page) {
  await hoverPoints(page);
  return page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>("#overlay");
    if (!svg) throw new Error("overlay");
    const points = window.hoverPoints.map(({ x, y }) => new DOMPoint(x, y));
    const names = ["reference", "shared", "current"] as const;
    const same = (a: Set<string>, b: Set<string>) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    for (const point of points) {
      const expected = window.hoverFunctions.reference(svg, point);
      for (const name of names) {
        if (!same(expected, window.hoverFunctions[name](svg, point)))
          throw new Error(`Hover mismatch: ${name} at ${point.x}, ${point.y}`);
      }
    }
    const times: Record<string, number[]> = {
      reference: [],
      shared: [],
      current: [],
    };
    // Warm every implementation, then alternate order to reduce warm-up/order bias.
    for (let warm = 0; warm < 3; warm++)
      for (const name of names)
        for (const point of points) window.hoverFunctions[name](svg, point);
    for (let run = 0; run < 5; run++) {
      for (let order = 0; order < names.length; order++) {
        const name = names[(run + order) % names.length];
        const start = performance.now();
        for (let repeat = 0; repeat < 3; repeat++)
          for (const point of points) window.hoverFunctions[name](svg, point);
        times[name].push((performance.now() - start) / (3 * points.length));
      }
    }
    const calls: Record<string, Record<string, number>> = {};
    const originals = {
      query: Element.prototype.querySelectorAll,
      rect: Element.prototype.getBoundingClientRect,
      ctm: SVGGraphicsElement.prototype.getScreenCTM,
      style: window.getComputedStyle,
      fill: SVGGeometryElement.prototype.isPointInFill,
      stroke: SVGGeometryElement.prototype.isPointInStroke,
    };
    for (const name of names) {
      const count = { query: 0, rect: 0, ctm: 0, style: 0, fill: 0, stroke: 0 };
      Element.prototype.querySelectorAll = function (
        this: Element,
        selector: string,
      ) {
        count.query++;
        return originals.query.call(this, selector);
      } as typeof originals.query;
      Element.prototype.getBoundingClientRect = function () {
        count.rect++;
        return originals.rect.call(this);
      };
      SVGGraphicsElement.prototype.getScreenCTM = function () {
        count.ctm++;
        return originals.ctm.call(this);
      };
      window.getComputedStyle = (...args) => {
        count.style++;
        return originals.style.apply(window, args);
      };
      SVGGeometryElement.prototype.isPointInFill = function (...args) {
        count.fill++;
        return originals.fill.apply(this, args);
      };
      SVGGeometryElement.prototype.isPointInStroke = function (...args) {
        count.stroke++;
        return originals.stroke.apply(this, args);
      };
      try {
        for (const point of points) window.hoverFunctions[name](svg, point);
      } finally {
        Element.prototype.querySelectorAll = originals.query;
        Element.prototype.getBoundingClientRect = originals.rect;
        SVGGraphicsElement.prototype.getScreenCTM = originals.ctm;
        window.getComputedStyle = originals.style;
        SVGGeometryElement.prototype.isPointInFill = originals.fill;
        SVGGeometryElement.prototype.isPointInStroke = originals.stroke;
      }
      calls[name] = Object.fromEntries(
        Object.entries(count).map(([key, value]) => [
          key,
          value / points.length,
        ]),
      );
    }
    if (calls.shared.ctm !== 1 || calls.current.ctm !== 1)
      throw new Error("Expected one CTM per query");
    return {
      points: points.length,
      millisecondsPerQuery: times,
      callsPerQuery: calls,
    };
  });
}

export async function checkHover(page: Page) {
  const { payload, fixture } = await prepareHover(page, 24);
  const compare = async (label: string) => {
    await hoverPoints(page);
    const result = await page.evaluate(async () => {
      const svg = document.querySelector<SVGSVGElement>("#overlay");
      const viewport = document.querySelector<HTMLElement>("#viewport");
      if (!svg || !viewport) throw new Error("workspace");
      const mismatch: unknown[] = [];
      for (const point of window.hoverPoints) {
        const expected = [
          ...window.hoverFunctions.reference(
            svg,
            new DOMPoint(point.x, point.y),
          ),
        ].sort();
        const current = [
          ...window.hoverFunctions.current(svg, new DOMPoint(point.x, point.y)),
        ].sort();
        if (JSON.stringify(expected) !== JSON.stringify(current))
          mismatch.push({ point, expected, current });
      }
      // Exercise the application's rAF path at rendered outlines, text, and empty space.
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error("matrix");
      const bounds = document.querySelector<SVGRectElement>("#image-clip rect");
      if (!bounds) throw new Error("clip");
      for (const point of window.hoverPoints.filter((_, i) => i % 8 === 0)) {
        const local = new DOMPoint(point.x, point.y).matrixTransform(
          matrix.inverse(),
        );
        const inside =
          local.x >= bounds.x.baseVal.value &&
          local.y >= bounds.y.baseVal.value &&
          local.x <= bounds.x.baseVal.value + bounds.width.baseVal.value &&
          local.y <= bounds.y.baseVal.value + bounds.height.baseVal.value;
        viewport.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            clientX: point.x,
            clientY: point.y,
          }),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const expected = inside
          ? [
              ...window.hoverFunctions.reference(
                svg,
                new DOMPoint(point.x, point.y),
              ),
            ].sort()
          : [];
        const actual = [
          ...new Set(
            Array.from(
              svg.querySelectorAll<SVGElement>(".pin-overlap"),
              (el) => el.dataset.key,
            ),
          ),
        ].sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual))
          mismatch.push({ point, expected, actual });
      }
      return mismatch;
    });
    assert.deepEqual(result, [], label);
  };
  await compare("initial");
  await page.locator('#overlay [data-part="body"][data-key="pin:p0"]').focus();
  await page.keyboard.press("Tab");
  await compare("keyboard focus stroke");
  const box = await page.locator("#viewport").boundingBox();
  assert(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(
    box.x + box.width / 2 + 25,
    box.y + box.height / 2 + 18,
  );
  await page.mouse.up({ button: "middle" });
  await compare("pan");
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  await compare("zoom");
  await page.locator("#actual").click();
  for (let i = 0; i < 25; i++) await page.locator("#zoom-in").click();
  await page.locator('#overlay [data-part="body"][data-key="pin:p0"]').focus();
  await page.keyboard.press("Tab");
  await compare("maximum zoom and keyboard focus");
  await page.locator("#fit").click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await compare("resize");
  await page.locator('[data-tool="select"]').click();
  await page.locator('[data-object-key="pin:p0"]').click();
  await page.locator("#object-name").fill("Wide label WWW  iii");
  await page.locator("#object-name").press("Tab");
  await page.locator('[data-tool="pin"]').click();
  await compare("edit");
  await page.locator("#undo").click();
  await compare("undo");
  await page.locator("#redo").click();
  await compare("redo");
  await page.locator("#file").setInputFiles(payload);
  await expect(page.locator("#viewport")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-tool="pin"]').click();
  await compare("image replacement");
  await page.locator("#project-file").setInputFiles({
    name: "restored.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      serializeProject(fixture, { width: 1536, height: 709 }),
    ),
  });
  await page.locator('[data-tool="pin"]').click();
  await compare("restored document");
  fixture.renderArea.bounds = { x: 100, y: 80, width: 1336, height: 549 };
  await page.locator("#project-file").setInputFiles({
    name: "clipped.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      serializeProject(fixture, { width: 1536, height: 709 }),
    ),
  });
  await page.locator('[data-tool="pin"]').click();
  await compare("manual game area clip");
  await prepareHover(page, 240);
  await compare("many annotations");
}
