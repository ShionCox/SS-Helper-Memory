import type { ExtractionStageKey, ExtractionStageSpec } from './extraction-types';

export const MEMORY_EXTRACTION_TASK_KEYS = Object.freeze({
  single: 'memory_extract_single',
  entities: 'memory_extract_entities',
  content: 'memory_extract_content',
  repair: 'memory_extract_repair',
} as const satisfies Record<ExtractionStageKey, string>);

export const EXTRACTION_STAGE_SPECS = Object.freeze({
  single: Object.freeze({
    key: 'single',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.single,
    description: '单阶段结构化记忆提取',
    execution: 'structured',
    ownedCollections: ['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations'] as const,
    allowedTools: [] as const,
    maxToolRounds: 1,
  }),
  entities: Object.freeze({
    key: 'entities',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.entities,
    description: '人物与地点实体解析',
    execution: 'tool_turn',
    ownedCollections: ['actorCandidates', 'locationCandidates'] as const,
    allowedTools: ['entity.resolve_context', 'scene.resolve_context', 'reference.get_details'] as const,
    maxToolRounds: 2,
  }),
  content: Object.freeze({
    key: 'content',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.content,
    description: '内容与库存联合提取',
    execution: 'tool_turn',
    ownedCollections: ['episodes', 'claims', 'itemCandidates', 'inventoryOperations'] as const,
    allowedTools: ['scene.resolve_context', 'memory.resolve_update_context', 'inventory.resolve_context', 'reference.get_details'] as const,
    maxToolRounds: 2,
  }),
  repair: Object.freeze({
    key: 'repair',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.repair,
    description: '局部结构化提取修复',
    execution: 'structured',
    ownedCollections: ['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations'] as const,
    // Repair resolves this whitelist from the failed collection at runtime.
    allowedTools: [] as const,
    maxToolRounds: 1,
  }),
} as const satisfies Record<ExtractionStageKey, ExtractionStageSpec>);
