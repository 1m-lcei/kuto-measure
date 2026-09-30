import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { buildProjection, imagePoint, imageToGround } from "../src/geometry";
import { emptyDocument } from "../src/model";
import { serializeProject } from "../src/project";

// Production build, generated image, real public controls; no application test hooks.
const root = resolve(process.env.PERF_DIST ?? "dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = resolve(
      root,
      new URL(request.url).pathname.slice(1) || "index.html",
    );
    if (!path.startsWith(root)) return new Response(null, { status: 404 });
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file)
      : new Response(null, { status: 404 });
  },
});
const browser = await chromium.launch();
const results = [];
try {
  for (let run = 0; run < 3; run++) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    const buffer = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1536;
      canvas.height = 709;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.fillStyle = "#384750";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL().split(",")[1];
    });
    await page.locator("#file").setInputFiles({
      name: "perf.png",
      mimeType: "image/png",
      buffer: Buffer.from(buffer, "base64"),
    });
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLButtonElement>("#load-project")?.disabled,
    );
    const size = { width: 1536, height: 709 };
    const doc = emptyDocument(),
      projection = buildProjection(doc.calibration, size);
    const pins = Array.from({ length: 24 }, (_, i) => {
      const point = imageToGround(
        imagePoint(300 + (i % 6) * 150, 230 + Math.floor(i / 6) * 95),
        projection,
      );
      assert(point);
      return { id: `p${i}`, name: `ピン${i + 1}`, point, groupId: null };
    });
    const fixture = {
      ...doc,
      pins,
      measurements: Array.from({ length: 8 }, (_, i) => ({
        id: `m${i}`,
        from: { kind: "pin" as const, id: `p${i}` },
        to: { kind: "pin" as const, id: `p${i + 10}` },
      })),
    };
    await page.locator("#project-file").setInputFiles({
      name: "perf.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProject(fixture, size)),
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".object-row").length === 32,
    );
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    for (const mode of ["pan", "zoom", "drag"] as const) {
      await page.locator("#fit").click();
      if (mode === "drag")
        await page.locator('[data-object-key="pin:p0"]').click();
      await page.locator("#viewport").scrollIntoViewIfNeeded();
      const target =
        mode === "drag"
          ? page.locator('#overlay [data-key="pin:p0"] circle.hit').first()
          : page.locator("#viewport");
      const box = await target.boundingBox();
      assert(box);
      const x = mode === "drag" ? box.x + box.width / 2 : box.x + 50;
      const y = mode === "drag" ? box.y + box.height / 2 : box.y + 50;
      await page.mouse.move(x, y);
      if (mode !== "zoom") await page.mouse.down();
      const before = await session.send("Performance.getMetrics");
      const sample = await page.evaluate(
        async ({ mode, x, y }) => {
          const viewport = document.querySelector<HTMLElement>("#viewport");
          const overlay = document.querySelector("#overlay");
          const inspector = document.querySelector(".inspector-stack");
          const stage = document.querySelector<HTMLElement>("#stage");
          if (!viewport || !overlay || !inspector || !stage)
            throw new Error("Missing editor");
          const position = () =>
            mode === "drag"
              ? overlay
                  .querySelector('[data-key="pin:p0"] circle.hit')
                  ?.getAttribute("cx")
              : mode === "zoom"
                ? document.querySelector("#zoom")?.textContent
                : stage.style.translate;
          const initial = position();
          let changedFrames = 0;
          let added = 0,
            panelMutations = 0;
          const observer = new MutationObserver((records) => {
            for (const record of records)
              for (const node of record.addedNodes) {
                if (node instanceof Element)
                  added += 1 + node.querySelectorAll("*").length;
              }
          });
          observer.observe(overlay, {
            childList: true,
            subtree: true,
          });
          const panels = new MutationObserver((records) => {
            panelMutations += records.length;
          });
          panels.observe(inspector, {
            childList: true,
            attributes: true,
            characterData: true,
            subtree: true,
          });
          const frames: number[] = [],
            dispatch: number[] = [];
          let previous = performance.now();
          for (let i = 0; i < 90; i++) {
            await new Promise<void>((done) =>
              requestAnimationFrame(() => done()),
            );
            const now = performance.now();
            if (position() !== initial) changedFrames++;
            if (i > 0) frames.push(now - previous);
            previous = now;
            const start = performance.now();
            for (let j = 0; j < 8; j++) {
              if (mode === "zoom") {
                viewport.dispatchEvent(
                  new WheelEvent("wheel", {
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y,
                    deltaY: i % 2 ? 1 : -1,
                  }),
                );
              } else {
                viewport.dispatchEvent(
                  new PointerEvent("pointermove", {
                    bubbles: true,
                    pointerId: 1,
                    pointerType: "mouse",
                    isPrimary: true,
                    buttons: 1,
                    clientX: x + Math.sin(i / 8) * 30 + j / 8,
                    clientY: y + Math.cos(i / 8) * 20,
                  }),
                );
              }
            }
            dispatch.push(performance.now() - start);
          }
          await new Promise<void>((done) =>
            requestAnimationFrame(() => done()),
          );
          observer.disconnect();
          panels.disconnect();
          const percentile = (values: number[], fraction: number) =>
            values.sort((a, b) => a - b)[Math.floor(values.length * fraction)];
          return {
            frameP50: percentile(frames, 0.5),
            frameP95: percentile(frames, 0.95),
            dispatchP95: percentile(dispatch, 0.95),
            addedNodes: added,
            panelMutations,
            changedFrames,
          };
        },
        { mode, x, y },
      );
      const after = await session.send("Performance.getMetrics");
      assert(
        sample.changedFrames > 30,
        `${mode} must actually change the view or pin`,
      );
      const metric = (name: string) => {
        const a = after.metrics.find((m) => m.name === name),
          b = before.metrics.find((m) => m.name === name);
        assert(a && b);
        return 1000 * (a.value - b.value);
      };
      results.push({
        run,
        mode,
        ...sample,
        scriptMs: metric("ScriptDuration"),
        layoutMs: metric("LayoutDuration"),
        taskMs: metric("TaskDuration"),
      });
      if (mode !== "zoom") await page.mouse.up();
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  const files = [
    "index.html",
    ...(await readdir(resolve(root, "assets")))
      .filter((f) => /\.(js|css)$/.test(f))
      .map((f) => `assets/${f}`),
  ];
  const sizes = await Promise.all(
    files.map(async (file) => {
      const bytes = await readFile(resolve(root, file));
      return { file, bytes: bytes.length, gzip: gzipSync(bytes).length };
    }),
  );
  const output = {
    browser: browser.version(),
    viewport: "1440x1000",
    frames: 90,
    eventsPerFrame: 8,
    results,
    sizes,
  };
  await mkdir("test-results", { recursive: true });
  await Bun.write(
    `test-results/performance-${process.env.PERF_LABEL ?? "current"}.json`,
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output, null, 2));
} finally {
  await browser.close();
  await server.stop(true);
}
