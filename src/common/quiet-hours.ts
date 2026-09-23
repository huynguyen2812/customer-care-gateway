export function isQuietHour(now: Date, start = '21:00', end = '08:00', timeZone = 'Asia/Ho_Chi_Minh'): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const current = hh * 60 + mm;
  const toMinutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const from = toMinutes(start); const to = toMinutes(end);
  return from <= to ? current >= from && current < to : current >= from || current < to;
}
