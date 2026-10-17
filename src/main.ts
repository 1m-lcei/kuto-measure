import { mount } from "svelte";
import App from "./App.svelte";
import { loadLabelSimd } from "./label-score";
import labelSimdUrl from "./label-score.wasm?url&no-inline";

void fetch(labelSimdUrl)
  .then((response) => response.arrayBuffer())
  .then(loadLabelSimd)
  .catch(() => undefined);

const target = document.getElementById("app");
if (!target) throw new Error("Missing app root");
mount(App, { target });
