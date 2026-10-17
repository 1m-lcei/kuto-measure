import { detectCircles } from "./circle-detection";
import { loadCircleSimd } from "./circle-score";
import simdUrl from "./circle-score.wasm?url&no-inline";
import type { Projection } from "./geometry";

self.onmessage = async (
  event: MessageEvent<{ pixels: ImageData; projection: Projection }>,
) => {
  try {
    const simd = await fetch(simdUrl)
      .then((response) => response.arrayBuffer())
      .then(loadCircleSimd)
      .catch(() => undefined);
    const circles = detectCircles(
      event.data.pixels,
      event.data.projection,
      simd,
    );
    self.postMessage({ circles, simd: !!simd });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
