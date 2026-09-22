/**
 * Timezone utilities for Europe/Bucharest (Romania, EET/EEST).
 * Corrects server container UTC offset so reports and schedules match Romanian local time.
 */

export const BOT_TIMEZONE = 'Europe/Bucharest';

/**
 * Returns the current hour (0-23) in Europe/Bucharest timezone.
 */
export function getBucharestHour(date: Date = new Date()): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: BOT_TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return parseInt(formatter.format(date), 10);
}

/**
 * Returns formatted time string in Bucharest timezone (e.g. "07:15:30").
 */
export function formatBucharestTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('ro-RO', {
    timeZone: BOT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Returns formatted date and time in Bucharest timezone (e.g. "22.09.2026, 07:15:30").
 */
export function formatBucharestDateTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('ro-RO', {
    timeZone: BOT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Returns start and end hour strings for hourly report (e.g. { startHour: "06:00", endHour: "07:00", currentHour: 7 }).
 */
export function getBucharestHourlyInterval(date: Date = new Date()): {
  startHour: string;
  endHour: string;
  currentHour: number;
  prevHour: number;
} {
  const currentHour = getBucharestHour(date);
  const prevHour = (currentHour - 1 + 24) % 24;
  return {
    startHour: `${prevHour.toString().padStart(2, '0')}:00`,
    endHour: `${currentHour.toString().padStart(2, '0')}:00`,
    currentHour,
    prevHour,
  };
}
