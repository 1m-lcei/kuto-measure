import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox, type Page, webkit } from "playwright";
import { expect } from "playwright/test";
import { checkGameArea } from "./game-area";
import { checkHover } from "./hover";
import { checkImageLoading } from "./image-loading";
import { checkInteractions } from "./interactions";
import { checkProject } from "./project";
import { checkReactivity } from "./reactivity";
import { checkTouch } from "./touch";

const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
let commit = "";
try {
  commit = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  /* Git-free builds display only the package version. */
}

// Serve the actual production artifact under a project-site path; no app test hooks.
const root = resolve("dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/nested/"))
      return new Response("Not found", { status: 404 });
    const path = resolve(
      root,
      decodeURIComponent(pathname.slice(8) || "index.html"),
    );
    if (
      path !== root &&
      !path.startsWith(`${root}\\`) &&
      !path.startsWith(`${root}/`)
    )
      return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});
await mkdir("test-results", { recursive: true });
const imagePayload = async (
  page: Page,
  width = 1536,
  height = 709,
  border = 0,
) => {
  const data = await page.evaluate(
    ({ width, height, border }) => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      if (!ctx) throw Error("canvas");
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#384750");
      gradient.addColorStop(1, "#6a7970");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "#8eaaa080";
      ctx.lineWidth = 1;
      for (let i = -12; i < 18; i++) {
        ctx.beginPath();
        ctx.moveTo(width / 2 + i * 40, 0);
        ctx.lineTo(width / 2 + i * 160, height);
        ctx.stroke();
      }
      for (let y = 40; y < height; y += 65) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.fillStyle = "#e8eee9";
      ctx.font = "24px sans-serif";
      ctx.fillText("KUTO / TEST GROUND", 60, 60);
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, width, border);
      ctx.fillRect(0, height - border, width, border);
      return c.toDataURL("image/png").split(",")[1];
    },
    { width, height, border },
  );
  return {
    name: "ground.png",
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  };
};
async function point(page: Page, x: number, y: number) {
  const box = await page.locator("#stage").boundingBox();
  assert(box);
  return {
    x: box.x + (x * box.width) / 1536,
    y: box.y + (y * box.height) / 709,
  };
}
async function clickImage(page: Page, x: number, y: number) {
  const p = await point(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function circlePosition(page: Page, key: string) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  return page
    .locator(`#overlay [data-key="${key}"] circle.hit`)
    .first()
    .evaluate((el) => ({
      x: Number(el.getAttribute("cx")),
      y: Number(el.getAttribute("cy")),
    }));
}
async function png(page: Page) {
  const pending = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await pending;
  const path = await download.path();
  assert(path);
  const bytes = await readFile(path);
  assert.equal(bytes.readUInt32BE(16), 1536);
  assert.equal(bytes.readUInt32BE(20), 709);
  return bytes;
}
const engines = process.env.BROWSER
  ? {
      [process.env.BROWSER]: ({ chromium, firefox, webkit } as const)[
        process.env.BROWSER as "chromium" | "firefox" | "webkit"
      ],
    }
  : { chromium, firefox, webkit };
let failed = false;
try {
  for (const [name, engine] of Object.entries(engines)) {
    assert(engine, `Unknown browser ${name}`);
    let browser: Awaited<ReturnType<typeof engine.launch>>;
    try {
      browser = await engine.launch();
    } catch (error) {
      failed = true;
      console.error(`${name}: browser launch failed`, error);
      continue;
    }
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: undefined,
      });
    });
    const page = await context.newPage();
    const modes = page.locator(".tools");
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    try {
      await page.goto(`http://127.0.0.1:${server.port}/nested/`);
      await expect(modes.locator('[data-tool="pin"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(
        page.getByRole("application").getByRole("list"),
      ).toBeVisible();
      await expect(
        page.getByRole("application").getByRole("listitem").first(),
      ).toBeVisible();
      await expect(
        page.locator("#object-list").getByRole("button"),
      ).toHaveCount(0);
      await expect(page.locator("#export")).toBeDisabled();
      await page.screenshot({
        path: `test-results/${name}-empty-hint.png`,
        fullPage: true,
      });
      // The two work areas are exclusive, keyboard-operable, and keep the distance mode visible.
      const editPanel = page.locator("#edit-panel-button");
      const setupPanel = page.locator("#setup-panel-button");
      await setupPanel.focus();
      await page.keyboard.press("Enter");
      await expect(setupPanel).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#analysis-panel")).toBeHidden();
      await expect(page.locator("#reference-panel")).toBeVisible();
      await expect(page.locator("#scale-state")).toBeVisible();
      await page.locator("#camera-settings > summary").click();
      await expect(page.locator("#projection-settings")).toBeVisible();
      await page.locator("#camera-settings > summary").click();
      await editPanel.focus();
      await page.keyboard.press("Space");
      await expect(editPanel).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("#reference-panel")).toBeHidden();
      await expect(page.locator("#analysis-panel")).toBeVisible();
      await expect(page.locator("#scale-state")).toBeVisible();
      for (const width of [1440, 780, 779, 480, 390, 360, 320, 1440]) {
        await page.locator("#theme-toggle").focus();
        await page.setViewportSize({ width, height: 1000 });
        assert.deepEqual(
          await page
            .locator(".zoom-tools button")
            .evaluateAll((buttons) =>
              buttons.map((button) => button.getBoundingClientRect().height),
            ),
          [32, 32, 32, 32],
          `Zoom button heights differ at ${width}px`,
        );
        assert(
          await page.locator(".icon-button").evaluateAll((buttons) =>
            buttons.every((button) => {
              const box = button.getBoundingClientRect();
              return box.width === box.height;
            }),
          ),
          `Icon buttons must be square at ${width}px`,
        );
        await page.waitForFunction(() => {
          const header = document.getElementById("header");
          return (
            (header?.children[1]?.id === "header-icons") ===
            matchMedia("(width < 780px)").matches
          );
        });
        await expect(page.locator("#theme-toggle")).toBeFocused();
        const [title, files, icons] = await Promise.all(
          [
            ".header hgroup",
            ".header-actions:not(#header-icons)",
            "#header-icons",
          ].map((selector) =>
            page.locator(selector).evaluate((el) => {
              const { top, right, bottom, left } = el.getBoundingClientRect();
              return { top, right, bottom, left };
            }),
          ),
        );
        for (const box of [title, files, icons])
          assert(
            box.left >= 0 && box.right <= width,
            `Header overflows at ${width}px`,
          );
        if (width < 780) {
          assert(Math.max(title.bottom, icons.bottom) <= files.top);
          if (width >= 390) {
            assert(title.right <= icons.left);
            assert(
              Math.max(title.top, icons.top) <
                Math.min(title.bottom, icons.bottom),
            );
          } else {
            assert(title.bottom <= icons.top);
          }
          await page.locator("#menu-trigger").focus();
          await page.keyboard.press("Tab");
          await expect(page.locator("#file")).toBeFocused();
        } else {
          assert(title.right <= files.left && files.right <= icons.left);
          assert(
            Math.max(title.top, files.top, icons.top) <
              Math.min(title.bottom, files.bottom, icons.bottom),
          );
          await page.locator("#file").focus();
          await page.keyboard.press("Tab");
          await expect(page.locator("#help-trigger")).toBeFocused();
        }
      }
      const selectedTheme = () =>
        page
          .getByRole("radio", { checked: true, includeHidden: true })
          .inputValue();
      await expect(page.locator("#show-advanced")).not.toBeChecked();
      await expect(page.locator("#projection-fields")).toBeHidden();
      await expect(page.locator("#reference-panel")).toBeHidden();
      await expect(page.locator("#analysis-panel")).toBeVisible();
      await page.locator("#menu-trigger").click();
      await page.locator("#show-advanced").check();
      await expect(page.locator("#projection-fields")).toBeVisible();
      await expect(page.locator("#pitch-angle")).toBeDisabled();
      await page.locator("#show-advanced").uncheck();
      await page.keyboard.press("Escape");
      const scheme = () =>
        page.locator("html").evaluate((el) => getComputedStyle(el).colorScheme);
      for (const system of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: system });
        assert.equal(await selectedTheme(), "system");
        assert.equal(await scheme(), system);
        await page.locator("#theme-toggle").click();
        assert.equal(
          await selectedTheme(),
          system === "light" ? "dark" : "light",
        );
        assert.equal(await scheme(), system === "light" ? "dark" : "light");
        await page.locator("#theme-toggle").click();
        assert.equal(await selectedTheme(), "system");
      }
      await page.locator("#menu-trigger").click();
      for (const value of ["light", "dark", "system"]) {
        await page.locator(`input[name="theme"][value="${value}"]`).check();
        assert.equal(await selectedTheme(), value);
        assert.equal(await scheme(), value === "system" ? "dark" : value);
      }
      await page.locator('input[name="theme"][value="light"]').check();
      await page.reload();
      assert.equal(await selectedTheme(), "light");
      assert.equal(await scheme(), "light");
      await page.locator("#menu-trigger").click();
      await page.locator("#about-trigger").click();
      await expect(page.locator("#about")).toBeVisible();
      assert.equal(
        await page
          .getByRole("dialog")
          .locator('a[href="https://x.com/1m_lcei"]')
          .getAttribute("href"),
        "https://x.com/1m_lcei",
      );
      assert.equal(
        await page
          .getByRole("dialog")
          .locator('a[href="https://github.com/1m-lcei/kuto-measure"]')
          .getAttribute("href"),
        "https://github.com/1m-lcei/kuto-measure",
      );
      await expect(page.locator(".release-label")).toBeVisible();
      await expect(page.locator(".release-label")).not.toBeEmpty();
      await expect(page.locator("#app-version")).toContainText(version);
      if (commit)
        await expect(page.locator("#app-version")).toContainText(commit);
      await page.screenshot({ path: `test-results/${name}-about.png` });
      await expect(page.locator("#header-menu")).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(page.locator("#menu-trigger")).toBeFocused();
      await page.locator("#menu-trigger").click();
      await page.locator("#about-trigger").click();
      await page.mouse.click(4, 4);
      await page.locator("#about").waitFor({ state: "hidden" });
      await page.locator("#menu-trigger").click();
      await page.keyboard.press("Escape");
      await expect(page.locator("#header-menu")).toBeHidden();
      // Supported raster data must load even if its extension/MIME label is wrong.
      for (const type of ["image/png", "image/jpeg"]) {
        const data = await page.evaluate((type) => {
          const canvas = document.createElement("canvas");
          canvas.width = 200;
          canvas.height = 100;
          return canvas.toDataURL(type).split(",")[1];
        }, type);
        await page.locator("#file").setInputFiles({
          name: type === "image/png" ? "renamed.jpg" : "renamed.png",
          mimeType: type === "image/png" ? "image/jpeg" : "image/png",
          buffer: Buffer.from(data, "base64"),
        });
        await expect(page.locator("#image-size")).toHaveText(
          "画像 200 × 100 px",
        );
        await expect(page.getByRole("application")).toHaveAttribute(
          "aria-busy",
          "false",
        );
        await expect(page.locator("#error")).toBeHidden();
        await expect(page.locator("#image")).toHaveJSProperty(
          "naturalWidth",
          200,
        );
      }
      await page.locator("#file").setInputFiles(await imagePayload(page));
      await page.locator("#stage").waitFor({ state: "visible" });
      await expect(modes.locator('[data-tool="pin"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByRole("application")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await expect(
        page.locator("#error"),
        "Valid image must load without an error",
      ).toBeHidden();
      await expect(page.locator("#image")).toHaveJSProperty(
        "naturalWidth",
        1536,
      );
      await expect(page.locator("#image")).toHaveJSProperty(
        "naturalHeight",
        709,
      );
      await expect(page.locator("#area-state")).toHaveAttribute(
        "data-source",
        "fallback",
      );
      await expect(page.locator("#image-clip rect")).toHaveAttribute(
        "width",
        "1536",
      );
      await expect(page.locator("#image-clip rect")).toHaveAttribute(
        "height",
        "709",
      );
      await modes.locator('[data-tool="pin"]').click();
      await clickImage(page, 500, 400);
      await clickImage(page, 1000, 470);
      await page.locator("#measure-from").selectOption({ index: 1 });
      await page.locator("#measure-to").selectOption({ index: 2 });
      await page.locator("#add-measure").click();
      await expect
        .poll(async () =>
          Number(
            await page
              .locator('#object-list [data-object-key^="measurement:"] small')
              .textContent(),
          ),
        )
        .toBe(1);
      await expect(page.locator("#scale-state")).toHaveAttribute(
        "data-state",
        "relative",
      );
      await expect
        .poll(async () =>
          Number(
            await page
              .locator(
                '#overlay [data-part="label"][data-key^="measurement:"] text',
              )
              .textContent(),
          ),
        )
        .toBe(1);
      const leaderGaps = await page
        .locator("#overlay .label-leader")
        .evaluateAll((leaders) => {
          const ctx = document.createElement("canvas").getContext("2d");
          if (!ctx) throw new Error("Missing text metrics");
          ctx.font = "12px system-ui, sans-serif";
          return leaders.map((node) => {
            const line = node as SVGLineElement;
            const text = line.parentElement?.querySelector(
              "text",
            ) as SVGTextElement;
            const zoom = text.getScreenCTM()?.a;
            if (!zoom) throw new Error("Missing SVG transform");
            const metrics = ctx.measureText(text.textContent ?? "");
            const x = text.x.baseVal[0].value * zoom;
            const y = text.y.baseVal[0].value * zoom;
            const endX = line.x2.baseVal.value * zoom;
            const endY = line.y2.baseVal.value * zoom;
            return Math.max(
              x - metrics.actualBoundingBoxLeft - endX,
              endX - x - metrics.actualBoundingBoxRight,
              y - metrics.actualBoundingBoxAscent - endY,
              endY - y - metrics.actualBoundingBoxDescent,
            );
          });
        });
      assert(leaderGaps.length >= 2, "Pin labels have leaders");
      for (const gap of leaderGaps)
        assert(
          Math.abs(gap - 2) < 0.1,
          `Leader must meet the text halo: ${gap}px`,
        );
      await modes.locator('[data-tool="pin"]').click();
      await clickImage(page, 1200, 550);
      await page.locator("#measure-to").selectOption({ index: 3 });
      await page.locator("#add-measure").click();
      const relativeRows = page.locator(
        '#object-list [data-object-key^="measurement:"]',
      );
      const up = page.locator("#object-up");
      const down = page.locator("#object-down");
      const listActions = page.locator("#object-order");
      await expect(
        listActions.locator("..").locator("#object-list"),
      ).toHaveCount(1);
      await expect(page.locator("#properties #object-order")).toHaveCount(0);
      const [upBox, downBox] = await Promise.all([
        up.boundingBox(),
        down.boundingBox(),
      ]);
      assert(upBox && downBox);
      assert.equal(upBox.y, downBox.y);
      assert(upBox.x + upBox.width <= downBox.x);
      await expect(relativeRows).toHaveCount(2);
      await expect(
        page.locator("#object-list .object-row").first(),
      ).toHaveAttribute("data-object-key", /^measurement:/);
      const originalKeys = await relativeRows.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute("data-object-key")),
      );
      const originalValues = await relativeRows
        .locator("small")
        .allTextContents();
      const ratio = Number(originalValues[1]);
      assert(ratio > 0 && ratio !== 1);
      await expect(up).toBeEnabled();
      await expect(down).toBeDisabled();
      await up.focus();
      await page.keyboard.press("Enter");
      await expect(relativeRows.first()).toHaveAttribute(
        "data-object-key",
        originalKeys[1] ?? "",
      );
      await expect(relativeRows.first()).toBeFocused();
      await expect(relativeRows.first()).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(relativeRows.first().locator("small")).toHaveText("1.0000");
      await expect
        .poll(async () =>
          Math.abs(
            Number(await relativeRows.last().locator("small").textContent()) -
              1 / ratio,
          ),
        )
        .toBeLessThan(0.001);
      await expect(up).toBeDisabled();
      await expect(down).toBeEnabled();
      await expect(page.locator("#status")).not.toBeEmpty();
      await expect(
        page.locator(
          `#overlay [data-part="label"][data-key="${originalKeys[1]}"] text`,
        ),
      ).toHaveText("1.0000");
      await page.locator("#undo").click();
      await expect(relativeRows.locator("small")).toHaveText(originalValues);
      await expect(relativeRows.first()).toHaveAttribute(
        "data-object-key",
        originalKeys[0] ?? "",
      );
      await page.locator("#redo").click();
      await expect(relativeRows.first()).toHaveAttribute(
        "data-object-key",
        originalKeys[1] ?? "",
      );
      await down.click();
      await expect(relativeRows.locator("small")).toHaveText(originalValues);
      await expect(relativeRows.last()).toBeFocused();
      await page.screenshot({
        path: `test-results/${name}-reorder.png`,
        fullPage: true,
      });
      await modes.locator('[data-tool="measure"]').click();
      await clickImage(page, 500, 400);
      await clickImage(page, 1000, 470);
      await expect(relativeRows).toHaveCount(3);
      await expect(page.locator("#viewport")).toHaveAttribute(
        "data-mode",
        "measure",
      );
      const relativePins = page.locator(
        '#object-list [data-object-key^="pin:"]',
      );
      await relativePins.nth(1).click();
      await expect(relativePins.nth(1)).toBeInViewport();
      await expect(relativePins.nth(1)).toBeFocused();
      await expect(relativeRows).toHaveCount(3);
      await relativePins.nth(2).click();
      await expect(relativeRows).toHaveCount(4);
      for (const pin of [relativePins.nth(1), relativePins.nth(2)]) {
        const pinName = await pin
          .locator(".object-label")
          .evaluate((el) => el.firstChild?.textContent?.trim() ?? "");
        assert(pinName);
        await expect(
          relativeRows.last().locator(".object-label"),
        ).toContainText(pinName);
      }
      await expect(page.locator("#viewport")).toHaveAttribute(
        "data-mode",
        "measure",
      );
      await page.keyboard.press("Escape");
      await expect(page.locator("#viewport")).toHaveAttribute(
        "data-mode",
        "select",
      );
      await page.locator("#file").setInputFiles(await imagePayload(page));
      await expect(
        page.locator("#object-list").getByRole("button"),
      ).toHaveCount(0);
      await modes.locator('[data-tool="reference"]').click();
      await clickImage(page, 768, 355);
      await clickImage(page, 900, 355);
      await page.locator("#reference-radius").fill("500");
      await page.locator("#reference-radius").press("Tab");
      assert(!(await page.locator("#reference-panel").isVisible()));
      assert(await page.locator("#analysis-panel").isVisible());
      await modes.locator('[data-tool="reference"]').click();
      await expect(page.locator("#reference-radius")).toBeVisible();
      await page.locator("#close-reference-panel").uncheck();
      await page.locator("#reference-radius").fill("501");
      await page.locator("#reference-radius").press("Enter");
      assert(await page.locator("#reference-panel").isVisible());
      await page.locator("#close-reference-panel").check();
      await page.locator("#reference-radius").fill("-1");
      await page.locator("#reference-radius").press("Enter");
      assert(await page.locator("#reference-panel").isVisible());
      await page.locator("#reference-radius").fill("500");
      await page.locator("#reference-radius").press("Enter");
      assert(!(await page.locator("#reference-panel").isVisible()));
      await expect(page.locator("#scale-state")).toHaveAttribute(
        "data-state",
        "absolute",
      );
      await modes.locator('[data-tool="pin"]').click();
      await clickImage(page, 500, 400);
      await clickImage(page, 1000, 470);
      const pinKeys = await page
        .locator('#object-list [data-object-key^="pin:"]')
        .evaluateAll((nodes) =>
          nodes.map((n) => (n as HTMLElement).dataset.objectKey as string),
        );
      assert.equal(pinKeys.length, 2);
      await page.locator("#measure-from").selectOption(pinKeys[0]);
      await page.locator("#measure-to").selectOption(pinKeys[1]);
      await page.locator("#add-measure").click();
      const measurement = page.locator(
        '#object-list [data-object-key^="measurement:"] small',
      );
      const baselineDistance = await measurement.textContent();
      assert(
        baselineDistance &&
          Number.isFinite(Number(baselineDistance.replaceAll(",", ""))),
      );
      await page.locator("#menu-trigger").click();
      await page.locator("#show-advanced").check();
      await page.keyboard.press("Escape");
      const initialPin = await circlePosition(page, pinKeys[0]);
      const initialPng = await png(page);
      for (const [id, value] of [
        ["pitch-angle", "35"],
        ["vertical-fov", "12"],
        ["roll-angle", "7"],
        ["principal-x", "0.48"],
        ["principal-y", "0.55"],
      ])
        await page.locator(`#${id}`).fill(value);
      await page.locator("#export").focus();
      await page.locator("#fit").click();
      assert.equal(
        await page.locator("#pitch-angle").inputValue(),
        "35",
        "Viewport updates must preserve unapplied settings",
      );
      await page.locator('#projection-settings button[type="submit"]').click();
      await expect(page.locator("#error")).toBeHidden();
      const changedDistance = await measurement.textContent();
      assert.notEqual(changedDistance, baselineDistance);
      const adjustedPin = await circlePosition(page, pinKeys[0]);
      assert(
        Math.hypot(adjustedPin.x - initialPin.x, adjustedPin.y - initialPin.y) <
          0.01,
      );
      const adjustedPng = await png(page);
      assert(!adjustedPng.equals(initialPng));
      await page.locator("#undo").click();
      await expect(page.locator("#pitch-angle")).toHaveValue("25.2");
      assert.equal(await measurement.textContent(), baselineDistance);
      assert((await png(page)).equals(initialPng));
      await page.locator("#redo").click();
      await expect(page.locator("#pitch-angle")).toHaveValue("35");
      assert.equal(await measurement.textContent(), changedDistance);
      assert((await png(page)).equals(adjustedPng));
      await page.locator("#pitch-angle").fill("0");
      await page.locator('#projection-settings button[type="submit"]').click();
      await expect(page.locator("#error")).toBeVisible();
      assert.equal(await measurement.textContent(), changedDistance);
      await page.locator("#pitch-angle").fill("35");
      await page.locator('#projection-settings button[type="submit"]').click();
      await expect(page.locator("#error")).toBeHidden();
      await page.screenshot({ path: `test-results/${name}-advanced.png` });
      await page.setViewportSize({ width: 390, height: 1000 });
      await page
        .locator('#projection-settings button[type="submit"]')
        .scrollIntoViewIfNeeded();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `test-results/${name}-advanced-mobile.png`,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator("#menu-trigger").click();
      await page.locator("#show-advanced").uncheck();
      await expect(page.locator("#projection-fields")).toBeHidden();
      assert.equal(await measurement.textContent(), changedDistance);
      await page.keyboard.press("Escape");
      await page.locator("#undo").click();
      assert.equal(await measurement.textContent(), baselineDistance);
      await page.locator("#edit-panel-button").click();
      await modes.locator('[data-tool="guide"]').click();
      await clickImage(page, 500, 400);
      await page.mouse.click(4, 4);
      await page.locator("#guide-dialog").waitFor({ state: "hidden" });
      await expect(page.getByRole("application")).toBeFocused();
      await expect(
        page.locator('#object-list [data-object-key^="guide:"]'),
      ).toHaveCount(0);
      await clickImage(page, 500, 400);
      await page.keyboard.press("Escape");
      await page.locator("#guide-dialog").waitFor({ state: "hidden" });
      await expect(page.getByRole("application")).toBeFocused();
      await clickImage(page, 500, 400);
      const guideDialog = page.locator("#guide-dialog");
      const guideInput = guideDialog.locator("#new-guide-radius");
      const addGuide = guideDialog.locator('button[type="submit"]');
      const guideRows = page.locator(
        '#object-list [data-object-key^="guide:"]',
      );
      await expect(guideInput).toHaveValue("0");
      await addGuide.click();
      await expect(page.locator("#guide-error")).not.toBeEmpty();
      await expect(guideRows).toHaveCount(0);
      await guideInput.fill("350");
      await addGuide.click();
      await expect(guideDialog).toBeHidden();
      await expect(guideRows).toHaveCount(1);
      await expect(page.locator("#viewport")).toHaveAttribute(
        "data-mode",
        "guide",
      );
      await expect(page.getByRole("application")).toBeFocused();
      await clickImage(page, 1150, 550);
      await expect(guideInput).toHaveValue("0");
      await expect(page.locator("#guide-error")).toBeEmpty();
      await guideInput.fill("200");
      await addGuide.click();
      await expect(guideDialog).toBeHidden();
      await expect(guideRows).toHaveCount(2);
      await expect(page.locator("#viewport")).toHaveAttribute(
        "data-mode",
        "guide",
      );
      await page.locator("#undo").click();
      await expect(guideRows).toHaveCount(1);
      await page.locator("#help-trigger").click();
      await expect(page.locator("#help")).toBeVisible();
      const helpDetails = page.locator("#help-details");
      await expect(helpDetails).toHaveJSProperty("open", false);
      await expect(helpDetails.locator("p").first()).toBeHidden();
      await page.locator("#help-details-title").press("Enter");
      await expect(helpDetails.locator("p").first()).toBeVisible();
      await page.locator("#help-details-title").press("Space");
      await expect(helpDetails).toHaveJSProperty("open", false);
      await page.locator("#help").locator("#help-title").click();
      await expect(page.locator("#help")).toBeVisible();
      await page.mouse.click(4, 4);
      await page.locator("#help").waitFor({ state: "hidden" });
      await page.locator("#help-trigger").click();
      await page.keyboard.press("Escape");
      await page.locator("#help").waitFor({ state: "hidden" });
      const before = await png(page);
      await page.locator("#zoom-in").click();
      await page.locator("#zoom-in").click();
      const panBox = await page.getByRole("application").boundingBox();
      assert(panBox);
      await page.mouse.move(panBox.x + 180, panBox.y + 120);
      await page.keyboard.down("Space");
      await page.mouse.down();
      await page.mouse.move(panBox.x + 50, panBox.y + 55);
      await page.mouse.up();
      await page.keyboard.up("Space");
      assert.equal(await measurement.textContent(), baselineDistance);
      const after = await png(page);
      assert(before.equals(after), `${name}: PNG changed with zoom/pan`);
      if (name === "chromium") {
        await page.locator("#fit").click();
        await modes.locator('[data-tool="select"]').click();
        const initial = await circlePosition(page, pinKeys[0]);
        const start = await point(page, initial.x, initial.y),
          end = await point(page, initial.x + 80, initial.y + 30);
        await page.mouse.click(start.x, start.y);
        await expect(
          page.locator(`#overlay [data-key="${pinKeys[0]}"]`).first(),
        ).toHaveAttribute("aria-pressed", "true");
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 4 });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        assert.deepEqual(
          await circlePosition(page, pinKeys[0]),
          initial,
          "Escape failed to cancel drag",
        );
        await modes.locator('[data-tool="select"]').click();
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 4 });
        await page.mouse.move(start.x, start.y, { steps: 4 });
        await page.mouse.up();
        assert.deepEqual(await circlePosition(page, pinKeys[0]), initial);
        await page.locator("#undo").click();
        assert.equal(
          await page
            .locator('#object-list [data-object-key^="guide:"]')
            .count(),
          0,
          "Return-to-start drag must not create an edit",
        );
        await page.locator("#redo").click();
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(end.x, end.y, { steps: 4 });
        await page.mouse.up();
        const moved = await circlePosition(page, pinKeys[0]);
        assert.notDeepEqual(moved, initial);
        await page.locator("#undo").click();
        assert.deepEqual(await circlePosition(page, pinKeys[0]), initial);
        await page.locator("#redo").click();
        assert.deepEqual(await circlePosition(page, pinKeys[0]), moved);
        await page.locator("#undo").click();
        await page.locator("#add-group").click();
        await page.locator("#object-name").fill("チーム A");
        await page.locator("#object-name").press("Tab");
        const groupKey = await page
          .locator('#object-list [data-object-key^="group:"]')
          .getAttribute("data-object-key");
        assert(groupKey);
        for (const key of pinKeys) {
          await page.locator(`[data-object-key="${key}"]`).click();
          await page.locator("#pin-group").selectOption(groupKey.slice(6));
        }
        assert(await page.locator(`#overlay [data-key="${groupKey}"]`).count());
        await page.locator("#measure-to").selectOption(groupKey);
        await page.locator("#add-measure").click();
        await modes.locator('[data-tool="guide"]').click();
        await page.locator(`[data-object-key="${groupKey}"]`).click();
        await guideInput.fill("350");
        await page
          .locator("#guide-dialog")
          .locator('button[type="submit"]')
          .click();
        await expect(
          page.locator('#object-list [data-object-key^="guide:"]'),
        ).toHaveCount(2);
        await modes.locator('[data-tool="select"]').click();
        await page.locator("#undo").click();
        await page.locator(`[data-object-key="${pinKeys[0]}"]`).click();
        await page.locator("#delete").click();
        await expect(
          page.locator('#object-list [data-object-key^="guide:"]'),
        ).toHaveCount(0);
        await expect(
          page.locator('#object-list [data-object-key^="measurement:"]'),
        ).toHaveCount(0);
        await page.locator("#undo").click();
        await expect(
          page.locator('#object-list [data-object-key^="guide:"]'),
        ).toHaveCount(1);
        await expect(
          page.locator('#object-list [data-object-key^="measurement:"]'),
        ).toHaveCount(2);
        // Keyboard placement and exactly one edit for a committed movement.
        await modes.locator('[data-tool="pin"]').click();
        await page.getByRole("application").focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await expect(
          page.locator('#object-list [data-object-key^="pin:"]'),
        ).toHaveCount(3);
        await page.keyboard.press("Control+z");
        await expect(
          page.locator('#object-list [data-object-key^="pin:"]'),
        ).toHaveCount(2);
        await modes.locator('[data-tool="select"]').click();
        const oldDistance = await measurement.first().textContent();
        await page.locator('[data-object-key="reference"]').click();
        const handle = page
          .locator('#overlay [data-handle="radius"] circle.visual')
          .first();
        const box = await handle.boundingBox();
        assert(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          box.x + box.width / 2 + 35,
          box.y + box.height / 2,
          { steps: 4 },
        );
        await page.mouse.up();
        assert.notEqual(
          await measurement.first().textContent(),
          oldDistance,
          "Reference resize must recalibrate measurements",
        );
        await page.locator("#undo").click();
        assert.equal(await measurement.first().textContent(), oldDistance);
        await page.locator('[data-object-key="reference"]').click();
        await page.locator("#delete").click();
        await expect(page.locator("#scale-state")).toHaveAttribute(
          "data-state",
          "relative",
        );
        await expect
          .poll(async () =>
            Number(
              (await measurement.first().textContent())?.replaceAll(",", ""),
            ),
          )
          .toBe(1);
        await expect(
          page.locator('#object-list [data-object-key^="guide:"]'),
        ).toHaveCount(1);
        await page.locator("#undo").click();
        assert.equal(await measurement.first().textContent(), oldDistance);
        await page.screenshot({
          path: "test-results/workspace-light.png",
          fullPage: true,
        });
        await page.locator("#theme-toggle").click();
        await page.screenshot({
          path: "test-results/workspace-dark.png",
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: "test-results/workspace-mobile.png",
          fullPage: true,
        });
        assert(
          await page
            .locator("body")
            .evaluate((el) => el.scrollWidth <= window.innerWidth),
          "Mobile layout overflows horizontally",
        );
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator("#file").setInputFiles({
          name: "bad.png",
          mimeType: "image/png",
          buffer: Buffer.from("not an image file"),
        });
        await page.locator("#error").waitFor({ state: "visible" });
        await expect(
          page.locator('#object-list [data-object-key^="pin:"]'),
        ).toHaveCount(2);
        await page
          .locator("#file")
          .setInputFiles(await imagePayload(page, 1920, 1080));
        await expect(page.locator("#image")).toHaveJSProperty(
          "naturalWidth",
          1920,
        );
        await expect(page.locator("#image")).toHaveJSProperty(
          "naturalHeight",
          1080,
        );
        await expect(page.getByRole("application")).toHaveAttribute(
          "aria-busy",
          "false",
        );
        await expect(modes.locator('[data-tool="pin"]')).toBeEnabled();
        await modes.locator('[data-tool="pin"]').click();
        await page.getByRole("application").focus();
        await page.keyboard.press("Enter");
        await page.locator('#overlay [data-key^="pin:"] path.visual').waitFor();
        await expect(
          page.locator('#overlay [data-key^="pin:"] path.visual'),
        ).toHaveCount(1);
        await expect(modes.locator('[data-tool="select"]')).toBeEnabled();
        await expect(page.locator(".excluded-boundary")).toHaveCount(0);
        await page
          .locator("#file")
          .setInputFiles(await imagePayload(page, 1920, 1080, 96));
        await page.waitForFunction(
          () =>
            Number(
              document.querySelector("#image-clip rect")?.getAttribute("y"),
            ) > 90,
        );
        const clip = await page
          .locator("#image-clip rect")
          .evaluate((node) => ({
            y: Number(node.getAttribute("y")),
            height: Number(node.getAttribute("height")),
          }));
        assert(
          Math.abs(clip.y - 96) <= 3 && Math.abs(clip.height - 888) <= 6,
          "Image border must be detected automatically",
        );
        await expect(page.locator("#image")).toHaveJSProperty(
          "naturalWidth",
          1920,
        );
        await expect(page.locator("#image")).toHaveJSProperty(
          "naturalHeight",
          1080,
        );
        await expect(page.locator("#area-state")).toHaveAttribute(
          "data-source",
          "auto",
        );
        await expect(page.locator("#image-clip rect")).toHaveAttribute(
          "width",
          "1920",
        );
        const boundary = page.locator("#overlay .excluded-boundary");
        await expect(boundary).toHaveCount(1);
        assert.equal(
          await boundary.getAttribute("d"),
          `M0,${clip.y}H1920M0,${clip.y + clip.height}H1920`,
        );
        assert.equal(await boundary.getAttribute("stroke-width"), "1");
        assert.equal(await boundary.getAttribute("pointer-events"), "none");
        assert.equal(
          await boundary.getAttribute("vector-effect"),
          "non-scaling-stroke",
        );
        await page.screenshot({
          path: `test-results/${name}-excluded-boundary.png`,
        });
        await modes.locator('[data-tool="pin"]').click();
        const bordered = await page.locator("#stage").boundingBox();
        assert(bordered);
        await page.mouse.click(
          bordered.x + bordered.width / 2,
          bordered.y + 10,
        );
        assert.equal(
          await page.locator('#object-list [data-object-key^="pin:"]').count(),
          0,
          "Borders are outside the ground plane",
        );
      }
      await page.locator("#menu-trigger").click();
      await page.locator("#show-advanced").focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("Escape");
      await page.locator("#pitch-angle").fill("35");
      await page.locator('#projection-settings button[type="submit"]').click();
      await page.locator("#file").setInputFiles(await imagePayload(page));
      await expect(page.locator("#pitch-angle")).toHaveValue("25.2");
      await expect(page.locator("#show-advanced")).toBeChecked();
      await page.reload();
      await expect(page.locator("#show-advanced")).not.toBeChecked();
      await expect(page.locator("#projection-fields")).toBeHidden();
      await checkInteractions(page, name, await imagePayload(page));
      await checkGameArea(page, name, await imagePayload(page));
      const hoverPage = await context.newPage();
      try {
        await hoverPage.goto(page.url());
        hoverPage.on("dialog", (dialog) => void dialog.accept());
        await checkHover(hoverPage);
      } finally {
        await hoverPage.close();
      }
      const loadingPage = await context.newPage();
      try {
        await loadingPage.goto(page.url());
        await checkImageLoading(loadingPage, await imagePayload(loadingPage));
      } finally {
        await loadingPage.close();
      }
      const projectPage = await context.newPage();
      try {
        await projectPage.goto(`http://127.0.0.1:${server.port}/nested/`);
        await checkProject(projectPage, name, await imagePayload(projectPage));
      } finally {
        await projectPage.close();
      }
      if (name === "chromium") {
        const touchContext = await browser.newContext({
          viewport: { width: 900, height: 1000 },
          hasTouch: true,
        });
        try {
          const touchPage = await touchContext.newPage();
          await touchPage.goto(`http://127.0.0.1:${server.port}/nested/`);
          await checkTouch(touchPage, await imagePayload(touchPage));
        } finally {
          await touchContext.close();
        }
      }
      const reactivePage = await context.newPage();
      try {
        await reactivePage.goto(`http://127.0.0.1:${server.port}/nested/`);
        await checkReactivity(reactivePage, await imagePayload(reactivePage));
      } finally {
        await reactivePage.close();
      }
      assert.deepEqual(errors, []);
      console.log(`${name}: passed`);
    } catch (e) {
      failed = true;
      console.error(`${name}:`, e);
      await page.screenshot({
        path: `test-results/${name}-failure.png`,
        fullPage: true,
      });
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.stop(true);
}
if (failed) process.exitCode = 1;
