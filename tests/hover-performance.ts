import { mkdir } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { measureHover, prepareHover } from "./hover";

const root = resolve(process.env.PERF_DIST ?? "dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = resolve(
      root,
      new URL(request.url).pathname.slice(1) || "index.html",
    );
    if (
      path !== root &&
      !path.startsWith(`${root}/`) &&
      !path.startsWith(`${root}\\`)
    )
      return new Response(null, { status: 404 });
    const file = Bun.file(path);
    return (await file.exists())
      ? new Response(file)
      : new Response(null, { status: 404 });
  },
});
const browser = await chromium.launch();
try {
  const results = [];
  for (const count of [24, 240]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`http://127.0.0.1:${server.port}`);
    await prepareHover(page, count);
    const micro = await measureHover(page);
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    const metrics = async () => {
      const { metrics } = await session.send("Performance.getMetrics");
      return Object.fromEntries(
        metrics.map(({ name, value }) => [name, value]),
      );
    };
    const frames: {
      taskMsPerMove: number;
      scriptMsPerMove: number;
      layoutMsPerMove: number;
      frameP95Ms: number;
    }[] = [];
    for (let run = 0; run < 3; run++) {
      const before = await metrics();
      const intervals = await page.evaluate(async () => {
        const viewport = document.querySelector<HTMLElement>("#viewport");
        if (!viewport) throw new Error("viewport");
        const durations: number[] = [];
        let previous = performance.now();
        for (let i = 0; i < 120; i++) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          const now = performance.now();
          if (i) durations.push(now - previous);
          previous = now;
          const point = window.hoverPoints[i % window.hoverPoints.length];
          viewport.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              clientX: point.x,
              clientY: point.y,
            }),
          );
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return durations.sort((a, b) => a - b);
      });
      const after = await metrics();
      frames.push({
        taskMsPerMove:
          ((after.TaskDuration - before.TaskDuration) * 1000) / 120,
        scriptMsPerMove:
          ((after.ScriptDuration - before.ScriptDuration) * 1000) / 120,
        layoutMsPerMove:
          ((after.LayoutDuration - before.LayoutDuration) * 1000) / 120,
        frameP95Ms: intervals[Math.floor(intervals.length * 0.95)],
      });
    }
    await session.detach();
    results.push({
      pins: count,
      measurements: Math.floor(count / 3),
      guides: count === 24 ? 3 : 12,
      ...micro,
      applicationFrames: frames,
    });
    await page.close();
  }
  const output = {
    browser: browser.version(),
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    viewport: [1440, 1000],
    deviceScaleFactor: 1,
    applicationNote:
      "Actual production app pointermove -> rAF -> hover -> Svelte. Three 120-move rounds, CDP TaskDuration/ScriptDuration/LayoutDuration divided by moves; includes test dispatch and Svelte work, not isolated hover time. No API instrumentation in timed rounds. Frame p95 is refresh-rate limited.",
    label: process.env.PERF_LABEL ?? "current",
    note: "Direct hit-test calls on a stable rendered production DOM; no rAF wait or Svelte render time. 3 warmups, 5 rotating-order rounds, 3 point sweeps per round. API counts are collected separately, outside timing.",
    results,
  };
  await mkdir("test-results", { recursive: true });
  await Bun.write(
    `test-results/hover-${process.env.PERF_LABEL ?? "current"}.json`,
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output, null, 2));
} finally {
  await browser.close();
  await server.stop(true);
}
