import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect } from "playwright/test";

export async function checkInteractions(
  page: Page,
  engine: string,
  payload: { name: string; mimeType: string; buffer: Buffer },
) {
  const modes = page.getByRole("group", { name: "操作モード" });
  const key = "kuto-measure.reference-preset";
  const savedState = page.locator("#saved-reference-state");
  const savedError = page
    .getByRole("region", { name: "ブラウザに保存した基準" })
    .getByRole("alert");
  const frame = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  const load = async () => {
    await page.getByLabel("画像を開く").setInputFiles(payload);
    await expect(page.getByRole("application")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(page.getByRole("application")).toHaveAttribute(
      "data-mode",
      "select",
    );
    await page.locator("#setup-panel-button").click();
  };
  const point = async (x: number, y: number) => {
    const box = await page.locator("#stage").boundingBox();
    assert(box);
    return {
      x: box.x + (x * box.width) / 1536,
      y: box.y + (y * box.height) / 709,
    };
  };
  const click = async (x: number, y: number) => {
    const p = await point(x, y);
    await page.mouse.click(p.x, p.y);
    await frame();
  };
  const stored = () => page.evaluate((k) => localStorage.getItem(k), key);
  const pinPositions = async () => {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    return page
      .locator('#overlay [data-part="body"][data-key^="pin:"] circle.hit')
      .evaluateAll((nodes) =>
        nodes.map((n) => [
          Number(n.getAttribute("cx")),
          Number(n.getAttribute("cy")),
        ]),
      );
  };
  const download = async () => {
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: /PNGを書き出す/ }).click();
    const result = await pending;
    const path = await result.path();
    assert(path);
    const bytes = await readFile(path);
    await frame();
    return { bytes, name: result.suggestedFilename() };
  };
  await load();
  // Exercise the native API contract without opening a system dialog in headless browsers.
  for (const outcome of ["save", "cancel", "write-error"]) {
    await page.evaluate((outcome) => {
      const calls: unknown[] = [];
      Object.assign(window, { nativeSaveCalls: calls });
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async (options: unknown) => {
          calls.push(options, navigator.userActivation.isActive);
          if (outcome === "cancel")
            throw new DOMException("cancel", "AbortError");
          return {
            name: "native.png",
            createWritable: async () => ({
              write: async (blob: Blob) => {
                calls.push(blob.type, blob.size > 0);
                if (outcome === "write-error")
                  throw new Error("native write failed");
              },
              close: async () => {
                calls.push("closed");
              },
              abort: async () => {
                calls.push("aborted");
              },
            }),
          };
        },
      });
    }, outcome);
    const unexpected: string[] = [];
    const onDownload = () => unexpected.push("download");
    page.on("download", onDownload);
    await page.getByRole("button", { name: /PNGを書き出す/ }).click();
    await expect(
      page.getByRole("button", { name: /PNGを書き出す/ }),
    ).toBeEnabled();
    const calls = await page.evaluate(
      () =>
        (window as unknown as { nativeSaveCalls: unknown[] }).nativeSaveCalls,
    );
    assert.equal(calls[1], true, "picker retains user activation");
    assert.equal(
      (calls[0] as { suggestedName: string }).suggestedName,
      outcome === "save" ? "ground-measure.png" : "native.png",
    );
    assert.deepEqual(
      (calls[0] as { types: { accept: unknown }[] }).types.map(
        (type) => type.accept,
      ),
      [{ "image/png": [".png"] }],
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (outcome === "save")
      assert.deepEqual(calls.slice(2), ["image/png", true, "closed"]);
    if (outcome === "cancel") assert.equal(calls.length, 2);
    if (outcome === "write-error") {
      assert.equal(calls.at(-1), "aborted");
      await expect(page.locator("#error")).toBeVisible();
      await expect(page.locator("#error")).not.toBeEmpty();
    } else await expect(page.locator("#error")).toBeHidden();
    assert.deepEqual(unexpected, []);
    page.off("download", onDownload);
  }
  await page.evaluate(() =>
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: undefined,
    }),
  );
  await load();
  let confirmations = 0;
  page.on("dialog", (d) => {
    if (d.type() === "confirm") confirmations++;
  });
  const named = await download();
  assert.equal(named.name, "ground-measure.png");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await modes.getByRole("button", { name: /基準円/ }).click();
  await click(768, 355);
  await click(900, 355);
  await page.locator("#saved-reference-options > summary").click();
  await expect(page.getByRole("button", { name: /現在の基準/ })).toBeDisabled();
  await page.getByLabel("設定後に測定・編集へ戻る").uncheck();
  await page.getByLabel("基準円の半径").fill("500");
  await page.getByLabel("基準円の半径").press("Tab");
  await page.getByRole("button", { name: /現在の基準/ }).click();
  const first = await stored();
  assert(first);
  assert.deepEqual(Object.keys(JSON.parse(first)), [
    "version",
    "calibration",
    "reference",
  ]);
  await page.getByLabel("基準円の半径").fill("600");
  await page.getByLabel("基準円の半径").press("Tab");
  assert.equal(await stored(), first);
  await expect(page.getByLabel("基準円の半径")).toHaveValue("600");
  await expect(savedState).toHaveAttribute("data-state", "changed");
  await load();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("500");
  await expect(page.getByRole("button", { name: "元に戻す" })).toBeDisabled();
  await expect(savedState).toHaveAttribute("data-state", "active");
  const count = confirmations;
  await load();
  assert.equal(
    confirmations,
    count,
    "Auto-applied saved data alone is not unsaved editing",
  );
  assert.equal((await download()).name, "ground-measure.png");
  await page.reload();
  await load();
  await page.locator("#saved-reference-options > summary").click();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("500");
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByLabel("高度な設定を表示").check();
  await page.keyboard.press("Escape");
  await page.getByLabel(/ピッチ角/).fill("30");
  await page.getByRole("button", { name: "投影設定を適用" }).click();
  await page.getByRole("button", { name: /現在の基準/ }).click();
  const calibrated = await stored();
  assert(
    calibrated && JSON.parse(calibrated).calibration.elevationDegrees === 30,
  );
  await modes.getByRole("button", { name: /ピン/ }).click();
  await click(500, 400);
  const beforeReset = await pinPositions();
  await page.locator("#setup-panel-button").click();
  await page.locator(".reference-reset > summary").click();
  await page.getByRole("button", { name: /この画像の基準をリセット/ }).click();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("");
  await expect(page.getByLabel(/ピッチ角/)).toHaveValue("25.2");
  const afterReset = await pinPositions();
  assert(
    Math.hypot(
      beforeReset[0][0] - afterReset[0][0],
      beforeReset[0][1] - afterReset[0][1],
    ) < 1e-6,
  );
  assert.equal(await stored(), calibrated);
  await page.getByRole("button", { name: "元に戻す" }).click();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("500");
  await expect(page.getByLabel(/ピッチ角/)).toHaveValue("30");
  await page.getByRole("button", { name: "保存した基準を削除" }).click();
  assert.equal(await stored(), null);
  await expect(page.getByLabel("基準円の半径")).toHaveValue("500");
  await load();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("");

  const other = await page.context().newPage();
  await other.goto(page.url());
  await other.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw: first,
  });
  await expect(savedState).toHaveAttribute("data-state", "unused");
  await expect(
    page.getByRole("button", { name: "保存した基準を削除" }),
  ).toBeEnabled();
  assert.equal(
    await page.getByLabel("基準円の半径").inputValue(),
    "",
    "Storage events never modify the current image",
  );
  await load();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("500");
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, value) {
      if (k === key) throw new DOMException("test quota", "QuotaExceededError");
      original.call(this, k, value);
    };
    window.addEventListener(
      "restore-storage-test",
      () => {
        Storage.prototype.setItem = original;
      },
      { once: true },
    );
  }, key);
  await page.getByRole("button", { name: /現在の基準/ }).click();
  await expect(savedError).toBeVisible();
  await expect(savedError).not.toBeEmpty();
  assert.equal(await stored(), first);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("restore-storage-test")),
  );
  await page.evaluate((key) => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (k) {
      if (k === key) throw new DOMException("test denied", "SecurityError");
      original.call(this, k);
    };
    window.addEventListener(
      "restore-storage-test",
      () => {
        Storage.prototype.removeItem = original;
      },
      { once: true },
    );
  }, key);
  await load();
  await expect(savedError).toBeEmpty();
  await page.getByRole("button", { name: "保存した基準を削除" }).click();
  assert.equal(await stored(), first);
  await expect(savedError).toBeVisible();
  await expect(savedError).not.toBeEmpty();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("restore-storage-test")),
  );
  await page.evaluate((key) => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      if (k === key) throw new DOMException("test denied", "SecurityError");
      return original.call(this, k);
    };
    window.addEventListener(
      "restore-storage-test",
      () => {
        Storage.prototype.getItem = original;
      },
      { once: true },
    );
  }, key);
  await load();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("");
  await expect(savedState).toHaveAttribute("data-state", "error");
  await expect(savedError).toBeVisible();
  await expect(savedError).not.toBeEmpty();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("restore-storage-test")),
  );
  await load();
  await expect(page.getByLabel("基準円の半径")).toHaveValue("500");
  for (const raw of [
    "{",
    JSON.stringify({ ...JSON.parse(first), version: 2 }),
  ]) {
    await other.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
      key,
      raw,
    });
    await load();
    await expect(page.getByLabel("基準円の半径")).toHaveValue("");
    assert.equal(await stored(), raw);
    await expect(savedState).toHaveAttribute("data-state", "invalid");
    await expect(page.getByLabel(/ピッチ角/)).toHaveValue("25.2");
    await expect(page.locator("#error")).toBeVisible();
    await expect(page.locator("#error")).not.toBeEmpty();
  }
  await page.getByRole("button", { name: "保存した基準を削除" }).click();
  await other.close();
  await load();

  await modes.getByRole("button", { name: /基準円/ }).click();
  await click(600, 350);
  await click(700, 350);
  await modes.getByRole("button", { name: /ピン/ }).click();
  const reference = page.locator(
    '#overlay [data-key="reference"][data-part="body"]',
  );
  const insideCircle = await point(600, 330);
  await page.mouse.move(insideCircle.x, insideCircle.y);
  await frame();
  assert.equal(
    await reference.evaluate((el) => getComputedStyle(el).opacity),
    "1",
    "empty circle interior must not fade",
  );
  const edge = await reference.locator("path:not(.line-hit)").evaluate((el) => {
    const path = el as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 4);
    const matrix = path.getScreenCTM();
    if (!matrix) throw new Error("Missing SVG transform");
    const screen = new DOMPoint(p.x, p.y).matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.move(edge.x, edge.y);
  await frame();
  assert.equal(
    await reference.evaluate((el) => getComputedStyle(el).opacity),
    "0.35",
    "painted circle edge fades",
  );
  await load();
  await modes.getByRole("button", { name: /ピン/ }).click();
  await frame();
  const beforePointerMove = await page.locator("#overlay").innerHTML();
  const emptyCanvasPoint = await point(900, 450);
  await page.mouse.move(emptyCanvasPoint.x, emptyCanvasPoint.y);
  await frame();
  assert.equal(
    await page.locator("#overlay").innerHTML(),
    beforePointerMove,
    "pointer movement must not add a placement marker",
  );
  for (let i = 0; i < 5; i++) await click(600, 350);
  const pins = page.locator('#overlay [data-part="body"][data-key^="pin:"]');
  await expect(pins).toHaveCount(5);
  assert.equal(
    await pins.first().evaluate((el) => getComputedStyle(el).opacity),
    "0.35",
  );
  assert.deepEqual(
    await pins.evaluateAll((nodes) =>
      nodes.map((el) => getComputedStyle(el).opacity),
    ),
    Array(5).fill("0.35"),
  );
  const emptyPoint = await point(1000, 450);
  await page.mouse.move(emptyPoint.x, emptyPoint.y);
  await frame();
  assert.deepEqual(
    await pins.evaluateAll((nodes) =>
      nodes.map((el) => getComputedStyle(el).opacity),
    ),
    Array(5).fill("1"),
  );
  const pinPoint = await point(600, 350);
  await page.mouse.move(pinPoint.x, pinPoint.y);
  await frame();
  assert.deepEqual(
    await pins.evaluateAll((nodes) =>
      nodes.map((el) => getComputedStyle(el).opacity),
    ),
    Array(5).fill("0.35"),
  );
  const pinLabelBox = await page
    .locator('#overlay [data-part="label"][data-key^="pin:"] text')
    .first()
    .evaluate((el) => el.getBoundingClientRect().toJSON());
  assert(pinLabelBox);
  await page.mouse.move(
    pinLabelBox.x + pinLabelBox.width / 2,
    pinLabelBox.y + pinLabelBox.height / 2,
  );
  await frame();
  assert.equal(
    await pins.first().evaluate((el) => getComputedStyle(el).opacity),
    "0.35",
    "overlapping a label also fades its object",
  );
  assert.equal(
    await pins.last().evaluate((el) => getComputedStyle(el).opacity),
    "1",
    "other labels at this anchor remain readable",
  );
  await page.mouse.move(0, 0);
  await frame();
  assert.deepEqual(
    await pins.evaluateAll((nodes) =>
      nodes.map((el) => getComputedStyle(el).opacity),
    ),
    Array(5).fill("1"),
  );
  await expect(page.locator('#overlay [data-part="handle"]')).toHaveCount(0);
  const positions = await pinPositions();
  assert(
    positions.every(
      (p) => Math.hypot(p[0] - positions[0][0], p[1] - positions[0][1]) < 1e-6,
    ),
  );
  const pinPng = await download();
  await page.keyboard.press("Escape");
  await expect(modes.getByRole("button", { name: /選択/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const labels = page.locator('#overlay [data-part="label"][data-key^="pin:"]');
  await labels.first().locator(".label-hit").waitFor({ state: "attached" });
  const boxes = await labels.locator(".label-hit").evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }),
  );
  assert.equal(boxes.length, 5);
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      assert(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
      );
    }
  }
  for (let i = 0; i < 5; i++) {
    await labels.nth(i).locator(".label-hit").click();
    await frame();
    const selectedKey = await labels.nth(i).getAttribute("data-key");
    assert(selectedKey);
    await expect(labels.nth(i)).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator("#object-list").getByRole("button", { pressed: true }),
    ).toHaveAttribute("data-object-key", selectedKey);
  }
  await labels.first().locator(".label-hit").hover();
  const firstKey = await labels.first().getAttribute("data-key");
  assert(firstKey);
  assert.deepEqual(
    await page
      .locator("#overlay .candidate")
      .evaluateAll((nodes) => [
        ...new Set(nodes.map((n) => n.getAttribute("data-key"))),
      ]),
    [firstKey],
  );
  await page.getByRole("button", { name: /PNGを書き出す/ }).hover();
  await expect(page.locator("#overlay .candidate")).toHaveCount(0);
  await labels.first().focus();
  await page.keyboard.press("Space");
  await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator("#object-list").getByRole("button", { pressed: true }),
  ).toHaveAttribute("data-object-key", firstKey);
  assert(
    !(await page
      .getByRole("application")
      .evaluate((el) => el.classList.contains("pan-ready"))),
  );
  await page
    .getByRole("button", { name: "全体表示", exact: true })
    .evaluate((el: HTMLButtonElement) => el.click());
  await frame();
  await expect(labels.first()).toBeFocused();
  const dragBox = await labels.nth(2).locator(".label-hit").boundingBox();
  assert(dragBox);
  await page.mouse.move(
    dragBox.x + dragBox.width / 2,
    dragBox.y + dragBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    dragBox.x + dragBox.width / 2 + 35,
    dragBox.y + dragBox.height / 2 + 35,
    { steps: 4 },
  );
  await page.mouse.up();
  assert.deepEqual(await pinPositions(), positions);
  await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator("#object-list").getByRole("button", { pressed: true }),
  ).toHaveAttribute("data-object-key", firstKey);
  await page.getByRole("button", { name: "元に戻す" }).click();
  await frame();
  await expect(pins).toHaveCount(4);
  await page.getByRole("button", { name: "やり直す" }).click();
  await frame();
  await expect(pins).toHaveCount(5);
  const selectedPng = await download();
  assert(
    pinPng.bytes.equals(selectedPng.bytes),
    "PNG must ignore pin dimming and selection",
  );
  assert.equal(selectedPng.bytes.readUInt32BE(16), 1536);
  assert.equal(selectedPng.bytes.readUInt32BE(20), 709);
  const viewport = page.getByRole("application");
  const scroll = () =>
    page.locator("#stage").evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { x: -box.x, y: -box.y };
    });
  await page.locator("#actual").click();
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  await frame();
  for (const target of [
    pins.last().locator(".hit"),
    labels.nth(2).locator(".label-hit"),
  ]) {
    const box = await target.boundingBox();
    assert(box);
    const before = await scroll();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 - 36,
      box.y + box.height / 2 - 24,
      { steps: 4 },
    );
    await page.mouse.up();
    const after = await scroll();
    assert(Math.abs(after.x - before.x - 36) < 0.01);
    assert(Math.abs(after.y - before.y - 24) < 0.01);
    assert.deepEqual(await pinPositions(), positions);
    await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
    await expect(viewport).toHaveAttribute("data-mode", "select");
  }
  await click(850, 500);
  await expect(
    page.locator("#object-list").getByRole("button", { pressed: true }),
  ).toHaveCount(0);
  const beforeKeyboardPan = await scroll();
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await scroll(), {
    x: beforeKeyboardPan.x + 40,
    y: beforeKeyboardPan.y,
  });
  await page.keyboard.press("ArrowLeft");
  assert.deepEqual(await scroll(), beforeKeyboardPan);
  await click(600, 350);
  await expect(pins.last()).toHaveAttribute("aria-pressed", "true");
  await labels.first().locator(".label-hit").click();
  // Selection redraw replaces the SVG nodes; wait before reading their bounds.
  await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
  const jitterBox = await labels.nth(2).locator(".label-hit").boundingBox();
  assert(jitterBox);
  const scrollBeforeClick = await scroll();
  await page.mouse.move(
    jitterBox.x + jitterBox.width / 2,
    jitterBox.y + jitterBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    jitterBox.x + jitterBox.width / 2 + 1,
    jitterBox.y + jitterBox.height / 2 + 1,
  );
  await page.mouse.up();
  assert.deepEqual(
    await scroll(),
    scrollBeforeClick,
    "click jitter must not pan",
  );
  await expect(labels.nth(2)).toHaveAttribute("aria-pressed", "true");
  await labels.first().focus();
  await page.keyboard.press("Enter");
  await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
  // Temporary pan gestures must never become a selection, even if Space is released first.
  await viewport.focus();
  await page.keyboard.down("Space");
  await page.mouse.move(
    jitterBox.x + jitterBox.width / 2,
    jitterBox.y + jitterBox.height / 2,
  );
  await page.mouse.down();
  await page.keyboard.up("Space");
  await page.mouse.up();
  await page.mouse.click(
    jitterBox.x + jitterBox.width / 2,
    jitterBox.y + jitterBox.height / 2,
    { button: "middle" },
  );
  await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
  // Escape rolls back a pan without clearing the selection or committing an edit.
  const beforeCancel = await scroll();
  const cancelPoint = await point(600, 350);
  await page.mouse.move(cancelPoint.x, cancelPoint.y);
  await page.mouse.down();
  await page.mouse.move(cancelPoint.x - 30, cancelPoint.y - 20, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.deepEqual(await scroll(), beforeCancel);
  await expect(labels.first()).toHaveAttribute("aria-pressed", "true");
  assert.deepEqual(await pinPositions(), positions);
  await page.locator("#fit").click();
  await frame();
  assert(
    pinPng.bytes.equals((await download()).bytes),
    "pan must not change exported annotations",
  );
  const labelBox = await labels.first().locator(".label-hit").boundingBox();
  assert(labelBox);
  await modes.getByRole("button", { name: /ピン/ }).click();
  await page.mouse.click(
    labelBox.x + labelBox.width / 2,
    labelBox.y + labelBox.height / 2,
  );
  await frame();
  await expect(pins).toHaveCount(6);
  assert.notDeepEqual((await pinPositions())[5], positions[0]);
  await modes.getByRole("button", { name: /選択/ }).click();
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = (callback) => {
      HTMLCanvasElement.prototype.toBlob = original;
      callback(null);
    };
  });
  await page.getByRole("button", { name: /PNGを書き出す/ }).click();
  await expect(page.locator("#error")).toBeVisible();
  await expect(page.locator("#error")).not.toBeEmpty();
  await expect(
    page.getByRole("button", { name: /PNGを書き出す/ }),
  ).toBeEnabled();
  await expect(pins).toHaveCount(6);
  const beforeSwitch = await download();
  assert.equal(beforeSwitch.name, "ground-measure.png");
  const ready = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (
          callback,
          type,
          quality,
        ) {
          HTMLCanvasElement.prototype.toBlob = original;
          original.call(
            this,
            (blob) => {
              window.addEventListener(
                "release-png-test",
                () => callback(blob),
                { once: true },
              );
              resolve();
            },
            type,
            quality,
          );
        };
      }),
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /PNGを書き出す/ }).click();
  await ready;
  await expect(
    page.getByRole("button", { name: /PNGを書き出す/ }),
  ).toBeDisabled();
  await load();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("release-png-test")),
  );
  const snapshotDownload = await pending,
    snapshotPath = await snapshotDownload.path();
  assert(snapshotPath);
  assert.equal(snapshotDownload.suggestedFilename(), "ground-measure.png");
  assert(
    beforeSwitch.bytes.equals(await readFile(snapshotPath)),
    "In-flight PNG keeps the image, annotations and name captured at click",
  );
  assert.equal((await download()).name, "ground-measure.png");
  // Rebuild a small overlap for visual review after testing image replacement.
  await modes.getByRole("button", { name: /ピン/ }).click();
  for (let i = 0; i < 3; i++) await click(600, 350);
  await modes.getByRole("button", { name: /選択/ }).click();
  await frame();
  await page
    .locator("#saved-reference-options")
    .evaluate((el: HTMLDetailsElement) => {
      el.open = false;
    });
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByLabel("高度な設定を表示").uncheck();
  await page.keyboard.press("Escape");
  await page.locator("#reference-panel").evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: `test-results/${engine}-labels.png` });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: `test-results/${engine}-labels-light.png` });
  await page.setViewportSize({ width: 390, height: 1000 });
  await download();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: `test-results/${engine}-export-mobile.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const browser = page.context().browser();
  assert(browser);
  const touchContext = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 900 },
  });
  const touch = await touchContext.newPage();
  try {
    await touch.goto(page.url());
    await touch.getByLabel("画像を開く").setInputFiles(payload);
    await expect(touch.getByRole("application")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await touch
      .getByRole("group", { name: "操作モード" })
      .getByRole("button", { name: /ピン/ })
      .tap();
    const stage = await touch.locator("#stage").boundingBox();
    assert(stage);
    for (let i = 0; i < 2; i++)
      await touch.touchscreen.tap(
        stage.x + stage.width / 2,
        stage.y + stage.height / 2,
      );
    await touch
      .getByRole("group", { name: "操作モード" })
      .getByRole("button", { name: /選択/ })
      .tap();
    const touchLabels = touch.locator(
      '#overlay [data-part="label"][data-key^="pin:"]',
    );
    await touchLabels.first().locator(".label-hit").tap();
    await expect(touchLabels.first()).toHaveAttribute("aria-pressed", "true");
    await expect(touchLabels.last()).toHaveAttribute("aria-pressed", "false");
    const touchKey = await touchLabels.first().getAttribute("data-key");
    assert(touchKey);
    await expect(
      touch.locator("#object-list").getByRole("button", { pressed: true }),
    ).toHaveAttribute("data-object-key", touchKey);
    await expect(touch.locator("#overlay .candidate")).toHaveCount(0);
    await expect(touchLabels).toHaveCount(2);
    await touch.screenshot({ path: `test-results/${engine}-touch-labels.png` });
  } finally {
    await touchContext.close();
  }
}
