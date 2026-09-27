import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";

export async function checkGameArea(
  page: Page,
  engine: string,
  payload: {
    name: string;
    mimeType: string;
    buffer: Buffer;
  },
) {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const warningCopy = await page.locator("#area-warning-text").textContent();
  assert(warningCopy?.trim(), "確認案内の固定文言はHTMLに置く");
  assert(
    !(await page
      .locator("#game-area")
      .evaluate((node: HTMLDetailsElement) => node.open)),
  );
  await page.locator("#file").setInputFiles(payload);
  const state = page.locator("#area-state");
  const waitSource = async (source: string) => {
    await page.waitForFunction(
      (value) =>
        document.getElementById("area-state")?.dataset.source === value,
      source,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  };
  await waitSource("fallback");
  const inputs = ["top", "bottom", "left", "right"].map((side) =>
    page.locator(`#area-${side}`),
  );
  const fill = async (values: number[]) => {
    for (let i = 0; i < values.length; i++)
      await inputs[i].fill(String(values[i]));
  };
  const clip = () =>
    page
      .locator("#image-clip rect")
      .evaluate((node) =>
        ["x", "y", "width", "height"].map((key) =>
          Number(node.getAttribute(key)),
        ),
      );
  const clickImage = async (x: number, y: number) => {
    await page.locator("#viewport").scrollIntoViewIfNeeded();
    const box = await page.locator("#stage").boundingBox();
    assert(box);
    await page.mouse.click(
      box.x + (x * box.width) / 1536,
      box.y + (y * box.height) / 709,
    );
  };
  const pinPositions = () =>
    page
      .locator('#overlay [data-key^="pin:"] circle.hit')
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          Number(node.getAttribute("cx")),
          Number(node.getAttribute("cy")),
        ]),
      );
  const png = async () => {
    const pending = page.waitForEvent("download");
    await page.locator("#export").click();
    const path = await (await pending).path();
    assert(path);
    const bytes = await readFile(path);
    assert.equal(bytes.readUInt32BE(16), 1536);
    assert.equal(bytes.readUInt32BE(20), 709);
    return bytes;
  };

  await page.locator("#reference-panel > summary").click();
  await page.locator('[data-tool="pin"]').click();
  assert(await page.locator("#area-warning").isVisible());
  assert(
    !(await page
      .locator("#game-area")
      .evaluate((node: HTMLDetailsElement) => node.open)),
  );
  assert.equal(
    await page.locator("#game-size").textContent(),
    "ゲーム領域 画像全体（2.166:1）",
  );
  assert.equal(
    await page.locator("#area-warning-text").textContent(),
    warningCopy,
  );
  for (const width of [1440, 390, 320, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(
      await page.evaluate(() => {
        const size = document.getElementById("image-size");
        const text = document.getElementById("area-warning-text");
        const button = document.getElementById("area-open");
        const confirm = document.getElementById("area-confirm");
        if (!size || !text || !button || !confirm) return false;
        const rect = text.getBoundingClientRect(),
          confirmRect = confirm.getBoundingClientRect(),
          buttonRect = button.getBoundingClientRect();
        return (
          rect.top >= size.getBoundingClientRect().bottom &&
          getComputedStyle(text).fontSize === getComputedStyle(size).fontSize &&
          getComputedStyle(text).color !== getComputedStyle(size).color &&
          confirmRect.right <= buttonRect.left &&
          (innerWidth >= 780
            ? confirmRect.left >= rect.right
            : confirmRect.top >= rect.bottom &&
              buttonRect.top >= rect.bottom) &&
          document.body.scrollWidth <= innerWidth
        );
      }),
      `Compact area notice layout at ${width}px`,
    );
  }
  await page.screenshot({
    path: `test-results/${engine}-game-area-warning.png`,
    fullPage: true,
  });
  const initialBounds = await clip();
  await page.locator("#area-confirm").click();
  await page.locator("#area-warning").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#area-warning-text").textContent(),
    warningCopy,
  );
  assert.equal(await state.getAttribute("data-confirmed"), "true");
  assert.deepEqual(await clip(), initialBounds);
  await page.locator("#undo").click();
  await page.locator("#area-warning").waitFor({ state: "visible" });
  await page.locator("#redo").click();
  await page.locator("#area-warning").waitFor({ state: "hidden" });
  let confirmations = 0;
  const recordConfirmation = () => {
    confirmations++;
  };
  page.on("dialog", recordConfirmation);
  await page.locator("#file").setInputFiles(payload);
  await page.locator("#area-warning").waitFor({ state: "visible" });
  page.off("dialog", recordConfirmation);
  assert.equal(
    confirmations,
    0,
    "Acknowledging an area alone must not prompt to discard edits",
  );
  await page.locator("#area-open").click();
  assert(
    await page
      .locator("#reference-panel")
      .evaluate((node: HTMLDetailsElement) => node.open),
  );
  assert(
    await page
      .locator("#game-area")
      .evaluate((node: HTMLDetailsElement) => node.open),
  );
  assert(await inputs[0].evaluate((node) => node === document.activeElement));
  // Closing the native disclosure cancels a draft; reopening via the footer focuses the input.
  await inputs[0].fill("40");
  await page.locator("#game-area > summary").click();
  await page.locator(".area-preview").waitFor({ state: "detached" });
  await page.locator("#area-open").click();
  assert.equal(await inputs[0].inputValue(), "0");
  assert(await inputs[0].evaluate((node) => node === document.activeElement));
  await fill([40, 60, 10, 20]);
  await page.locator(".area-preview").waitFor();
  assert.deepEqual(await clip(), [0, 0, 1536, 709]);
  for (const invalid of ["", "-1", "0.5"]) {
    await inputs[0].fill(invalid);
    await page.locator("#area-apply").click();
    assert(await page.locator("#area-error").textContent());
    assert.equal(await state.getAttribute("data-source"), "fallback");
  }
  await fill([400, 400, 0, 0]);
  await page.locator("#area-apply").click();
  assert(await inputs[1].evaluate((node) => node === document.activeElement));
  await fill([0, 0, 800, 800]);
  await page.locator("#area-apply").click();
  assert(await inputs[3].evaluate((node) => node === document.activeElement));
  assert.deepEqual(await clip(), [0, 0, 1536, 709]);
  await page.locator("#area-cancel").click();
  await page.locator(".area-preview").waitFor({ state: "detached" });
  await inputs[0].fill("40");
  await inputs[0].press("Escape");
  assert.equal(await inputs[0].inputValue(), "0");
  await inputs[0].fill("40");
  await page.locator("#reference-panel > summary").click();
  await page.locator(".area-preview").waitFor({ state: "detached" });
  await page.locator("#area-open").click();
  await page.locator("#area-full").click();
  await waitSource("full");
  assert(!(await page.locator("#area-warning").isVisible()));
  assert.equal(
    await page.locator("#game-size").textContent(),
    "ゲーム領域 画像全体（2.166:1）",
  );
  await page.locator("#undo").click();
  await waitSource("fallback");

  // Make real annotations before changing the projection area.
  await page.locator('[data-tool="pin"]').click();
  await clickImage(600, 300);
  await clickImage(900, 500);
  await page.locator("#measure-from").selectOption({ index: 1 });
  await page.locator("#measure-to").selectOption({ index: 2 });
  await page.locator("#add-measure").click();
  await page.locator('[data-tool="reference"]').click();
  await clickImage(740, 400);
  await clickImage(800, 400);
  await page.locator("#close-reference-panel").uncheck();
  await page.locator("#reference-radius").fill("500");
  await page.locator("#reference-radius").press("Tab");
  const positions = await pinPositions();
  assert.equal(positions.length, 2);
  const distance = page.locator(
    '#object-list [data-object-key^="measurement:"]',
  );
  const beforeDistance = await distance.textContent();
  const originalPng = await png();
  await fill([60, 90, 20, 30]);
  await page.locator(".area-preview").waitFor();
  assert(
    originalPng.equals(await png()),
    "Draft must not affect exported pixels",
  );
  assert.equal(await distance.textContent(), beforeDistance);
  await page.locator("#area-apply").click();
  await waitSource("manual");
  assert.deepEqual(await clip(), [20, 60, 1486, 559]);
  assert.equal(
    await page.locator("#game-size").textContent(),
    "ゲーム領域 1486 × 559 px（2.658:1）",
  );
  assert.notEqual(await distance.textContent(), beforeDistance);
  const newPositions = await pinPositions();
  positions.forEach((point, i) => {
    point.forEach((value, axis) => {
      assert(Math.abs(value - newPositions[i][axis]) < 1e-6);
    });
  });
  const appliedPng = await png();
  assert(
    !appliedPng.equals(originalPng),
    "Applied projection must affect export",
  );
  await page.locator(".area-preview").waitFor({ state: "detached" });
  await page.locator("#undo").click();
  await waitSource("fallback");
  assert.equal(await distance.textContent(), beforeDistance);
  assert(originalPng.equals(await png()));
  await page.locator("#redo").click();
  await waitSource("manual");
  assert.equal(await inputs[0].inputValue(), "60");
  assert(appliedPng.equals(await png()));
  await inputs[0].fill("61");
  await page.locator("#undo").click();
  await waitSource("fallback");
  assert.equal(await inputs[0].inputValue(), "0");
  await page.locator(".area-preview").waitFor({ state: "detached" });
  await page.locator("#redo").click();

  await page.locator("#saved-reference-options > summary").click();
  await page.locator("#save-reference").click();
  assert.equal(await page.locator("#saved-reference-error").textContent(), "");
  const saved = await page.evaluate(() =>
    localStorage.getItem("kuto-measure.reference-preset"),
  );
  assert(saved && !saved.includes("renderArea"));
  await page.locator("#reset-reference").click();
  assert.equal(await state.getAttribute("data-source"), "manual");
  assert.deepEqual(await clip(), [20, 60, 1486, 559]);
  await page.locator("#undo").click();
  await page.locator("#area-auto").click();
  await waitSource("fallback");
  assert(!(await page.locator("#area-warning").isVisible()));
  await page.locator("#undo").click();
  await waitSource("manual");

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => document.body.scrollWidth <= innerWidth);
  }
  await page.screenshot({
    path: `test-results/${engine}-game-area-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#theme-toggle").click();
  await page.screenshot({
    path: `test-results/${engine}-game-area-dark.png`,
    fullPage: true,
  });
  await page.locator("#theme-toggle").click();
  await inputs[0].fill("61");
  await page.locator("#file").setInputFiles(payload);
  await waitSource("fallback");
  assert.equal(await inputs[0].inputValue(), "0");
  await page.locator(".area-preview").waitFor({ state: "detached" });
  assert.equal(await page.locator("#reference-radius").inputValue(), "500");
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("kuto-measure.reference-preset"),
    ),
    saved,
  );

  // Synthetic cursor in a blue band: exercise the real Canvas sampling path.
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1440;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("canvas");
    ctx.fillStyle = "#29272b";
    ctx.fillRect(0, 0, 1440, 1080);
    for (let x = 0; x < 1440; x++) {
      ctx.fillStyle = `rgb(${55 + (x % 8)},${105 + (x % 8)},${155 + (x % 8)})`;
      ctx.fillRect(x, 0, 1, 189);
      ctx.fillRect(x, 891, 1, 189);
    }
    ctx.fillStyle = "#c8ebff";
    ctx.beginPath();
    ctx.moveTo(1155, 975);
    ctx.lineTo(1190, 1005);
    ctx.lineTo(1155, 1020);
    ctx.closePath();
    ctx.fill();
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator("#file").setInputFiles({
    name: "cursor-band.png",
    mimeType: "image/png",
    buffer: Buffer.from(encoded, "base64"),
  });
  await waitSource("auto");
  assert(
    await page.locator("#area-warning").isVisible(),
    "Detected bands also need initial confirmation",
  );
  const detected = await clip();
  assert(
    Math.abs(detected[1] - 189) <= 3 &&
      Math.abs(detected[1] + detected[3] - 891) <= 3,
  );
  await page.locator("#area-confirm").click();
  await page.locator("#area-warning").waitFor({ state: "hidden" });
  assert.deepEqual(await clip(), detected);
  await page.locator("#area-full").click();
  await waitSource("full");
  await page.locator("#area-auto").click();
  await waitSource("auto");
  assert(!(await page.locator("#area-warning").isVisible()));
  assert.deepEqual(await clip(), detected);
  await page.screenshot({
    path: `test-results/${engine}-game-area-auto.png`,
    fullPage: true,
  });
}
