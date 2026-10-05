export default function Loading() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      <div className="h-6 w-48 animate-pulse rounded bg-slate-200" />
      <div className="h-32 animate-pulse rounded-lg bg-slate-200" />
    </div>
  );
}
