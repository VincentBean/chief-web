import { type ReactNode, useEffect, useRef } from 'react';

/**
 * A modal confirmation, on the native `<dialog>` element.
 *
 * `window.confirm` cannot render the two facts that make a decision like this
 * safe — which branch is about to be pushed, and whose GitHub account is about
 * to speak — as anything but a wall of newline-joined text. `showModal()` gives
 * the focus trap, Esc, the inert background and focus restoration for free, so
 * this is a small component rather than a hand-rolled one.
 *
 * Cancel takes focus deliberately: a stray Enter must not push commits.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    // `showModal()` throws if it is already open, which StrictMode's double
    // invocation would otherwise trigger.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className="dialog"
      ref={ref}
      // Esc and the backdrop both fire `cancel`; neither may count as consent.
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 className="dialog__title">{title}</h2>
      <div className="dialog__body">{children}</div>
      <div className="dialog__actions">
        <button type="button" className="button" onClick={onCancel} disabled={busy} autoFocus>
          Cancel
        </button>
        <button type="button" className="button button--primary" onClick={onConfirm} disabled={busy}>
          {busy ? 'Starting…' : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
