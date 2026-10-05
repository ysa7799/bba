'use client';

/** Opens the browser print dialog (print or "Save as PDF"). */
export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-10 items-center rounded-md px-4 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 print:hidden"
    >
      {label}
    </button>
  );
}
