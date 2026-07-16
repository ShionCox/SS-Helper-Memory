import type {
  SettingsAdapter,
  SettingsFieldStateMap,
  SettingsSchema,
  SettingsStatusSnapshot,
  SettingsValues,
  ToastNotification,
} from '@ss-helper/sdk';
import config from '../../plugin.config.json' with { type: 'json' };
import {
  MEMORY_LLM_RESOURCE_ACTION,
  type MemoryCapabilitySettings,
  type MemoryCapabilityStatusMap,
  type MemorySettingsAssessment,
} from './llm-capability-monitor';

export interface MemorySettings extends MemoryCapabilitySettings {
  maxRecallItems: number;
  promptMaxChars: number;
  answerMode: 'auto' | 'roleplay' | 'diagnostic';
  chatMode: 'inherit' | 'enabled' | 'disabled';
}
export type MemoryEffectiveSettings = Omit<MemorySettings, 'chatMode'>;

export const MEMORY_DEFAULT_SETTINGS: Readonly<MemorySettings> = Object.freeze({
  enabled: true,
  autoOrganize: true,
  maxRecallItems: 12,
  promptMaxChars: 8_000,
  answerMode: 'auto',
  recallMode: 'auto',
  rerankMode: 'adaptive',
  chatMode: 'inherit',
});

export const MEMORY_WORKBENCH_POPUP = Object.freeze({
  kind: 'popup', provider: 'ss-helper.memory', name: 'workbench', version: 1,
} as const);

export const MEMORY_SETTINGS_SCHEMA = Object.freeze({
  id: 'ss-helper.memory',
  title: config.settingsTitle,
  fields: [
    { kind: 'section', id: 'global', label: '全局', children: [
      { kind: 'section', id: 'globalBasic', label: '基础', children: [
        { kind: 'toggle', id: 'enabled', label: '默认启用记忆', description: '作为未单独设置聊天时的默认值；当前聊天可以覆盖。', defaultValue: true },
        { kind: 'status', id: 'workspaceStatus', label: '当前工作区', value: '未检查', tone: 'neutral' },
        { kind: 'toggle', id: 'autoOrganize', label: '自动整理', description: '在聊天轮次完成后整理有证据的事实。', defaultValue: true },
        { kind: 'status', id: 'generationStatus', label: '大语言模型', value: '未检查', tone: 'neutral', action: MEMORY_LLM_RESOURCE_ACTION },
        { kind: 'select', id: 'answerMode', label: '回答模式', options: [
          { value: 'auto', label: '自动' }, { value: 'roleplay', label: '角色扮演' }, { value: 'diagnostic', label: '诊断' },
        ], defaultValue: 'auto' },
      ] },
      { kind: 'section', id: 'globalRecall', label: '召回', children: [
        { kind: 'range', id: 'maxRecallItems', label: '召回条数', description: '单次最多注入的记忆数量。', min: 4, max: 30, step: 1, defaultValue: 12 },
        { kind: 'range', id: 'promptMaxChars', label: 'Prompt 字符预算', description: '单次记忆注入可使用的最大字符数。', min: 2_000, max: 16_000, step: 500, defaultValue: 8_000 },
        { kind: 'select', id: 'recallMode', label: '召回模式', options: [
          { value: 'auto', label: '自动' }, { value: 'lexical', label: '关键词' }, { value: 'vector', label: '向量' }, { value: 'hybrid', label: '混合' },
        ], defaultValue: 'auto' },
        { kind: 'status', id: 'embeddingStatus', label: 'Embedding API', value: '未检查', tone: 'neutral', action: MEMORY_LLM_RESOURCE_ACTION },
        { kind: 'select', id: 'rerankMode', label: '重排策略', options: [
          { value: 'off', label: '关闭' }, { value: 'adaptive', label: '自适应' }, { value: 'always', label: '始终' },
        ], defaultValue: 'adaptive' },
        { kind: 'status', id: 'rerankStatus', label: 'Rerank API', value: '未检查', tone: 'neutral', action: MEMORY_LLM_RESOURCE_ACTION },
      ] },
      { kind: 'section', id: 'globalTools', label: '工具', children: [
        { kind: 'action', id: 'workbench', label: '记忆工作台', description: '查看、整理和维护当前聊天的记忆。', actionId: 'open-workbench', popup: MEMORY_WORKBENCH_POPUP, placement: 'inline', buttonLabel: '打开工作台' },
      ] },
    ] },
    { kind: 'section', id: 'currentChat', label: '当前聊天', children: [
      { kind: 'status', id: 'currentChatIdentity', label: '当前聊天', value: '不可用', tone: 'warning' },
      { kind: 'radio', id: 'chatMode', label: '记忆状态', description: '可跟随全局默认值，或只为当前聊天强制开启、关闭。', options: [
        { value: 'inherit', label: '跟随全局' }, { value: 'enabled', label: '强制开启' }, { value: 'disabled', label: '强制关闭' },
      ], defaultValue: 'inherit' },
      { kind: 'status', id: 'currentChatEffective', label: '当前生效状态', value: '不可用', tone: 'warning' },
    ] },
  ],
} as const satisfies SettingsSchema);

export interface MemoryCurrentChatInfo {
  available: boolean;
  name: string;
  key: string;
  mode: MemorySettings['chatMode'];
  effectiveEnabled: boolean;
}

export interface MemorySettingsController {
  getSettings(): MemorySettings;
  getEffectiveSettings(settings?: MemorySettings): MemoryEffectiveSettings;
  saveSettings(settings: MemorySettings): Promise<void>;
  resetSettings(): Promise<void>;
  getCurrentChatInfo(): MemoryCurrentChatInfo;
  onSettingsChanged(listener: (settings: MemorySettings) => void): () => void;
}

export interface MemorySettingsStatusSource {
  loadStatus(): MemoryCapabilityStatusMap | Promise<MemoryCapabilityStatusMap>;
  subscribeStatus(listener: (status: MemoryCapabilityStatusMap) => void): () => void;
  assess(next: MemoryCapabilitySettings, previous: MemoryCapabilitySettings): Promise<MemorySettingsAssessment>;
}

function fromValues(values: SettingsValues, fallback: MemorySettings): MemorySettings {
  return {
    enabled: values.enabled === undefined ? fallback.enabled : values.enabled === true,
    autoOrganize: values.autoOrganize === undefined ? fallback.autoOrganize : values.autoOrganize === true,
    maxRecallItems: typeof values.maxRecallItems === 'number' ? values.maxRecallItems : fallback.maxRecallItems,
    promptMaxChars: typeof values.promptMaxChars === 'number' ? values.promptMaxChars : fallback.promptMaxChars,
    answerMode: values.answerMode === 'roleplay' || values.answerMode === 'diagnostic' ? values.answerMode : 'auto',
    recallMode: values.recallMode === 'lexical' || values.recallMode === 'vector' || values.recallMode === 'hybrid' ? values.recallMode : 'auto',
    rerankMode: values.rerankMode === 'off' || values.rerankMode === 'always' ? values.rerankMode : 'adaptive',
    chatMode: values.chatMode === 'enabled' || values.chatMode === 'disabled' ? values.chatMode : 'inherit',
  };
}

function toValues(settings: MemorySettings): SettingsValues { return { ...settings }; }

function chatStatuses(controller: MemorySettingsController): Readonly<Record<string, SettingsStatusSnapshot>> {
  const chat = controller.getCurrentChatInfo();
  if (!chat.available) return Object.freeze({
    currentChatIdentity: { value: '不可用', tone: 'warning', description: '请先进入角色或群组聊天。' },
    currentChatEffective: { value: '未生效', tone: 'warning', description: '当前没有可应用聊天级设置的聊天。' },
  });
  const modeText = chat.mode === 'inherit' ? '跟随全局' : chat.mode === 'enabled' ? '强制开启' : '强制关闭';
  return Object.freeze({
    currentChatIdentity: { value: chat.name || chat.key, tone: 'success', description: `聊天标识：${chat.key}` },
    currentChatEffective: { value: chat.effectiveEnabled ? '已启用' : '已关闭', tone: chat.effectiveEnabled ? 'success' : 'neutral', description: `当前策略：${modeText}` },
  });
}

function fieldState(controller: MemorySettingsController): SettingsFieldStateMap {
  const chat = controller.getCurrentChatInfo();
  return Object.freeze({ chatMode: chat.available
    ? Object.freeze({ disabled: false })
    : Object.freeze({ disabled: true, disabledReason: '请先进入角色或群组聊天，再修改当前聊天设置。' }) });
}

function notify(sink: ((notification: ToastNotification) => void) | undefined, notification: ToastNotification): void {
  sink?.(notification);
}

export function createMemorySettingsAdapter(
  controller: MemorySettingsController,
  statusSource?: MemorySettingsStatusSource,
  toast?: (notification: ToastNotification) => void,
): SettingsAdapter {
  let latestCapabilityStatus: MemoryCapabilityStatusMap = Object.freeze({});
  return {
    load: () => toValues(controller.getSettings()),
    save: async (values) => {
      const previous = controller.getSettings();
      const next = fromValues(values, previous);
      const previousEffective = controller.getEffectiveSettings(previous);
      const nextEffective = controller.getEffectiveSettings(next);
      const assessment = statusSource === undefined ? { warnings: [] } : await statusSource.assess(nextEffective, previousEffective);
      if (assessment.blocked !== undefined) {
        notify(toast, { level: 'error', ...assessment.blocked, durationMs: 0 });
        throw new Error(assessment.blocked.message);
      }
      try { await controller.saveSettings(next); }
      catch (error) {
        notify(toast, { level: 'error', title: 'Memory 设置保存失败', message: error instanceof Error ? error.message : '设置未能保存，请稍后重试。', code: 'MEMORY_SETTINGS_SAVE_FAILED', durationMs: 0 });
        throw error;
      }
      for (const warning of assessment.warnings) notify(toast, { level: 'warning', ...warning });
      if (!controller.getCurrentChatInfo().available && !previous.enabled && next.enabled) {
        notify(toast, { level: 'warning', title: '全局设置已保存', message: '当前未进入聊天；该默认值会在进入角色或群组聊天后生效。', code: 'MEMORY_NO_ACTIVE_CHAT' });
      }
    },
    reset: async () => { await controller.resetSettings(); return toValues(controller.getSettings()); },
    subscribe: (listener) => controller.onSettingsChanged((settings) => listener(toValues(settings))),
    loadStatus: async () => ({ ...(statusSource === undefined ? {} : await statusSource.loadStatus()), ...chatStatuses(controller) }),
    subscribeStatus: (listener) => {
      const emit = (): void => listener(Object.freeze({ ...latestCapabilityStatus, ...chatStatuses(controller) }));
      const disposeCapability = statusSource?.subscribeStatus((status) => { latestCapabilityStatus = status; emit(); });
      const disposeSettings = controller.onSettingsChanged(emit);
      emit();
      return () => { disposeCapability?.(); disposeSettings(); };
    },
    loadFieldState: () => fieldState(controller),
    subscribeFieldState: (listener) => controller.onSettingsChanged(() => listener(fieldState(controller))),
  };
}
