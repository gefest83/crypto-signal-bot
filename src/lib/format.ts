/** Display helpers shared by the signal console and the landing page. */

export function formatClock(utcMs: number): string {
  const date = new Date(utcMs);
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function formatClockWithSeconds(utcMs: number): string {
  const date = new Date(utcMs);
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  return `${formatClock(utcMs)}:${seconds}`;
}

export function formatPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const digits = Math.abs(value) >= 100 ? 2 : 4;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatSignedPct(value: number, digits = 3): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`;
}

export function formatSigned(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}
