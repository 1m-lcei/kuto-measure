import {
  circleValid,
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
  type History,
  measuredDistance,
  resolveCenter,
  type Selection,
  scaleFactor,
  selectionKey,
  validateRenderArea,
} from "./model";

export function element<T extends Element = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as unknown as T;
}
export function showState(id: string, state: string) {
  for (const node of element(id).querySelectorAll<HTMLElement>(
    ":scope > [data-state]",
  ))
    node.hidden = node.dataset.state !== state;
}
export function createPanels(actions: {
  edit: (e: Edit) => boolean;
  select: (s: Selection) => void;
  error: (e: unknown) => void;
  measure: (a: Endpoint, b: Endpoint) => void;
  previewArea: (bounds: ImageRect | null) => void;
  automaticArea: () => boolean;
}) {
  let doc: AnalysisDocument,
    projection: Projection | null = null,
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
  const areaForm = element<HTMLFormElement>("area-form");
  const areaInputs = ["top", "bottom", "left", "right"].map((side) =>
    element<HTMLInputElement>(`area-${side}`),
  );
  const areaError = element("area-error");
  const areaDraft = element("area-draft");
  const referencePanel = element<HTMLDetailsElement>("reference-panel");
  const areaPanel = element<HTMLDetailsElement>("game-area");
  const readArea = (): ImageRect => {
    if (!projection) throw new Error("先に画像を開いてください。");
    const [top, bottom, left, right] = areaInputs.map(
      (input) => input.valueAsNumber,
    );
    if (
      ![top, bottom, left, right].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error("除外幅は0以上の整数で入力してください。");
    const bounds = {
      x: left,
      y: top,
      width: projection.size.width - left - right,
      height: projection.size.height - top - bottom,
    };
    validateRenderArea(bounds, projection.size);
    return bounds;
  };
  const cancelArea = () => {
    if (projection) {
      const { size, renderArea: a } = projection;
      const values = [
        a.y,
        size.height - a.y - a.height,
        a.x,
        size.width - a.x - a.width,
      ];
      areaInputs.forEach((input, i) => {
        input.value = String(values[i]);
        input.max = String((i < 2 ? size.height : size.width) - 1);
      });
    }
    for (const input of areaInputs) input.removeAttribute("aria-invalid");
    areaError.textContent = "";
    areaDraft.hidden = true;
    actions.previewArea(null);
  };
  areaForm.addEventListener("input", () => {
    areaError.textContent = "";
    for (const input of areaInputs) input.removeAttribute("aria-invalid");
    areaDraft.hidden = false;
    try {
      actions.previewArea(readArea());
    } catch {
      actions.previewArea(null);
    }
  });
  areaForm.addEventListener(
    "invalid",
    (event) => {
      (event.target as HTMLInputElement).setAttribute("aria-invalid", "true");
      areaError.textContent =
        "除外幅は0以上の整数にし、ゲーム領域を縦横とも1px以上残してください。";
    },
    true,
  );
  areaForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!projection) return;
    let bounds: ImageRect;
    try {
      bounds = readArea();
    } catch (error) {
      areaError.textContent =
        error instanceof Error ? error.message : String(error);
      const field =
        areaInputs[0].valueAsNumber + areaInputs[1].valueAsNumber >=
        projection.size.height
          ? areaInputs[1]
          : areaInputs[3];
      field.setAttribute("aria-invalid", "true");
      field.focus();
      return;
    }
    if (
      actions.edit({
        type: "render-area",
        value: { bounds, source: "manual", confirmed: true },
        size: projection.size,
        renderArea: projection.renderArea,
      })
    )
      cancelArea();
  });
  areaForm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelArea();
    }
  });
  element("area-cancel").addEventListener("click", cancelArea);
  element("area-auto").addEventListener("click", () => {
    if (actions.automaticArea()) cancelArea();
  });
  const useFullArea = () => {
    if (
      projection &&
      actions.edit({
        type: "render-area",
        value: {
          bounds: {
            x: 0,
            y: 0,
            width: projection.size.width,
            height: projection.size.height,
          },
          source: "full",
          confirmed: true,
        },
        size: projection.size,
        renderArea: projection.renderArea,
      })
    )
      cancelArea();
  };
  element("area-full").addEventListener("click", useFullArea);
  element("area-confirm").addEventListener("click", () => {
    if (actions.edit({ type: "confirm-area" }))
      element("viewport").focus({ preventScroll: true });
  });
  element("area-open").addEventListener("click", () => {
    referencePanel.open = true;
    areaPanel.open = true;
    areaInputs[0].focus();
  });
  for (const panel of [referencePanel, areaPanel])
    panel.addEventListener("toggle", () => {
      if (!panel.open) cancelArea();
    });
  const advanced = element<HTMLInputElement>("show-advanced");
  const projectionForm = element<HTMLFormElement>("projection-settings");
  const pitch = element<HTMLInputElement>("pitch-angle"),
    fov = element<HTMLInputElement>("vertical-fov"),
    roll = element<HTMLInputElement>("roll-angle"),
    principalX = element<HTMLInputElement>("principal-x"),
    principalY = element<HTMLInputElement>("principal-y");
  advanced.checked = false;
  advanced.addEventListener("change", () => {
    projectionForm.hidden = !advanced.checked;
    if (advanced.checked)
      element<HTMLDetailsElement>("reference-panel").open = true;
  });
  projectionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const currentProjection = projection;
    if (!currentProjection) return;
    const elevationDegrees = pitch.valueAsNumber;
    const verticalFovDegrees = fov.valueAsNumber;
    if (
      elevationDegrees <= 0 ||
      verticalFovDegrees <= 0 ||
      verticalFovDegrees >= 180
    ) {
      actions.error(
        "ピッチ角は0°より大きく90°以下、垂直画角は0°より大きく180°未満で入力してください。",
      );
      return;
    }
    safely(() =>
      actions.edit({
        type: "calibration",
        value: {
          elevationDegrees,
          verticalFovDegrees,
          rollDegrees: roll.valueAsNumber,
          principalPoint: {
            x: principalX.valueAsNumber,
            y: principalY.valueAsNumber,
          },
        },
        size: currentProjection.size,
        renderArea: currentProjection.renderArea,
      }),
    );
  });
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
    cancelArea,
    render(
      history: History,
      nextSelection: Selection | null,
      p: Projection | null,
      hasImage: boolean,
    ) {
      const calibrationChanged =
        doc?.calibration !== history.present.calibration ||
        projection?.size !== p?.size;
      const areaChanged =
        doc?.renderArea !== history.present.renderArea ||
        projection?.size !== p?.size;
      doc = history.present;
      projection = p;
      element<HTMLFieldSetElement>("area-fields").disabled = !p;
      if (areaChanged) cancelArea();
      const areaSource = doc.renderArea?.source;
      const needsConfirmation = !!doc.renderArea && !doc.renderArea.confirmed;
      const areaState = element("area-state");
      showState(
        "area-source",
        areaSource === "fallback" ? "full" : (areaSource ?? "none"),
      );
      element("area-confirmation").hidden = !areaSource;
      showState(
        "area-confirmation",
        needsConfirmation ? "pending" : "confirmed",
      );
      areaState.dataset.source = areaSource ?? "";
      areaState.dataset.confirmed = String(!needsConfirmation);
      element("area-warning").hidden = !needsConfirmation;
      element<HTMLFieldSetElement>("projection-fields").disabled = !p;
      if (calibrationChanged)
        for (const [input, value] of [
          [pitch, doc.calibration.elevationDegrees],
          [fov, doc.calibration.verticalFovDegrees],
          [roll, doc.calibration.rollDegrees],
          [principalX, doc.calibration.principalPoint.x],
          [principalY, doc.calibration.principalPoint.y],
        ] as const)
          input.value = String(value);
      selection = nextSelection;
      element<HTMLButtonElement>("undo").disabled = !history.past.length;
      element<HTMLButtonElement>("redo").disabled = !history.future.length;
      element<HTMLButtonElement>("delete").disabled = !selection;
      element<HTMLButtonElement>("add-group").disabled = !p;
      radius.disabled = !doc.reference;
      setValue(radius, doc.reference?.radiusGame?.toString() ?? "");
      const scale = scaleFactor(doc);
      const scaleState = scale
        ? doc.reference?.radiusGame
          ? "absolute"
          : "relative"
        : hasImage && !p
          ? "invalid"
          : "unset";
      showState("scale-state", scaleState);
      showState("scale-hint", scaleState);
      element("name-row").hidden =
        selection?.kind !== "pin" && selection?.kind !== "group";
      element("group-row").hidden = selection?.kind !== "pin";
      element("guide-radius-row").hidden = selection?.kind !== "guide";
      element("object-detail").textContent = "";
      showState("selection-title", selection?.kind ?? "none");
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
      if (focused)
        rows
          .find((r) => r.dataset.objectKey === focused)
          ?.focus({ preventScroll: true });
    },
  };
}
