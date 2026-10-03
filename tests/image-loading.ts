import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect } from "playwright/test";

declare global {
  interface Window {
    imageLoadingProbe: {
      waiting: boolean;
      decodes: number;
      samples: number;
      revoked: string[];
      url: string;
    };
  }
}

export async function checkImageLoading(
  page: Page,
  payload: { name: string; mimeType: string; buffer: Buffer },
) {
  const errors: string[] = [];
  let accept = true;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on(
    "dialog",
    (dialog) => void (accept ? dialog.accept() : dialog.dismiss()),
  );
  const viewport = page.locator("#viewport");
  const pins = page.locator('#object-list [data-object-key^="pin:"]');
  const idle = () => expect(viewport).toHaveAttribute("aria-busy", "false");
  const snapshot = async () => {
    await page.locator("#menu-trigger").click();
    const pending = page.waitForEvent("download");
    await page.locator("#save-project").click();
    const path = await (await pending).path();
    assert(path);
    return JSON.parse(await readFile(path, "utf8"));
  };
  // Pause native I/O at a deterministic boundary; no application test hooks.
  const hold = async (stage: "header" | "decode") => {
    await page.evaluate((stage) => {
      const probe = {
        waiting: false,
        decodes: 0,
        samples: 0,
        revoked: [] as string[],
        url: "",
      };
      window.imageLoadingProbe = probe;
      const gate = new Promise<void>((resolve, reject) =>
        window.addEventListener(
          "release-image-test",
          (event) =>
            (event as CustomEvent<boolean>).detail
              ? reject(new Error("Test decode failure"))
              : resolve(),
          { once: true },
        ),
      );
      const read = Blob.prototype.arrayBuffer;
      const decode = HTMLImageElement.prototype.decode;
      const sample = CanvasRenderingContext2D.prototype.getImageData;
      const revoke = URL.revokeObjectURL;
      if (stage === "header") {
        Blob.prototype.arrayBuffer = async function () {
          Blob.prototype.arrayBuffer = read;
          const bytes = await read.call(this);
          probe.waiting = true;
          await gate;
          return bytes;
        };
      }
      HTMLImageElement.prototype.decode = async function () {
        const first = ++probe.decodes === 1;
        await decode.call(this);
        if (stage === "decode" && first) {
          probe.url = this.src;
          probe.waiting = true;
          await gate;
        }
      };
      CanvasRenderingContext2D.prototype.getImageData = function (...args) {
        probe.samples++;
        return sample.apply(this, args);
      };
      URL.revokeObjectURL = (url) => {
        probe.revoked.push(url);
        revoke(url);
      };
      window.addEventListener(
        "finish-image-test",
        () => {
          Blob.prototype.arrayBuffer = read;
          HTMLImageElement.prototype.decode = decode;
          CanvasRenderingContext2D.prototype.getImageData = sample;
          URL.revokeObjectURL = revoke;
        },
        { once: true },
      );
    }, stage);
  };
  const start = async () => {
    await page.locator("#file").setInputFiles(payload);
    await expect
      .poll(() => page.evaluate(() => window.imageLoadingProbe.waiting))
      .toBe(true);
    await expect(viewport).toHaveAttribute("aria-busy", "true");
  };
  const release = async (fail = false) => {
    await page.evaluate(async (fail) => {
      window.dispatchEvent(
        new CustomEvent("release-image-test", { detail: fail }),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }, fail);
  };
  const finish = () =>
    page.evaluate(() => window.dispatchEvent(new Event("finish-image-test")));

  await page.locator("#file").setInputFiles(payload);
  await idle();
  await page.locator("#edit-panel-button").click();
  await page.locator('[data-tool="pin"]').click();
  await viewport.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(pins).toHaveCount(2);
  await page.locator("#object-name").fill("redo survives loading");
  await page.locator("#object-name").press("Tab");
  await page.locator("#undo").click();
  await page.locator('[data-tool="select"]').click();
  const before = await snapshot();
  const originalUrl = await page.locator("#image").getAttribute("src");

  await hold("decode");
  await start();
  await expect(page.locator(".inspector-stack")).toHaveJSProperty(
    "inert",
    true,
  );
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(page.locator("#redo")).toBeDisabled();
  await expect(page.locator('[data-tool="pin"]')).toBeDisabled();
  await expect(page.locator("#area-confirm")).toBeDisabled();
  await page.locator("#object-name").evaluate((input) => input.focus());
  await expect(page.locator("#object-name")).not.toBeFocused();
  // Also verify the shared edit guard if a queued event reaches the handler.
  await page.locator("#delete").dispatchEvent("click");
  await viewport.focus();
  for (const key of [
    "Control+z",
    "Control+y",
    "ArrowRight",
    "Delete",
    "Enter",
  ]) {
    await page.keyboard.press(key);
  }
  await expect(pins).toHaveCount(2);
  await release(true);
  await idle();
  await expect(page.locator("#error")).toBeVisible();
  assert.equal(await page.locator("#image").getAttribute("src"), originalUrl);
  assert.deepEqual(await snapshot(), before);
  await expect(page.locator(".inspector-stack")).toHaveJSProperty(
    "inert",
    false,
  );
  await expect(page.locator("#undo")).toBeEnabled();
  await expect(page.locator("#redo")).toBeEnabled();
  await page.locator("#redo").click();
  await expect(page.locator("#object-name")).toHaveValue(
    "redo survives loading",
  );
  await page.locator("#undo").click();
  assert.deepEqual(await snapshot(), before);
  const failed = await page.evaluate(() => window.imageLoadingProbe);
  assert(failed.revoked.includes(failed.url));
  assert.equal(failed.samples, 0);
  await finish();

  // Declining replacement cancels an older pending request and unlocks the old document.
  await hold("decode");
  await start();
  accept = false;
  await page.locator("#file").setInputFiles(payload);
  await idle();
  await expect(page.locator(".inspector-stack")).toHaveJSProperty(
    "inert",
    false,
  );
  await release();
  assert.equal(await page.locator("#image").getAttribute("src"), originalUrl);
  assert.deepEqual(await snapshot(), before);
  const cancelled = await page.evaluate(() => window.imageLoadingProbe);
  assert(cancelled.revoked.includes(cancelled.url));
  assert.equal(cancelled.samples, 0);
  await expect(page.locator("#error")).toBeHidden();
  await finish();
  accept = true;

  // Both checkpoints preserve latest-wins without waiting for the old request.
  for (const stage of ["header", "decode"] as const) {
    await hold(stage);
    await start();
    await page
      .locator("#file")
      .setInputFiles({ ...payload, name: "latest.png" });
    await idle();
    const latestUrl = await page.locator("#image").getAttribute("src");
    await expect(pins).toHaveCount(0);
    await release();
    assert.equal(await page.locator("#image").getAttribute("src"), latestUrl);
    const probe = await page.evaluate(() => window.imageLoadingProbe);
    assert.equal(probe.decodes, stage === "header" ? 1 : 2);
    assert.equal(
      probe.samples,
      1,
      "Only the latest image reaches border detection",
    );
    if (stage === "decode") assert(probe.revoked.includes(probe.url));
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.locator(".inspector-stack")).toHaveJSProperty(
      "inert",
      false,
    );
    await finish();
  }
  await page.locator('[data-tool="pin"]').click();
  await viewport.focus();
  await page.keyboard.press("Enter");
  await expect(pins).toHaveCount(1);
  await page.locator("#undo").click();
  await expect(pins).toHaveCount(0);
  assert.deepEqual(errors, []);
}
