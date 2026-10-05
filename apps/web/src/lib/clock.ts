/**
 * The current time for server components. They render once per request, so reading the clock
 * there is intended (React's purity rule targets components that re-render on the client).
 */
export function requestTime(): number {
  return Date.now();
}
