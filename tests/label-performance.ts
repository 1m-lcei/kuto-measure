import assert from "node:assert/strict";
import { arch, cpus, platform } from "node:os";
import { basename } from "node:path";
import { chromium } from "playwright";

const build = await Bun.build({
  entrypoints: [
    "src/labels.ts",
    "src/label-score.ts",
    "tests/labels-reference.ts",
    "tests/label-fixture.ts",
  ],
  target: "browser",
  splitting: true,
  minify: true,
});
assert(build.success, String(build.logs));
const files = new Map(
  await Promise.all(
    build.outputs.map(
      async (file) => [basename(file.path), await file.text()] as const,
    ),
  ),
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname.slice(1);
    if (path === "label-score.wasm")
      return new Response(Bun.file("src/label-score.wasm"));
    const js = files.get(path);
    if (js)
      return new Response(js, {
        headers: { "Content-Type": "text/javascript" },
      });
    return new Response("<!doctype html><title>Label benchmark</title>", {
      headers: { "Content-Type": "text/html" },
    });
  },
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  const results = await page.evaluate(async () => {
    const urls = [
      "/labels.js",
      "/label-score.js",
      "/labels-reference.js",
      "/label-fixture.js",
    ];
    const current = (await import(urls[0])) as typeof import("../src/labels");
    const score = (await import(
      urls[1]
    )) as typeof import("../src/label-score");
    const original = (await import(
      urls[2]
    )) as typeof import("./labels-reference");
    const { labelFixture } = (await import(
      urls[3]
    )) as typeof import("./label-fixture");
    const simd = await score.loadLabelSimd(
      await fetch("/label-score.wasm").then((r) => r.arrayBuffer()),
    );
    if (!simd) throw new Error("SIMD unavailable");
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    const measure = current.canvasLabelMeasure(ctx),
      output = [];
    for (const pins of [24, 240]) {
      const f = labelFixture(pins, measure);
      const run = [
        () =>
          original.layoutLabels(
            f.labels,
            f.area,
            1,
            f.obstacles,
            measure,
            f.lines,
          ),
        () =>
          current.layoutLabels(
            f.labels,
            f.area,
            1,
            f.obstacles,
            measure,
            f.lines,
            null,
          ),
        () =>
          current.layoutLabels(
            f.labels,
            f.area,
            1,
            f.obstacles,
            measure,
            f.lines,
            simd,
          ),
      ];
      const expected = JSON.stringify(run[0]());
      for (const fn of run) {
        if (JSON.stringify(fn()) !== expected)
          throw new Error("Label positions changed");
        const warmStart = performance.now();
        for (
          let warm = 0;
          warm < 3 || performance.now() - warmStart < 250;
          warm++
        )
          fn();
      }
      const samples: number[][] = [[], [], []];
      let checksum = 0;
      for (let round = 0; round < 5; round++)
        for (let j = 0; j < 3; j++) {
          const index = (round + j) % 3,
            start = performance.now();
          let count = 0;
          do {
            checksum += run[index]().boxes.length;
            count++;
          } while (performance.now() - start < 80);
          samples[index].push((performance.now() - start) / count);
        }
      output.push({
        pins,
        labels: f.labels.length,
        strokes: f.lines.length,
        checksum,
        variants: samples.map((values, i) => {
          const sorted = [...values].sort((a, b) => a - b);
          return {
            backend: ["original", "javascript", "simd"][i],
            medianMs: sorted[2],
            minMs: sorted[0],
            maxMs: sorted[4],
            samples: values,
          };
        }),
      });
    }
    return output;
  });
  assert.deepEqual(errors, []);
  const output = {
    browser: browser.version(),
    cpu: cpus()[0]?.model,
    platform: platform(),
    arch: arch(),
    note: "Generated 24/240-pin documents with 8/80 measurements and 4/13 circles; layout only including text measurement, buffer packing and WASM calls. At least three warmups and 250ms per variant, five rotating-order rounds of >=80ms; milliseconds per layout. Module fetch/init and DOM rendering excluded. Exact layout parity checked before timing.",
    results,
  };
  await Bun.write(
    "test-results/label-performance.json",
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output, null, 2));
} finally {
  await browser.close();
  server.stop(true);
}
