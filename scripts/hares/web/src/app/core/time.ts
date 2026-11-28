const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];
const formatter = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

/** "5 minutes ago", "now"; the absolute time goes in the element's title. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return '';
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return formatter.format(Math.round(diff / size), unit);
  }
  return 'just now';
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-GB');
}

/** "42 min", "1 h 5 min": how long until `iso`, never negative. */
export function untilTime(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(iso) - now) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
