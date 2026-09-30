<script lang="ts">
import type { Snippet } from "svelte";

let {
  id,
  labelledby,
  open = $bindable(false),
  children,
  onclose = () => {},
  ontoggle = () => {},
}: {
  id: string;
  labelledby: string;
  open?: boolean;
  children: Snippet;
  onclose?: () => void;
  ontoggle?: () => void;
} = $props();
let dialog: HTMLDialogElement;
let startedOutside = false;
$effect(() => {
  if (open && !dialog.open) dialog.showModal();
  else if (!open && dialog.open) dialog.close();
});
function outside(event: MouseEvent) {
  const rect = dialog.getBoundingClientRect();
  return (
    event.target === dialog &&
    (event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom)
  );
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- native dialog backdrop dismissal -->
<dialog
  bind:this={dialog}
  {id}
  aria-labelledby={labelledby}
  closedby="any"
  {ontoggle}
  onbeforetoggle={(event) => {
  if (event.newState === "closed") open = false;
}}
  onclose={() => {
  if (!dialog.open) {
    open = false;
    onclose();
  }
}}
  onpointerdown={(event) => {
  startedOutside = outside(event);
}}
  onclick={(event) => {
  if (
    !("closedBy" in HTMLDialogElement.prototype) &&
    startedOutside &&
    outside(event)
  )
    open = false;
  startedOutside = false;
}}
>
  {@render children()}
</dialog>
