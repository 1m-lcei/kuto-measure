<script lang="ts">
import { tick, untrack } from "svelte";
import {
  circleValid,
  DEFAULT_CALIBRATION,
  gameDistance,
  type ImageRect,
  type Projection,
} from "./geometry";
import {
  type AnalysisDocument,
  centroid,
  type Edit,
  type Endpoint,
  endpointName,
  formatDistance,
  measuredDistance,
  type ReferencePreset,
  referencePreset,
  resolveCenter,
  type Selection,
  sameCalibration,
  scaleFactor,
  selectionKey,
  validateRenderArea,
} from "./model";

let {
  doc,
  projection,
  selection,
  hasImage,
  loading,
  savedPreset,
  savedExists,
  presetError,
  edit,
  select,
  error,
  measure,
  previewArea,
  automaticArea,
  saveReference,
  deleteSavedReference,
  resetReference,
  advanced,
  referenceOpen = $bindable(true),
}: {
  doc: AnalysisDocument;
  projection: Projection | null;
  selection: Selection | null;
  hasImage: boolean;
  loading: boolean;
  savedPreset: ReferencePreset | null;
  savedExists: boolean;
  presetError: string;
  edit: (edit: Edit) => boolean;
  select: (selection: Selection) => void;
  error: (error: unknown) => void;
  measure: (from: Endpoint, to: Endpoint) => void;
  previewArea: (bounds: ImageRect | null) => void;
  automaticArea: () => boolean;
  saveReference: () => void;
  deleteSavedReference: () => void;
  resetReference: () => void;
  advanced: boolean;
  referenceOpen?: boolean;
} = $props();
const calibration = $derived(doc.calibration);
const area = $derived(doc.renderArea?.bounds ?? projection?.renderArea);
const size = $derived(projection?.size);
const areaSource = $derived(doc.renderArea?.source);
const needsConfirmation = $derived(
  !!doc.renderArea && !doc.renderArea.confirmed,
);
const scale = $derived(scaleFactor(doc));
const scaleState = $derived(
  scale
    ? doc.reference?.radiusGame
      ? "absolute"
      : "relative"
    : hasImage && !projection
      ? "invalid"
      : "unset",
);
const canSave = $derived(hasImage && !!doc.reference?.radiusGame && !loading);
const savedState = $derived(
  !savedPreset
    ? savedExists
      ? "invalid"
      : presetError
        ? "error"
        : "none"
    : !hasImage
      ? "ready"
      : !doc.reference
        ? "unused"
        : doc.reference.radiusGame &&
            JSON.stringify(referencePreset(doc)) === JSON.stringify(savedPreset)
          ? "active"
          : "changed",
);
const selectedPin = $derived(
  selection?.kind === "pin"
    ? doc.pins.find((p) => p.id === selection.id)
    : undefined,
);
const selectedGroup = $derived(
  selection?.kind === "group"
    ? doc.groups.find((g) => g.id === selection.id)
    : undefined,
);
const selectedGuide = $derived(
  selection?.kind === "guide"
    ? doc.guides.find((g) => g.id === selection.id)
    : undefined,
);
const selectedMeasurement = $derived(
  selection?.kind === "measurement"
    ? doc.measurements.find((m) => m.id === selection.id)
    : undefined,
);
const ordered = $derived(
  selection && selection.kind !== "reference" ? doc[`${selection.kind}s`] : [],
);
const position = $derived(
  ordered.findIndex(
    (item) => selection?.kind !== "reference" && item.id === selection?.id,
  ),
);
const detail = $derived(
  selectedGroup
    ? `所属ピン ${doc.pins.filter((p) => p.groupId === selectedGroup.id).length} 個 · 中心は自動更新`
    : selectedGuide
      ? selectedGuide.center.kind === "point"
        ? "中心は地面上の自由な点です。"
        : `中心：${endpointName(doc, selectedGuide.center)}`
      : selectedMeasurement
        ? `${endpointName(doc, selectedMeasurement.from)} → ${endpointName(doc, selectedMeasurement.to)}：${measurementValue(selectedMeasurement)}`
        : selection?.kind === "reference"
          ? "中心と円周のハンドルで調整できます。"
          : "",
);
const endpoints = $derived([
  ...doc.pins.map((p) => ({
    value: `pin:${p.id}`,
    label: p.name || "ピン",
    endpoint: { kind: "pin" as const, id: p.id },
  })),
  ...doc.groups
    .filter((g) => centroid(doc, g.id))
    .map((g) => ({
      value: `group:${g.id}`,
      label: `${g.name || "グループ"}（中心）`,
      endpoint: { kind: "group" as const, id: g.id },
    })),
]);
let from = $state(""),
  to = $state("");
$effect(() => {
  if (from && !endpoints.some((e) => e.value === from))
    from = endpoints[0]?.value ?? "";
  if (to && !endpoints.some((e) => e.value === to))
    to = endpoints[1]?.value ?? "";
});
let areaOpen = $state(false),
  closeReference = $state(true);
let areaValues = $state<(number | undefined)[]>([0, 0, 0, 0]);
let areaDirty = $state(false),
  areaError = $state(""),
  invalidSides = $state<number[]>([]);
let pitch = $derived<number | undefined>(calibration.elevationDegrees),
  fov = $derived<number | undefined>(calibration.verticalFovDegrees),
  roll = $derived<number | undefined>(calibration.rollDegrees),
  principalX = $derived<number | undefined>(calibration.principalPoint.x),
  principalY = $derived<number | undefined>(calibration.principalPoint.y);
let referenceRadius = $derived<number | undefined>(
    doc.reference?.radiusGame ?? undefined,
  ),
  guideRadius = $derived<number | undefined>(selectedGuide?.radiusGame);
let radiusInput: HTMLInputElement,
  nameInput: HTMLInputElement,
  areaForm: HTMLFormElement,
  referenceSummary: HTMLElement,
  objectList: HTMLDivElement;
const safely = (action: () => void) => {
  try {
    action();
  } catch (e) {
    error(e);
  }
};
const numeric = (input: HTMLInputElement) => {
  if (!input.value.trim()) throw new Error("半径を入力してください。");
  return gameDistance(Number(input.value));
};
$effect(() => {
  const bounds = area,
    imageSize = size;
  if (bounds && imageSize) untrack(cancelArea);
});
$effect(() => {
  if (!referenceOpen || !areaOpen) untrack(cancelArea);
});
$effect(() => {
  const values = areaValues.slice(),
    dirty = areaDirty;
  let bounds: ImageRect | null = null;
  if (dirty) {
    try {
      bounds = readArea(values);
    } catch {
      /* Native validation announces errors on submission. */
    }
  }
  untrack(() => previewArea(bounds));
});
export function cancelArea() {
  if (area && size)
    areaValues = [
      area.y,
      size.height - area.y - area.height,
      area.x,
      size.width - area.x - area.width,
    ];
  areaError = "";
  invalidSides = [];
  areaDirty = false;
}
export async function openArea() {
  referenceOpen = true;
  areaOpen = true;
  await tick();
  areaForm.querySelector("input")?.focus();
}
export async function focusRadius() {
  referenceOpen = true;
  await tick();
  radiusInput.focus();
}
function readArea(values = areaValues): ImageRect {
  if (!size) throw new Error("先に画像を開いてください。");
  if (
    !values.every(
      (value) =>
        value !== undefined && Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("除外幅は0以上の整数で入力してください。");
  const [top, bottom, left, right] = values as number[];
  const bounds = {
    x: left,
    y: top,
    width: size.width - left - right,
    height: size.height - top - bottom,
  };
  validateRenderArea(bounds, size);
  return bounds;
}
function submitArea(event: SubmitEvent) {
  event.preventDefault();
  if (!projection) return;
  let bounds: ImageRect;
  try {
    bounds = readArea();
  } catch (e) {
    areaError = e instanceof Error ? e.message : String(e);
    const invalidSide =
      (areaValues[0] ?? 0) + (areaValues[1] ?? 0) >= projection.size.height
        ? 1
        : 3;
    invalidSides = [invalidSide];
    areaForm.querySelectorAll("input")[invalidSide].focus();
    return;
  }
  if (
    edit({
      type: "render-area",
      value: { bounds, source: "manual", confirmed: true },
      size: projection.size,
      renderArea: projection.renderArea,
    })
  )
    cancelArea();
}
function fullArea() {
  if (
    projection &&
    edit({
      type: "render-area",
      value: {
        bounds: { x: 0, y: 0, ...projection.size },
        source: "full",
        confirmed: true,
      },
      size: projection.size,
      renderArea: projection.renderArea,
    })
  )
    cancelArea();
}
function submitProjection(event: SubmitEvent) {
  event.preventDefault();
  if (!projection) return;
  if (!pitch || !fov || fov >= 180) {
    error(
      "ピッチ角は0°より大きく90°以下、垂直画角は0°より大きく180°未満で入力してください。",
    );
    return;
  }
  edit({
    type: "calibration",
    value: {
      elevationDegrees: pitch,
      verticalFovDegrees: fov,
      rollDegrees: roll ?? NaN,
      principalPoint: { x: principalX ?? NaN, y: principalY ?? NaN },
    },
    size: projection.size,
    renderArea: projection.renderArea,
  });
}
function rename(value: string) {
  if (selectedPin)
    edit({ type: "pin", value: { ...selectedPin, name: value } });
  else if (selectedGroup)
    edit({ type: "group", value: { ...selectedGroup, name: value } });
}
async function changeRadius(input: HTMLInputElement) {
  if (!doc.reference) return;
  try {
    const radiusGame = input.value.trim() ? numeric(input) : null;
    if (
      edit({ type: "reference", value: { ...doc.reference, radiusGame } }) &&
      radiusGame &&
      closeReference
    ) {
      referenceOpen = false;
      await tick();
      referenceSummary.focus();
    }
  } catch (e) {
    error(e);
  }
}
async function reorder(direction: -1 | 1) {
  if (!selection || selection.kind === "reference") return;
  if (edit({ type: "reorder", target: selection, direction })) {
    await tick();
    if (direction < 0 ? position <= 0 : position >= ordered.length - 1)
      objectList
        .querySelector<HTMLButtonElement>('[aria-pressed="true"]')
        ?.focus({ preventScroll: true });
  }
}
async function addGroup() {
  const id = crypto.randomUUID();
  if (
    !edit({
      type: "group",
      value: { id, name: `グループ${doc.groups.length + 1}` },
    })
  )
    return;
  select({ kind: "group", id });
  await tick();
  nameInput.focus();
  nameInput.select();
}
function addMeasurement() {
  const a = endpoints.find((e) => e.value === from),
    b = endpoints.find((e) => e.value === to);
  if (a && b) measure(a.endpoint, b.endpoint);
}
function measurementValue(m: AnalysisDocument["measurements"][number]) {
  return resolveCenter(doc, m.from) && resolveCenter(doc, m.to)
    ? formatDistance(measuredDistance(doc, m), doc)
    : "グループが空";
}
function guideDetail(g: AnalysisDocument["guides"][number]) {
  const center = resolveCenter(doc, g.center);
  return !scale
    ? "距離スケール未設定"
    : !center
      ? "グループが空"
      : projection && !circleValid(center, g.radiusGame / scale, projection)
        ? "円がカメラ前方に収まりません"
        : g.center.kind === "point"
          ? "自由な中心"
          : endpointName(doc, g.center);
}
const scaleTitles = {
  unset: "距離スケール未設定",
  absolute: "距離スケール設定済み",
  relative: "相対距離",
  invalid: "投影を設定できません",
};
const scaleHints = {
  unset: "基準円をゲーム内の円に合わせ、その半径を入力してください。",
  absolute: "地面上の距離をゲーム内の数値で表示しています。",
  relative: "先頭の測距線を1として、地面上の距離を表示しています。",
  invalid: "キャリブレーションの設定を確認してください。",
};
const savedStates = {
  none: "保存した基準はありません",
  invalid: "保存した基準は使用できません",
  error: "保存した基準を確認できません",
  ready: "次に開く画像へ自動適用します",
  unused: "この画像では保存した基準を使用していません",
  active: "保存した基準を使用中",
  changed: "現在の基準は保存内容と異なります",
};
const selectionTitles = {
  none: "対象を選択すると編集できます。",
  pin: "ピン",
  group: "グループ",
  measurement: "測距線",
  guide: "補助円",
  reference: "基準円",
};
</script>

{#snippet row(
  s: Selection,
  title: string,
  detail: string,
  symbol: string,
  type: string,
)}
  <button
    type="button"
    class="object-row"
    data-object-key={selectionKey(s)}
    aria-pressed={!!selection && selectionKey(selection) === selectionKey(s)}
    onclick={() => select(s)}
  >
    <span class="badge">{symbol}</span
    ><span class="object-label">{title}<small>{detail}</small></span
    ><span class="object-type">{type}</span>
  </button>
{/snippet}

<aside class="inspector-stack" aria-label="距離設定">
  <details id="reference-panel" class="inspector" bind:open={referenceOpen}>
    <summary bind:this={referenceSummary}>
      基準パネル <span>距離の設定</span>
    </summary>
    <div class="inspector-body">
      <details id="game-area" class="game-area" bind:open={areaOpen}>
        <summary>ゲーム領域</summary>
        <p
          id="area-state"
          data-source={areaSource ?? ""}
          data-confirmed={!needsConfirmation}
        >
          <span
            id="area-source"
            data-state={areaSource === "fallback" ? "full" : (areaSource ?? "none")}
            >{areaSource === "auto"
  ? "ゲーム領域を自動検出"
  : areaSource === "manual"
    ? "ゲーム領域を手動設定"
    : areaSource
      ? "画像全体を使用"
      : "画像未選択"}</span
          >
          <span
            id="area-confirmation"
            hidden={!areaSource}
            data-state={needsConfirmation ? "pending" : "confirmed"}
            >{needsConfirmation ? "（要確認）" : "（確認済み）"}</span
          >
        </p>
        <p class="muted" id="area-hint">
          ゲーム映像の外側にある帯の幅を、元画像のpx単位で指定します。入力すると赤い破線でプレビューします。「適用」で確定します。
        </p>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- Escape cancels the draft from any form control -->
        <form
          id="area-form"
          bind:this={areaForm}
          onsubmit={submitArea}
          onkeydown={(event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancelArea();
  }
}}
        >
          <fieldset id="area-fields" disabled={!projection}>
            <legend class="sr-only">上下左右の除外幅</legend>
            <div class="endpoint-fields">
              {#each [
   { name: "top", label: "上" },
   { name: "bottom", label: "下" },
   { name: "left", label: "左" },
   { name: "right", label: "右" },
 ] as side, i (side.name)}
                <label for={`area-${side.name}`}
                  >{side.label}（px）<input
                    id={`area-${side.name}`}
                    name={side.name}
                    type="number"
                    min="0"
                    step="1"
                    required
                    aria-describedby="area-hint area-error"
                    bind:value={areaValues[i]}
                    max={size ? (i < 2 ? size.height : size.width) - 1 : undefined}
                    aria-invalid={invalidSides.includes(i) ? true : undefined}
                    oninput={() => {
  areaDirty = true;
  areaError = "";
  invalidSides = [];
}}
                    oninvalid={() => {
  invalidSides = [...invalidSides, i];
  areaError =
    "除外幅は0以上の整数にし、ゲーム領域を縦横とも1px以上残してください。";
}}
                  ></label
                >
              {/each}
            </div>
            <p id="area-error" class="detail danger" role="alert">
              {areaError}
            </p>
            <p id="area-draft" class="muted" hidden={!areaDirty}>
              プレビュー中（未適用）。赤い破線の内側がゲーム領域、暗い部分が除外予定です。「適用」で確定、「取消」で元に戻します。
            </p>
            <div class="area-actions">
              <button id="area-apply" type="submit" class="primary">
                適用
              </button>
              <button id="area-cancel" type="button" onclick={cancelArea}>
                取消
              </button>
            </div>
            <button
              id="area-auto"
              type="button"
              class="wide"
              onclick={() => {
  if (automaticArea()) cancelArea();
}}
            >
              自動検出を適用
            </button>
            <button
              id="area-full"
              type="button"
              class="wide"
              onclick={fullArea}
            >
              画面全体を適用
            </button>
          </fieldset>
        </form>
        <p class="muted">
          変更後は基準円の形を確認してください。領域外の注釈は保持されますが、表示・PNGでは隠れます。領域設定はこの画像だけに適用します。
        </p>
      </details>
      <section class="scale-card">
        <span class="eyebrow">距離スケール</span>
        <div class="scale-title">
          <span class="scale-dot"></span>
          <strong id="scale-state" data-state={scaleState}
            >{scaleTitles[scaleState]}</strong
          >
        </div>
        <p id="scale-hint" data-state={scaleState}>
          {scaleHints[scaleState]}
        </p>
        <label>
          基準円の半径
          <input
            id="reference-radius"
            type="number"
            min="0"
            step="any"
            placeholder="例：500"
            bind:this={radiusInput}
            bind:value={referenceRadius}
            disabled={!doc.reference}
            onchange={(event) => void changeRadius(event.currentTarget)}
            onkeydown={(event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    event.currentTarget.blur();
  }
}}
          >
        </label>
        <label class="checkbox-label">
          <input
            id="close-reference-panel"
            type="checkbox"
            bind:checked={closeReference}
          >
          設定時にパネルを閉じる
        </label>
      </section>
      <section class="saved-reference" aria-labelledby="saved-reference-title">
        <h2 id="saved-reference-title">ブラウザに保存した基準</h2>
        <p id="saved-reference-state" role="status" data-state={savedState}>
          {savedStates[savedState]}
        </p>
        <p id="saved-reference-error" role="alert" class="detail">
          {presetError}
        </p>
        <details id="saved-reference-options">
          <summary>保存・リセットの操作</summary>
          <p id="saved-reference-detail" class="muted">
            {savedPreset
  ? `保存したゲーム内半径：${savedPreset.reference.radiusGame}（カメラ設定を含む）`
  : ""}
          </p>
          <button
            id="save-reference"
            type="button"
            class="wide"
            disabled={!canSave}
            onclick={saveReference}
            data-state={savedExists ? "overwrite" : "new"}
          >
            {savedExists ? "現在の基準で上書き" : "現在の基準を保存"}
          </button>
          <p
            id="save-reference-hint"
            class="muted"
            data-state={canSave ? "available" : "unavailable"}
          >
            {canSave
  ? "確定済みの円とカメラ設定を保存します。調整後は明示的に上書きしてください。"
  : "先に基準円のゲーム内半径を設定してください。"}
          </p>
          <button
            id="delete-saved-reference"
            type="button"
            class="wide"
            disabled={!savedExists && !presetError}
            onclick={deleteSavedReference}
          >
            保存した基準を削除
          </button>
          <p class="muted">
            円とカメラ設定を1件保存し、次に開く画像へ自動適用します。同じ撮影条件の画像に使用し、円の位置と大きさを確認してください。
          </p>
          <p class="muted">
            このブラウザ・配信元だけに保存され、サイトデータの削除等で失われます。
          </p>
          <button
            id="reset-reference"
            type="button"
            class="wide"
            aria-describedby="reset-reference-hint"
            disabled={!hasImage ||
  loading ||
  (!doc.reference && sameCalibration(doc.calibration, DEFAULT_CALIBRATION))}
            onclick={resetReference}
          >
            この画像の基準をリセット
          </button>
          <p id="reset-reference-hint" class="muted">
            基準円とカメラ設定を初期化します。ピンの画像上の位置と保存した基準は保持します。
          </p>
        </details>
      </section>
      <form
        id="projection-settings"
        hidden={!advanced}
        onsubmit={submitProjection}
      >
        <fieldset id="projection-fields" disabled={!projection}>
          <legend>投影パラメータ</legend>
          <label>
            ピッチ角（°）
            <input
              id="pitch-angle"
              name="pitch"
              type="number"
              min="0"
              max="90"
              step="any"
              required
              aria-describedby="pitch-hint"
              bind:value={pitch}
            >
          </label>
          <p id="pitch-hint" class="muted">
            水平から下向き。0°より大きく90°以下。
          </p>
          <label>
            垂直画角（°）
            <input
              id="vertical-fov"
              name="fov"
              type="number"
              min="0"
              max="180"
              step="any"
              required
              aria-describedby="fov-hint"
              bind:value={fov}
            >
          </label>
          <p id="fov-hint" class="muted">
            描画領域の高さに対応。0°より大きく180°未満。
          </p>
          <label>
            ロール角（°）
            <input
              id="roll-angle"
              name="roll"
              type="number"
              step="any"
              required
              aria-describedby="roll-hint"
              bind:value={roll}
            >
          </label>
          <p id="roll-hint" class="muted">
            正の値で消失線が右下がりになります。
          </p>
          <div class="endpoint-fields">
            <label>
              主点 X
              <input
                id="principal-x"
                name="principal-x"
                type="number"
                min="0"
                max="1"
                step="any"
                required
                aria-describedby="principal-hint"
                bind:value={principalX}
              >
            </label>
            <label>
              主点 Y
              <input
                id="principal-y"
                name="principal-y"
                type="number"
                min="0"
                max="1"
                step="any"
                required
                aria-describedby="principal-hint"
                bind:value={principalY}
              >
            </label>
          </div>
          <p id="principal-hint" class="muted">
            描画領域内の比率（0〜1）。左上が (0, 0)、中央が (0.5, 0.5)。
          </p>
          <p class="muted">
            適用後もピンの画像上の位置を保ちます。基準円の形が変わるため、必要に応じて合わせ直してください。
          </p>
          <button type="submit" class="wide">投影設定を適用</button>
        </fieldset>
      </form>
    </div>
  </details>
  <details id="analysis-panel" class="inspector" open>
    <summary>編集パネル <span>設定・オブジェクト</span></summary>
    <div class="inspector-body">
      <section id="properties">
        <div class="section-title">
          <h2>選択中の対象</h2>
          <button
            id="delete"
            class="danger"
            type="button"
            disabled={!selection}
            onclick={() => {
  if (selection) edit({ type: "delete", target: selection });
}}
          >
            削除
          </button>
        </div>
        <p
          id="selection-title"
          class="muted"
          data-state={selection?.kind ?? "none"}
        >
          {selectionTitles[selection?.kind ?? "none"]}
        </p>
        <label id="name-row" hidden={!selectedPin && !selectedGroup}>
          名前
          <input
            id="object-name"
            type="text"
            bind:this={nameInput}
            value={selectedPin?.name ?? selectedGroup?.name ?? ""}
            onchange={(event) => rename(event.currentTarget.value)}
          >
        </label>
        <label id="group-row" hidden={!selectedPin}>
          所属グループ
          <select
            id="pin-group"
            value={selectedPin?.groupId ?? ""}
            onchange={(event) => {
  if (selectedPin)
    edit({
      type: "pin",
      value: { ...selectedPin, groupId: event.currentTarget.value || null },
    });
}}
          >
            <option value="">未所属</option>
            {#each doc.groups as group (group.id)}
              <option value={group.id}>{group.name || "グループ"}</option>
            {/each}
          </select>
        </label>
        <label id="guide-radius-row" hidden={!selectedGuide}>
          補助円の半径
          <input
            id="guide-radius"
            type="number"
            min="0"
            step="any"
            bind:value={guideRadius}
            onchange={(event) =>
  safely(() => {
    if (selectedGuide)
      edit({
        type: "guide",
        value: { ...selectedGuide, radiusGame: numeric(event.currentTarget) },
      });
  })}
          >
        </label>
        <p id="object-detail" class="detail">{detail}</p>
        <div id="object-order" hidden={!ordered.length}>
          <p id="object-order-hint" class="muted">
            同じ種類の中で並び替えます。
          </p>
          <div class="endpoint-fields">
            <button
              id="object-up"
              type="button"
              aria-describedby="object-order-hint"
              disabled={position <= 0}
              onclick={() => void reorder(-1)}
            >
              ↑ 上へ
            </button>
            <button
              id="object-down"
              type="button"
              aria-describedby="object-order-hint"
              disabled={position < 0 || position >= ordered.length - 1}
              onclick={() => void reorder(1)}
            >
              ↓ 下へ
            </button>
          </div>
        </div>
      </section>
      <section id="measure-panel">
        <div class="section-title"><h2>対象を指定して測る</h2></div>
        <div class="endpoint-fields">
          <label>
            始点
            <select id="measure-from" bind:value={from}>
              <option value="">対象を選択</option>
              {#each endpoints as endpoint (endpoint.value)}
                <option value={endpoint.value}>{endpoint.label}</option>
              {/each}
            </select>
          </label>
          <label>
            終点
            <select id="measure-to" bind:value={to}>
              <option value="">対象を選択</option>
              {#each endpoints as endpoint (endpoint.value)}
                <option value={endpoint.value}>{endpoint.label}</option>
              {/each}
            </select>
          </label>
        </div>
        <button
          type="button"
          id="add-measure"
          class="wide"
          disabled={!from || !to || from === to}
          onclick={addMeasurement}
        >
          測距線を追加
        </button>
      </section>
      <section>
        <div class="section-title">
          <h2>
            オブジェクト
            <span id="object-count"
              >{(doc.reference ? 1 : 0) +
  doc.pins.length +
  doc.groups.length +
  doc.measurements.length +
  doc.guides.length}</span
            >
          </h2>
          <button
            id="add-group"
            type="button"
            disabled={!projection}
            onclick={() => void addGroup()}
          >
            ＋ グループ
          </button>
        </div>
        <div id="object-list" bind:this={objectList}>
          {#if doc.reference}
            {@render row(
  { kind: "reference" },
  "基準円",
  doc.reference.radiusGame
    ? "半径 " + formatDistance(doc.reference.radiusGame, doc)
    : "半径を入力してください",
  "◎",
  "基準",
)}
          {/if}
          {#each doc.pins as pin (pin.id)}
            {@render row(
  { kind: "pin", id: pin.id },
  pin.name || "ピン",
  (doc.groups.find((g) => g.id === pin.groupId)?.name ?? "未所属") ||
    "グループ",
  "•",
  "ピン",
)}
          {/each}
          {#each doc.groups as group (group.id)}
            {@render row(
  { kind: "group", id: group.id },
  group.name || "グループ",
  centroid(doc, group.id)
    ? doc.pins.filter((p) => p.groupId === group.id).length + " 個のピン"
    : "グループが空",
  "◇",
  "グループ",
)}
          {/each}
          {#each doc.measurements as m (m.id)}
            {@render row(
  { kind: "measurement", id: m.id },
  endpointName(doc, m.from) + " → " + endpointName(doc, m.to),
  measurementValue(m),
  "↔",
  !doc.reference?.radiusGame && m === doc.measurements[0]
    ? "測距線 · 基準"
    : "測距線",
)}
          {/each}
          {#each doc.guides as guide (guide.id)}
            {@render row(
  { kind: "guide", id: guide.id },
  "半径 " + formatDistance(guide.radiusGame, doc),
  guideDetail(guide),
  "◌",
  "補助円",
)}
          {/each}
        </div>
        <p id="object-empty" class="muted">
          ピン・円・測距線がここに並びます。
        </p>
      </section>
    </div>
  </details>
</aside>
