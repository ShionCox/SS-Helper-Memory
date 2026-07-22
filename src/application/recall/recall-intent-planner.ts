export type RecallIntentFacet = 'time' | 'actor' | 'event' | 'relationship' | 'state' | 'complexity';

export interface RecallIntentPlan {
  readonly facets: readonly RecallIntentFacet[];
  readonly terms: readonly string[];
  readonly actorNames: readonly string[];
  readonly temporal: 'current' | 'historical' | 'mixed' | 'unspecified';
  readonly complexity: 'simple' | 'complex';
  readonly source: 'rules' | 'llm' | 'rules-fallback';
}

export interface RecallIntentLlm {
  plan(query: string): Promise<Partial<RecallIntentPlan>>;
}

const TIME = /(?:之前|曾经|当时|历史|最早|最初|起初|后来|先后|过去|未来|明天|昨天|多久|何时|什么时候)/u;
const CURRENT = /(?:当前|现在|目前|最新|最后|还剩|剩余|现有|最终)/u;
const RELATIONSHIP = /(?:关系|朋友|敌人|同伴|喜欢|讨厌|信任|认识|属于|父母|兄弟|恋人)/u;
const EVENT = /(?:发生|事件|经历|做过|说过|见过|战斗|离开|抵达|死亡|承诺|答应)/u;
const STATE = /(?:状态|位置|地点|数量|多少|拥有|持有|健康|伤|计划|目标)/u;

function tokens(value: string): string[] {
  const result = new Set<string>();
  for (const segment of value.normalize('NFKC').matchAll(/[\p{Script=Han}]{2,}|[a-z0-9_:-]{2,}/giu)) result.add(segment[0]!.toLocaleLowerCase());
  return [...result];
}

function actorNames(query: string): string[] {
  return [...query.matchAll(/[“‘"']([^”’"']{2,32})[”’"']/gu)].map(match => match[1]!.trim()).filter(Boolean);
}

export function planRecallIntentByRules(query: string): RecallIntentPlan {
  const facets = new Set<RecallIntentFacet>();
  if (TIME.test(query)) facets.add('time');
  if (RELATIONSHIP.test(query)) facets.add('relationship');
  if (EVENT.test(query)) facets.add('event');
  if (STATE.test(query)) facets.add('state');
  if (actorNames(query).length > 0) facets.add('actor');
  const words = tokens(query);
  const complexity = words.length >= 8 || facets.size >= 3 ? 'complex' : 'simple';
  if (complexity === 'complex') facets.add('complexity');
  const temporal = TIME.test(query) && CURRENT.test(query) ? 'mixed' : TIME.test(query) ? 'historical' : CURRENT.test(query) ? 'current' : 'unspecified';
  return { facets: [...facets], terms: words, actorNames: actorNames(query), temporal, complexity, source: 'rules' };
}

export async function planRecallIntent(query: string, llm?: RecallIntentLlm): Promise<RecallIntentPlan> {
  const deterministic = planRecallIntentByRules(query);
  if (!llm || deterministic.complexity !== 'complex') return deterministic;
  try {
    const proposal = await llm.plan(query);
    const facets = [...new Set((proposal.facets ?? deterministic.facets).filter((facet): facet is RecallIntentFacet => ['time', 'actor', 'event', 'relationship', 'state', 'complexity'].includes(facet)))];
    return {
      facets: facets.length > 0 ? facets : deterministic.facets,
      terms: proposal.terms?.filter(Boolean).slice(0, 32) ?? deterministic.terms,
      actorNames: proposal.actorNames?.filter(Boolean).slice(0, 16) ?? deterministic.actorNames,
      temporal: proposal.temporal ?? deterministic.temporal,
      complexity: proposal.complexity ?? deterministic.complexity,
      source: 'llm',
    };
  } catch {
    return { ...deterministic, source: 'rules-fallback' };
  }
}

