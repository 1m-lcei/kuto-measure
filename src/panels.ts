import { circleValid, gameDistance, type Projection } from "./geometry";
import {
  type AnalysisDocument,
  centroid,
  type Edit,
  type Endpoint,
  endpointName,
  formatDistance,
  type History,
  measuredDistance,
  resolveCenter,
  type Selection,
  scaleFactor,
  selectionKey,
} from "./model";

export function element<T extends Element = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as unknown as T;
}
export function createPanels(actions: {
  edit: (e: Edit) => void;
  select: (s: Selection) => void;
  error: (e: unknown) => void;
  measure: (a: Endpoint, b: Endpoint) => void;
}) {
  let doc: AnalysisDocument,
    selection: Selection | null = null;
  const name = element<HTMLInputElement>("object-name"),
    group = element<HTMLSelectElement>("pin-group"),
    radius = element<HTMLInputElement>("reference-radius"),
    guideRadius = element<HTMLInputElement>("guide-radius");
  const from = element<HTMLSelectElement>("measure-from"),
    to = element<HTMLSelectElement>("measure-to");
  const safely = (action: () => void) => {
    try {
      action();
    } catch (e) {
      actions.error(e);
    }
  };
  const numeric = (input: HTMLInputElement) => {
    if (!input.value.trim()) throw new Error("半径を入力してください。");
    return gameDistance(Number(input.value));
  };
  name.addEventListener("change", () =>
    safely(() => {
      if (selection?.kind === "pin") {
        const p = doc.pins.find(
          (p) => selection?.kind === "pin" && p.id === selection.id,
        );
        if (p) actions.edit({ type: "pin", value: { ...p, name: name.value } });
      }
      if (selection?.kind === "group") {
        const g = doc.groups.find(
          (g) => selection?.kind !== "reference" && g.id === selection?.id,
        );
        if (g)
          actions.edit({ type: "group", value: { ...g, name: name.value } });
      }
    }),
  );
  group.addEventListener("change", () =>
    safely(() => {
      if (selection?.kind !== "pin") return;
      const p = doc.pins.find(
        (p) => selection?.kind === "pin" && p.id === selection.id,
      );
      if (p)
        actions.edit({
          type: "pin",
          value: { ...p, groupId: group.value || null },
        });
    }),
  );
  radius.addEventListener("change", () =>
    safely(() => {
      if (doc.reference) {
        const radiusGame = radius.value.trim() ? numeric(radius) : null;
        actions.edit({
          type: "reference",
          value: {
            ...doc.reference,
            radiusGame,
          },
        });
        if (
          radiusGame &&
          doc.reference?.radiusGame === radiusGame &&
          element<HTMLInputElement>("close-reference-panel").checked
        ) {
          const panel = element<HTMLDetailsElement>("reference-panel");
          panel.open = false;
          panel.querySelector("summary")?.focus();
        }
      }
    }),
  );
  radius.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      radius.blur();
    }
  });
  guideRadius.addEventListener("change", () =>
    safely(() => {
      if (selection?.kind !== "guide") return;
      const g = doc.guides.find(
        (g) => selection?.kind !== "reference" && g.id === selection?.id,
      );
      if (g)
        actions.edit({
          type: "guide",
          value: { ...g, radiusGame: numeric(guideRadius) },
        });
    }),
  );
  element("delete").addEventListener("click", () => {
    if (selection) actions.edit({ type: "delete", target: selection });
  });
  element("add-group").addEventListener("click", () => {
    const id = crypto.randomUUID();
    actions.edit({
      type: "group",
      value: { id, name: `グループ${doc.groups.length + 1}` },
    });
    actions.select({ kind: "group", id });
    name.focus();
    name.select();
  });
  const endpoint = (value: string): Endpoint | null => {
    const all: Endpoint[] = [
      ...doc.pins.map((p) => ({ kind: "pin" as const, id: p.id })),
      ...doc.groups
        .filter((g) => centroid(doc, g.id))
        .map((g) => ({ kind: "group" as const, id: g.id })),
    ];
    return all.find((e) => selectionKey(e) === value) ?? null;
  };
  const measure = () => {
    const a = endpoint(from.value),
      b = endpoint(to.value);
    if (a && b) actions.measure(a, b);
  };
  element("add-measure").addEventListener("click", () => safely(measure));
  const updateMeasureButton = () => {
    element<HTMLButtonElement>("add-measure").disabled =
      !from.value || !to.value || from.value === to.value;
  };
  from.addEventListener("change", updateMeasureButton);
  to.addEventListener("change", updateMeasureButton);
  const setValue = (input: HTMLInputElement, value: string) => {
    if (document.activeElement !== input) input.value = value;
  };
  function options(
    select: HTMLSelectElement,
    items: { value: string; label: string }[],
    fallback: string,
  ) {
    const signature = JSON.stringify(items);
    if (select.dataset.options === signature) return;
    const previous = select.value;
    select.replaceChildren(...items.map((i) => new Option(i.label, i.value)));
    select.value = items.some((i) => i.value === previous)
      ? previous
      : fallback;
    select.dataset.options = signature;
  }
  return {
    render(
      history: History,
      nextSelection: Selection | null,
      p: Projection | null,
      hasImage: boolean,
    ) {
      doc = history.present;
      selection = nextSelection;
      element<HTMLButtonElement>("undo").disabled = !history.past.length;
      element<HTMLButtonElement>("redo").disabled = !history.future.length;
      element<HTMLButtonElement>("delete").disabled = !selection;
      element<HTMLButtonElement>("add-group").disabled = !p;
      radius.disabled = !doc.reference;
      setValue(radius, doc.reference?.radiusGame?.toString() ?? "");
      const scale = scaleFactor(doc);
      element("scale-state").textContent = scale
        ? doc.reference?.radiusGame
          ? "距離スケール設定済み"
          : "相対距離"
        : hasImage && !p
          ? "投影を設定できません"
          : "距離スケール未設定";
      element("scale-hint").textContent = scale
        ? doc.reference?.radiusGame
          ? "地面上の距離をゲーム内の数値で表示しています。"
          : "最初の測距線を1として、地面上の距離を表示しています。"
        : hasImage && !p
          ? "キャリブレーションの設定を確認してください。"
          : "基準円の半径を入力するか、長さ0でない最初の測距線を作成してください。";
      element("name-row").hidden =
        selection?.kind !== "pin" && selection?.kind !== "group";
      element("group-row").hidden = selection?.kind !== "pin";
      element("guide-radius-row").hidden = selection?.kind !== "guide";
      element("object-detail").textContent = "";
      element("selection-title").textContent = selection
        ? {
            pin: "ピン",
            group: "グループ",
            measurement: "測距線",
            guide: "補助円",
            reference: "基準円",
          }[selection.kind]
        : "対象を選択すると編集できます。";
      options(
        group,
        [
          { value: "", label: "未所属" },
          ...doc.groups.map((g) => ({
            value: g.id,
            label: g.name || "グループ",
          })),
        ],
        "",
      );
      if (selection?.kind === "pin") {
        const pin = doc.pins.find(
          (p) => selection?.kind === "pin" && p.id === selection.id,
        );
        if (pin) {
          setValue(name, pin.name);
          group.value = pin.groupId ?? "";
        }
      } else if (selection?.kind === "group") {
        const g = doc.groups.find(
          (g) => selection?.kind === "group" && g.id === selection.id,
        );
        if (g) {
          setValue(name, g.name);
          element("object-detail").textContent =
            `所属ピン ${doc.pins.filter((p) => p.groupId === g.id).length} 個 · 中心は自動更新`;
        }
      } else if (selection?.kind === "guide") {
        const g = doc.guides.find(
          (g) => selection?.kind === "guide" && g.id === selection.id,
        );
        if (g) {
          setValue(guideRadius, String(g.radiusGame));
          element("object-detail").textContent =
            g.center.kind === "point"
              ? "中心は地面上の自由な点です。"
              : `中心：${endpointName(doc, g.center)}`;
        }
      } else if (selection?.kind === "reference")
        element("object-detail").textContent =
          "中心と円周のハンドルで調整できます。";
      else if (selection?.kind === "measurement") {
        const m = doc.measurements.find(
          (m) => selection?.kind === "measurement" && m.id === selection.id,
        );
        if (m)
          element("object-detail").textContent =
            `${endpointName(doc, m.from)} → ${endpointName(doc, m.to)}：${resolveCenter(doc, m.from) && resolveCenter(doc, m.to) ? formatDistance(measuredDistance(doc, m), doc) : "グループが空"}`;
      }
      const endpoints = [
        ...doc.pins.map((p) => ({
          value: `pin:${p.id}`,
          label: p.name || "ピン",
        })),
        ...doc.groups
          .filter((g) => centroid(doc, g.id))
          .map((g) => ({
            value: `group:${g.id}`,
            label: `${g.name || "グループ"}（中心）`,
          })),
      ];
      options(
        from,
        [{ value: "", label: "対象を選択" }, ...endpoints],
        endpoints[0]?.value ?? "",
      );
      options(
        to,
        [{ value: "", label: "対象を選択" }, ...endpoints],
        endpoints[1]?.value ?? "",
      );
      updateMeasureButton();
      const list = element("object-list"),
        focused =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.dataset.objectKey
            : null;
      const rows: HTMLElement[] = [];
      const row = (
        s: Selection,
        title: string,
        detail: string,
        symbol: string,
        type: string,
      ) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "object-row";
        button.dataset.objectKey = selectionKey(s);
        button.setAttribute(
          "aria-pressed",
          String(!!selection && selectionKey(selection) === selectionKey(s)),
        );
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = symbol;
        const label = document.createElement("span");
        label.className = "object-label";
        label.textContent = title;
        const small = document.createElement("small");
        small.textContent = detail;
        label.append(small);
        const kind = document.createElement("span");
        kind.className = "object-type";
        kind.textContent = type;
        button.append(badge, label, kind);
        button.addEventListener("click", () => actions.select(s));
        rows.push(button);
      };
      if (doc.reference)
        row(
          { kind: "reference" },
          "基準円",
          doc.reference.radiusGame
            ? `半径 ${formatDistance(doc.reference.radiusGame, doc)}`
            : "半径を入力してください",
          "◎",
          "基準",
        );
      for (const pin of doc.pins)
        row(
          { kind: "pin", id: pin.id },
          pin.name || "ピン",
          doc.groups.find((g) => g.id === pin.groupId)?.name || "未所属",
          "•",
          "ピン",
        );
      for (const g of doc.groups)
        row(
          { kind: "group", id: g.id },
          g.name || "グループ",
          centroid(doc, g.id)
            ? `${doc.pins.filter((p) => p.groupId === g.id).length} 個のピン`
            : "グループが空",
          "◇",
          "グループ",
        );
      for (const m of doc.measurements)
        row(
          { kind: "measurement", id: m.id },
          `${endpointName(doc, m.from)} → ${endpointName(doc, m.to)}`,
          resolveCenter(doc, m.from) && resolveCenter(doc, m.to)
            ? formatDistance(measuredDistance(doc, m), doc)
            : "グループが空",
          "↔",
          "測距線",
        );
      for (const g of doc.guides) {
        const c = resolveCenter(doc, g.center);
        row(
          { kind: "guide", id: g.id },
          `半径 ${formatDistance(g.radiusGame, doc)}`,
          !scale
            ? "距離スケール未設定"
            : !c
              ? "グループが空"
              : p && !circleValid(c, g.radiusGame / scale, p)
                ? "円がカメラ前方に収まりません"
                : g.center.kind === "point"
                  ? "自由な中心"
                  : endpointName(doc, g.center),
          "◌",
          "補助円",
        );
      }
      element("object-count").textContent = String(rows.length);
      list.replaceChildren(...rows);
      if (!rows.length) {
        const hint = document.createElement("p");
        hint.className = "muted";
        hint.textContent = "ピン・円・測距線がここに並びます。";
        list.append(hint);
      }
      if (focused)
        rows
          .find((r) => r.dataset.objectKey === focused)
          ?.focus({ preventScroll: true });
    },
  };
}
