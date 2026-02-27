import type { SessionTemplateId } from '../types';

type SessionWindow = {
  startMinute: number;
  endMinute: number;
};

export interface SessionTemplate {
  id: SessionTemplateId;
  label: string;
  timezone: string;
  tradingDays: number[];
  windows: SessionWindow[];
  description: string;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

export const SESSION_TEMPLATES: SessionTemplate[] = [
  {
    id: 'always',
    label: '7x24',
    timezone: 'UTC',
    tradingDays: [0, 1, 2, 3, 4, 5, 6],
    windows: [{ startMinute: 0, endMinute: 1440 }],
    description: '全年无休，适合数字货币和外汇连续交易。',
  },
  {
    id: 'cn_stock',
    label: 'A股',
    timezone: 'Asia/Shanghai',
    tradingDays: [1, 2, 3, 4, 5],
    windows: [
      { startMinute: 9 * 60 + 30, endMinute: 11 * 60 + 30 },
      { startMinute: 13 * 60, endMinute: 15 * 60 },
    ],
    description: '北京时间 工作日 09:30-11:30 / 13:00-15:00。',
  },
  {
    id: 'us_stock',
    label: '美股常规',
    timezone: 'America/New_York',
    tradingDays: [1, 2, 3, 4, 5],
    windows: [{ startMinute: 9 * 60 + 30, endMinute: 16 * 60 }],
    description: '纽约时间 工作日 09:30-16:00。',
  },
  {
    id: 'hk_stock',
    label: '港股',
    timezone: 'Asia/Hong_Kong',
    tradingDays: [1, 2, 3, 4, 5],
    windows: [
      { startMinute: 9 * 60 + 30, endMinute: 12 * 60 },
      { startMinute: 13 * 60, endMinute: 16 * 60 },
    ],
    description: '香港时间 工作日 09:30-12:00 / 13:00-16:00。',
  },
];

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = FORMATTER_CACHE.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    FORMATTER_CACHE.set(timezone, formatter);
  }
  return formatter;
}

function getLocalParts(ts: number, timezone: string): { weekday: number; minuteOfDay: number } {
  const parts = getFormatter(timezone).formatToParts(new Date(ts));
  const weekday = parts.find((item) => item.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((item) => item.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((item) => item.type === 'minute')?.value ?? 0);
  return {
    weekday: WEEKDAY_MAP[weekday] ?? 0,
    minuteOfDay: hour * 60 + minute,
  };
}

export function getSessionTemplate(id: SessionTemplateId): SessionTemplate {
  return SESSION_TEMPLATES.find((item) => item.id === id) ?? SESSION_TEMPLATES[0];
}

export function formatSessionTemplate(id: SessionTemplateId): string {
  return getSessionTemplate(id).label;
}

export function isSessionOpen(id: SessionTemplateId, ts: number): boolean {
  if (id === 'always') {
    return true;
  }
  const session = getSessionTemplate(id);
  const local = getLocalParts(ts, session.timezone);
  if (!session.tradingDays.includes(local.weekday)) {
    return false;
  }
  return session.windows.some(
    (window) => local.minuteOfDay >= window.startMinute && local.minuteOfDay < window.endMinute,
  );
}
