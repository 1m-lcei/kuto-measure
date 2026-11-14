import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect } from "playwright/test";
import {
  buildProjection,
  groundPoint,
  groundToImage,
  imagePoint,
  imageToGround,
} from "../src/geometry";
import { emptyDocument } from "../src/model";
import { serializeProject } from "../src/project";

const imageSize = { width: 1536, height: 709 };
const base = emptyDocument();
const bounds = { ...imageSize, x: 0, y: 0 };
const projection = buildProjection(base.calibration, imageSize, bounds);
function ground(x: number, y: number) {
  const point = imageToGround(imagePoint(x, y), projection);
  assert(point);
  return point;
}

const a = ground(270, 245);
const b = ground(725, 305);
const c = ground(250, 435);
const parallelAt = (scale: number) =>
  groundToImage(
    groundPoint(c.x + (b.x - a.x) * scale, c.y + (b.y - a.y) * scale),
    projection,
  );
const d = parallelAt(1.02);
assert(d);
const pin = (id: string) => ({ kind: "pin" as const, id });
const project = {
  name: "parallel.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    serializeProject(
      {
        ...base,
        renderArea: { bounds, source: "full", confirmed: true },
        pins: [
          { id: "a", name: "A", point: a, groupId: null },
          { id: "b", name: "B", point: b, groupId: null },
          { id: "c", name: "C", point: c, groupId: null },
          { id: "d", name: "D", point: ground(d.x, d.y + 24), groupId: null },
          { id: "member", name: "E", point: ground(815, 580), groupId: "g" },
          { id: "edge", name: "F", point: ground(1432, 600), groupId: "g" },
          { id: "other", name: "G", point: ground(1270, 350), groupId: null },
        ],
        groups: [{ id: "g", name: "Group" }],
        measurements: [
          { id: "reference", from: pin("a"), to: pin("b") },
          { id: "moving", from: pin("c"), to: pin("d") },
          { id: "linked", from: pin("edge"), to: pin("other") },
          {
            id: "grouped",
            from: { kind: "group", id: "g" },
            to: pin("member"),
          },
        ],
      },
      imageSize,
    ),
  ),
};

type ImagePayload = { name: string; mimeType: string; buffer: Buffer };
const body = (page: Page, key: string) =>
  page.locator(`#overlay [data-key="${key}"][data-part="body"]`);
const line = (page: Page, id: string) => body(page, `measurement:${id}`);
const mark = (page: Page, id: string) =>
  line(page, id).locator('[data-part="parallel-mark"]');
const row = (page: Page, key: string) =>
  page.locator(`#object-list [data-object-key="${key}"]`);

async function load(page: Page, image: ImagePayload) {
  await page.locator("#file").setInputFiles(image);
  await expect(page.locator("#image")).toHaveJSProperty("naturalWidth", 1536);
  await expect(page.locator("#viewport")).toHaveAttribute("aria-busy", "false");
  await page.locator("#project-file").setInputFiles(project);
  await expect(line(page, "moving")).toBeVisible();
  await expect(page.locator("#viewport")).toHaveAttribute(
    "data-mode",
    "select",
  );
}

async function screenPoint(page: Page, x: number, y: number) {
  const box = await page.locator("#stage").boundingBox();
  assert(box);
  const zoom = box.width / imageSize.width;
  return { x: box.x + x * zoom, y: box.y + y * zoom, zoom };
}

async function positions(page: Page) {
  const pins = await page
    .locator('#overlay [data-key^="pin:"][data-part="body"] circle.hit')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.parentElement?.getAttribute("data-key")?.slice(4) ?? "",
        x: Number(node.getAttribute("cx")),
        y: Number(node.getAttribute("cy")),
      })),
    );
  return Object.fromEntries(pins.map(({ id, x, y }) => [id, ground(x, y)]));
}

async function linePointer(page: Page) {
  return line(page, "grouped")
    .locator("line.line-hit")
    .evaluate((el) => {
      if (!(el instanceof SVGLineElement)) throw new Error("Missing line");
      const matrix = el.getScreenCTM();
      if (!matrix) throw new Error("Missing line transform");
      const x = 0.6 * el.x1.baseVal.value + 0.4 * el.x2.baseVal.value;
      const y = 0.6 * el.y1.baseVal.value + 0.4 * el.y2.baseVal.value;
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: point.x, y: point.y, zoom: matrix.a };
    });
}

async function png(page: Page) {
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  const downloaded = await pending;
  const path = await downloaded.path();
  assert(path);
  return readFile(path);
}

function assertRigid(
  before: Awaited<ReturnType<typeof positions>>,
  after: Awaited<ReturnType<typeof positions>>,
) {
  const dx = after.member.x - before.member.x;
  const dy = after.member.y - before.member.y;
  assert(Math.hypot(dx, dy) > 1e-4);
  assert(Math.abs(after.edge.x - before.edge.x - dx) < 1e-8);
  assert(Math.abs(after.edge.y - before.edge.y - dy) < 1e-8);
  for (const id of ["a", "b", "c", "d", "other"])
    assert.deepEqual(after[id], before[id]);
}

export async function checkParallel(
  page: Page,
  engine: string,
  image: ImagePayload,
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const checkbox = page.locator("#parallel-snap");
  const undo = page.locator("#undo");
  const selectedPin = row(page, "pin:d");
  const reference = line(page, "reference");
  const moving = line(page, "moving");
  const highlighted = page.locator('#overlay [data-parallel-highlight="true"]');
  await load(page, image);
  await expect(checkbox).toBeChecked();
  const beforeSnap = await positions(page);
  const target = parallelAt(1.18);
  assert(d && target);
  const desktop = page.viewportSize();
  assert(desktop);
  const viewport = page.locator("#viewport");
  await page.setViewportSize({ width: 740, height: desktop.height });
  await viewport.scrollIntoViewIfNeeded();
  await page.locator("#fit").click();
  const start = await screenPoint(page, d.x, d.y + 24);
  const end = await screenPoint(page, target.x, target.y + 7);

  await page.mouse.click(start.x, start.y);
  await expect(body(page, "pin:d")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await expect(mark(page, "moving")).toBeVisible();
  await expect(moving).toHaveAttribute("data-parallel-highlight", "true");
  await expect(reference).toHaveAttribute("data-parallel-highlight", "true");
  await expect(highlighted).toHaveCount(2);
  const viewportBeforeShift = await viewport.boundingBox();
  await page.keyboard.down("Shift");
  await expect(mark(page, "moving")).toHaveCount(0);
  await expect(highlighted).toHaveCount(0);
  assert.deepEqual(await viewport.boundingBox(), viewportBeforeShift);
  await page.keyboard.up("Shift");
  await expect(mark(page, "moving")).toBeVisible();
  await expect(highlighted).toHaveCount(2);
  await page.mouse.up();
  await expect(highlighted).toHaveCount(0);
  const snapped = await positions(page);
  assert.notDeepEqual(snapped.d, beforeSnap.d);
  for (const id of ["a", "b", "c", "member", "edge", "other"])
    assert.deepEqual(snapped[id], beforeSnap[id]);

  await page.setViewportSize(desktop);
  await checkbox.uncheck();
  await expect(mark(page, "reference")).toBeVisible();
  await expect(mark(page, "moving")).toBeVisible();
  const unselectedPng = await png(page);
  await row(page, "measurement:moving").click();
  await expect(moving).toHaveAttribute("data-parallel-highlight", "true");
  await expect(reference).toHaveAttribute("data-parallel-highlight", "true");
  assert(
    (await png(page)).equals(unselectedPng),
    "PNG includes selection styling",
  );
  await page.screenshot({ path: `test-results/${engine}-parallel.png` });
  if (engine === "chromium") {
    await page.setViewportSize({ width: 390, height: desktop.height });
    await page.locator("#fit").click();
    await expect(checkbox).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.screenshot({
      path: "test-results/chromium-parallel-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize(desktop);
  }
  await undo.click();
  assert.deepEqual(await positions(page), beforeSnap);

  await page.reload();
  await load(page, image);
  await expect(checkbox).not.toBeChecked();
  await selectedPin.click();
  const reloadedStart = await screenPoint(page, d.x, d.y + 24);
  const reloadedEnd = await screenPoint(page, target.x, target.y + 7);
  await page.mouse.move(reloadedStart.x, reloadedStart.y);
  await page.mouse.down();
  await page.mouse.move(reloadedEnd.x, reloadedEnd.y);
  await page.mouse.up();
  await expect(mark(page, "moving")).toHaveCount(0);
  const unsnapped = await positions(page);
  assert.notDeepEqual(unsnapped.d, beforeSnap.d);
  assert.notDeepEqual(unsnapped.d, snapped.d);

  await expect(moving).toHaveAttribute("data-movable", "true");
  await undo.click();
  await checkbox.check();
  await selectedPin.click();
  const outside = await screenPoint(page, target.x, -20);
  await page.mouse.move(reloadedStart.x, reloadedStart.y);
  await page.mouse.down();
  await page.mouse.move(reloadedEnd.x, reloadedEnd.y);
  await expect(mark(page, "moving")).toBeVisible();
  await page.mouse.move(outside.x, outside.y);
  await expect(highlighted).toHaveCount(0);
  await expect(mark(page, "moving")).toHaveCount(0);
  assert.deepEqual(await positions(page), unsnapped);
  await page.keyboard.down("Shift");
  await expect(mark(page, "moving")).toHaveCount(0);
  assert.deepEqual(await positions(page), unsnapped);
  await page.keyboard.up("Shift");
  await expect(mark(page, "moving")).toHaveCount(0);
  assert.deepEqual(await positions(page), unsnapped);
  await page.mouse.up();
  assert.deepEqual(await positions(page), unsnapped);

  await undo.click();
  await selectedPin.click();
  await page.mouse.move(reloadedStart.x, reloadedStart.y);
  await page.mouse.down();
  await page.mouse.move(reloadedEnd.x, reloadedEnd.y);
  await page.mouse.up();
  await expect(mark(page, "moving")).toBeVisible();
  await body(page, "pin:d").press("ArrowDown");
  await expect(mark(page, "moving")).toHaveCount(0);
  await undo.click();
  await expect(mark(page, "moving")).toBeVisible();

  const grouped = line(page, "grouped");
  await row(page, "measurement:grouped").click();
  const original = await positions(page);
  const linkedLine = line(page, "linked").locator("line.line-hit");
  const linkedStart = await linkedLine.getAttribute("x1");
  const pointer = await linePointer(page);
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(
    pointer.x - 72 * pointer.zoom,
    pointer.y - 30 * pointer.zoom,
  );
  await expect.poll(() => positions(page)).not.toEqual(original);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => positions(page)).toEqual(original);

  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(pointer.x + 205 * pointer.zoom, pointer.y);
  await page.mouse.up();
  assert.deepEqual(await positions(page), original);

  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(
    pointer.x - 72 * pointer.zoom,
    pointer.y - 30 * pointer.zoom,
  );
  await page.mouse.up();
  assertRigid(original, await positions(page));
  await expect(linkedLine).not.toHaveAttribute("x1", linkedStart ?? "");
  await undo.click();
  await expect.poll(() => positions(page)).toEqual(original);

  await row(page, "measurement:grouped").click();
  const beforeKey = await linePointer(page);
  await grouped.press("Shift+ArrowLeft");
  assertRigid(original, await positions(page));
  const afterKey = await linePointer(page);
  assert(Math.abs(beforeKey.x - afterKey.x - 10 * beforeKey.zoom) < 0.4);
  assert.deepEqual(errors, []);
}

export async function checkParallelTouch(page: Page, image: ImagePayload) {
  await load(page, image);
  await row(page, "measurement:grouped").click();
  await page.locator("#viewport").scrollIntoViewIfNeeded();
  const before = await positions(page);
  const { x, y } = await linePointer(page);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x - 54, y: y - 28 }],
    });
    await expect.poll(() => positions(page)).not.toEqual(before);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    assertRigid(before, await positions(page));
    await page.locator("#undo").click();
    await expect.poll(() => positions(page)).toEqual(before);
  } finally {
    await session.detach();
  }
}
