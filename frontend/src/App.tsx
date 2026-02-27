import { useCallback, useEffect, useMemo, useState } from 'react';
import { EventsOff, EventsOn } from '../wailsjs/runtime/runtime';
import {
  NotifySystem,
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

const PRESET_MINUTES = [15, 60, 240, 1440];

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

const VALID_SESSION_IDS = new Set<SessionTemplateId>(SESSION_TEMPLATES.map((item) => item.id));

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
          <span className="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-muted">
            {formatSessionTemplate(task.sessionTemplate)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onDelete(task.id)}
          className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-muted transition-colors hover:border-danger/60 hover:text-danger"
          aria-label="删除任务"
          title="删除任务"
        >
          删除
        </button>
      </header>

      <div className="mb-2 flex items-end justify-between gap-3">
        <p className="font-mono text-3xl font-bold tracking-tight text-text">{formatCountdown(remaining)}</p>
        <p className="text-xs text-muted">收盘 {formatClock(task.nextCloseAt)}</p>
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
        <p className="mt-2 text-xs font-semibold text-danger">预警已触发 · 剩余 {task.leadSeconds}s 窗口</p>
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
    async (provider: 'webhook' | 'telegram' | 'wecom', title: string, message: string): Promise<void> => {
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

      if (!settings.enableWeCom || !settings.weComWebhookURL.trim()) {
        return;
      }
      await PushExternalNotification('wecom', settings.weComWebhookURL.trim(), '', '', title, message);
    },
    [
      settings.enableTelegram,
      settings.enableWeCom,
      settings.enableWebhook,
      settings.telegramBotToken,
      settings.telegramChatID,
      settings.weComWebhookURL,
      settings.webhookURL,
    ],
  );

  const triggerAlert = useCallback(
    async (task: ReminderTask) => {
      const tfText = formatTimeframe(task.timeframeMinutes);
      const sessionText = formatSessionTemplate(task.sessionTemplate);
      const detail = `${task.symbol} ${tfText}（${sessionText}）将在 ${task.leadSeconds} 秒后收盘`;

      if (settings.enableDefaultBeep) {
        playDefaultBeep();
      }
      if (settings.customSoundDataUrl) {
        playCustomSound(settings.customSoundDataUrl);
      }
      if (settings.enableTTS) {
        speakAlert(`注意，${task.symbol} ${tfText} 即将收盘`);
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
          pushExternal('wecom', 'K线临近收盘', detail),
        ]);
      } catch {
        setNoticeWithTimeout('外部推送失败，请检查 Webhook / Telegram / 企业微信配置。');
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
    const dueAlerts: ReminderTask[] = [];

    setTasks((prev) => {
      let changed = false;
      const updated = prev.map((task) => {
        const nextCloseAt = normalizeNextClose(now, task.nextCloseAt, task.timeframeMinutes);
        let lastAlertCycle = task.lastAlertCycle;
        const leadAt = nextCloseAt - task.leadSeconds * 1000;
        const sessionOpen = isSessionOpen(task.sessionTemplate, now);

        if (sessionOpen && now >= leadAt && now < nextCloseAt && lastAlertCycle !== nextCloseAt) {
          dueAlerts.push({ ...task, nextCloseAt });
          lastAlertCycle = nextCloseAt;
        }

        if (nextCloseAt !== task.nextCloseAt || lastAlertCycle !== task.lastAlertCycle) {
          changed = true;
          return { ...task, nextCloseAt, lastAlertCycle };
        }

        return task;
      });

      return changed ? updated : prev;
    });

    if (dueAlerts.length > 0) {
      dueAlerts.forEach((task) => {
        void triggerAlert(task);
      });
    }
  }, [now, triggerAlert]);

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

  function applyTemplate(template: TaskTemplate) {
    const createdAt = Date.now();
    const generated = template.items.map((item, index): ReminderTask => {
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

    setTasks((prev) => [...generated, ...prev]);
    setShowTemplateModal(false);
    setNoticeWithTimeout(`已应用模板“${template.name}”（新增 ${generated.length} 个任务）。`);
  }

  function removeTemplate(id: string) {
    setTaskTemplates((prev) => prev.filter((tpl) => tpl.id !== id));
  }

  async function testExternalPush() {
    try {
      await Promise.all([
        pushExternal('webhook', 'K线测试通知', '这是 Webhook 测试消息。'),
        pushExternal('telegram', 'K线测试通知', '这是 Telegram 测试消息。'),
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
        <header className="rounded-xl border border-slate-200 bg-panel p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-text">K 线收盘提醒</h1>
              <p className="mt-1 text-xs text-muted">时钟对齐 · 后台运行 · 多周期并行</p>
            </div>
            <button
              type="button"
              onClick={() => {
                void applyAlwaysOnTop();
              }}
              className={[
                'rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors',
                alwaysOnTop ? 'border-accent/50 bg-accent/15 text-accent' : 'border-slate-200 text-muted',
              ].join(' ')}
            >
              {alwaysOnTop ? '已置顶' : '置顶'}
            </button>
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
        </header>

        <section className="rounded-xl border border-slate-200 bg-panel p-2">
          <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
            <button type="button" onClick={() => setShowAddModal(true)} className="rounded-lg bg-accent px-3 py-2 text-white">
              新建提醒
            </button>
            <button
              type="button"
              onClick={() => setShowTemplateModal(true)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-muted"
            >
              模板
            </button>
            <button
              type="button"
              onClick={() => setShowSettingsModal(true)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-muted"
            >
              设置
            </button>
            <button
              type="button"
              onClick={() => setConfirmQuit(true)}
              className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-danger"
            >
              退出
            </button>
          </div>
        </section>

        {notice ? (
          <div className="animate-reveal rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-text">
            {notice}
          </div>
        ) : null}

        <section className="space-y-3">
          {tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-panel p-8 text-center">
              <h2 className="text-base font-semibold text-text">暂无提醒任务</h2>
              <p className="mt-2 text-xs text-muted">点击上方“新建提醒”，添加 15m / 1h / 4h / 日线提醒。</p>
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
            <h3 className="text-xl font-semibold text-text">新建 K 线提醒</h3>
            <p className="mt-1 text-sm text-muted">系统会自动对齐到下一个标准收盘点，而不是“当前时间 + 周期”。</p>

            <div className="mt-4 grid gap-4">
              <label className="grid gap-2 text-sm">
                <span className="text-muted">交易对 / 标的</span>
                <input
                  value={draft.symbol}
                  onChange={(e) => setDraft((prev) => ({ ...prev, symbol: e.target.value }))}
                  placeholder="例如 BTCUSDT"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-text outline-none transition-colors focus:border-accent/60"
                />
              </label>

              <div className="grid gap-2 text-sm">
                <span className="text-muted">K 线周期（分钟）</span>
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
                      {formatTimeframe(minute)}
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
                    placeholder="输入分钟数，例如 45"
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
                <span className="text-muted">提前提醒秒数（留空使用全局默认）</span>
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
                创建任务
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
                          if (settings.customSoundDataUrl) {
                            playCustomSound(settings.customSoundDataUrl);
                          }
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
                    <p className="text-sm font-semibold text-text">外部通知通道</p>
                    <p className="mt-1 text-xs text-muted">支持 Webhook / Telegram / 企业微信机器人。</p>
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
