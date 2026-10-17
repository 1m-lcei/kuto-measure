import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect } from "playwright/test";
import { DEFAULT_CALIBRATION } from "../src/geometry";
import {
  circlePixels,
  fixtureCircle,
  fixtureProjection,
} from "./circle-fixture";

export async function checkCircleDetection(page: Page, engine: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.accept());
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator("#setup-panel-button").click();
  await expect(page.locator("#detect-circles")).toBeDisabled();
  const p = fixtureProjection();
  const pixels = circlePixels(
    p,
    [fixtureCircle(p, 185, 165, 100), fixtureCircle(p, 440, 270, 120)],
    { noise: true },
  );
  const png = await page.evaluate(
    ({ width, height, encoded }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const data = Uint8ClampedArray.from(atob(encoded), (c) =>
        c.charCodeAt(0),
      );
      canvas
        .getContext("2d")
        ?.putImageData(new ImageData(data, width, height), 0, 0);
      return canvas.toDataURL("image/png").split(",")[1];
    },
    {
      width: pixels.width,
      height: pixels.height,
      encoded: Buffer.from(pixels.data).toString("base64"),
    },
  );
  const payload = {
    name: "circles.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  };
  await page.locator("#file").setInputFiles(payload);
  await expect(page.locator("#detect-circles")).toBeEnabled();
  const candidates = page.locator("[data-circle-candidate]");
  const outlines = page.locator("[data-detected-circle]");
  const reference = page.locator('#object-list [data-object-key="reference"]');
  const guides = page.locator('#object-list [data-object-key^="guide:"]');
  await page.locator("#detect-circles").focus();
  await page.keyboard.press("Enter");
  await expect(candidates).toHaveCount(2);
  await expect(outlines).toHaveCount(2);
  await expect(page.locator("#circle-detection")).toHaveAttribute(
    "data-backend",
    "simd",
  );
  await expect(reference).toHaveCount(0);
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(
    candidates.first().locator('[data-use-circle="guide"]'),
  ).toBeDisabled();
  await page.screenshot({
    path: `test-results/${engine}-circle-candidates.png`,
    fullPage: true,
  });
  const shape = await outlines
    .locator("path:first-child")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("d")));

  // Missing/unsupported SIMD must still run the actual production worker.
  await page.route("**/*.wasm", (route) =>
    route.fulfill({ contentType: "application/wasm", body: "invalid" }),
  );
  await page.locator("#detect-circles").click();
  await expect(candidates).toHaveCount(2);
  await expect(page.locator("#circle-detection")).toHaveAttribute(
    "data-backend",
    "javascript",
  );
  assert.deepEqual(
    await outlines
      .locator("path:first-child")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("d"))),
    shape,
  );
  await page.unroute("**/*.wasm");
  await candidates.first().locator('[data-use-circle="reference"]').focus();
  await page.keyboard.press("Enter");
  await expect(reference).toHaveCount(1);
  await expect(page.locator("#reference-radius")).toBeFocused();
  await expect(page.locator("#reference-radius")).toHaveValue("");
  await page.locator("#undo").click();
  await expect(reference).toHaveCount(0);
  await page.locator("#redo").click();
  await expect(reference).toHaveCount(1);
  await page.locator("#close-reference-panel").uncheck();
  await page.locator("#reference-radius").fill("500");
  await page.locator("#reference-radius").press("Tab");
  await candidates.last().locator('[data-use-circle="guide"]').click();
  await expect(guides).toHaveCount(1);
  await page.locator("#undo").click();
  await expect(guides).toHaveCount(0);
  await page.locator("#redo").click();
  await expect(guides).toHaveCount(1);
  await page.locator("#menu-trigger").click();
  const download = page.waitForEvent("download");
  await page.locator("#save-project").click();
  const path = await (await download).path();
  assert(path);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.document.guides.length, 1);
  assert.equal(saved.document.reference.radiusGame, 500);
  assert.equal(saved.document.circles, undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#detect-circles").scrollIntoViewIfNeeded();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: `test-results/${engine}-circle-candidates-mobile.png`,
    fullPage: true,
  });
  const close = page.locator("#clear-circle-candidates");
  const closeBounds = await close.boundingBox();
  const detectBounds = await page.locator("#detect-circles").boundingBox();
  assert(closeBounds && detectBounds);
  assert(Math.abs(closeBounds.width - detectBounds.width) < 1);
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(candidates).toHaveCount(0);
  await expect(outlines).toHaveCount(0);
  await expect(reference).toHaveCount(1);
  await expect(guides).toHaveCount(1);
  await expect(page.locator("#circle-detection-status")).toBeEmpty();
  await expect(page.locator("#circle-detection-status svg")).toHaveCount(0);
  await expect(page.locator("#circle-detection-status")).toHaveAttribute(
    "data-empty",
    "false",
  );
  await page.locator("#detect-circles").click();
  await expect(candidates).toHaveCount(2);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#menu-trigger").click();
  await page.locator("#show-advanced").check();
  await page.keyboard.press("Escape");
  await page.locator("#pitch-angle").fill("28.28");
  await page.locator('#projection-settings button[type="submit"]').click();
  await expect(candidates).toHaveCount(0);
  await expect(outlines).toHaveCount(0);
  await page.locator("#detect-circles").click();
  await expect(page.locator("#circle-detection")).toHaveAttribute(
    "data-backend",
    "simd",
  );
  await page
    .locator("#pitch-angle")
    .fill(String(DEFAULT_CALIBRATION.elevationDegrees));
  await page.locator('#projection-settings button[type="submit"]').click();
  await page.locator("#detect-circles").click();
  await expect(candidates).toHaveCount(2);
  assert.deepEqual(
    await outlines
      .locator("path:first-child")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("d"))),
    shape,
  );

  // Hold the asset request to exercise cancellation and stale result rejection deterministically.
  await page.locator("#file").setInputFiles(payload);
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*.wasm", async (route) => {
    await waiting;
    await route.continue().catch(() => {});
  });
  await page.locator("#detect-circles").click();
  await expect(page.locator("#cancel-circle-detection")).toBeVisible();
  await page.locator("#cancel-circle-detection").click();
  await expect(page.locator("#detect-circles")).toBeEnabled();
  await expect(candidates).toHaveCount(0);
  await page.locator("#detect-circles").click();
  await expect(page.locator("#cancel-circle-detection")).toBeVisible();
  await page.locator("#file").setInputFiles(payload);
  release();
  await page.unroute("**/*.wasm");
  await expect(page.locator("#detect-circles")).toBeEnabled();
  await expect(candidates).toHaveCount(0);
  await expect(page.locator("#cancel-circle-detection")).toHaveCount(0);

  const blank = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    ctx.fillStyle = "#334455";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#file").setInputFiles({
    name: "no-circles.png",
    mimeType: "image/png",
    buffer: Buffer.from(blank, "base64"),
  });
  await page.locator("#detect-circles").click();
  const status = page.locator("#circle-detection-status");
  await expect(status).toHaveAttribute("data-empty", "true");
  await expect(status).toHaveAttribute("aria-busy", "false");
  await expect(status).toBeVisible();
  await expect(status).toHaveText("円を検出できませんでした");
  const warningColor = await page
    .locator(".experimental-badge")
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return style.color;
    });
  await expect(status).toHaveCSS("color", warningColor);
  await expect(status).toHaveCSS("border-left-style", "none");
  await expect(status).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(status.locator("svg")).toBeVisible();
  await expect(status.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(candidates).toHaveCount(0);
  await expect(close).toHaveCount(0);
  await page.screenshot({
    path: `test-results/${engine}-circle-empty.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
}
