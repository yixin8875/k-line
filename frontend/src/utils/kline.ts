const SECOND = 1000;
const MINUTE = 60 * SECOND;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getNextAlignedClose(now: number, timeframeMinutes: number): number {
  const tfMs = Math.max(1, timeframeMinutes) * MINUTE;
  const current = new Date(now);
  const dayStart = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();

  const elapsed = now - dayStart;
  const nextOffset = Math.ceil(elapsed / tfMs) * tfMs;
  let next = dayStart + nextOffset;

  if (next <= now) {
    next += tfMs;
  }

  return next;
}

export function normalizeNextClose(now: number, nextCloseAt: number, timeframeMinutes: number): number {
  const tfMs = Math.max(1, timeframeMinutes) * MINUTE;
  let next = nextCloseAt;
  while (next <= now) {
    next += tfMs;
  }
  return next;
}

export function getProgress(now: number, nextCloseAt: number, timeframeMinutes: number): number {
  const tfMs = Math.max(1, timeframeMinutes) * MINUTE;
  const windowStart = nextCloseAt - tfMs;
  return clamp((now - windowStart) / tfMs, 0, 1);
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return `${hh}:${mm}:${ss}`;
}

export function formatTimeframe(minutes: number): string {
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}D`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}H`;
  }
  return `${minutes}m`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
