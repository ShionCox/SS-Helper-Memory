import type { ExtractionStageKey, ExtractionStageSpec } from './extraction-types';

export const MEMORY_EXTRACTION_TASK_KEYS = Object.freeze({
  single: 'memory_extract_single',
  entities: 'memory_extract_entities',
  narrative: 'memory_extract_narrative',
  inventory: 'memory_extract_inventory',
  repair: 'memory_extract_repair',
} as const satisfies Record<ExtractionStageKey, string>);

export const EXTRACTION_STAGE_SPECS = Object.freeze({
  single: Object.freeze({
    key: 'single',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.single,
    description: '单阶段结构化记忆提取',
    ownedCollections: ['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations'] as const,
    allowedTools: ['entity.resolve_context', 'scene.resolve_context', 'inventory.resolve_context', 'memory.resolve_update_context', 'reference.get_details'] as const,
    maxToolRounds: 1,
  }),
  entities: Object.freeze({
    key: 'entities',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.entities,
    description: '人物与地点实体解析',
    ownedCollections: ['actorCandidates', 'locationCandidates'] as const,
    allowedTools: ['entity.resolve_context', 'scene.resolve_context', 'reference.get_details'] as const,
    maxToolRounds: 2,
  }),
  narrative: Object.freeze({
    key: 'narrative',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.narrative,
    description: '事件、事实与知识边界提取',
    ownedCollections: ['episodes', 'claims'] as const,
    allowedTools: ['scene.resolve_context', 'memory.resolve_update_context', 'reference.get_details'] as const,
    maxToolRounds: 2,
  }),
  inventory: Object.freeze({
    key: 'inventory',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.inventory,
    description: '物品与库存变化提取',
    ownedCollections: ['itemCandidates', 'inventoryOperations'] as const,
    allowedTools: ['inventory.resolve_context', 'scene.resolve_context', 'reference.get_details'] as const,
    maxToolRounds: 2,
  }),
  repair: Object.freeze({
    key: 'repair',
    taskKey: MEMORY_EXTRACTION_TASK_KEYS.repair,
    description: '局部结构化提取修复',
    ownedCollections: ['actorCandidates', 'locationCandidates', 'itemCandidates', 'episodes', 'claims', 'inventoryOperations'] as const,
    // Repair resolves this whitelist from the failed collection at runtime.
    allowedTools: [] as const,
    maxToolRounds: 1,
  }),
} as const satisfies Record<ExtractionStageKey, ExtractionStageSpec>);
