import type { LlmToolDefinition, PlainData } from '@ss-helper/sdk';
import type { AgentToolName } from '../extraction/extraction-types';

const text = (maxLength: number): PlainData => ({ type: 'string', minLength: 1, maxLength });
const strings = (maxItems: number, maxLength: number): PlainData => ({
  type: 'array', minItems: 1, maxItems, items: text(maxLength),
});
const limit: PlainData = { type: 'number', minimum: 1, maximum: 50 };
const detailFields: PlainData = {
  type: 'array', minItems: 1, maxItems: 20,
  items: { type: 'string', enum: ['canonicalName', 'aliases', 'status', 'category', 'states', 'history', 'kind', 'subjectKey', 'predicateKey', 'objectKey', 'content', 'validFrom', 'validUntil', 'sceneId', 'locationId', 'presentOwnerIds', 'updatedAtFloor', 'revision'] },
};
const object = (properties: Record<string, PlainData>, required: string[]): PlainData => ({
  type: 'object', additionalProperties: false, properties, required,
});

export const AGENT_TOOL_DEFINITIONS: Readonly<Record<AgentToolName, LlmToolDefinition>> = Object.freeze({
  'entity.resolve_context': Object.freeze({
    name: 'entity.resolve_context',
    description: '按当前批次中的人物或地点称呼解析已知短引用；结果只用于消歧和查重。',
    strict: true,
    parameters: object({
      mentions: strings(20, 120),
      needs: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['identity', 'aliases', 'presence', 'location'] } },
      limit,
    }, ['mentions', 'needs', 'limit']),
  }),
  'scene.resolve_context': Object.freeze({
    name: 'scene.resolve_context',
    description: '读取当前或最近场景的安全摘要；工具命中本身不能证明本批发生地点或在场人物。',
    strict: true,
    parameters: object({
      query: text(160),
      needs: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['current', 'recent', 'presence', 'transitions'] } },
      limit,
    }, ['query', 'needs', 'limit']),
  }),
  'inventory.resolve_context': Object.freeze({
    name: 'inventory.resolve_context',
    description: '按本批明确出现的物品称呼读取目录、当前状态或历史；旧数量不能成为新证据。',
    strict: false,
    parameters: object({
      mentions: strings(20, 120),
      needs: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['identity', 'current_state', 'recent_history', 'aliases'] } },
      category: { type: 'string', maxLength: 80, description: '可选分类筛选；空字符串表示不限制分类。' },
      limit,
    }, ['mentions', 'needs', 'limit']),
  }),
  'memory.resolve_update_context': Object.freeze({
    name: 'memory.resolve_update_context',
    description: '读取同一事实槽位的当前或历史安全摘要，用于查重和选择更新裁决器。',
    strict: false,
    parameters: object({
      subject: text(160),
      predicate: text(160),
      object: text(240),
      content: text(500),
      needs: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['current', 'history', 'entity'] } },
      limit,
    }, ['subject', 'predicate', 'needs', 'limit']),
  }),
  'reference.get_details': Object.freeze({
    name: 'reference.get_details',
    description: '读取本次 pipeline 已发放短引用的安全详情；不能接受数据库 ID 或未发放引用。',
    strict: false,
    parameters: object({ refs: strings(20, 16), fields: detailFields }, ['refs']),
  }),
});

export function buildAgentToolDefinitions(names: readonly AgentToolName[]): readonly LlmToolDefinition[] {
  return names.map(name => structuredClone(AGENT_TOOL_DEFINITIONS[name]));
}
