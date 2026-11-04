// The browser build has only window.confirm: OK and Cancel. Map them onto a message box's buttons so Cancel always
// means the box's cancel button, whatever order the buttons are in.

/** The button index a browser confirm() answer stands for. */
export function confirmResponse(buttons: readonly string[], cancelId: number | undefined, confirmed: boolean): number {
  const cancel = cancelId ?? buttons.length - 1;
  if (!confirmed) return cancel;
  const action = buttons.findIndex((_, index) => index !== cancel);
  return action < 0 ? 0 : action;
}
