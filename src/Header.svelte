<script lang="ts">
import { tick } from "svelte";
import { MediaQuery } from "svelte/reactivity";
import Dialog from "./Dialog.svelte";

let {
  unavailable,
  exporting,
  openFiles,
  exportImage,
  saveProject,
  loadProject,
  clearHover,
  advanced = $bindable(false),
  referenceOpen = $bindable(false),
}: {
  unavailable: boolean;
  exporting: boolean;
  openFiles: (files: FileList) => Promise<void>;
  exportImage: () => void;
  saveProject: () => void;
  loadProject: (
    event: Event & { currentTarget: HTMLInputElement },
  ) => Promise<void>;
  clearHover: () => void;
  advanced?: boolean;
  referenceOpen?: boolean;
} = $props();
const narrow = new MediaQuery("(width < 780px)");
const systemTheme = new MediaQuery("(prefers-color-scheme: dark)");
const settingsKey = "kuto-measure.preferences";
let theme = $state("system");
let helpOpen = $state(false),
  aboutOpen = $state(false);
let headerNode: HTMLElement;
$effect.pre(() => {
  narrow.current;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && headerNode?.contains(focused))
    void tick().then(() => focused.focus({ preventScroll: true }));
});
let menu: HTMLElement,
  menuTrigger: HTMLButtonElement,
  projectInput: HTMLInputElement;
try {
  const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
  if (
    settings?.version === 1 &&
    ["system", "light", "dark"].includes(settings.theme)
  )
    theme = settings.theme;
} catch {
  /* Storage is optional. */
}
$effect(() => {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
});
function saveTheme() {
  try {
    localStorage.setItem(settingsKey, JSON.stringify({ version: 1, theme }));
  } catch {
    /* Keep theme switching usable without storage. */
  }
}
function toggleTheme() {
  const dark = theme === "dark" || (theme === "system" && systemTheme.current);
  const next = dark ? "light" : "dark";
  theme = next === (systemTheme.current ? "dark" : "light") ? "system" : next;
  saveTheme();
}
export function closeMenu() {
  menu.hidePopover();
}
</script>
<svelte:head
  ><meta
    name="color-scheme"
    content={theme === "system" ? "light dark" : theme}
  ></svelte:head
>
<header id="header" class="header" bind:this={headerNode}>
  {#each narrow.current
    ? ["brand", "icons", "actions"]
    : ["brand", "actions", "icons"] as section (section)}
    {#if section === "icons"}
      {@render icons()}
    {:else if section === "brand"}
      <hgroup>
        <h1 class="brand">
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg?v=outline`}
            alt=""
            width="32"
            height="32"
          >
          <span>Kuto <strong>Measure</strong></span>
        </h1>
        <p class="release-label">β版</p>
      </hgroup>
    {:else}
      <div class="header-actions">
        <label class="file-button">
          画像を開く
          <input
            id="file"
            onchange={(event) => {
              const input = event.currentTarget;
              if (input.files) void openFiles(input.files);
              input.value = "";
            }}
            type="file"
            accept="image/png,image/jpeg,image/webp"
          >
        </label>
        <button
          id="export"
          onclick={exportImage}
          type="button"
          class="primary"
          disabled={unavailable || exporting}
        >
          画像を書き出す ↗
        </button>
      </div>
    {/if}
  {/each}
</header>
{#snippet icons()}
  <div id="header-icons" class="header-actions">
    <button
      id="help-trigger"
      class="icon-button"
      type="button"
      onclick={() => {
        helpOpen = true;
      }}
      aria-label="使い方"
      title="使い方"
      aria-haspopup="dialog"
    >
      <svg aria-hidden="true">
        <use href={`${import.meta.env.BASE_URL}icons.svg#help`} />
      </svg>
    </button>
    <button
      id="theme-toggle"
      onclick={toggleTheme}
      class="icon-button"
      type="button"
      aria-label="テーマの切り替え"
      title="テーマの切り替え"
    >
      <svg class="sun" aria-hidden="true">
        <use href={`${import.meta.env.BASE_URL}icons.svg#sun`} />
      </svg>
      <svg class="moon" aria-hidden="true">
        <use href={`${import.meta.env.BASE_URL}icons.svg#moon`} />
      </svg>
    </button>
    <button
      id="menu-trigger"
      bind:this={menuTrigger}
      class="icon-button"
      type="button"
      popovertarget="header-menu"
      aria-label="メニュー"
      title="メニュー"
    >
      <svg aria-hidden="true">
        <use href={`${import.meta.env.BASE_URL}icons.svg#menu`} />
      </svg>
    </button>
    <section
      id="header-menu"
      bind:this={menu}
      popover="auto"
      aria-label="メニュー"
    >
      <div class="menu-section">
        <button
          id="save-project"
          onclick={saveProject}
          class="menu-item"
          type="button"
          disabled={unavailable}
        >
          編集データを保存
        </button>
        <button
          id="load-project"
          onclick={() => projectInput.click()}
          class="menu-item"
          type="button"
          disabled={unavailable}
        >
          編集データを読み込む
        </button>
        <input
          id="project-file"
          bind:this={projectInput}
          onchange={loadProject}
          type="file"
          accept=".json,application/json"
          aria-label="編集データ"
          hidden
        >
        <p class="muted">
          画像本体は編集データに含まれません。
          <br>
          <span class="danger">
            編集データの仕様は変更される場合があります（β版）。
          </span>
        </p>
      </div>
      <fieldset class="theme-settings menu-section">
        <legend>テーマ</legend>
        <div class="theme-options">
          {#each [
            ["system", "システム"],
            ["light", "ライト"],
            ["dark", "ダーク"],
          ] as [value, label] (value)}
            <label>
              <input
                type="radio"
                name="theme"
                bind:group={theme}
                onchange={(event) => {
                  theme = event.currentTarget.value;
                  saveTheme();
                }}
                {value}
              >
              {label}
            </label>
          {/each}
        </div>
      </fieldset>
      <div class="menu-section">
        <label class="menu-item">
          高度な設定を表示
          <input
            id="show-advanced"
            bind:checked={advanced}
            onchange={(event) => {
              if (event.currentTarget.checked) referenceOpen = true;
            }}
            type="checkbox"
            aria-controls="projection-settings"
          >
        </label>
      </div>
      <button
        id="about-trigger"
        class="menu-item"
        type="button"
        onclick={() => {
          menu.hidePopover();
          aboutOpen = true;
        }}
        aria-haspopup="dialog"
      >
        このアプリについて
      </button>
    </section>
  </div>
{/snippet}
<Dialog
  id="help"
  labelledby="help-title"
  bind:open={helpOpen}
  ontoggle={clearHover}
>
  <div class="dialog-heading"><h2 id="help-title">使い方</h2></div>
  <section aria-labelledby="help-basics-title">
    <h3 id="help-basics-title">基本的な使い方</h3>
    <ol class="help-steps">
      <li>
        <strong>スクリーンショットを開く</strong>
        <p>
          「画像を開く」ボタンか、画像領域へドロップしてを読み込みます。画像は、ゲーム全体のものを使用してください。
        </p>
      </li>
      <li>
        <strong>ゲーム領域を確認する</strong>
        <p>
          レターボックス（上下の帯）を表示している場合、ゲーム領域が正しく判定されているか確認してください。判定がおかしい場合は、画像下の「ゲーム領域を設定」ボタンを押し、調整します。
        </p>
      </li>
      <li>
        <strong>ピンを置く</strong>
        <p>クリック・タップして「ピン」を配置します。</p>
      </li>
      <li>
        <strong>距離を測る</strong>
        <p>
          「距離線」を選び、ピンを2つ指定します。最初の線を1として距離を比較できます。「基準円」で距離を指定することで、絶対値で表示できます。
        </p>
      </li>
      <li>
        <strong>結果を保存する</strong>
        <p>
          「画像を書き出す」でPNG画像を保存します。編集を保存したい場合は、メニューの「編集データを保存」を使います。
        </p>
      </li>
    </ol>
  </section>
  <details id="help-details">
    <summary id="help-details-title">詳細</summary>
    <h3>表示の移動と編集</h3>
    <p>
      ドラッグで表示位置を移動し、ホイールで拡大・縮小します。タッチでは2本指で移動・ピンチで拡大縮小できます。
    </p>
    <p>
      「選択」で対象を選び、選択済みのピンや円のハンドルをドラッグして調整します。対象はパネルの一覧からも選べます。ラベルのドラッグでは表示位置が動き、測定点は動きません。選択中の対象の上でも、Space＋ドラッグや中ボタンドラッグで表示位置を移動できます。
    </p>
    <h3>履歴</h3>
    <p>アンドゥ、リドゥできる履歴は100操作までです。</p>
    <h3>基準円と距離</h3>
    <p>
      数値で距離を測る場合は、「基準円」で既知の円の中心と円周を指定し、ハンドルで位置・大きさを合わせて「基準円の半径」を入力します。
    </p>
    <p>
      半径が未設定なら「相対距離で測定」になります。相対距離のとき、先頭の距離線の端点を動かしたり、一覧で並び替え・削除したりすると基準が変わります。基準線の長さが0、または端点のグループが空の場合は距離を計算できません。基準円は距離の倍率だけを決め、カメラの補正値は変えません。
    </p>
    <h3>グループと補助円</h3>
    <p>
      「測定・編集」の「＋
      グループ」でグループを作り、ピンを選んで所属先を指定します。中心は所属ピンの地面上の平均位置で、距離線の端点にも使えます。「補助円」は距離の基準ができると使え、ピン・グループ中心・地面上の点を選んで半径を入力します。
    </p>
    <h3>ゲーム領域と測定の前提</h3>
    <p>
      「画像・基準」→「ゲーム領域」で、ゲーム映像の外側にある帯の幅を上下左右の整数pxで指定します。「バーをドラッグして調整」も使えます。赤い破線はプレビューで、「適用」で反映し、「取消」で元に戻します。
    </p>
    <p>
      地面は一枚の平面、カメラは共通と仮定しています。高低差・ゲーム側のカメラ変更には対応しません。また、切り抜きされたスクリーンショットも対応していません。
    </p>
    <h3>保存と再開</h3>
    <p>
      「画像を書き出す」は元解像度のPNG画像を保存します。選択表示・薄表示・編集用の境界は含みません。対応ブラウザでは保存ダイアログが表示され、非対応の場合はブラウザ設定のダウンロードになります。
    </p>
    <p>
      編集を再開するには、元画像を開き、メニューの「編集データを読み込む」で保存したJSONを選びます。画像本体は編集データに含まれないため、元画像も別途保管してください。自動保存はしません。サイズが異なる画像へ読み込んだ場合は、位置とゲーム領域を確認してください。読み込みは元に戻せます。
    </p>
    <p>
      同じ撮影条件で基準を使い回す場合は、「画像・基準」の「保存・削除の操作」で円とカメラ設定をブラウザに1件保存できます。次に開く画像へ自動適用します。ゲーム領域やピンは含みません。
    </p>
  </details>
</Dialog>
<Dialog
  id="about"
  labelledby="about-title"
  bind:open={aboutOpen}
  ontoggle={clearHover}
  onclose={() => menuTrigger?.focus()}
>
  <div class="dialog-heading">
    <img
      src={`${import.meta.env.BASE_URL}favicon.svg?v=outline`}
      alt=""
      width="64"
      height="64"
    >
    <h2 id="about-title">Kuto Measure</h2>
  </div>
  <p id="app-version" class="muted">
    バージョン
    {__APP_VERSION__}{__BUILD_COMMIT__ ? ` · ${__BUILD_COMMIT__}` : ""}
  </p>
  <nav class="about-links" aria-label="関連リンク">
    <a
      href="https://1m-lcei.github.io/kei-pinboard/"
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg class="link-icon" aria-hidden="true">
        <use href={`${import.meta.env.BASE_URL}icons.svg#home`} />
      </svg>
      ポータルサイト
    </a>
    <a href="https://x.com/1m_lcei" target="_blank" rel="noopener noreferrer">
      <svg class="link-icon" aria-hidden="true">
        <use href={`${import.meta.env.BASE_URL}icons.svg#x`} />
      </svg>
      連絡先
    </a>
    <a
      href="https://github.com/1m-lcei/kuto-measure"
      target="_blank"
      rel="noopener noreferrer"
    >
      <svg class="link-icon" aria-hidden="true">
        <use href={`${import.meta.env.BASE_URL}icons.svg#github`} />
      </svg>
      GitHub
    </a>
  </nav>
</Dialog>
