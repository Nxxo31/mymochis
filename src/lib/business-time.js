export const BUSINESS_TIME_ZONE = 'America/Bogota';
export const BUSINESS_TZ_OFFSET_MINUTES = -300;

function timestampOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return Date.now();
}

export function businessClock(now = Date.now()) {
  const timestamp = timestampOf(now);
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  const local = new Date(safeTimestamp + BUSINESS_TZ_OFFSET_MINUTES * 60 * 1000);
  return {
    business_date: local.toISOString().slice(0, 10),
    business_tz: BUSINESS_TIME_ZONE,
    day_of_week: local.getUTCDay(),
    minutes_of_day: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

export function businessDate(now = Date.now()) {
  return businessClock(now).business_date;
}

export function weekdayForDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
}
