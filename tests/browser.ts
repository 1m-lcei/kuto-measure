import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox, type Page, webkit } from "playwright";
import { checkInteractions } from "./interactions";

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
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => void d.accept());
    try {
      await page.goto(`http://127.0.0.1:${server.port}/nested/`);
      for (const width of [1440, 780, 779, 390, 320, 1440]) {
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
            (header?.firstElementChild?.id === "header-icons") ===
            matchMedia("(width < 780px)").matches
          );
        });
        assert.equal(
          await page.locator(":focus").getAttribute("id"),
          "theme-toggle",
        );
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
          assert(icons.bottom <= title.top && title.bottom <= files.top);
          await page.locator("#menu-trigger").focus();
          await page.keyboard.press("Tab");
          assert.equal(await page.locator(":focus").getAttribute("id"), "file");
        } else {
          assert(title.right <= files.left && files.right <= icons.left);
          assert(
            Math.max(title.top, files.top, icons.top) <
              Math.min(title.bottom, files.bottom, icons.bottom),
          );
          await page.locator("#file").focus();
          await page.keyboard.press("Tab");
          assert.equal(
            await page.locator(":focus").getAttribute("id"),
            "help-trigger",
          );
        }
      }
      assert.equal(
        await page.locator('dialog button[command="close"]').count(),
        0,
      );
      const selectedTheme = () =>
        page.locator('input[name="theme"]:checked').inputValue();
      assert(!(await page.locator("#show-advanced").isChecked()));
      assert(!(await page.locator("#projection-settings").isVisible()));
      assert(
        (
          await page.locator("#reference-panel > summary").textContent()
        )?.includes("基準パネル"),
      );
      await page.locator("#menu-trigger").click();
      await page.locator("#show-advanced").check();
      assert(await page.locator("#projection-settings").isVisible());
      assert(await page.locator("#pitch-angle").isDisabled());
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
      assert(await page.locator("#about").isVisible());
      assert.equal(
        await page.locator("#about a").first().getAttribute("href"),
        "https://x.com/1m_lcei",
      );
      assert.equal(
        await page.locator("#about a").last().getAttribute("href"),
        "https://github.com/1m-lcei/kuto-measure",
      );
      await page.screenshot({ path: `test-results/${name}-about.png` });
      assert(!(await page.locator("#header-menu").isVisible()));
      assert.equal(
        await page.getByRole("link", { name: "第三者ライセンス" }).count(),
        0,
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => document.activeElement?.id === "menu-trigger",
      );
      await page.locator("#menu-trigger").click();
      await page.locator("#about-trigger").click();
      await page.mouse.click(4, 4);
      await page.locator("#about").waitFor({ state: "hidden" });
      await page.locator("#menu-trigger").click();
      await page.keyboard.press("Escape");
      assert(!(await page.locator("#header-menu").isVisible()));
      await page.locator("#file").setInputFiles(await imagePayload(page));
      await page.locator("#stage").waitFor({ state: "visible" });
      await page.waitForFunction(
        () =>
          document.getElementById("viewport")?.getAttribute("aria-busy") ===
          "false",
      );
      assert(
        !(await page.locator("#error").isVisible()),
        "Valid image must load without an error",
      );
      assert.equal(
        await page.locator("#image-size").textContent(),
        "画像 1536 × 709 px",
      );
      assert.equal(
        await page.locator("#game-size").textContent(),
        "ゲーム領域 1536 × 709 px（2.166:1）",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "全体表示", exact: true })
          .locator("svg use")
          .getAttribute("href"),
        "./icons.svg#fit",
      );
      await page.locator('[data-tool="pin"]').click();
      await clickImage(page, 500, 400);
      await clickImage(page, 1000, 470);
      await page.locator("#measure-from").selectOption({ index: 1 });
      await page.locator("#measure-to").selectOption({ index: 2 });
      await page.locator("#add-measure").click();
      assert.equal(
        await page
          .locator('#object-list [data-object-key^="measurement:"] small')
          .textContent(),
        "1.0000",
      );
      assert.equal(
        await page.locator("#scale-state").textContent(),
        "相対距離",
      );
      await page
        .locator("#overlay text")
        .filter({ hasText: /^1\.0000$/ })
        .waitFor();
      await page.locator("#file").setInputFiles(await imagePayload(page));
      await page.waitForFunction(
        () => document.getElementById("object-count")?.textContent === "0",
      );
      await page.locator('[data-tool="reference"]').click();
      await clickImage(page, 768, 355);
      await clickImage(page, 900, 355);
      await page.locator("#reference-radius").fill("500");
      await page.locator("#reference-radius").press("Tab");
      assert(
        !(await page
          .locator("#reference-panel")
          .evaluate((el) => (el as HTMLDetailsElement).open)),
      );
      assert(
        await page
          .locator("#analysis-panel")
          .evaluate((el) => (el as HTMLDetailsElement).open),
      );
      await page.locator('[data-tool="reference"]').click();
      assert(await page.locator("#reference-radius").isVisible());
      await page.locator("#close-reference-panel").uncheck();
      await page.locator("#reference-radius").fill("501");
      await page.locator("#reference-radius").press("Enter");
      assert(
        await page
          .locator("#reference-panel")
          .evaluate((el) => (el as HTMLDetailsElement).open),
      );
      await page.locator("#close-reference-panel").check();
      await page.locator("#reference-radius").fill("-1");
      await page.locator("#reference-radius").press("Enter");
      assert(
        await page
          .locator("#reference-panel")
          .evaluate((el) => (el as HTMLDetailsElement).open),
      );
      await page.locator("#reference-radius").fill("500");
      await page.locator("#reference-radius").press("Enter");
      assert(
        !(await page
          .locator("#reference-panel")
          .evaluate((el) => (el as HTMLDetailsElement).open)),
      );
      assert.equal(
        await page.locator("#scale-state").textContent(),
        "距離スケール設定済み",
      );
      await page.locator('[data-tool="pin"]').click();
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
      assert(baselineDistance && baselineDistance !== "距離スケール未設定");
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
      await page.locator("#projection-settings button").click();
      assert(!(await page.locator("#error").isVisible()));
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
      assert.equal(await page.locator("#pitch-angle").inputValue(), "25.2");
      assert.equal(await measurement.textContent(), baselineDistance);
      assert((await png(page)).equals(initialPng));
      await page.locator("#redo").click();
      assert.equal(await page.locator("#pitch-angle").inputValue(), "35");
      assert.equal(await measurement.textContent(), changedDistance);
      assert((await png(page)).equals(adjustedPng));
      await page.locator("#pitch-angle").fill("0");
      await page.locator("#projection-settings button").click();
      assert(await page.locator("#error").isVisible());
      assert.equal(await measurement.textContent(), changedDistance);
      await page.locator("#pitch-angle").fill("35");
      await page.locator("#projection-settings button").click();
      assert(!(await page.locator("#error").isVisible()));
      await page.screenshot({ path: `test-results/${name}-advanced.png` });
      await page.setViewportSize({ width: 390, height: 1000 });
      await page
        .locator("#projection-settings button")
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
      assert(!(await page.locator("#projection-settings").isVisible()));
      assert.equal(await measurement.textContent(), changedDistance);
      await page.keyboard.press("Escape");
      await page.locator("#undo").click();
      assert.equal(await measurement.textContent(), baselineDistance);
      await page.locator("#reference-panel > summary").click();
      await page.locator('[data-tool="guide"]').click();
      await clickImage(page, 500, 400);
      await page.mouse.click(4, 4);
      await page.locator("#guide-dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.activeElement?.id === "viewport",
      );
      assert.equal(
        await page.locator('#object-list [data-object-key^="guide:"]').count(),
        0,
      );
      await clickImage(page, 500, 400);
      await page.keyboard.press("Escape");
      await page.locator("#guide-dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () => document.activeElement?.id === "viewport",
      );
      await clickImage(page, 500, 400);
      await page.locator("#guide-form button[type=submit]").click();
      await page.locator("#guide-dialog").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "使い方", exact: true }).click();
      assert(await page.locator("#help").isVisible());
      await page.locator("#help-title").click();
      assert(await page.locator("#help").isVisible());
      await page.mouse.click(4, 4);
      await page.locator("#help").waitFor({ state: "hidden" });
      await page.locator("#help-trigger").click();
      await page.keyboard.press("Escape");
      await page.locator("#help").waitFor({ state: "hidden" });
      const before = await png(page);
      await page.locator("#zoom-in").click();
      await page.locator("#zoom-in").click();
      await page.locator("#viewport").evaluate((el) => el.scrollTo(130, 65));
      assert.equal(await measurement.textContent(), baselineDistance);
      const after = await png(page);
      assert(before.equals(after), `${name}: PNG changed with zoom/pan`);
      if (name === "chromium") {
        await page.locator("#fit").click();
        await page.locator('[data-tool="select"]').click();
        const initial = await circlePosition(page, pinKeys[0]);
        const start = await point(page, initial.x, initial.y),
          end = await point(page, initial.x + 80, initial.y + 30);
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
        await page.locator('[data-tool="guide"]').click();
        await page.locator(`[data-object-key="${groupKey}"]`).click();
        await page.locator("#guide-form button[type=submit]").click();
        assert.equal(
          await page
            .locator('#object-list [data-object-key^="guide:"]')
            .count(),
          2,
        );
        await page.locator("#undo").click();
        await page.locator(`[data-object-key="${pinKeys[0]}"]`).click();
        await page.locator("#delete").click();
        assert.equal(
          await page
            .locator('#object-list [data-object-key^="guide:"]')
            .count(),
          0,
        );
        assert.equal(
          await page
            .locator('#object-list [data-object-key^="measurement:"]')
            .count(),
          0,
        );
        await page.locator("#undo").click();
        assert.equal(
          await page
            .locator('#object-list [data-object-key^="guide:"]')
            .count(),
          1,
        );
        assert.equal(
          await page
            .locator('#object-list [data-object-key^="measurement:"]')
            .count(),
          2,
        );
        // Keyboard placement and exactly one edit for a committed movement.
        await page.locator('[data-tool="pin"]').click();
        await page.locator("#viewport").focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        assert.equal(
          await page.locator('#object-list [data-object-key^="pin:"]').count(),
          3,
        );
        await page.keyboard.press("Control+z");
        assert.equal(
          await page.locator('#object-list [data-object-key^="pin:"]').count(),
          2,
        );
        await page.locator('[data-tool="select"]').click();
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
        assert.equal(
          await page.locator("#scale-state").textContent(),
          "相対距離",
        );
        assert.equal(
          await page
            .locator('#object-list [data-object-key^="guide:"]')
            .count(),
          1,
        );
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
        assert.equal(
          await page.locator('#object-list [data-object-key^="pin:"]').count(),
          2,
        );
        await page
          .locator("#file")
          .setInputFiles(await imagePayload(page, 1920, 1080));
        await page.waitForFunction(() =>
          document.getElementById("image-size")?.textContent?.includes("1920"),
        );
        assert(!(await page.locator('[data-tool="pin"]').isDisabled()));
        await page.locator('[data-tool="pin"]').click();
        await page.locator("#viewport").focus();
        await page.keyboard.press("Enter");
        await page.locator('#overlay [data-key^="pin:"] path.visual').waitFor();
        assert.equal(
          await page.locator('#overlay [data-key^="pin:"] path.visual').count(),
          1,
        );
        assert(!(await page.locator('[data-tool="pan"]').isDisabled()));
        assert.equal(await page.locator(".excluded-boundary").count(), 0);
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
        assert.equal(
          await page.locator("#image-size").textContent(),
          "画像 1920 × 1080 px",
        );
        assert.equal(
          await page.locator("#game-size").textContent(),
          `ゲーム領域 1920 × ${clip.height} px（${(1920 / clip.height).toFixed(3)}:1）`,
        );
        const boundary = page.locator("#overlay .excluded-boundary");
        assert.equal(await boundary.count(), 1);
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
        await page.locator('[data-tool="pin"]').click();
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
      await page.locator("#projection-settings button").click();
      await page.locator("#file").setInputFiles(await imagePayload(page));
      await page.waitForFunction(
        () =>
          (document.getElementById("pitch-angle") as HTMLInputElement).value ===
          "25.2",
      );
      assert(await page.locator("#show-advanced").isChecked());
      await page.reload();
      assert(!(await page.locator("#show-advanced").isChecked()));
      assert(!(await page.locator("#projection-settings").isVisible()));
      await checkInteractions(page, name, await imagePayload(page));
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
