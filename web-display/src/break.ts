export function remainingBreakSeconds(active: boolean | undefined, endsAt: string | null | undefined, now = Date.now()): number {
  if (!active || !endsAt) return 0;
  return Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 1000));
}
export function clampBreakMinutes(value: unknown, fallback = 10) {
  const minutes = Number(value);
  return Number.isInteger(minutes) ? Math.min(60, Math.max(1, minutes)) : fallback;
}
