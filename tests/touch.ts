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
  const start = async () => {
    await touch("touchStart", pair().slice(0, 1));
    await touch("touchStart", pair());
  };

  for (const tool of ["pan", "pin", "select", "reference", "measure"]) {
    await page.locator(`[data-tool="${tool}"]`).click();
    const before = await state();
    await start();
    await touch("touchMove", pair(1.5, -20, -15));
    const zoomed = await state();
    close(zoomed.zoom * 100, before.zoom * 150, `${tool}: pinch zoom`);
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
    close((await state()).zoom * 100, before.zoom * 100, `${tool}: pinch in`);
    // Lifting only one finger must not turn the remaining contact into an edit.
    await touch("touchEnd", pair().slice(0, 1));
    const released = await state();
    await touch("touchMove", [{ id: 1, x: center.x + 40, y: center.y + 20 }]);
    assert.deepEqual(await state(), released);
    await touch("touchEnd");
    await expect(pins).toHaveCount(0);
    await expect(page.locator("#undo")).toBeDisabled();
    await page.keyboard.press("Escape");
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

  // Cancelling, losing capture, a third finger, and resizing must all recover cleanly.
  for (const interruption of [
    "cancel",
    "capture",
    "third",
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
      } else if (interruption === "third") {
        await touch("touchStart", [
          ...pair(),
          { id: 3, x: center.x, y: center.y + 70 },
        ]);
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

  // Pinching from fit must keep working when scrollbars first appear.
  await page.locator("#fit").click();
  const fitted = await state();
  await start();
  await touch("touchMove", pair(1.2));
  await touch("touchMove", pair(2));
  close(
    (await state()).zoom * 100,
    fitted.zoom * 200,
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
  close((await state()).zoom * 100, mobileFit.zoom * 200, "phone-size pinch");
  await touch("touchEnd");
  await expect(pins).toHaveCount(0);
  await page.screenshot({
    path: "test-results/chromium-touch.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await session.detach();
}
