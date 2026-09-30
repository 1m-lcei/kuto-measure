import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect } from "playwright/test";

export async function checkReactivity(
  page: Page,
  payload: { name: string; mimeType: string; buffer: Buffer },
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  await page.getByLabel("ダーク", { exact: true }).check();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#file").setInputFiles(payload);
  await expect(page.locator("#viewport")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#area-source")).toHaveText("画像全体を使用");
  await expect(page.locator("#area-confirmation")).toHaveText("（要確認）");
  await page.locator("#area-confirm").click();
  await expect(page.locator("#area-confirmation")).toHaveText("（確認済み）");
  await page.locator("#edit-panel-button").click();
  await page.locator("#menu-trigger").click();
  await page.locator("#show-advanced").check();
  await page.keyboard.press("Escape");
  await expect(page.locator("#reference-panel")).toBeVisible();
  await page.locator("#edit-panel-button").click();
  await page.locator('[data-tool="pin"]').click();
  await page.locator("#viewport").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  const marker = page.locator('#overlay [data-part="body"][data-key^="pin:"]');
  const label = page.locator('#overlay [data-part="label"][data-key^="pin:"]');
  await expect(marker).toHaveCount(1);
  const nodes = await page.evaluateHandle(() => {
    const marker = document.querySelector(
      '#overlay [data-part="body"][data-key^="pin:"]',
    );
    const label = document.querySelector("#overlay .annotation-label");
    const row = document.querySelector("#object-list .object-row");
    const inspector = document.querySelector(".inspector-stack");
    const overlay = document.querySelector("#overlay");
    if (!marker || !label || !row || !inspector || !overlay)
      throw new Error("Missing annotations");
    let panelChanges = 0,
      annotationChanges = 0;
    const panelObserver = new MutationObserver((records) => {
      panelChanges += records.length;
    });
    const annotationObserver = new MutationObserver((records) => {
      annotationChanges += records.length;
    });
    panelObserver.observe(inspector, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    annotationObserver.observe(overlay, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    return {
      marker,
      label,
      row,
      stop() {
        panelObserver.disconnect();
        annotationObserver.disconnect();
        return { panelChanges, annotationChanges };
      },
    };
  });
  await page.mouse.move(2, 2);
  const box = await page.locator("#viewport").boundingBox();
  assert(box);
  await page.mouse.move(box.x + 25, box.y + 25);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 65, box.y + 55, { steps: 10 });
  await page.mouse.up({ button: "middle" });
  const changes = await nodes.evaluate((state) => state.stop());
  assert.equal(
    changes.panelChanges,
    0,
    "panning must not update the inspector",
  );
  assert.equal(
    changes.annotationChanges,
    0,
    "panning must not rebuild or relayout annotations",
  );
  await page.locator("#zoom-in").click();
  await marker.focus();
  const x = await marker.locator("circle.hit").getAttribute("cx");
  await page.keyboard.press("ArrowRight");
  await expect(marker.locator("circle.hit")).not.toHaveAttribute("cx", x ?? "");
  await expect(marker).toBeFocused();
  assert(
    await nodes.evaluate((state) =>
      [state.marker, state.label, state.row].every((node) => node.isConnected),
    ),
    "Svelte keeps SVG, label and list nodes through zoom and edits",
  );
  await label.focus();
  await page.keyboard.press("Space");
  await expect(label).toBeFocused();
  await page
    .getByLabel("名前", { exact: true })
    .fill('<img src=x onerror="alert(1)">');
  await page.getByLabel("名前", { exact: true }).press("Tab");
  await expect(
    page.locator(
      "#object-list img, #overlay img, #object-list script, #overlay script",
    ),
  ).toHaveCount(0);
  await expect(page.locator("#object-list")).toContainText(
    '<img src=x onerror="alert(1)">',
  );
  await nodes.dispose();

  // An unnamed group still owns its pins.
  await page.locator("#add-group").click();
  await page.locator("#object-name").fill("");
  await page.locator("#object-name").press("Tab");
  const pin = page.locator('[data-object-key^="pin:"]');
  await pin.click();
  await page.locator("#pin-group").selectOption({ index: 1 });
  await expect(pin.locator("small")).toHaveText("グループ");
  await page.locator("#undo").click();
  await expect(pin.locator("small")).toHaveText("未所属");
  await page.locator("#redo").click();
  await expect(pin.locator("small")).toHaveText("グループ");

  await page.locator("#fit").click();
  await page.locator('[data-tool="reference"]').click();
  const stage = await page.locator("#stage").boundingBox();
  assert(stage);
  await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.click(
    stage.x + stage.width * 0.6,
    stage.y + stage.height / 2,
  );
  await page.locator("#close-reference-panel").uncheck();
  await page.locator("#reference-radius").fill("500");
  await page.locator("#reference-radius").press("Tab");
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-tool="guide"]').click();
    await page.locator("#viewport").focus();
    await page.keyboard.press("Enter");
    await page.locator("#new-guide-radius").fill("100");
    await page.locator('#guide-form button[type="submit"]').click();
    await expect(page.locator("#guide-dialog")).toBeHidden();
  }
  // Rejected drafts must reset even when the next object has the same radius.
  const guides = page.locator('[data-object-key^="guide:"]');
  const radius = page.locator("#guide-radius");
  await guides.first().click();
  await radius.fill("-1");
  await radius.press("Tab");
  await expect(page.locator("#error")).toContainText("正の有限数");
  await guides.last().click();
  await expect(radius).toHaveValue("100");
  await guides.first().click();
  await expect(radius).toHaveValue("100");
  await radius.fill("200");
  await expect(guides.first()).toContainText("半径 100.00");
  await radius.press("Tab");
  await expect(guides.first()).toContainText("半径 200.00");
  await page.locator("#undo").click();
  await expect(radius).toHaveValue("100");
  await page.locator("#redo").click();
  await expect(radius).toHaveValue("200");

  // Projection drafts survive unrelated edits, then follow applied history.
  await page.locator("#setup-panel-button").click();
  const pitch = page.locator("#pitch-angle");
  const initialPitch = await pitch.inputValue();
  await pitch.fill("35");
  await page.locator("#undo").click();
  await expect(pitch).toHaveValue("35");
  await page.getByRole("button", { name: "投影設定を適用" }).click();
  await page.locator("#undo").click();
  await expect(pitch).toHaveValue(initialPitch);
  await page.locator("#redo").click();
  await expect(pitch).toHaveValue("35");
  assert.deepEqual(errors, []);
}
