import { useCallback, useEffect, useMemo, useState } from 'react';
import { EventsOff, EventsOn } from '../wailsjs/runtime/runtime';
import {
  CheckForUpdates,
  NotifySystem,
  OpenURL,
  PlayAlertSound,
  PushExternalNotification,
  RequestQuit,
  SetAlwaysOnTop,
} from '../wailsjs/go/main/App';
import { playCustomSound, playDefaultBeep, notifyBrowser, speakAlert } from './utils/alerts';
import {
  formatClock,
  formatCountdown,
  formatTimeframe,
  getNextAlignedClose,
  getProgress,
  normalizeNextClose,
} from './utils/kline';
import {
  SESSION_TEMPLATES,
  formatSessionTemplate,
  getSessionTemplate,
  isSessionOpen,
} from './utils/session';
import type {
  AccentColor,
  AppSettings,
  ReminderTask,
  SessionTemplateId,
  TaskTemplate,
  ThemeMode,
} from './types';

const STORAGE_KEYS = {
  tasks: 'kline.tasks.v1',
  settings: 'kline.settings.v1',
  alwaysOnTop: 'kline.alwaysOnTop.v1',
  templates: 'kline.templates.v1',
};

const PRESET_MINUTES = [1, 3, 5, 15, 30, 60, 240, 1440];

const ACCENT_RGB: Record<AccentColor, string> = {
  blue: '59 130 246',
  green: '16 185 129',
  orange: '251 146 60',
  red: '239 68 68',
  violet: '139 92 246',
};

const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'light',
  accent: 'blue',
  globalLeadSeconds: 30,
  alertsEnabled: true,
  enableTTS: false,
  enableDefaultBeep: true,
  enableSystemNotification: true,
  customSoundDataUrl: '',
  customSoundName: '',
  enableWebhook: false,
  webhookURL: '',
  enableTelegram: false,
  telegramBotToken: '',
  telegramChatID: '',
  enableFeishu: false,
  feishuWebhookURL: '',
  enableWeCom: false,
  weComWebhookURL: '',
};

type TaskDraft = {
  symbol: string;
  preset: number;
  customMinutes: string;
  useCustom: boolean;
  leadSeconds: string;
  sessionTemplate: SessionTemplateId;
};

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseName: string;
  releaseURL: string;
  publishedAt: string;
  notes: string;
};

const VALID_SESSION_IDS = new Set<SessionTemplateId>(SESSION_TEMPLATES.map((item) => item.id));

const SCENE_TEMPLATES: Array<{
  id: string;
  name: string;
  description: string;
  items: TaskTemplate['items'];
}> = [
  {
    id: 'scene-intraday-crypto',
    name: 'Intraday Crypto',
    description: '1m/3m/5m/15m for active intraday tracking.',
    items: [
      { symbol: 'BTCUSDT', timeframeMinutes: 1, leadSeconds: 20, sessionTemplate: 'always' },
      { symbol: 'BTCUSDT', timeframeMinutes: 3, leadSeconds: 30, sessionTemplate: 'always' },
      { symbol: 'ETHUSDT', timeframeMinutes: 5, leadSeconds: 30, sessionTemplate: 'always' },
      { symbol: 'BTCUSDT', timeframeMinutes: 15, leadSeconds: 45, sessionTemplate: 'always' },
    ],
  },
  {
    id: 'scene-swing-crypto',
    name: 'Swing Crypto',
    description: '30m/1h/4h/1D for trend-focused swing setups.',
    items: [
      { symbol: 'BTCUSDT', timeframeMinutes: 30, leadSeconds: 60, sessionTemplate: 'always' },
      { symbol: 'ETHUSDT', timeframeMinutes: 60, leadSeconds: 90, sessionTemplate: 'always' },
      { symbol: 'BTCUSDT', timeframeMinutes: 240, leadSeconds: 120, sessionTemplate: 'always' },
      { symbol: 'BTCUSDT', timeframeMinutes: 1440, leadSeconds: 300, sessionTemplate: 'always' },
    ],
  },
  {
    id: 'scene-us-pre-open',
    name: 'US Pre-Market',
    description: 'Pre-market watchlist with US session timing.',
    items: [
      { symbol: 'SPY', timeframeMinutes: 5, leadSeconds: 20, sessionTemplate: 'us_stock' },
      { symbol: 'QQQ', timeframeMinutes: 15, leadSeconds: 30, sessionTemplate: 'us_stock' },
      { symbol: 'NVDA', timeframeMinutes: 60, leadSeconds: 45, sessionTemplate: 'us_stock' },
    ],
  },
];

function parseJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function resolveSessionTemplate(id: unknown): SessionTemplateId {
  const value = String(id || 'always') as SessionTemplateId;
  return VALID_SESSION_IDS.has(value) ? value : 'always';
}

function buildTask(raw: Partial<ReminderTask>, now: number): ReminderTask | null {
  const timeframeMinutes = Number(raw.timeframeMinutes);
  const leadSeconds = Number(raw.leadSeconds);
  if (!Number.isFinite(timeframeMinutes) || timeframeMinutes <= 0) {
    return null;
  }

  const safeLead = Number.isFinite(leadSeconds) && leadSeconds > 0 ? leadSeconds : 30;
  const fallbackClose = getNextAlignedClose(now, timeframeMinutes);

  return {
    id: raw.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: (raw.symbol || 'BTCUSDT').toUpperCase(),
    timeframeMinutes,
    leadSeconds: safeLead,
    sessionTemplate: resolveSessionTemplate(raw.sessionTemplate),
    createdAt: Number(raw.createdAt) || now,
    nextCloseAt: normalizeNextClose(now, Number(raw.nextCloseAt) || fallbackClose, timeframeMinutes),
    lastAlertCycle: Number(raw.lastAlertCycle) || 0,
  };
}

function loadTasks(now: number): ReminderTask[] {
  const cached = parseJSON<Partial<ReminderTask>[]>(STORAGE_KEYS.tasks, []);
  return cached
    .map((item) => buildTask(item, now))
    .filter((item): item is ReminderTask => Boolean(item));
}

function loadSettings(): AppSettings {
  const cached = parseJSON<Partial<AppSettings>>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...cached,
  };
}

function loadAlwaysOnTop(): boolean {
  return parseJSON<boolean>(STORAGE_KEYS.alwaysOnTop, false);
}

function loadTaskTemplates(): TaskTemplate[] {
  const cached = parseJSON<TaskTemplate[]>(STORAGE_KEYS.templates, []);
  return cached.filter((tpl) => tpl && Array.isArray(tpl.items));
}

function formatTemplateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function TaskCard(props: {
  task: ReminderTask;
  now: number;
  onDelete: (id: string) => void;
}) {
  const { task, now, onDelete } = props;
  const remaining = Math.max(0, task.nextCloseAt - now);
  const sessionOpen = isSessionOpen(task.sessionTemplate, now);
  const urgent = sessionOpen && remaining <= task.leadSeconds * 1000;
  const progress = getProgress(now, task.nextCloseAt, task.timeframeMinutes);

  return (
    <article
      className={[
        'animate-reveal rounded-xl border bg-panel p-4 transition-all duration-200',
        urgent ? 'animate-critical border-danger/70 bg-danger/10' : 'border-slate-200',
      ].join(' ')}
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-lg font-semibold tracking-wide text-text">{task.symbol}</h3>
          <span className="rounded-md border border-slate-200 px-2 py-0.5 text-xs font-semibold text-muted">
            {formatTimeframe(task.timeframeMinutes)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onDelete(task.id)}
          className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-muted transition-colors hover:border-danger/60 hover:text-danger"
          aria-label="删除任务"
          title="删除任务"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v9h-2V9Zm4 0h2v9h-2V9Zm-8 0h2v9H6V9Z"/></svg>
        </button>
      </header>

      <div className="mb-2 flex items-end justify-between gap-3">
        <p className="font-mono text-3xl font-bold tracking-tight text-text">{formatCountdown(remaining)}</p>
        <div className="text-xs text-muted">
          <p className="flex items-center gap-1">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5"><path fill="currentColor" d="M12 8a4 4 0 0 1 4 4v3l1.5 1.5a1 1 0 0 1-.7 1.7H7.2a1 1 0 0 1-.7-1.7L8 15v-3a4 4 0 0 1 4-4Z"/></svg>
            {formatClock(task.nextCloseAt)}
          </p>
          <p className="mt-1 flex items-center gap-1">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5"><path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v1.06a7 7 0 0 1 5 6.94v3l2 2H4l2-2v-3a7 7 0 0 1 5-6.94V3a1 1 0 0 1 1-1Zm0 20a2.5 2.5 0 0 0 2.3-1.5H9.7A2.5 2.5 0 0 0 12 22Z"/></svg>
            {-task.leadSeconds}s
          </p>
        </div>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={['h-full rounded-full transition-all duration-300', urgent ? 'bg-danger' : 'bg-accent'].join(' ')}
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {!sessionOpen ? (
        <p className="mt-2 text-xs font-semibold text-muted">当前时段休市，提醒暂停。</p>
      ) : urgent ? (
        <p className="mt-2 text-xs font-semibold text-danger">预警窗口中 · 剩余 {task.leadSeconds}s</p>
      ) : (
        <p className="mt-2 text-xs text-muted">提前提醒: {task.leadSeconds}s</p>
      )}
    </article>
  );
}

function App() {
  const bootNow = Date.now();
  const [tasks, setTasks] = useState<ReminderTask[]>(() => loadTasks(bootNow));
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [alwaysOnTop, setAlwaysOnTopState] = useState<boolean>(() => loadAlwaysOnTop());
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>(() => loadTaskTemplates());
  const [now, setNow] = useState<number>(bootNow);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string>('');
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [notice, setNotice] = useState('');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const [draft, setDraft] = useState<TaskDraft>({
    symbol: 'BTCUSDT',
    preset: 15,
    customMinutes: '',
    useCustom: false,
    leadSeconds: '',
    sessionTemplate: 'always',
  });

  const themeResolved = useMemo<'light' | 'dark'>(() => {
    if (settings.themeMode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return settings.themeMode;
  }, [settings.themeMode]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.alwaysOnTop, JSON.stringify(alwaysOnTop));
  }, [alwaysOnTop]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.templates, JSON.stringify(taskTemplates));
  }, [taskTemplates]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeResolved;
    document.documentElement.style.setProperty('--accent-rgb', ACCENT_RGB[settings.accent]);
  }, [settings.accent, themeResolved]);

  useEffect(() => {
    if (settings.themeMode !== 'system') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      document.documentElement.dataset.theme = media.matches ? 'dark' : 'light';
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [settings.themeMode]);

  function setNoticeWithTimeout(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 3600);
  }

  function formatTimeframeSpeech(minutes: number): string {
    if (minutes % 1440 === 0) {
      const d = minutes / 1440;
      return d === 1 ? '日线' : `${d}天`;
    }
    if (minutes % 60 === 0) {
      const h = minutes / 60;
      return `${h}小时`;
    }
    return `${minutes}分钟`;
  }

  function formatSymbolSpeech(symbol: string): string {
    const MAP: Record<string, string> = {
      BTC: '比特币',
      ETH: '以太坊',
      BNB: '币安币',
      SOL: '索拉纳',
      USDT: '泰达币',
      USDC: '美元稳定币',
      USD: '美元',
      CNY: '人民币',
      EUR: '欧元',
      JPY: '日元',
      XAU: '黄金',
      GOLD: '黄金',
      XAG: '白银',
      SILVER: '白银',
    };
    const sanitize = (t: string) => t.replace(/[-.\s]+/g, '/').toUpperCase();
    const speakToken = (t: string) => MAP[t] || t;
    const s = sanitize(String(symbol).trim());
    if (/[\u4e00-\u9fa5]/.test(symbol)) {
      return symbol.trim();
    }
    if (s.includes('/')) {
      const parts = s.split('/').filter(Boolean);
      if (parts.length === 2) {
        return `${speakToken(parts[0])} 对 ${speakToken(parts[1])}`;
      }
      return parts.map(speakToken).join(' 对 ');
    }
    const SUF = ['USDT', 'USDC', 'USD', 'CNY', 'EUR', 'JPY', 'BTC', 'ETH', 'BNB', 'XAU', 'XAG'];
    for (const suf of SUF) {
      if (s.endsWith(suf) && s.length > suf.length) {
        const base = s.slice(0, s.length - suf.length);
        return `${speakToken(base)} 对 ${speakToken(suf)}`;
      }
    }
    return speakToken(s);
  }

  const checkForUpdate = useCallback(
    async (manual = false) => {
      setCheckingUpdate(true);
      try {
        const info = (await CheckForUpdates()) as UpdateInfo;
        setUpdateInfo(info);
        if (manual) {
          if (info.hasUpdate) {
            setNoticeWithTimeout(`发现新版本 ${info.latestVersion}，可立即下载更新。`);
          } else {
            setNoticeWithTimeout(`当前已是最新版本（${info.currentVersion}）。`);
          }
        } else if (info.hasUpdate) {
          setNoticeWithTimeout(`检测到新版本 ${info.latestVersion}。`);
        }
      } catch (error) {
        if (manual) {
          setNoticeWithTimeout('检查更新失败，请稍后再试。');
        }
        console.error(error);
      } finally {
        setCheckingUpdate(false);
      }
    },
    [],
  );

  async function openUpdatePage() {
    if (!updateInfo?.releaseURL) {
      setNoticeWithTimeout('没有可用的更新下载地址。');
      return;
    }
    try {
      await OpenURL(updateInfo.releaseURL);
    } catch {
      setNoticeWithTimeout('打开下载地址失败，请手动访问 GitHub Releases。');
    }
  }

  useEffect(() => {
    void checkForUpdate(false);
  }, [checkForUpdate]);

  useEffect(() => {
    const hiddenHandler = () => {
      setNotice('窗口已隐藏到后台。可用菜单“控制 > 显示主窗口”恢复。');
      window.setTimeout(() => setNotice(''), 5000);
    };

    EventsOn('app:hidden-to-background', hiddenHandler);

    return () => {
      EventsOff('app:hidden-to-background');
    };
  }, []);

  const pushExternal = useCallback(
    async (provider: 'webhook' | 'telegram' | 'feishu' | 'wecom', title: string, message: string): Promise<void> => {
      if (provider === 'webhook') {
        if (!settings.enableWebhook || !settings.webhookURL.trim()) {
          return;
        }
        await PushExternalNotification('webhook', settings.webhookURL.trim(), '', '', title, message);
        return;
      }

      if (provider === 'telegram') {
        if (!settings.enableTelegram || !settings.telegramBotToken.trim() || !settings.telegramChatID.trim()) {
          return;
        }
        await PushExternalNotification(
          'telegram',
          '',
          settings.telegramBotToken.trim(),
          settings.telegramChatID.trim(),
          title,
          message,
        );
        return;
      }

      if (provider === 'feishu') {
        if (!settings.enableFeishu || !settings.feishuWebhookURL.trim()) {
          return;
        }
        await PushExternalNotification('feishu', settings.feishuWebhookURL.trim(), '', '', title, message);
        return;
      }

      if (!settings.enableWeCom || !settings.weComWebhookURL.trim()) {
        return;
      }
      await PushExternalNotification('wecom', settings.weComWebhookURL.trim(), '', '', title, message);
    },
    [
      settings.enableTelegram,
      settings.enableFeishu,
      settings.enableWeCom,
      settings.enableWebhook,
      settings.feishuWebhookURL,
      settings.telegramBotToken,
      settings.telegramChatID,
      settings.weComWebhookURL,
      settings.webhookURL,
    ],
  );

  const triggerAlert = useCallback(
    async (task: ReminderTask) => {
      const tfText = formatTimeframe(task.timeframeMinutes);
      const tfSpeech = formatTimeframeSpeech(task.timeframeMinutes);
      const sessionText = formatSessionTemplate(task.sessionTemplate);
      const detail = `${task.symbol} ${tfText}（${sessionText}）将在 ${task.leadSeconds} 秒后收盘`;
      const anySoundEnabled =
        settings.enableDefaultBeep || Boolean(settings.customSoundDataUrl) || settings.enableTTS;
      let playedInFrontend = false;

      if (!anySoundEnabled) {
        setNoticeWithTimeout('提醒已触发，但声音提醒已关闭。请在设置中开启默认蜂鸣或上传自定义声音。');
      }

      if (settings.enableDefaultBeep) {
        const played = await playDefaultBeep();
        playedInFrontend = playedInFrontend || played;
        try {
          // Native beep is more reliable than WebAudio under background/minimized state.
          await PlayAlertSound();
        } catch {
          // Keep silent here, other channels continue.
        }
      }
      if (settings.customSoundDataUrl) {
        const played = await playCustomSound(settings.customSoundDataUrl);
        playedInFrontend = playedInFrontend || played;
      }
      if (settings.customSoundDataUrl && (document.hidden || !playedInFrontend)) {
        try {
          await PlayAlertSound();
        } catch {
          // Keep silent here, other channels continue.
        }
      }
      if (settings.enableTTS) {
        speakAlert(`注意，${formatSymbolSpeech(task.symbol)} ${tfSpeech} 即将收盘`);
      }

      if (settings.enableSystemNotification) {
        try {
          await NotifySystem('K线临近收盘', `${task.symbol} ${tfText}`, detail);
        } catch {
          await notifyBrowser('K线临近收盘', detail);
        }
      }

      try {
        await Promise.all([
          pushExternal('webhook', 'K线临近收盘', detail),
          pushExternal('telegram', 'K线临近收盘', detail),
          pushExternal('feishu', 'K线临近收盘', detail),
          pushExternal('wecom', 'K线临近收盘', detail),
        ]);
      } catch {
        setNoticeWithTimeout('外部推送失败，请检查 Webhook / Telegram / Feishu / 企业微信配置。');
      }
    },
    [
      pushExternal,
      settings.customSoundDataUrl,
      settings.enableDefaultBeep,
      settings.enableSystemNotification,
      settings.enableTTS,
    ],
  );

  useEffect(() => {
    if (tasks.length === 0) {
      return;
    }

    const dueAlerts: ReminderTask[] = [];
    let changed = false;
    const updated = tasks.map((task) => {
      const cycleCloseAt = task.nextCloseAt;
      const nextCloseAt = normalizeNextClose(now, cycleCloseAt, task.timeframeMinutes);
      const cycleMs = Math.max(1, task.timeframeMinutes) * 60 * 1000;
      let lastAlertCycle = task.lastAlertCycle;
      const leadAt = cycleCloseAt - task.leadSeconds * 1000;
      const latestAllowedAlertAt = cycleCloseAt + cycleMs - 1000;
      const sessionCheckAt = now < cycleCloseAt ? now : cycleCloseAt - 1;
      const sessionOpen = isSessionOpen(task.sessionTemplate, sessionCheckAt);

      if (
        sessionOpen &&
        now >= leadAt &&
        now <= latestAllowedAlertAt &&
        lastAlertCycle !== cycleCloseAt
      ) {
        dueAlerts.push({ ...task, nextCloseAt: cycleCloseAt });
        lastAlertCycle = cycleCloseAt;
      }

      if (nextCloseAt !== task.nextCloseAt || lastAlertCycle !== task.lastAlertCycle) {
        changed = true;
        return { ...task, nextCloseAt, lastAlertCycle };
      }

      return task;
    });

    if (changed) {
      setTasks(updated);
    }

    if (dueAlerts.length > 0) {
      dueAlerts.forEach((task) => {
        void triggerAlert(task);
      });
    }
  }, [now, tasks, triggerAlert]);

  function createTask() {
    const timeframe = draft.useCustom ? Number.parseInt(draft.customMinutes, 10) : draft.preset;
    const leadSeconds = Number.parseInt(draft.leadSeconds, 10) || settings.globalLeadSeconds;

    if (!Number.isFinite(timeframe) || timeframe <= 0) {
      setNoticeWithTimeout('周期必须是正整数（分钟）。');
      return;
    }

    if (!Number.isFinite(leadSeconds) || leadSeconds <= 0) {
      setNoticeWithTimeout('提前提醒秒数必须大于 0。');
      return;
    }

    const task: ReminderTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: (draft.symbol || 'BTCUSDT').toUpperCase(),
      timeframeMinutes: timeframe,
      leadSeconds,
      sessionTemplate: draft.sessionTemplate,
      createdAt: Date.now(),
      nextCloseAt: getNextAlignedClose(Date.now(), timeframe),
      lastAlertCycle: 0,
    };

    setTasks((prev) => [task, ...prev]);
    setShowAddModal(false);
    setDraft({
      symbol: draft.symbol,
      preset: 15,
      customMinutes: '',
      useCustom: false,
      leadSeconds: '',
      sessionTemplate: draft.sessionTemplate,
    });
  }

  function deleteTask(id: string) {
    setTasks((prev) => prev.filter((item) => item.id !== id));
    setPendingDeleteId('');
  }

  async function applyAlwaysOnTop() {
    const next = !alwaysOnTop;
    setAlwaysOnTopState(next);
    try {
      await SetAlwaysOnTop(next);
    } catch {
      setAlwaysOnTopState(!next);
      setNoticeWithTimeout('置顶切换失败，请重试。');
    }
  }

  function patchSettings(patch: Partial<AppSettings>) {
    setSettings((prev) => ({ ...prev, ...patch }));
  }

  function uploadCustomSound(file: File | null) {
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      patchSettings({
        customSoundDataUrl: String(reader.result || ''),
        customSoundName: file.name,
      });
      setNoticeWithTimeout(`已加载提示音：${file.name}`);
    };
    reader.readAsDataURL(file);
  }

  function saveAsTemplate() {
    const name = templateName.trim();
    if (!name) {
      setNoticeWithTimeout('请输入模板名称。');
      return;
    }
    if (tasks.length === 0) {
      setNoticeWithTimeout('当前没有任务，无法保存模板。');
      return;
    }

    const nextTemplate: TaskTemplate = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: Date.now(),
      items: tasks.map((task) => ({
        symbol: task.symbol,
        timeframeMinutes: task.timeframeMinutes,
        leadSeconds: task.leadSeconds,
        sessionTemplate: task.sessionTemplate,
      })),
    };

    setTaskTemplates((prev) => [nextTemplate, ...prev]);
    setTemplateName('');
    setNoticeWithTimeout(`模板“${name}”已保存。`);
  }

  function buildTasksFromTemplateItems(items: TaskTemplate['items']): ReminderTask[] {
    const createdAt = Date.now();
    return items.map((item, index): ReminderTask => {
      const nowTs = Date.now() + index;
      return {
        id: `${createdAt}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: item.symbol.toUpperCase(),
        timeframeMinutes: item.timeframeMinutes,
        leadSeconds: item.leadSeconds,
        sessionTemplate: resolveSessionTemplate(item.sessionTemplate),
        createdAt,
        nextCloseAt: getNextAlignedClose(nowTs, item.timeframeMinutes),
        lastAlertCycle: 0,
      };
    });
  }

  function applyTemplate(template: TaskTemplate) {
    const generated = buildTasksFromTemplateItems(template.items);

    setTasks((prev) => [...generated, ...prev]);
    setShowTemplateModal(false);
    setNoticeWithTimeout(`已应用模板“${template.name}”（新增 ${generated.length} 个任务）。`);
  }

  function applySceneTemplate(sceneId: string) {
    const scene = SCENE_TEMPLATES.find((item) => item.id === sceneId);
    if (!scene) {
      return;
    }

    const generated = buildTasksFromTemplateItems(scene.items);
    setTasks((prev) => [...generated, ...prev]);
    setShowTemplateModal(false);
    setNoticeWithTimeout(`已应用场景模板“${scene.name}”（新增 ${generated.length} 个任务）。`);
  }

  function removeTemplate(id: string) {
    setTaskTemplates((prev) => prev.filter((tpl) => tpl.id !== id));
  }

  async function testExternalPush() {
    try {
      await Promise.all([
        pushExternal('webhook', 'K线测试通知', '这是 Webhook 测试消息。'),
        pushExternal('telegram', 'K线测试通知', '这是 Telegram 测试消息。'),
        pushExternal('feishu', 'K线测试通知', '这是 Feishu 测试消息。'),
        pushExternal('wecom', 'K线测试通知', '这是企业微信机器人测试消息。'),
      ]);
      setNoticeWithTimeout('外部通道测试已发送。');
    } catch {
      setNoticeWithTimeout('测试发送失败，请检查外部通道配置。');
    }
  }

  return (
    <div className="min-h-screen px-3 py-3 text-text">
      <div className="mx-auto flex max-w-[560px] flex-col gap-3">
        <div className="rounded-xl border border-slate-200 bg-panel p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold text-text">K 线收盘提醒</h1>
              <p className="text-[11px] text-muted">时钟对齐 · 后台运行</p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  void applyAlwaysOnTop();
                }}
                className={[
                  'relative h-9 w-14 rounded-full border transition-colors',
                  alwaysOnTop ? 'border-accent/60 bg-accent/15' : 'border-slate-300 bg-white',
                ].join(' ')}
                aria-label="置顶开关"
                title="置顶开关"
              >
                <span
                  className={[
                    'absolute left-1 top-1 h-7 w-7 rounded-full bg-white shadow transition-transform',
                    alwaysOnTop ? 'translate-x-6' : 'translate-x-0',
                  ].join(' ')}
                />
              </button>
              <button
                type="button"
                onClick={() => setShowSettingsModal(true)}
                className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-muted transition-colors hover:text-text"
                aria-label="设置"
                title="设置"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5"><path fill="currentColor" d="M12 8a4 4 0 1 0 .001 8.001A4 4 0 0 0 12 8Zm8.94 4a7.8 7.8 0 0 0-.2-1.7l2.1-1.6-2-3.4-2.6 1a7.9 7.9 0 0 0-1.5-1l-.4-2.7h-3.9l-.4 2.7a7.9 7.9 0 0 0-1.5 1l-2.6-1-2 3.4 2.1 1.6a7.8 7.8 0 0 0-.2 1.7c0 .6.1 1.1.2 1.7l-2.1 1.6 2 3.4 2.6-1c.5-.4 1-.7 1.5-1l.4 2.7h3.9l.4-2.7c.5-.3 1-.6 1.5-1l2.6 1 2-3.4-2.1-1.6c.1-.6.2-1.1.2-1.7Z"/></svg>
              </button>
              <button
                type="button"
                onClick={() => setShowTemplateModal(true)}
                className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-muted transition-colors hover:text-text"
                aria-label="模板"
                title="模板"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5"><path fill="currentColor" d="M4 5a2 2 0 0 1 2-2h7l7 7v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm9 0v5h5"/></svg>
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-white transition-colors hover:bg-accent/90"
                aria-label="添加"
                title="添加"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5"><path fill="currentColor" d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2h6Z"/></svg>
              </button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-muted">当前时间</p>
              <p className="mt-1 font-mono text-sm font-semibold text-text">{formatClock(now)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
              <p className="text-muted">运行任务</p>
              <p className="mt-1 text-sm font-semibold text-text">{tasks.length} 个</p>
            </div>
          </div>
        </div>

        {notice ? (
          <div className="animate-reveal rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-text">
            {notice}
          </div>
        ) : null}

        {updateInfo?.hasUpdate ? (
          <div className="animate-reveal rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
            <div className="flex items-center justify-between gap-2">
              <span>
                有新版本：{updateInfo.latestVersion}（当前 {updateInfo.currentVersion}）
              </span>
              <button
                type="button"
                onClick={() => {
                  void openUpdatePage();
                }}
                className="rounded-md border border-danger/40 bg-white px-2 py-1 text-[11px] font-semibold text-danger"
              >
                下载更新
              </button>
            </div>
          </div>
        ) : null}

        <section className="space-y-3">
          {tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-panel p-8 text-center">
              <h2 className="text-base font-semibold text-text">暂无活跃提醒</h2>
              <p className="mt-2 text-xs text-muted">点击右上角 + 添加一个</p>
            </div>
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                now={now}
                onDelete={(id) => {
                  setPendingDeleteId(id);
                }}
              />
            ))
          )}
        </section>
      </div>

      {showAddModal ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/20 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-panel p-5">
            <h3 className="text-xl font-semibold text-text">添加提醒</h3>
            <p className="mt-1 text-sm text-muted">系统会自动对齐到下一个标准收盘点，而不是“当前时间 + 周期”。</p>

            <div className="mt-4 grid gap-4">
              <label className="grid gap-2 text-sm">
                <span className="text-muted">标签 / 名称</span>
                <input
                  value={draft.symbol}
                  onChange={(e) => setDraft((prev) => ({ ...prev, symbol: e.target.value }))}
                  placeholder="例如 BTC/USDT"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-text outline-none transition-colors focus:border-accent/60"
                />
              </label>

              <div className="grid gap-2 text-sm">
                <span className="text-muted">K线周期</span>
                <div className="flex flex-wrap gap-2">
                  {PRESET_MINUTES.map((minute) => (
                    <button
                      key={minute}
                      type="button"
                      onClick={() => setDraft((prev) => ({ ...prev, preset: minute, useCustom: false }))}
                      className={[
                        'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all',
                        !draft.useCustom && draft.preset === minute
                          ? 'border-accent/60 bg-accent/20 text-accent'
                          : 'border-slate-200 text-muted hover:border-slate-300 hover:text-text',
                      ].join(' ')}
                    >
                      {minute === 1440 ? '日线' : minute % 60 === 0 ? `${minute / 60}小时` : `${minute}分钟`}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, useCustom: true }))}
                    className={[
                      'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all',
                      draft.useCustom
                        ? 'border-accent/60 bg-accent/20 text-accent'
                        : 'border-slate-200 text-muted hover:border-slate-300 hover:text-text',
                    ].join(' ')}
                  >
                    自定义
                  </button>
                </div>
                {draft.useCustom ? (
                  <input
                    type="number"
                    min={1}
                    value={draft.customMinutes}
                    onChange={(e) => setDraft((prev) => ({ ...prev, customMinutes: e.target.value }))}
                    placeholder="输入周期（分）..."
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-text outline-none transition-colors focus:border-accent/60"
                  />
                ) : null}
              </div>

              <div className="grid gap-2 text-sm">
                <span className="text-muted">交易时段模板</span>
                <div className="flex flex-wrap gap-2">
                  {SESSION_TEMPLATES.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => setDraft((prev) => ({ ...prev, sessionTemplate: session.id }))}
                      className={[
                        'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all',
                        draft.sessionTemplate === session.id
                          ? 'border-accent/60 bg-accent/20 text-accent'
                          : 'border-slate-200 text-muted hover:border-slate-300 hover:text-text',
                      ].join(' ')}
                    >
                      {session.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted">{getSessionTemplate(draft.sessionTemplate).description}</p>
              </div>

              <label className="grid gap-2 text-sm">
                <span className="text-muted">提前提醒（秒）</span>
                <input
                  type="number"
                  min={1}
                  value={draft.leadSeconds}
                  onChange={(e) => setDraft((prev) => ({ ...prev, leadSeconds: e.target.value }))}
                  placeholder={`${settings.globalLeadSeconds}`}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-text outline-none transition-colors focus:border-accent/60"
                />
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-muted transition-colors hover:border-slate-300 hover:text-text"
              >
                取消
              </button>
              <button
                type="button"
                onClick={createTask}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"
              >
                添加任务
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showTemplateModal ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/20 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-panel p-5">
            <h3 className="text-xl font-semibold text-text">任务模板</h3>
            <p className="mt-1 text-sm text-muted">可将当前任务组保存为模板，并一键重复加载。</p>

            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-sm font-semibold text-text">场景模板（快速开始）</p>
              <div className="mt-2 space-y-2">
                {SCENE_TEMPLATES.map((scene) => (
                  <div key={scene.id} className="rounded-lg border border-slate-200 bg-panel p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-text">{scene.name}</p>
                        <p className="mt-1 text-xs text-muted">
                          {scene.description} · {scene.items.length} 个任务
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => applySceneTemplate(scene.id)}
                        className="rounded-lg border border-accent/35 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent"
                      >
                        一键应用
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-sm text-text">保存当前任务为模板</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="例如：币圈日内组合"
                  className="min-w-[240px] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-text outline-none focus:border-accent/60"
                />
                <button
                  type="button"
                  onClick={saveAsTemplate}
                  className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white"
                >
                  保存模板
                </button>
              </div>
            </div>

            <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
              {taskTemplates.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-muted">
                  还没有模板，先创建一组任务后再保存。
                </div>
              ) : (
                taskTemplates.map((tpl) => (
                  <div key={tpl.id} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-text">{tpl.name}</p>
                        <p className="mt-1 text-xs text-muted">
                          {tpl.items.length} 个任务 · 保存于 {formatTemplateTime(tpl.createdAt)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => applyTemplate(tpl)}
                          className="rounded-lg border border-accent/35 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent"
                        >
                          应用
                        </button>
                        <button
                          type="button"
                          onClick={() => removeTemplate(tpl.id)}
                          className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowTemplateModal(false)}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showSettingsModal ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/20 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-panel p-5">
            <h3 className="text-xl font-semibold text-text">提醒设置</h3>

            <div className="mt-4 max-h-[72vh] space-y-4 overflow-y-auto pr-1 scrollbar-thin">
              <div className="grid gap-5 md:grid-cols-2">
                <div className="grid gap-3">
                  <p className="text-sm text-muted">主题模式</p>
                  <div className="flex flex-wrap gap-2">
                    {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => patchSettings({ themeMode: mode })}
                        className={[
                          'rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all',
                          settings.themeMode === mode
                            ? 'border-accent/60 bg-accent/20 text-accent'
                            : 'border-slate-200 text-muted hover:border-slate-300 hover:text-text',
                        ].join(' ')}
                      >
                        {mode === 'dark' ? '暗色' : mode === 'light' ? '亮色' : '跟随系统'}
                      </button>
                    ))}
                  </div>

                  <p className="text-sm text-muted">主题色</p>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(ACCENT_RGB) as AccentColor[]).map((accent) => (
                      <button
                        key={accent}
                        type="button"
                        onClick={() => patchSettings({ accent })}
                        className={[
                          'h-8 w-8 rounded-full border-2 transition-transform hover:scale-105',
                          settings.accent === accent ? 'border-slate-900/70' : 'border-slate-300',
                        ].join(' ')}
                        style={{ backgroundColor: `rgb(${ACCENT_RGB[accent]})` }}
                        aria-label={`accent-${accent}`}
                      />
                    ))}
                  </div>

                  <label className="grid gap-2 text-sm">
                    <span className="text-muted">全局提前提醒秒数</span>
                    <input
                      type="number"
                      min={1}
                      value={settings.globalLeadSeconds}
                      onChange={(e) => patchSettings({ globalLeadSeconds: Math.max(1, Number(e.target.value) || 1) })}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-text outline-none transition-colors focus:border-accent/60"
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <span className="text-sm text-text">窗口置顶</span>
                    <input
                      type="checkbox"
                      checked={alwaysOnTop}
                      onChange={() => {
                        void applyAlwaysOnTop();
                      }}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>
                </div>

                <div className="grid gap-3">
                  <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <span className="text-sm text-text">默认蜂鸣</span>
                    <input
                      type="checkbox"
                      checked={settings.enableDefaultBeep}
                      onChange={(e) => patchSettings({ enableDefaultBeep: e.target.checked })}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>

                  <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <span className="text-sm text-text">语音播报 (TTS)</span>
                    <input
                      type="checkbox"
                      checked={settings.enableTTS}
                      onChange={(e) => patchSettings({ enableTTS: e.target.checked })}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>

                  <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <span className="text-sm text-text">系统通知</span>
                    <input
                      type="checkbox"
                      checked={settings.enableSystemNotification}
                      onChange={(e) => patchSettings({ enableSystemNotification: e.target.checked })}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>

                  <div className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-sm text-text">自定义提示音</p>
                    <p className="mt-1 text-xs text-muted">
                      支持 MP3/WAV。当前：{settings.customSoundName || '未设置'}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <label className="cursor-pointer rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-muted transition-colors hover:border-slate-300 hover:text-text">
                        上传音频
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          onChange={(e) => uploadCustomSound(e.target.files?.[0] || null)}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          void (async () => {
                            if (!settings.enableDefaultBeep && !settings.customSoundDataUrl) {
                              setNoticeWithTimeout('请先开启默认蜂鸣，或上传自定义声音。');
                              return;
                            }

                            let ok = false;

                            if (settings.enableDefaultBeep) {
                              const played = await playDefaultBeep();
                              ok = ok || played;
                              try {
                                await PlayAlertSound();
                                ok = true;
                              } catch {
                                // ignore
                              }
                            }

                            if (settings.customSoundDataUrl) {
                              const played = await playCustomSound(settings.customSoundDataUrl);
                              ok = ok || played;
                              if (!played) {
                                try {
                                  await PlayAlertSound();
                                  ok = true;
                                } catch {
                                  // ignore
                                }
                              }
                            }

                            if (!ok) {
                              setNoticeWithTimeout('声音测试失败，请检查系统输出设备与音量。');
                            }
                          })();
                        }}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-muted transition-colors hover:border-slate-300 hover:text-text"
                      >
                        测试蜂鸣
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!settings.customSoundDataUrl) {
                            setNoticeWithTimeout('请先上传自定义声音。');
                            return;
                          }
                          void playCustomSound(settings.customSoundDataUrl);
                        }}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-muted transition-colors hover:border-slate-300 hover:text-text"
                      >
                        试听
                      </button>
                      <button
                        type="button"
                        onClick={() => patchSettings({ customSoundDataUrl: '', customSoundName: '' })}
                        className="rounded-lg border border-danger/30 px-3 py-1.5 text-xs text-danger transition-colors hover:border-danger/50"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text">版本更新</p>
                    <p className="mt-1 text-xs text-muted">
                      当前版本：{updateInfo?.currentVersion || 'dev'}{' '}
                      {updateInfo?.hasUpdate ? `· 最新：${updateInfo.latestVersion}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void checkForUpdate(true);
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-muted transition-colors hover:border-slate-300 hover:text-text"
                    >
                      {checkingUpdate ? '检查中...' : '检查更新'}
                    </button>
                    {updateInfo?.hasUpdate ? (
                      <button
                        type="button"
                        onClick={() => {
                          void openUpdatePage();
                        }}
                        className="rounded-lg border border-accent/35 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent"
                      >
                        下载更新
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text">外部通知通道</p>
                    <p className="mt-1 text-xs text-muted">支持 Webhook / Telegram / Feishu / 企业微信机器人。</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void testExternalPush();
                    }}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-muted transition-colors hover:border-slate-300 hover:text-text"
                  >
                    测试发送
                  </button>
                </div>

                <div className="mt-3 grid gap-3">
                  <label className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <span className="text-sm text-text">Webhook</span>
                    <input
                      type="checkbox"
                      checked={settings.enableWebhook}
                      onChange={(e) => patchSettings({ enableWebhook: e.target.checked })}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>
                  <input
                    value={settings.webhookURL}
                    onChange={(e) => patchSettings({ webhookURL: e.target.value })}
                    placeholder="https://example.com/webhook"
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-text outline-none focus:border-accent/60"
                  />

                  <label className="mt-1 flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <span className="text-sm text-text">Telegram</span>
                    <input
                      type="checkbox"
                      checked={settings.enableTelegram}
                      onChange={(e) => patchSettings({ enableTelegram: e.target.checked })}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>
                  <div className="grid gap-2 md:grid-cols-2">
                    <input
                      value={settings.telegramBotToken}
                      onChange={(e) => patchSettings({ telegramBotToken: e.target.value })}
                      placeholder="Bot Token"
                      className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-text outline-none focus:border-accent/60"
                    />
                    <input
                      value={settings.telegramChatID}
                      onChange={(e) => patchSettings({ telegramChatID: e.target.value })}
                      placeholder="Chat ID"
                      className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-text outline-none focus:border-accent/60"
                    />
                  </div>

                  <label className="mt-1 flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <span className="text-sm text-text">Feishu 机器人</span>
                    <input
                      type="checkbox"
                      checked={settings.enableFeishu}
                      onChange={(e) => patchSettings({ enableFeishu: e.target.checked })}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>
                  <input
                    value={settings.feishuWebhookURL}
                    onChange={(e) => patchSettings({ feishuWebhookURL: e.target.value })}
                    placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-text outline-none focus:border-accent/60"
                  />

                  <label className="mt-1 flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                    <span className="text-sm text-text">企业微信机器人</span>
                    <input
                      type="checkbox"
                      checked={settings.enableWeCom}
                      onChange={(e) => patchSettings({ enableWeCom: e.target.checked })}
                      className="h-4 w-4 accent-[rgb(var(--accent-rgb))]"
                    />
                  </label>
                  <input
                    value={settings.weComWebhookURL}
                    onChange={(e) => patchSettings({ weComWebhookURL: e.target.value })}
                    placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-text outline-none focus:border-accent/60"
                  />
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDeleteId ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/20 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-panel p-5">
            <h3 className="text-lg font-semibold text-text">确认删除任务？</h3>
            <p className="mt-2 text-sm text-muted">删除后无法恢复，且将停止该任务的后续提醒。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDeleteId('')}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-muted transition-colors hover:border-slate-300 hover:text-text"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => deleteTask(pendingDeleteId)}
                className="rounded-xl bg-danger px-4 py-2 text-sm font-semibold text-white"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmQuit ? (
        <div className="fixed inset-0 z-40 grid place-items-center bg-slate-900/20 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-panel p-5">
            <h3 className="text-lg font-semibold text-text">退出应用？</h3>
            <p className="mt-2 text-sm text-muted">退出后所有倒计时提醒都会停止。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmQuit(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-muted transition-colors hover:border-slate-300 hover:text-text"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  void RequestQuit();
                }}
                className="rounded-xl bg-danger px-4 py-2 text-sm font-semibold text-white"
              >
                立即退出
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
