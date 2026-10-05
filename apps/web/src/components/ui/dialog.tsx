'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Modal dialog built on the native <dialog> element (focus trapping, Escape to close and
 * inert background come from the browser).
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="dialog-title"
      className="m-auto w-full max-w-lg rounded-lg border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      {open ? (
        <div className="p-6">
          <h2 id="dialog-title" className="mb-4 text-lg font-semibold text-slate-900">
            {title}
          </h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

/** Confirmation dialog for destructive actions. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p className="text-sm text-slate-700">{message}</p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-md px-3 text-sm text-slate-700 hover:bg-slate-100"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="h-9 rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
