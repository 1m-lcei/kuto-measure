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
    ? ["icons", "brand", "actions"]
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
        <p class="alpha-label">動作確認用 α版</p>
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
          PNGを書き出す ↗
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
          編集をJSONで保存
        </button>
        <button
          id="load-project"
          onclick={() => projectInput.click()}
          class="menu-item"
          type="button"
          disabled={unavailable}
        >
          編集JSONを読み込む
        </button>
        <input
          id="project-file"
          bind:this={projectInput}
          onchange={loadProject}
          type="file"
          accept=".json,application/json"
          aria-label="編集JSON"
          hidden
        >
        <p class="muted">
          画像を開いてから読み込みます。画像本体はJSONに含みません。
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
  <ol class="help-steps">
    <li>
      <strong>画像を開く</strong>
      <p>任意の縦横比の画像を読み込みます。画像は送信されません。</p>
    </li>
    <li>
      <strong>ゲーム内の距離を測る場合：基準円を合わせる</strong>
      <p>
        「基準円」で中心と円周を順に指定。中心と半径ハンドルで位置を合わせ、ゲーム内の半径を入力します。
      </p>
    </li>
    <li>
      <strong>ピンとグループを作る</strong>
      <p>
        「ピン」でカーソルと重なる既存の注釈だけを薄くして連続配置できます。パネルで名前と所属を設定。グループ中心は所属ピンの地面上の平均です。
      </p>
    </li>
    <li>
      <strong>測距線と補助円</strong>
      <p>
        「測距線」でピン・グループ中心を2つ選択。「補助円」で対象か地面を選び、半径を入力。重なる対象はパネルから指定できます。
      </p>
    </li>
  </ol>
  <h3>操作</h3>
  <p>
    どのツールでもドラッグで表示位置を移動できます。「選択」ではクリック・タップで対象を選び、選択済みのピンやハンドルをドラッグすると位置や半径を調整できます。ホイールでズーム。タッチでは2本指で移動・ピンチで拡大縮小でき、片指を離した後も残った指で移動を続けられます。倍率ボタンも使えます。
  </p>
  <p>
    2本指に切り替えると未確定のドラッグ編集を取り消します。全ての指を離してから、次の選択・配置・編集を始めてください。
  </p>
  <p>
    配置や描画は各ツールを選び、クリック・タップで指定します。選択済みの対象の上でもSpace＋ドラッグ／中ボタンドラッグなら表示位置を移動できます。Escapeで操作を取り消して「選択」に戻ります。
  </p>
  <p>
    Deleteで削除。Ctrl／Cmd＋ZでUndo、Ctrl＋YまたはCtrl／Cmd＋Shift＋ZでRedo。編集は100操作まで戻せます。
  </p>
  <p>
    各作成ツールで画像領域をフォーカスし、矢印キー＋Enterで作成。「選択」では選択したピン・ハンドルを矢印キーで1画像px、Shift付きで10px調整します。
  </p>
  <p>
    「選択」で対象が未選択のときは矢印キーで表示位置を移動します。Shiftを押すと移動量が大きくなります。
  </p>
  <p>
    「選択」では対象の輪郭を強調します。重なるラベルは位置をずらし、クリック・タップ・Enter／Spaceで個別選択できます。ラベルのドラッグでは表示位置を移動し、測定点は動きません。密集時は拡大するかオブジェクト一覧を使ってください。
  </p>
  <h3>測定の前提</h3>
  <p>
    地面は一枚の平面、カメラは共通という前提です。画像の帯を自動判定し、ゲーム領域の高さに合わせて投影を計算します。帯を判別できない場合は画像全体で仮計算します。画像を開いたら自動検出の成否にかかわらず境界を確認し、正しければ画像サイズ下の「問題なし」を押してください。修正する場合は「画像・基準」の「ゲーム領域」で上下左右の除外幅を指定するか、「自動検出を適用」「画面全体を適用」を選んでください。坂・高低差・任意の切り抜き・ゲーム側でのカメラ変更には対応しません。
  </p>
  <p>
    ゲーム領域の入力中は破線でプレビューし、「適用」で測定に反映します。「取消」またはEscapeで入力を戻せます。ピンの画像上の位置は保ちますが、基準円の形と測距値は変わるため確認してください。領域外の注釈は削除せず非表示にします。Undo／Redoに対応し、領域設定は保存した基準には含めません。赤い境界線と破線はPNGに含まれません。
  </p>
  <p>
    基準円は距離スケールだけを決めます。半径の設定後は「測定・編集」に戻ります（オプションで解除できます）。未設定時は先頭の測距線を1とする相対距離を表示し、その線を動かすと比率も更新します。並び替え・削除で先頭が変わると、新しい先頭の線が基準になります。先頭の線が長さ0、または端点のグループが空の場合は距離スケール未設定です。初期カメラ値は推定値です。
  </p>
  <p>
    PNGは元解像度で画像全体を書き出します。ラベルは元解像度で配置し直し、選択表示・薄表示は含めません。対応ブラウザではOSの保存ダイアログで名前と保存先を指定できます。非対応の場合は通常のダウンロードを開始し、保存ダイアログの表示や保存先はブラウザの設定に従います。
  </p>
  <p>
    メニューの「編集をJSONで保存」で編集内容と画像サイズを保存できます。画像本体は含みません。画像を開いて「編集JSONを読み込む」で復元します。サイズが違う場合も、確認後に読み込めます。ゲーム領域は画像サイズの比率に合わせるため、位置を確認してください。読み込みはUndo／Redoに対応します。未保存の編集はタブ終了・画像切替で失われます。「画像・基準」の「保存・削除の操作」では円とカメラ設定をブラウザに1件保存し、次の画像から自動適用できます。
  </p>
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
  <nav class="about-links" aria-label="連絡先とソースコード">
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
