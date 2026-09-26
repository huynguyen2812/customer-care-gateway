import { dayKey } from './day-key';

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FALLBACK_TIME_ZONE = 'Asia/Ho_Chi_Minh';

function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

export function shiftDateKey(value: string, days: number): string | null {
  const match = DATE_KEY.exec(value);
  if (!match) return null;
  const base = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (base.toISOString().slice(0, 10) !== value) return null;
  const date = new Date(base.getTime() + days * 86_400_000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** Convert midnight of a calendar day in an IANA timezone to its absolute UTC instant. */
export function localDateStartUtc(value: string, timeZone: string): Date | null {
  const match = DATE_KEY.exec(value);
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0);
  if (new Date(target).toISOString().slice(0, 10) !== value) return null;
  const zone = safeTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const next = target - (represented - guess);
    if (next === guess) break;
    guess = next;
  }
  const result = new Date(guess);
  return dayKey(result, zone) === value ? result : null;
}
