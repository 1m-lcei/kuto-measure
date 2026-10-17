import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect } from "playwright/test";
import { serializeProject } from "../src/project";
import { labelDocument } from "./label-fixture";

export async function checkLabelBackends(
  page: Page,
  image: { name: string; mimeType: string; buffer: Buffer },
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(() => {
    const instantiate = WebAssembly.instantiate;
    Object.defineProperty(WebAssembly, "instantiate", {
      value: async (
        module: WebAssembly.Module,
        imports?: WebAssembly.Imports,
      ) => {
        const result = await instantiate(module, imports);
        if (
          typeof result.exports.count === "function" &&
          result.exports.count.length === 14
        )
          document.documentElement.dataset.labelSimdReady = "true";
        return result;
      },
    });
  });
  const { doc, size } = labelDocument(24);
  let expected: unknown;
  for (const backend of ["simd", "invalid", "missing"] as const) {
    let requested = 0;
    await page.route("**/label-score-*.wasm", (route) => {
      requested++;
      return backend === "missing"
        ? route.abort()
        : backend === "invalid"
          ? route.fulfill({ contentType: "application/wasm", body: "invalid" })
          : route.continue();
    });
    await page.reload();
    if (backend === "simd")
      await expect(page.locator("html")).toHaveAttribute(
        "data-label-simd-ready",
        "true",
      );
    await page.locator("#file").setInputFiles(image);
    await expect(page.locator("#load-project")).toBeEnabled();
    await page.locator("#project-file").setInputFiles({
      name: "labels.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProject(doc, size)),
    });
    const labels = page.locator('#overlay [data-part="label"]');
    await expect(labels).toHaveCount(36);
    const positions = await labels.evaluateAll((nodes) =>
      nodes.map((node) => ({
        key: node.getAttribute("data-key"),
        shapes: Array.from(
          node.querySelectorAll("rect,text,line"),
          (shape) => ({
            tag: shape.tagName,
            text: shape.textContent,
            attributes: [
              "x",
              "y",
              "width",
              "height",
              "x1",
              "y1",
              "x2",
              "y2",
            ].map((name) => shape.getAttribute(name)),
          }),
        ),
      })),
    );
    if (backend === "simd") expected = positions;
    else {
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-label-simd-ready",
        "true",
      );
      assert.deepEqual(positions, expected, `${backend} label positions`);
    }
    assert.equal(
      requested,
      1,
      "Production build requests the bundled label SIMD module",
    );
    await page.unroute("**/label-score-*.wasm");
  }
  assert.deepEqual(errors, []);
}
