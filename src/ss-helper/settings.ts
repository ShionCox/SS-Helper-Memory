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
import type { MemoryGraphStatus } from '../domain';

export interface MemorySettings extends MemoryCapabilitySettings {
  summaryBatchMode: 'floors' | 'chars';
  summaryBatchFloors: number;
  summaryBatchChars: number;
  summaryIntervalFloors: number;
  summaryOverlapFloors: number;
  maxRecallItems: number;
  promptMaxChars: number;
  answerMode: 'auto' | 'roleplay' | 'diagnostic';
  preExtractReferenceEnabled: boolean;
  preExtractReferenceItems: number;
  preExtractReferenceMode: 'auto' | 'lexical' | 'vector' | 'hybrid';
  preExtractReferenceMaxChars: number;
  graphEnabled: boolean;
  graphLlmRelationEnabled: boolean;
  graphMaxHops: 1 | 2;
  graphMaxEdges: number;
  chatMode: 'inherit' | 'enabled' | 'disabled';
}
export type MemoryEffectiveSettings = Omit<MemorySettings, 'chatMode'>;

export const MEMORY_DEFAULT_SETTINGS: Readonly<MemorySettings> = Object.freeze({
  enabled: true,
  autoOrganize: true,
  summaryBatchMode: 'floors',
  summaryBatchFloors: 5,
  summaryBatchChars: 12_000,
  summaryIntervalFloors: 5,
  summaryOverlapFloors: 2,
  maxRecallItems: 12,
  promptMaxChars: 8_000,
  answerMode: 'auto',
  recallMode: 'auto',
  rerankMode: 'adaptive',
  preExtractReferenceEnabled: true,
  preExtractReferenceItems: 8,
  preExtractReferenceMode: 'auto',
  preExtractReferenceMaxChars: 2_400,
  graphEnabled: true,
  graphLlmRelationEnabled: true,
  graphMaxHops: 1,
  graphMaxEdges: 12,
  chatMode: 'inherit',
});

export const MEMORY_WORKBENCH_POPUP = Object.freeze({
  kind: 'popup', provider: 'ss-helper.memory', name: 'workbench', version: 0,
} as const);

export const MEMORY_SETTINGS_SCHEMA = Object.freeze({
  id: 'ss-helper.memory',
  title: config.settingsTitle,
  fields: [
    { kind: 'section', id: 'basic', label: '基础', children: [
      { kind: 'toggle', id: 'enabled', label: '默认启用记忆', description: '作为未单独设置聊天时的默认值；当前聊天可以覆盖。', defaultValue: true },
      { kind: 'status', id: 'workspaceStatus', label: '当前工作区', value: '正在同步', tone: 'neutral' },
      { kind: 'action', id: 'workbench', label: '记忆工作台', description: '查看、整理和维护当前聊天的记忆。', actionId: 'open-workbench', popup: MEMORY_WORKBENCH_POPUP, placement: 'inline', buttonLabel: '打开工作台' },
    ] },
    { kind: 'section', id: 'summary', label: '总结', children: [
      { kind: 'toggle', id: 'autoOrganize', label: '自动整理', description: '达到总结间隔后，提炼可追溯的结构化事实。', defaultValue: true },
      { kind: 'status', id: 'generationStatus', label: '大语言模型', value: '正在同步', tone: 'neutral', action: MEMORY_LLM_RESOURCE_ACTION },
      { kind: 'select', id: 'summaryBatchMode', label: '分批方式', options: [
        { value: 'floors', label: '按楼层' }, { value: 'chars', label: '按字数' },
      ], defaultValue: 'floors' },
      { kind: 'range', id: 'summaryBatchFloors', label: '每批楼层数', description: '按楼层时，每次总结最多处理的可见用户和助手消息数。', min: 1, max: 20, step: 1, defaultValue: 5 },
      { kind: 'range', id: 'summaryBatchChars', label: '每批字符数', description: '按字数时，单次总结窗口的最大正文字符数。', min: 2_000, max: 16_000, step: 500, defaultValue: 12_000 },
      { kind: 'range', id: 'summaryIntervalFloors', label: '自动触发间隔', description: '已总结边界后每积累多少楼层形成一个窗口；会保留下一层等待后续窗口。', min: 1, max: 50, step: 1, defaultValue: 5 },
      { kind: 'range', id: 'summaryOverlapFloors', label: '前置重叠层数', description: '每个总结窗口额外携带的前置上下文楼层数。', min: 0, max: 10, step: 1, defaultValue: 2 },
      { kind: 'status', id: 'summaryProgress', label: '当前聊天总结进度', value: '正在同步', tone: 'neutral' },
    ] },
    { kind: 'section', id: 'recall', label: '召回', children: [
      { kind: 'select', id: 'answerMode', label: '回答模式', options: [
        { value: 'auto', label: '自动' }, { value: 'roleplay', label: '角色扮演' }, { value: 'diagnostic', label: '诊断' },
      ], defaultValue: 'auto' },
      { kind: 'range', id: 'maxRecallItems', label: '召回条数', description: '单次最多注入的记忆数量。', min: 4, max: 30, step: 1, defaultValue: 12 },
      { kind: 'range', id: 'promptMaxChars', label: 'Prompt 字符预算', description: '单次记忆注入可使用的最大字符数。', min: 2_000, max: 16_000, step: 500, defaultValue: 8_000 },
      { kind: 'select', id: 'recallMode', label: '召回模式', options: [
        { value: 'auto', label: '自动' }, { value: 'lexical', label: '关键词' }, { value: 'vector', label: '向量' }, { value: 'hybrid', label: '混合' },
      ], defaultValue: 'auto' },
      { kind: 'status', id: 'embeddingStatus', label: '向量模型', value: '正在同步', tone: 'neutral', action: MEMORY_LLM_RESOURCE_ACTION },
      { kind: 'select', id: 'rerankMode', label: '重排策略', options: [
        { value: 'off', label: '关闭' }, { value: 'adaptive', label: '自适应' }, { value: 'always', label: '始终' },
      ], defaultValue: 'adaptive' },
      { kind: 'status', id: 'rerankStatus', label: '重排序模型', value: '正在同步', tone: 'neutral', action: MEMORY_LLM_RESOURCE_ACTION },
    ] },
    { kind: 'section', id: 'advanced', label: '高级', children: [
      { kind: 'section', id: 'preExtractReference', label: '提取前参考旧记忆', description: '旧记忆只帮助判断重复、补充或状态变化，不能作为新事实的来源证据。', children: [
        { kind: 'toggle', id: 'preExtractReferenceEnabled', label: '提取前参考旧记忆', description: '每批整理前检索当前聊天中相关的已存事实；检索不可用时仍会按当前聊天内容继续整理。', defaultValue: true },
        { kind: 'range', id: 'preExtractReferenceItems', label: '参考条数', description: '每批最多提供多少条相关旧事实供提取器对照。', min: 1, max: 10, step: 1, defaultValue: 8 },
        { kind: 'select', id: 'preExtractReferenceMode', label: '检索方式', description: '自动优先综合语义和关键词；向量不可用时会回退到关键词。', options: [
          { value: 'auto', label: '自动' }, { value: 'lexical', label: '关键词' }, { value: 'vector', label: '语义' }, { value: 'hybrid', label: '混合' },
        ], defaultValue: 'auto' },
        { kind: 'range', id: 'preExtractReferenceMaxChars', label: '上下文字符上限', description: '发送给提取器的旧记忆正文总字符数上限；不会截断单条事实。', min: 500, max: 4_000, step: 100, defaultValue: 2_400 },
      ] },
      { kind: 'section', id: 'relationshipGraph', label: '关系图谱', description: '仅从当前聊天中已验证、带证据的事实派生关系；不会把语义相似度当作实体关系。', children: [
        { kind: 'toggle', id: 'graphEnabled', label: '启用关系图谱', description: '在后台回填当前聊天的事实关系图；图谱不可用时，整理和普通召回仍会继续。', defaultValue: true },
        { kind: 'toggle', id: 'graphLlmRelationEnabled', label: '提炼明确关系', description: '仅提示同一次事实提取识别来源中明确说出的关系，仍须通过来源证据与归并校验。', defaultValue: true },
        { kind: 'range', id: 'graphMaxHops', label: '关联跳数', description: '召回时最多沿已验证关系扩展一到两跳。', min: 1, max: 2, step: 1, defaultValue: 1 },
        { kind: 'range', id: 'graphMaxEdges', label: '关联边上限', description: '单次召回最多提名多少条已验证关系边。', min: 4, max: 24, step: 1, defaultValue: 12 },
        { kind: 'status', id: 'graphStatus', label: '图谱状态', value: '正在同步', tone: 'neutral' },
        { kind: 'action', id: 'graphWorkbench', label: '重建关系图谱', description: '立即依据当前聊天的已验证事实重建，并打开只读关系图谱页；不会创建手工边。', actionId: 'rebuild-relationship-graph', popup: MEMORY_WORKBENCH_POPUP, placement: 'inline', buttonLabel: '重建关系图谱' },
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

export interface MemorySummaryProgressInfo {
  available: boolean;
  initialized: boolean;
  completedFloor?: number;
  nextWindow?: string;
  waitingFloors?: number;
}

export interface MemorySettingsController {
  getSettings(): MemorySettings;
  getEffectiveSettings(settings?: MemorySettings): MemoryEffectiveSettings;
  saveSettings(settings: MemorySettings): Promise<void>;
  resetSettings(): Promise<void>;
  getCurrentChatInfo(): MemoryCurrentChatInfo;
  getSummaryProgressInfo(): MemorySummaryProgressInfo;
  /** Optional so older controller adapters remain source-compatible. */
  getGraphStatus?(): MemoryGraphStatus;
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
    summaryBatchMode: values.summaryBatchMode === 'chars' ? 'chars' : 'floors',
    summaryBatchFloors: typeof values.summaryBatchFloors === 'number' ? Math.min(20, Math.max(1, Math.trunc(values.summaryBatchFloors))) : fallback.summaryBatchFloors,
    summaryBatchChars: typeof values.summaryBatchChars === 'number' ? Math.min(16_000, Math.max(2_000, Math.trunc(values.summaryBatchChars / 500) * 500)) : fallback.summaryBatchChars,
    summaryIntervalFloors: typeof values.summaryIntervalFloors === 'number' ? Math.min(50, Math.max(1, Math.trunc(values.summaryIntervalFloors))) : fallback.summaryIntervalFloors,
    summaryOverlapFloors: typeof values.summaryOverlapFloors === 'number' ? Math.min(10, Math.max(0, Math.trunc(values.summaryOverlapFloors))) : fallback.summaryOverlapFloors,
    maxRecallItems: typeof values.maxRecallItems === 'number' ? values.maxRecallItems : fallback.maxRecallItems,
    promptMaxChars: typeof values.promptMaxChars === 'number' ? values.promptMaxChars : fallback.promptMaxChars,
    answerMode: values.answerMode === 'roleplay' || values.answerMode === 'diagnostic' ? values.answerMode : 'auto',
    recallMode: values.recallMode === 'lexical' || values.recallMode === 'vector' || values.recallMode === 'hybrid' ? values.recallMode : 'auto',
    rerankMode: values.rerankMode === 'off' || values.rerankMode === 'always' ? values.rerankMode : 'adaptive',
    preExtractReferenceEnabled: values.preExtractReferenceEnabled === undefined ? fallback.preExtractReferenceEnabled : values.preExtractReferenceEnabled === true,
    preExtractReferenceItems: typeof values.preExtractReferenceItems === 'number'
      ? Math.min(10, Math.max(1, Math.trunc(values.preExtractReferenceItems)))
      : fallback.preExtractReferenceItems,
    preExtractReferenceMode: values.preExtractReferenceMode === 'lexical' || values.preExtractReferenceMode === 'vector' || values.preExtractReferenceMode === 'hybrid'
      ? values.preExtractReferenceMode
      : fallback.preExtractReferenceMode,
    preExtractReferenceMaxChars: typeof values.preExtractReferenceMaxChars === 'number'
      ? Math.min(4_000, Math.max(500, Math.round(values.preExtractReferenceMaxChars / 100) * 100))
      : fallback.preExtractReferenceMaxChars,
    graphEnabled: values.graphEnabled === undefined ? fallback.graphEnabled : values.graphEnabled === true,
    graphLlmRelationEnabled: values.graphLlmRelationEnabled === undefined ? fallback.graphLlmRelationEnabled : values.graphLlmRelationEnabled === true,
    graphMaxHops: values.graphMaxHops === 2 ? 2 : 1,
    graphMaxEdges: typeof values.graphMaxEdges === 'number'
      ? Math.min(24, Math.max(4, Math.trunc(values.graphMaxEdges)))
      : fallback.graphMaxEdges,
    chatMode: values.chatMode === 'enabled' || values.chatMode === 'disabled' ? values.chatMode : 'inherit',
  };
}

function toValues(settings: MemorySettings): SettingsValues { return { ...settings }; }

function chatStatuses(controller: MemorySettingsController): Readonly<Record<string, SettingsStatusSnapshot>> {
  const chat = controller.getCurrentChatInfo();
  const summary = controller.getSummaryProgressInfo();
  const graph = controller.getGraphStatus?.();
  if (!chat.available) return Object.freeze({
    currentChatIdentity: { value: '不可用', tone: 'warning', description: '请先进入角色或群组聊天。' },
    currentChatEffective: { value: '未生效', tone: 'warning', description: '当前没有可应用聊天级设置的聊天。' },
    summaryProgress: { value: '未选择聊天', tone: 'warning', description: '进入角色或群组聊天后显示该聊天独立的总结进度。' },
    graphStatus: { value: '未选择聊天', tone: 'warning', description: '进入聊天后才会建立该聊天独立的事实关系图。' },
  });
  const modeText = chat.mode === 'inherit' ? '跟随全局' : chat.mode === 'enabled' ? '强制开启' : '强制关闭';
  return Object.freeze({
    currentChatIdentity: { value: chat.name || '当前聊天', tone: 'success', description: '状态会随角色或群组聊天切换实时更新。' },
    currentChatEffective: { value: chat.effectiveEnabled ? '已启用' : '已关闭', tone: chat.effectiveEnabled ? 'success' : 'neutral', description: `当前策略：${modeText}` },
    summaryProgress: !summary.initialized
      ? { value: '尚未初始化', tone: 'neutral', description: '请在记忆工作台初始化当前聊天；不会自动跳过既有楼层。' }
      : { value: `已总结至第 ${summary.completedFloor} 层`, tone: 'success', description: [summary.nextWindow, summary.waitingFloors === undefined ? undefined : `还需 ${summary.waitingFloors} 层触发下一窗口。`].filter(Boolean).join(' ') },
    graphStatus: !graph
      ? { value: '等待协调', tone: 'neutral', description: '关系图谱会在后台根据已验证事实回填。' }
      : graph.phase === 'degraded'
        ? { value: '已降级', tone: 'warning', description: graph.lastError ? '图谱本轮不可用，普通整理和召回不受影响。' : '图谱本轮不可用，普通整理和召回不受影响。' }
        : graph.phase === 'disabled'
          ? { value: '已关闭', tone: 'neutral', description: '当前设置未启用关系图谱。' }
          : { value: graph.phase === 'ready' ? `已就绪（${graph.edgeCount} 条边）` : graph.phase === 'rebuilding' ? '重建中' : graph.phase === 'queued' ? '已排队' : '等待协调', tone: graph.phase === 'ready' ? 'success' : 'neutral', description: '仅展示当前聊天中有来源证据的事实关系，不将语义相似度视为实体关系。' },
  });
}

function fieldState(controller: MemorySettingsController): SettingsFieldStateMap {
  const chat = controller.getCurrentChatInfo();
  const summary = controller.getSettings();
  return Object.freeze({
    chatMode: chat.available
      ? Object.freeze({ disabled: false })
      : Object.freeze({ disabled: true, disabledReason: '请先进入角色或群组聊天，再修改当前聊天设置。' }),
    summaryBatchFloors: summary.summaryBatchMode === 'floors'
      ? Object.freeze({ disabled: false })
      : Object.freeze({ disabled: true, disabledReason: '当前选择“按字数”分批；此项不会参与总结。' }),
    summaryBatchChars: summary.summaryBatchMode === 'chars'
      ? Object.freeze({ disabled: false })
      : Object.freeze({ disabled: true, disabledReason: '当前选择“按楼层”分批；此项不会参与总结。' }),
    graphWorkbench: !chat.available
      ? Object.freeze({ disabled: true, disabledReason: '请先进入角色或群组聊天，再重建关系图谱。' })
      : !chat.effectiveEnabled
        ? Object.freeze({ disabled: true, disabledReason: '当前聊天未启用记忆，不能重建关系图谱。' })
        : Object.freeze({ disabled: false }),
  });
}

function notify(sink: ((notification: ToastNotification) => void) | undefined, notification: ToastNotification): void {
  sink?.(notification);
}

function capabilitySettings(controller: MemorySettingsController, settings: MemorySettings): MemoryCapabilitySettings {
  const effective = controller.getEffectiveSettings(settings);
  return {
    // Global defaults must be validated even before a chat is selected. A
    // forced-on current chat is also active when the global default is off.
    enabled: settings.enabled || effective.enabled,
    autoOrganize: settings.autoOrganize,
    recallMode: settings.recallMode,
    rerankMode: settings.rerankMode,
    preExtractReferenceEnabled: settings.preExtractReferenceEnabled,
    preExtractReferenceMode: settings.preExtractReferenceMode,
  };
}

export function createMemorySettingsAdapter(
  controller: MemorySettingsController,
  statusSource: MemorySettingsStatusSource,
  toast?: (notification: ToastNotification) => void,
): SettingsAdapter {
  let latestCapabilityStatus: MemoryCapabilityStatusMap = Object.freeze({});
  return {
    load: () => toValues(controller.getSettings()),
    save: async (values) => {
      const previous = controller.getSettings();
      const next = fromValues(values, previous);
      const assessment = await statusSource.assess(capabilitySettings(controller, next), capabilitySettings(controller, previous));
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
    loadStatus: async () => ({ ...await statusSource.loadStatus(), ...chatStatuses(controller) }),
    subscribeStatus: (listener) => {
      const emit = (): void => listener(Object.freeze({ ...latestCapabilityStatus, ...chatStatuses(controller) }));
      const disposeCapability = statusSource.subscribeStatus((status) => { latestCapabilityStatus = status; emit(); });
      const disposeSettings = controller.onSettingsChanged(emit);
      emit();
      return () => { disposeCapability(); disposeSettings(); };
    },
    loadFieldState: () => fieldState(controller),
    subscribeFieldState: (listener) => controller.onSettingsChanged(() => listener(fieldState(controller))),
  };
}
