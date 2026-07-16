import type { SettingsAdapter, SettingsSchema, SettingsValues } from '@ss-helper/sdk';
import config from '../../plugin.config.json' with { type: 'json' };

export interface MemorySettings {
  enabled: boolean;
  autoOrganize: boolean;
  maxRecallItems: number;
  promptMaxChars: number;
  answerMode: 'auto' | 'roleplay' | 'diagnostic';
  recallMode: 'auto' | 'lexical' | 'vector' | 'hybrid';
  rerankMode: 'off' | 'adaptive' | 'always';
}

export const MEMORY_DEFAULT_SETTINGS: Readonly<MemorySettings> = Object.freeze({
  enabled: true,
  autoOrganize: true,
  maxRecallItems: 12,
  promptMaxChars: 8_000,
  answerMode: 'auto',
  recallMode: 'auto',
  rerankMode: 'adaptive',
});

export const MEMORY_WORKBENCH_POPUP = Object.freeze({
  kind: 'popup', provider: 'ss-helper.memory', name: 'workbench', version: 1,
} as const);

export const MEMORY_SETTINGS_SCHEMA = Object.freeze({
  id: 'ss-helper.memory',
  title: config.settingsTitle,
  fields: [
    { kind: 'section', id: 'basic', label: '基础', children: [
      { kind: 'toggle', id: 'enabled', label: '启用记忆', description: '控制记忆整理与召回。', defaultValue: true },
      { kind: 'toggle', id: 'autoOrganize', label: '自动整理', description: '在聊天轮次完成后整理有证据的事实。', defaultValue: true },
      { kind: 'select', id: 'answerMode', label: '回答模式', options: [
        { value: 'auto', label: '自动' }, { value: 'roleplay', label: '角色扮演' }, { value: 'diagnostic', label: '诊断' },
      ], defaultValue: 'auto' },
    ] },
    { kind: 'section', id: 'recall', label: '召回', children: [
      { kind: 'range', id: 'maxRecallItems', label: '召回条数', description: '单次最多注入的记忆数量。', min: 4, max: 30, step: 1, defaultValue: 12 },
      { kind: 'range', id: 'promptMaxChars', label: 'Prompt 字符预算', description: '单次记忆注入可使用的最大字符数。', min: 2_000, max: 16_000, step: 500, defaultValue: 8_000 },
      { kind: 'select', id: 'recallMode', label: '召回模式', options: [
        { value: 'auto', label: '自动' }, { value: 'lexical', label: '关键词' }, { value: 'vector', label: '向量' }, { value: 'hybrid', label: '混合' },
      ], defaultValue: 'auto' },
      { kind: 'select', id: 'rerankMode', label: '重排策略', options: [
        { value: 'off', label: '关闭' }, { value: 'adaptive', label: '自适应' }, { value: 'always', label: '始终' },
      ], defaultValue: 'adaptive' },
    ] },
    { kind: 'section', id: 'tools', label: '工具', children: [
      { kind: 'action', id: 'workbench', label: '打开记忆工作台', actionId: 'open-workbench', popup: MEMORY_WORKBENCH_POPUP },
    ] },
  ],
} as const satisfies SettingsSchema);

export interface MemorySettingsController {
  getSettings(): MemorySettings;
  saveSettings(settings: MemorySettings): Promise<void>;
  onSettingsChanged(listener: (settings: MemorySettings) => void): () => void;
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
  };
}

function toValues(settings: MemorySettings): SettingsValues {
  return { ...settings };
}

export function createMemorySettingsAdapter(controller: MemorySettingsController): SettingsAdapter {
  return {
    load: () => toValues(controller.getSettings()),
    save: (values) => controller.saveSettings(fromValues(values, controller.getSettings())),
    reset: async () => {
      await controller.saveSettings({ ...MEMORY_DEFAULT_SETTINGS });
      return toValues(controller.getSettings());
    },
    subscribe: (listener) => controller.onSettingsChanged((settings) => listener(toValues(settings))),
  };
}
