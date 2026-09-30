<svelte:options namespace="svg" />
<script lang="ts">
import { untrack } from "svelte";
import {
  boundaryPath,
  captionVisible,
  crossPath,
  diamondPath,
  type Marker,
  prepareAnnotations,
  previewPath,
  referenceHandles,
} from "./annotations";
import type { ImagePoint, ImageRect, Projection } from "./geometry";
import type { MeasureLabel } from "./labels";
import type { AnalysisDocument } from "./model";

let {
  doc,
  p,
  z,
  selected,
  selectLabels,
  coarse,
  visible,
  measureLabel,
  cursor,
  referenceStart,
  areaPreview,
  candidate,
  overlapped,
  onwarning,
}: {
  doc: AnalysisDocument;
  p: Projection;
  z: number;
  selected: string;
  selectLabels: boolean;
  coarse: boolean;
  visible: { left: number; top: number; right: number; bottom: number };
  measureLabel: MeasureLabel;
  cursor: ImagePoint | null;
  referenceStart: ImagePoint | null;
  areaPreview: ImageRect | null;
  candidate: string | null;
  overlapped: ReadonlySet<string>;
  onwarning: (message: string) => void;
} = $props();
const scene = $derived(
  prepareAnnotations(doc, p, z, measureLabel, true, coarse),
);
const controls = $derived(referenceHandles(doc, p, selected, scene, visible));
const boundary = $derived(boundaryPath(p));
const hit = $derived((coarse ? 22 : 16) / z);
$effect(() => {
  const warning = scene.warnings[0];
  if (warning) untrack(() => onwarning(warning));
});
</script>

{#snippet text(
  x: number,
  y: number,
  label: string,
)}
  <text
    {x}
    {y}
    font-size={12 / z}
    font-family="system-ui, sans-serif"
    fill="#ffffff"
    stroke="#17313e"
    stroke-width={3 / z}
    stroke-linejoin="round"
    paint-order="stroke"
    pointer-events="none"
  >
    {label}
  </text>
{/snippet}

{#snippet marker(
  m: Marker,
  control = false,
)}
  <g
    data-key={m.key}
    data-part={control ? "handle" : "body"}
    data-movable={m.movable ? "true" : undefined}
    data-handle={m.handle}
    data-angle={m.angle}
    tabindex="0"
    role="button"
    aria-pressed={m.key === selected}
    aria-label={m.name}
    class:candidate={candidate === m.key}
    class:pin-overlap={overlapped.has(m.key)}
  >
    <circle
      class="hit"
      cx={m.point.x}
      cy={m.point.y}
      r={hit}
      fill="transparent"
    />
    {#if m.key === selected}
      <circle
        cx={m.point.x}
        cy={m.point.y}
        r={10 / z}
        stroke="#ffffff"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
        fill="none"
      />
    {/if}
    {#if m.shape === "cross"}
      <path
        d={crossPath(m.point, z)}
        stroke="#ffffff"
        stroke-width="4"
        vector-effect="non-scaling-stroke"
        fill="none"
        pointer-events="none"
      />
      <path
        class="visual"
        d={crossPath(m.point, z)}
        stroke={m.color}
        stroke-width="2"
        vector-effect="non-scaling-stroke"
        fill="none"
        pointer-events="none"
      />
    {:else if m.shape === "diamond"}
      <path
        class="visual"
        d={diamondPath(m.point, z)}
        fill={m.color}
        stroke="#fff"
        stroke-width={1.5 / z}
      />
    {:else}
      <circle
        class="visual"
        cx={m.point.x}
        cy={m.point.y}
        r={6 / z}
        fill={m.color}
        stroke="#fff"
        stroke-width={1.5 / z}
      />
    {/if}
    {#if control && captionVisible(m, scene.labels, z, measureLabel)}
      {@render text(m.point.x + 10 / z, m.point.y - 10 / z, m.name)}
    {/if}
  </g>
{/snippet}

<defs>
  <clipPath id="image-clip">
    <rect
      x={p.renderArea.x}
      y={p.renderArea.y}
      width={p.renderArea.width}
      height={p.renderArea.height}
    />
  </clipPath>
</defs>
<g clip-path="url(#image-clip)">
  {#each scene.circles as c (c.key)}
    <g
      data-key={c.key}
      data-part="body"
      tabindex="0"
      role="button"
      aria-pressed={c.key === selected}
      aria-label={c.name}
      class:candidate={candidate === c.key}
      class:pin-overlap={overlapped.has(c.key)}
    >
      <path
        class="line-hit"
        d={c.path}
        stroke="transparent"
        stroke-width="12"
        vector-effect="non-scaling-stroke"
        fill="none"
      />
      <path
        d={c.path}
        stroke={c.color}
        stroke-width={c.key === selected ? 3 : 2}
        vector-effect="non-scaling-stroke"
        fill="none"
        stroke-dasharray={c.key.startsWith("guide:") ? "7 5" : undefined}
      />
    </g>
  {/each}
  {#each scene.lines as line (line.key)}
    <g
      data-key={line.key}
      data-part="body"
      tabindex="0"
      role="button"
      aria-pressed={line.key === selected}
      aria-label={line.name}
      class:candidate={candidate === line.key}
      class:pin-overlap={overlapped.has(line.key)}
    >
      <line
        class="line-hit"
        x1={line.start.x}
        y1={line.start.y}
        x2={line.end.x}
        y2={line.end.y}
        stroke="transparent"
        stroke-width="14"
        vector-effect="non-scaling-stroke"
        fill="none"
      />
      <line
        x1={line.start.x}
        y1={line.start.y}
        x2={line.end.x}
        y2={line.end.y}
        stroke="#56c7e9"
        stroke-width={line.key === selected ? 3 : 2}
        vector-effect="non-scaling-stroke"
        fill="none"
      />
    </g>
  {/each}
  {#each scene.markers as m (m.key)}
    {@render marker(m)}
  {/each}
  {#each scene.labels as box (box.label.key)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- focusable only with button role; keyboard handling lives on the workspace -->
    <g
      data-key={box.label.key}
      data-part="label"
      tabindex={selectLabels ? 0 : undefined}
      role={selectLabels ? "button" : undefined}
      aria-pressed={selectLabels ? box.label.key === selected : undefined}
      aria-label={selectLabels ? box.label.name : undefined}
      aria-hidden={selectLabels ? undefined : true}
      class="annotation-label"
      class:candidate={candidate === box.label.key}
      class:pin-overlap={overlapped.has(box.label.key)}
      pointer-events="none"
    >
      {#if box.leader}
        <line
          class="label-leader"
          x1={box.leader.start.x / z}
          y1={box.leader.start.y / z}
          x2={box.leader.end.x / z}
          y2={box.leader.end.y / z}
          stroke={box.label.color}
          stroke-width="1"
          vector-effect="non-scaling-stroke"
          fill="none"
          pointer-events="none"
        />
      {/if}
      {#if selectLabels}
        <rect
          class="label-hit"
          x={box.x / z}
          y={box.y / z}
          width={box.width / z}
          height={box.height / z}
          rx={3 / z}
          fill="transparent"
          stroke="none"
          stroke-width={1 / z}
          pointer-events="all"
        />
      {/if}
      {@render text(box.textX / z, box.baseline / z, box.text)}
    </g>
  {/each}
</g>
{#if boundary && !areaPreview}
  <path
    class="excluded-boundary"
    d={boundary}
    stroke="#ef4444"
    stroke-width="1"
    vector-effect="non-scaling-stroke"
    fill="none"
    opacity="0.65"
    pointer-events="none"
    role="img"
    aria-label="ゲーム領域の境界"
  >
    <title>赤線の外側は測距から除外されています</title>
  </path>
{/if}
{#each controls as m (`${m.key}:${m.handle ?? ""}:${m.angle ?? ""}`)}
  {@render marker(m, true)}
{/each}
{#each [cursor, referenceStart] as point}
  {#if point}
    <path
      d={crossPath(point, z)}
      stroke="#ffffff"
      stroke-width="2"
      vector-effect="non-scaling-stroke"
      fill="none"
      pointer-events="none"
    />
  {/if}
{/each}
{#if areaPreview}
  <g
    class="area-preview"
    pointer-events="none"
    role="img"
    aria-label="未適用のゲーム領域"
  >
    <title>
      赤い破線の内側が適用予定のゲーム領域です。暗い部分は除外予定です。
    </title>
    <path
      d={previewPath(p, areaPreview)}
      fill="#000"
      fill-opacity="0.3"
      fill-rule="evenodd"
    />
    <rect
      class="area-preview-boundary"
      x={areaPreview.x}
      y={areaPreview.y}
      width={areaPreview.width}
      height={areaPreview.height}
      stroke="#ef4444"
      stroke-width="1"
      vector-effect="non-scaling-stroke"
      fill="none"
      stroke-dasharray="8 5"
    />
  </g>
{/if}
