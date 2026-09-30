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
  await page.locator("#reference-panel > summary").click();
  await page.locator("#menu-trigger").click();
  await page.locator("#show-advanced").check();
  await page.keyboard.press("Escape");
  await expect(page.locator("#reference-panel")).toHaveJSProperty("open", true);
  await page.locator("#reference-panel > summary").click();
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
  assert.deepEqual(errors, []);
}
