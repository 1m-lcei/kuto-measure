import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect } from "playwright/test";

export async function checkProject(
  page: Page,
  engine: string,
  image: { name: string; mimeType: string; buffer: Buffer },
) {
  const errors: string[] = [],
    dialogs: string[] = [];
  let accept = true;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void (accept ? d.accept() : d.dismiss());
  });
  const menu = () =>
    page.getByRole("button", { name: "メニュー", exact: true }).click();
  const pins = page.locator('#object-list [data-object-key^="pin:"]');
  await menu();
  await expect(page.locator("#save-project")).toBeDisabled();
  await expect(page.locator("#load-project")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.locator("#file").setInputFiles(image);
  await expect(page.locator("#viewport")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-tool="pin"]').click();
  const box = await page.locator("#stage").boundingBox();
  assert(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(pins).toHaveCount(1);
  await menu();
  const pending = page.waitForEvent("download");
  await page.locator("#save-project").click();
  const download = await pending;
  assert.match(download.suggestedFilename(), /-measure\.json$/);
  const path = await download.path();
  assert(path);
  const buffer = await readFile(path);
  const saved = JSON.parse(buffer.toString());
  assert.deepEqual(saved.imageSize, { width: 1536, height: 709 });
  assert.equal(saved.document.pins.length, 1);
  const payload = {
    name: "editing.json",
    mimeType: "application/json",
    buffer,
  };
  await page.locator("#undo").click();
  await expect(pins).toHaveCount(0);
  await menu();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#load-project").click();
  await (await chooser).setFiles(payload);
  await expect(pins).toHaveCount(1);
  assert.equal(
    dialogs.length,
    0,
    "Matching size and unchanged document need no confirmation",
  );
  await page.locator("#undo").click();
  await expect(pins).toHaveCount(0);
  await page.locator("#redo").click();
  await expect(pins).toHaveCount(1);
  await page
    .locator("#project-file")
    .setInputFiles({ ...payload, buffer: Buffer.from('{"version":2}') });
  await expect(page.locator("#error")).toContainText("編集JSON");
  await expect(pins).toHaveCount(1);

  // A saved image twice as large forces both dimensions and the game area to adapt.
  saved.imageSize = { width: 3072, height: 1418 };
  saved.document.renderArea.bounds = { x: 0, y: 0, width: 3072, height: 1418 };
  const mismatch = { ...payload, buffer: Buffer.from(JSON.stringify(saved)) };
  await page.locator("#undo").click();
  accept = false;
  await page.locator("#project-file").setInputFiles(mismatch);
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(pins).toHaveCount(0);
  assert.match(dialogs[0], /3072 × 1418/);
  assert.match(dialogs[0], /1536 × 709/);
  accept = true;
  await page.locator("#project-file").setInputFiles(mismatch);
  await expect(pins).toHaveCount(1);
  await expect(page.locator("#image-clip rect")).toHaveAttribute(
    "width",
    "1536",
  );
  await expect(page.locator("#image-clip rect")).toHaveAttribute(
    "height",
    "709",
  );
  await expect(page.locator("#error")).toBeHidden();
  await page.locator("#undo").click();
  await expect(pins).toHaveCount(0);
  await page.locator("#redo").click();
  await expect(pins).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await menu();
  await expect(page.locator("#save-project")).toBeVisible();
  await expect(page.locator("#load-project")).toBeVisible();
  await page.screenshot({ path: `test-results/${engine}-project-menu.png` });
  assert.deepEqual(errors, []);
}
