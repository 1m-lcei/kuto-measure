import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";

export async function checkInteractions(
  page: Page,
  engine: string,
  payload: { name: string; mimeType: string; buffer: Buffer },
) {
  const key = "kuto-measure.reference-preset";
  const frame = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  const load = async () => {
    await page.locator("#file").setInputFiles(payload);
    await page.waitForFunction(
      () =>
        document.getElementById("viewport")?.getAttribute("aria-busy") ===
        "false",
    );
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
    await page.locator("#export").click();
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
    await page.locator("#export").click();
    await page.waitForFunction(
      () => !(document.getElementById("export") as HTMLButtonElement).disabled,
    );
    const calls = await page.evaluate(
      () =>
        (window as unknown as { nativeSaveCalls: unknown[] }).nativeSaveCalls,
    );
    assert.equal(calls[1], true, "picker retains user activation");
    assert.equal(
      (calls[0] as { suggestedName: string }).suggestedName,
      outcome === "save" ? "ground-measure.png" : "native.png",
    );
    assert.deepEqual((calls[0] as { types: unknown }).types, [
      { description: "PNG画像", accept: { "image/png": [".png"] } },
    ]);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    if (outcome === "save")
      assert.deepEqual(calls.slice(2), ["image/png", true, "closed"]);
    if (outcome === "cancel") assert.equal(calls.length, 2);
    if (outcome === "write-error") {
      assert.equal(calls.at(-1), "aborted");
      assert.match(
        await page.locator("#error").innerText(),
        /native write failed/,
      );
    }
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
  assert.equal(await page.locator("dialog[open]").count(), 0);

  await page.locator('[data-tool="reference"]').click();
  await click(768, 355);
  await click(900, 355);
  await page.locator("#saved-reference-options > summary").click();
  assert(await page.locator("#save-reference").isDisabled());
  await page.locator("#close-reference-panel").uncheck();
  await page.locator("#reference-radius").fill("500");
  await page.locator("#reference-radius").press("Tab");
  await page.locator("#save-reference").click();
  const first = await stored();
  assert(first);
  assert.deepEqual(Object.keys(JSON.parse(first)), [
    "version",
    "calibration",
    "reference",
  ]);
  await page.locator("#reference-radius").fill("600");
  await page.locator("#reference-radius").press("Tab");
  assert.equal(await stored(), first);
  assert.match(
    (await page.locator("#saved-reference-state").textContent()) ?? "",
    /異なります/,
  );
  await load();
  assert.equal(await page.locator("#reference-radius").inputValue(), "500");
  assert(await page.locator("#undo").isDisabled());
  assert.equal(
    await page.locator("#saved-reference-state").textContent(),
    "保存した基準を使用中",
  );
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
  assert.equal(await page.locator("#reference-radius").inputValue(), "500");
  await page.locator("#menu-trigger").click();
  await page.locator("#show-advanced").check();
  await page.keyboard.press("Escape");
  await page.locator("#pitch-angle").fill("30");
  await page.locator("#projection-settings button").click();
  await page.locator("#save-reference").click();
  const calibrated = await stored();
  assert(
    calibrated && JSON.parse(calibrated).calibration.elevationDegrees === 30,
  );
  await page.locator('[data-tool="pin"]').click();
  await click(500, 400);
  const beforeReset = await pinPositions();
  await page.locator("#reset-reference").click();
  assert.equal(await page.locator("#reference-radius").inputValue(), "");
  assert.equal(await page.locator("#pitch-angle").inputValue(), "25.2");
  const afterReset = await pinPositions();
  assert(
    Math.hypot(
      beforeReset[0][0] - afterReset[0][0],
      beforeReset[0][1] - afterReset[0][1],
    ) < 1e-6,
  );
  assert.equal(await stored(), calibrated);
  await page.locator("#undo").click();
  assert.equal(await page.locator("#reference-radius").inputValue(), "500");
  assert.equal(await page.locator("#pitch-angle").inputValue(), "30");
  await page.locator("#delete-saved-reference").click();
  assert.equal(await stored(), null);
  assert.equal(await page.locator("#reference-radius").inputValue(), "500");
  await load();
  assert.equal(await page.locator("#reference-radius").inputValue(), "");

  const other = await page.context().newPage();
  await other.goto(page.url());
  await other.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key,
    raw: first,
  });
  await page.waitForFunction(() =>
    document
      .getElementById("saved-reference-detail")
      ?.textContent?.includes("500"),
  );
  assert.equal(
    await page.locator("#reference-radius").inputValue(),
    "",
    "Storage events never modify the current image",
  );
  await load();
  assert.equal(await page.locator("#reference-radius").inputValue(), "500");
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
  await page.locator("#save-reference").click();
  assert.match(
    (await page.locator("#saved-reference-error").textContent()) ?? "",
    /保存できません/,
  );
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
  await page.locator("#delete-saved-reference").click();
  assert.equal(await stored(), first);
  assert.match(
    (await page.locator("#saved-reference-error").textContent()) ?? "",
    /削除できません/,
  );
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
  assert.equal(await page.locator("#reference-radius").inputValue(), "");
  assert.match(
    (await page.locator("#saved-reference-state").textContent()) ?? "",
    /確認できません/,
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("restore-storage-test")),
  );
  await load();
  assert.equal(await page.locator("#reference-radius").inputValue(), "500");
  for (const raw of [
    "{",
    JSON.stringify({ ...JSON.parse(first), version: 2 }),
  ]) {
    await other.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
      key,
      raw,
    });
    await load();
    assert.equal(await page.locator("#reference-radius").inputValue(), "");
    assert.equal(await stored(), raw);
    assert.match(
      (await page.locator("#error").textContent()) ?? "",
      /初期設定/,
    );
  }
  await page.locator("#delete-saved-reference").click();
  await other.close();
  await load();

  await page.locator('[data-tool="reference"]').click();
  await click(600, 350);
  await click(700, 350);
  await page.locator('[data-tool="pin"]').click();
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
  await page.locator('[data-tool="pin"]').click();
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
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#overlay [data-part="body"][data-key^="pin:"]')
        .length === 5,
  );
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
  assert.equal(await page.locator('#overlay [data-part="handle"]').count(), 0);
  const positions = await pinPositions();
  assert(
    positions.every(
      (p) => Math.hypot(p[0] - positions[0][0], p[1] - positions[0][1]) < 1e-6,
    ),
  );
  const pinPng = await download();
  await page.locator('[data-tool="select"]').click();
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
    assert.equal(
      await page.locator("#object-name").inputValue(),
      `ピン${i + 1}`,
    );
    assert.equal(await labels.nth(i).getAttribute("aria-pressed"), "true");
  }
  await labels.first().locator(".label-hit").hover();
  const firstKey = await labels.first().getAttribute("data-key");
  assert.deepEqual(
    await page
      .locator("#overlay .candidate")
      .evaluateAll((nodes) => [
        ...new Set(nodes.map((n) => n.getAttribute("data-key"))),
      ]),
    [firstKey],
  );
  await page.locator("#export").hover();
  assert.equal(await page.locator("#overlay .candidate").count(), 0);
  await labels.first().focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#object-name").inputValue(), "ピン1");
  assert(
    !(await page
      .locator("#viewport")
      .evaluate((el) => el.classList.contains("pan-ready"))),
  );
  await page.locator("#fit").evaluate((el: HTMLButtonElement) => el.click());
  await frame();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-part") === "label",
  );
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
  assert.equal(await page.locator("#object-name").inputValue(), "ピン1");
  await page.locator("#undo").click();
  await frame();
  assert.equal(await pins.count(), 4);
  await page.locator("#redo").click();
  await frame();
  assert.equal(await pins.count(), 5);
  const selectedPng = await download();
  assert(
    pinPng.bytes.equals(selectedPng.bytes),
    "PNG must ignore pin dimming and selection",
  );
  assert.equal(selectedPng.bytes.readUInt32BE(16), 1536);
  assert.equal(selectedPng.bytes.readUInt32BE(20), 709);
  const labelBox = await labels.first().locator(".label-hit").boundingBox();
  assert(labelBox);
  await page.locator('[data-tool="pin"]').click();
  await page.mouse.click(
    labelBox.x + labelBox.width / 2,
    labelBox.y + labelBox.height / 2,
  );
  await frame();
  assert.equal(await pins.count(), 6);
  assert.notDeepEqual((await pinPositions())[5], positions[0]);
  await page.locator('[data-tool="select"]').click();
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = (callback) => {
      HTMLCanvasElement.prototype.toBlob = original;
      callback(null);
    };
  });
  await page.locator("#export").click();
  await page.waitForFunction(() =>
    document
      .getElementById("error")
      ?.textContent?.includes("PNGを生成できません"),
  );
  assert(!(await page.locator("#export").isDisabled()));
  assert.equal(await pins.count(), 6);
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
  await page.locator("#export").click();
  await ready;
  assert(await page.locator("#export").isDisabled());
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
  await page.locator('[data-tool="pin"]').click();
  for (let i = 0; i < 3; i++) await click(600, 350);
  await page.locator('[data-tool="select"]').click();
  await frame();
  await page
    .locator("#saved-reference-options")
    .evaluate((el: HTMLDetailsElement) => {
      el.open = false;
    });
  await page.locator("#menu-trigger").click();
  await page.locator("#show-advanced").uncheck();
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
    await touch.locator("#file").setInputFiles(payload);
    await touch.waitForFunction(
      () =>
        document.getElementById("viewport")?.getAttribute("aria-busy") ===
        "false",
    );
    await touch.locator('[data-tool="pin"]').tap();
    const stage = await touch.locator("#stage").boundingBox();
    assert(stage);
    for (let i = 0; i < 2; i++)
      await touch.touchscreen.tap(
        stage.x + stage.width / 2,
        stage.y + stage.height / 2,
      );
    await touch.locator('[data-tool="select"]').tap();
    const touchLabels = touch.locator(
      '#overlay [data-part="label"][data-key^="pin:"]',
    );
    await touchLabels.first().locator(".label-hit").tap();
    await touch.waitForFunction(() =>
      document
        .querySelector('#overlay [data-part="label"][aria-pressed="true"]')
        ?.getAttribute("aria-label")
        ?.includes("ピン1"),
    );
    assert.equal(await touch.locator("#overlay .candidate").count(), 0);
    assert.equal(await touchLabels.count(), 2);
    await touch.screenshot({ path: `test-results/${engine}-touch-labels.png` });
  } finally {
    await touchContext.close();
  }
}
