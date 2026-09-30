import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect } from "playwright/test";

export async function checkTouch(
  page: Page,
  image: { name: string; mimeType: string; buffer: Buffer },
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await page.context().newCDPSession(page);
  const frame = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  // Native touch input exercises pointer capture, primary pointers and cancellation.
  const touch = async (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    touchPoints: { id: number; x: number; y: number }[] = [],
  ) => {
    await session.send("Input.dispatchTouchEvent", { type, touchPoints });
    await frame();
  };
  const state = () =>
    page.locator("#stage").evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y, zoom: box.width / 1536 };
    });
  const close = (actual: number, expected: number, message: string) =>
    assert(
      Math.abs(actual - expected) < 1.5,
      `${message}: ${actual} vs ${expected}`,
    );
  const pins = page.locator('#object-list [data-object-key^="pin:"]');
  await page.locator("#file").setInputFiles(image);
  await expect(page.locator("#viewport")).toHaveAttribute("aria-busy", "false");
  await page.locator("#actual").click();
  await page.locator("#viewport").scrollIntoViewIfNeeded();
  const box = await page.locator("#viewport").boundingBox();
  assert(box);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const pair = (scale = 1, dx = 0, dy = 0) => [
    { id: 1, x: center.x - 60 * scale + dx, y: center.y - 30 * scale + dy },
    { id: 2, x: center.x + 60 * scale + dx, y: center.y + 30 * scale + dy },
  ];
  const span = Math.hypot(120, 60);
  // Zoom begins after 8 CSS pixels of spacing change, without applying that dead zone.
  const zoomStartSpan = span + 8;
  const start = async () => {
    await touch("touchStart", pair().slice(0, 1));
    await touch("touchStart", pair());
  };

  // Deliver one finger's PointerEvent a frame late, while TouchEvent has both positions.
  await start();
  const panStart = await state();
  await page.evaluate(() => {
    const delay = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || event.isPrimary) return;
      document.removeEventListener("pointermove", delay, true);
      event.stopImmediatePropagation();
      const copy = new PointerEvent(event.type, event);
      const target = event.target;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => target?.dispatchEvent(copy)),
      );
    };
    document.addEventListener("pointermove", delay, true);
  });
  await touch("touchMove", pair(1, -40, -20));
  close(
    (await state()).zoom * 100,
    panStart.zoom * 100,
    "staggered finger delivery must not zoom",
  );
  await frame();
  close((await state()).x, panStart.x - 40, "two-finger translation pans x");
  close((await state()).y, panStart.y - 20, "two-finger translation pans y");
  await touch("touchMove", pair(1.03, -60, -25));
  close(
    (await state()).zoom * 100,
    panStart.zoom * 100,
    "small finger-spacing jitter must stay a pan",
  );
  close((await state()).x, panStart.x - 60, "jitter does not slow panning x");
  close((await state()).y, panStart.y - 25, "jitter does not slow panning y");
  await touch("touchMove", pair((span + 7) / span, -60, -25));
  close(
    (await state()).zoom * 100,
    panStart.zoom * 100,
    "slow pinch waits for the spacing threshold",
  );
  await touch("touchMove", pair((span + 9) / span, -60, -25));
  const recognized = await state();
  assert(
    recognized.zoom > panStart.zoom && recognized.zoom < panStart.zoom * 1.01,
    "crossing the threshold starts zooming without a jump",
  );
  await touch("touchMove", pair(((span + 9) / span) * 1.2, -60, -25));
  close(
    (await state()).zoom * 100,
    recognized.zoom * 120,
    "recognized pinch follows finger spacing proportionally",
  );
  await touch("touchEnd");
  await page.locator("#fit").click();
  await page.locator("#actual").click();

  // A second finger on the workspace border still makes this a gesture, not a tap.
  await page.locator('[data-tool="pin"]').click();
  const inside = { id: 1, ...center };
  const outside = { id: 2, x: box.x + box.width + 5, y: center.y };
  await touch("touchStart", [inside]);
  await touch("touchStart", [inside, outside]);
  await touch("touchEnd", [inside]);
  await expect(pins).toHaveCount(0);
  await touch("touchEnd");
  await expect(pins).toHaveCount(0);

  await expect(page.locator('[data-tool="pan"]')).toHaveCount(0);
  for (const tool of ["select", "pin", "reference", "measure"]) {
    await page.locator(`[data-tool="${tool}"]`).click();
    const beforePan = await state();
    await touch("touchStart", [{ id: 1, ...center }]);
    await touch("touchMove", [{ id: 1, x: center.x + 20, y: center.y - 15 }]);
    await touch("touchEnd");
    close((await state()).x, beforePan.x + 20, `${tool}: one finger pans`);
    await expect(pins).toHaveCount(0);
    const before = await state();
    await start();
    await touch("touchMove", pair(1.5, -20, -15));
    const zoomed = await state();
    close(
      zoomed.zoom * 100,
      before.zoom * 150 * (span / zoomStartSpan),
      `${tool}: pinch zoom`,
    );
    close(
      zoomed.x + ((center.x - before.x) / before.zoom) * zoomed.zoom,
      center.x - 20,
      `${tool}: horizontal anchor`,
    );
    close(
      zoomed.y + ((center.y - before.y) / before.zoom) * zoomed.zoom,
      center.y - 15,
      `${tool}: vertical anchor`,
    );
    await touch("touchMove", pair(1.5, -50, -35));
    const panned = await state();
    close(panned.x, zoomed.x - 30, `${tool}: two-finger pan x`);
    close(panned.y, zoomed.y - 20, `${tool}: two-finger pan y`);
    await touch("touchMove", pair());
    close(
      (await state()).zoom * 100,
      zoomed.zoom * (100 / 1.5),
      `${tool}: pinch in`,
    );
    // Lifting one finger continues panning, and putting it back resumes the pinch.
    await touch("touchEnd", pair().slice(1));
    const released = await state();
    await touch("touchMove", [{ id: 1, x: center.x + 40, y: center.y + 20 }]);
    const continued = await state();
    close(continued.x, released.x + 100, `${tool}: remaining finger pans x`);
    close(continued.y, released.y + 50, `${tool}: remaining finger pans y`);
    await touch("touchStart", [
      { id: 1, x: center.x + 40, y: center.y + 20 },
      pair()[1],
    ]);
    assert.deepEqual(
      await state(),
      continued,
      "adding the finger back must not jump",
    );
    await touch("touchEnd");
    await expect(pins).toHaveCount(0);
    await expect(page.locator("#undo")).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.locator("#fit").click();
    await page.locator("#actual").click();
  }

  // Adding a second finger after a one-finger pan must not undo that pan.
  await touch("touchStart", [{ id: 1, ...center }]);
  const panFinger = { id: 1, x: center.x - 30, y: center.y - 20 };
  await touch("touchMove", [panFinger]);
  const panned = await state();
  await touch("touchStart", [panFinger, pair()[1]]);
  assert.deepEqual(
    await state(),
    panned,
    "switching to pinch keeps the current view",
  );
  await touch("touchEnd");

  // A slightly shaky tap still places a pin; a subsequent touch can select and edit it.
  await page.locator('[data-tool="pin"]').click();
  const p = { id: 1, ...center };
  await touch("touchStart", [p]);
  await touch("touchMove", [{ ...p, x: p.x + 4, y: p.y + 3 }]);
  await touch("touchEnd");
  await expect(pins).toHaveCount(1);
  const pin = page.locator(
    '#overlay [data-part="body"][data-key^="pin:"] circle.hit',
  );
  const position = () =>
    pin.evaluate((el) => [
      Number(el.getAttribute("cx")),
      Number(el.getAttribute("cy")),
    ]);
  const original = await position();
  await page.locator('[data-tool="select"]').click();
  await touch("touchStart", [{ id: 1, x: p.x - 90, y: p.y }]);
  await touch("touchEnd");
  await touch("touchStart", [{ ...p, x: p.x + 4, y: p.y + 3 }]);
  await touch("touchMove", [{ ...p, x: p.x + 24, y: p.y + 3 }]);
  await touch("touchEnd");
  assert.deepEqual(
    await position(),
    original,
    "dragging an unselected pin only pans",
  );
  await touch("touchStart", [{ ...p, x: p.x + 24, y: p.y + 3 }]);
  await touch("touchEnd");
  await expect(pin.locator("..")).toHaveAttribute("aria-pressed", "true");
  const pinBox = await pin.boundingBox();
  assert(pinBox);
  const finger = {
    id: 1,
    x: pinBox.x + pinBox.width / 2,
    y: pinBox.y + pinBox.height / 2,
  };
  await touch("touchStart", [finger]);
  const moved = { ...finger, x: finger.x + 25 };
  await touch("touchMove", [moved]);
  assert.notDeepEqual(await position(), original, "drag preview moves the pin");
  await touch("touchStart", [
    moved,
    { id: 2, x: moved.x + 90, y: moved.y + 20 },
  ]);
  assert.deepEqual(
    await position(),
    original,
    "second finger rolls back the edit",
  );
  await touch("touchEnd");
  await page.locator("#undo").click();
  await expect(pins).toHaveCount(0);
  await expect(page.locator("#undo")).toBeDisabled();

  // Cancelling, losing capture, and resizing must all recover cleanly.
  for (const interruption of [
    "cancel",
    "capture",
    "escape",
    "resize",
    "blur",
  ]) {
    await page.locator('[data-tool="pin"]').click();
    await start();
    if (interruption === "cancel") await touch("touchCancel");
    else {
      if (interruption === "capture") {
        await page.evaluate(() => {
          const viewport = document.getElementById("viewport");
          if (!viewport) throw new Error("Missing viewport");
          viewport.addEventListener(
            "pointermove",
            (event) => viewport.releasePointerCapture(event.pointerId),
            { once: true },
          );
        });
        await touch("touchMove", pair(1.1));
      } else if (interruption === "escape") await page.keyboard.press("Escape");
      else if (interruption === "resize")
        await page.setViewportSize({ width: 900, height: 950 });
      else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await frame();
      const stopped = await state();
      await touch("touchMove", pair(1.2));
      assert.deepEqual(
        await state(),
        stopped,
        `${interruption}: cancelled navigation stays stopped`,
      );
      await touch("touchEnd");
    }
    await expect(pins).toHaveCount(0);
    await page.locator('[data-tool="pin"]').click();
    await touch("touchStart", [p]);
    await touch("touchEnd");
    await expect(pins).toHaveCount(1);
    await page.locator("#undo").click();
    await page.setViewportSize({ width: 900, height: 1000 });
    await frame();
  }

  // Pinching across the fit scale must stay proportional without clamping the anchor.
  await page.locator("#fit").click();
  const fitted = await state();
  await start();
  await touch("touchMove", pair(1.2));
  await touch("touchMove", pair(2));
  close(
    (await state()).zoom * 100,
    fitted.zoom * 200 * (span / zoomStartSpan),
    "pinch continues from fit",
  );
  await touch("touchEnd");
  await expect(pins).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#fit").click();
  await page.locator("#viewport").scrollIntoViewIfNeeded();
  const mobileBox = await page.locator("#viewport").boundingBox();
  assert(mobileBox);
  center.x = mobileBox.x + mobileBox.width / 2;
  center.y = mobileBox.y + mobileBox.height / 2;
  const mobileFit = await state();
  await start();
  await touch("touchMove", pair(2));
  close(
    (await state()).zoom * 100,
    mobileFit.zoom * 200 * (span / zoomStartSpan),
    "phone-size pinch",
  );
  const mobileZoomed = await state();
  close(
    mobileZoomed.y +
      ((center.y - mobileFit.y) / mobileFit.zoom) * mobileZoomed.zoom,
    center.y,
    "phone-size pinch preserves the image point under the fingers",
  );
  await touch("touchEnd");
  await expect(pins).toHaveCount(0);
  // At a zoom limit, reversing the fingers must respond immediately.
  await page.locator("#actual").click();
  await page.locator("#zoom-in").evaluate((button) => {
    for (let i = 0; i < 22; i++) (button as HTMLButtonElement).click();
  });
  await start();
  await touch("touchMove", pair(1.5));
  close((await state()).zoom * 100, 1000, "maximum zoom");
  await touch("touchMove", pair(1.35));
  close((await state()).zoom * 100, 900, "reverse at maximum zoom");
  await touch("touchEnd");
  await page.locator("#fit").click();
  await page.screenshot({
    path: "test-results/chromium-touch.png",
    fullPage: true,
  });

  // Mobile panels participate in page scrolling, even with no internal overflow.
  await page.setViewportSize({ width: 390, height: 640 });
  for (const [button, panel] of [
    ["edit-panel-button", "analysis-panel"],
    ["setup-panel-button", "reference-panel"],
  ]) {
    await page.locator(`#${button}`).click();
    for (const direction of [1, -1]) {
      await page.locator(`#${panel}`).evaluate((el) => {
        el.scrollIntoView({ block: "start" });
        window.scrollBy(0, -120);
      });
      const before = await page.evaluate(() => ({
        y: scrollY,
        remaining:
          document.documentElement.scrollHeight - innerHeight - scrollY,
      }));
      assert(before.y > 100 && before.remaining > 100);
      const panelBox = await page.locator(`#${panel}`).boundingBox();
      assert(panelBox);
      const finger = {
        id: 1,
        x: panelBox.x + 12,
        y: Math.max(0, panelBox.y) + 60,
      };
      await touch("touchStart", [finger]);
      for (let step = 1; step <= 6; step++)
        await touch("touchMove", [
          { ...finger, y: finger.y - direction * step * 15 },
        ]);
      await expect
        .poll(
          async () =>
            ((await page.evaluate(() => scrollY)) - before.y) * direction,
          { message: `${panel}: swiping scrolls the page in either direction` },
        )
        .toBeGreaterThan(25);
      await touch("touchEnd");
    }
  }
  assert.deepEqual(errors, []);
  await session.detach();
}
