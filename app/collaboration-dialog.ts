// Child effects may run before the task board's effect when both mount together.
// Open ancestors first so the intended detail dialog remains at the top.
export function showCollaborationDialog(element: HTMLDialogElement | null) {
  if (!element) return;
  const parent = element.parentElement?.closest<HTMLDialogElement>('dialog');
  if (parent) showCollaborationDialog(parent);
  if (!element.open) element.showModal();
}
