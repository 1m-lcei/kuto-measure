<script lang="ts">
import { untrack } from "svelte";
import { DETECTION_MAX_SIDE, type DetectedCircle } from "./circle-detection";
import type { Projection } from "./geometry";
import type { LoadedImage } from "./image";

let {
  resource,
  projection,
  loading,
  scale,
  apply,
  circles = $bindable([]),
}: {
  resource: LoadedImage | null;
  projection: Projection | null;
  loading: boolean;
  scale: number | null;
  apply: (circle: DetectedCircle, kind: "reference" | "guide") => void;
  circles?: DetectedCircle[];
} = $props();
let worker: Worker | null = null;
let busy = $state(false),
  message = $state(""),
  error = $state("");
let backend = $state("");
function cancel() {
  worker?.terminate();
  worker = null;
  busy = false;
}
$effect(() => {
  resource;
  projection;
  loading;
  untrack(() => {
    cancel();
    circles = [];
    message = "";
    error = "";
    backend = "";
  });
  return cancel;
});
function detect() {
  if (!resource || !projection || loading) return;
  cancel();
  circles = [];
  error = "";
  backend = "";
  const canvas = document.createElement("canvas");
  try {
    const area = projection.renderArea;
    const factor = Math.min(
      1,
      DETECTION_MAX_SIDE / Math.max(area.width, area.height),
    );
    canvas.width = Math.max(3, Math.round(area.width * factor));
    canvas.height = Math.max(3, Math.round(area.height * factor));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("円検出用の画像を読み取れませんでした。");
    ctx.drawImage(
      resource.image,
      area.x,
      area.y,
      area.width,
      area.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const current = new Worker(
      new URL("./circle-detection.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker = current;
    busy = true;
    message = "円を検出しています…";
    current.onmessage = (
      event: MessageEvent<{
        circles?: DetectedCircle[];
        simd?: boolean;
        error?: string;
      }>,
    ) => {
      if (worker !== current) return;
      cancel();
      if (event.data.error) {
        error = event.data.error;
        message = "";
        return;
      }
      circles = event.data.circles ?? [];
      backend = event.data.simd ? "simd" : "javascript";
      message = circles.length
        ? `${circles.length}個の候補が見つかりました。画像と重なりを確認して選んでください。`
        : "円の候補が見つかりませんでした。ゲーム領域とカメラ設定を確認するか、手動で円を合わせてください。";
    };
    current.onerror = (event) => {
      event.preventDefault();
      if (worker !== current) return;
      cancel();
      message = "";
      error =
        "円を検出できませんでした。再実行するか、手動で円を合わせてください。";
    };
    // Projection.size may be the LoadedImage, which also holds an unclonable DOM image.
    const { width, height } = projection.size;
    current.postMessage(
      { pixels, projection: { ...projection, size: { width, height } } },
      [pixels.data.buffer],
    );
  } catch (e) {
    cancel();
    message = "";
    error = e instanceof Error ? e.message : String(e);
  } finally {
    canvas.width = canvas.height = 0;
  }
}
</script>

<div id="circle-detection" data-backend={backend}>
  <button
    id="detect-circles"
    type="button"
    class="wide"
    disabled={!projection || loading || busy}
    onclick={detect}
  >
    {busy ? "円を検出中…" : "画像から円を検出"}
  </button>
  {#if busy}
    <button
      id="cancel-circle-detection"
      type="button"
      onclick={() => {
        cancel();
        message = "検出を中止しました。";
      }}
    >
      中止
    </button>
  {/if}
  <p class="muted">
    現在のカメラ設定で、地面上の円を検出します。検出だけでは編集内容は変わりません。
  </p>
  <p id="circle-detection-status" role="status" aria-busy={busy}>{message}</p>
  {#if error}
    <p role="alert">{error}</p>
  {/if}
  {#if circles.length}
    <ol id="circle-candidates">
      {#each circles as circle, i (circle)}
        <li data-circle-candidate={i}>
          <span>候補 {i + 1}</span>
          <div class="button-row">
            <button
              type="button"
              data-use-circle="reference"
              aria-label={`候補 ${i + 1} を基準円にする`}
              disabled={loading}
              onclick={() => apply(circle, "reference")}
            >
              基準円にする
            </button>
            <button
              type="button"
              data-use-circle="guide"
              aria-label={`候補 ${i + 1} を補助円に追加`}
              disabled={loading || !scale}
              onclick={() => apply(circle, "guide")}
            >
              補助円に追加
            </button>
          </div>
        </li>
      {/each}
    </ol>
    {#if !scale}
      <p class="muted">
        補助円の追加には、基準円の半径または距離線が必要です。
      </p>
    {/if}
    <button
      id="clear-circle-candidates"
      type="button"
      onclick={() => {
        circles = [];
        message = "";
      }}
    >
      候補を閉じる
    </button>
  {/if}
</div>

<style>
ol {
  padding: 0;
  list-style: none;
  display: grid;
  gap: 12px;
}
.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-block-start: 4px;
}
</style>
