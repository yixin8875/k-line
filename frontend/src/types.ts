export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentColor = 'blue' | 'green' | 'orange' | 'red' | 'violet';
export type ViewMode = 'reminders' | 'journal';
export type SessionTemplateId = 'always' | 'cn_stock' | 'us_stock' | 'hk_stock';

export interface ReminderTask {
  id: string;
  symbol: string;
  timeframeMinutes: number;
  leadSeconds: number;
  sessionTemplate: SessionTemplateId;
  createdAt: number;
  nextCloseAt: number;
  lastAlertCycle: number;
}

export interface AppSettings {
  themeMode: ThemeMode;
  accent: AccentColor;
  globalLeadSeconds: number;
  enableTTS: boolean;
  enableDefaultBeep: boolean;
  enableSystemNotification: boolean;
  customSoundDataUrl: string;
  customSoundName: string;
  enableWebhook: boolean;
  webhookURL: string;
  enableTelegram: boolean;
  telegramBotToken: string;
  telegramChatID: string;
  enableWeCom: boolean;
  weComWebhookURL: string;
}

export interface AlertLog {
  id: string;
  timestamp: number;
  symbol: string;
  timeframeMinutes: number;
  leadSeconds: number;
  message: string;
}

export interface TaskTemplateItem {
  symbol: string;
  timeframeMinutes: number;
  leadSeconds: number;
  sessionTemplate: SessionTemplateId;
}

export interface TaskTemplate {
  id: string;
  name: string;
  createdAt: number;
  items: TaskTemplateItem[];
}
