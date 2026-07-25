import type { GenerationCastPlan, GenerationRecallIntentPlan, GenerationRecallSubQuery } from '../../domain';

export type RecallIntentFacet = 'time' | 'actor' | 'event' | 'relationship' | 'state' | 'complexity';

/** Extended generation-time plan with the legacy inspection fields retained. */
export interface RecallIntentPlan extends GenerationRecallIntentPlan {
  readonly facets: readonly RecallIntentFacet[];
  readonly actorNames: readonly string[];
  readonly temporal: 'current' | 'historical' | 'mixed' | 'unspecified';
}

export interface RecallIntentLlm {
  plan(query: string): Promise<Partial<RecallIntentPlan>>;
}

export interface RecallIntentContext {
  readonly castPlan?: GenerationCastPlan;
  readonly resolveOwnerName?: (name: string) => string | undefined;
  readonly entityKeys?: readonly string[];
}

const TIME = /(?:之前|曾经|当时|历史|最早|最初|起初|后来|先后|过去|未来|明天|昨天|多久|何时|什么时候)/u;
const CURRENT = /(?:当前|现在|目前|最新|最后|还剩|剩余|现有|最终|此刻|这里)/u;
const TIMELINE = /(?:变化|经过|一路|时间线|先.*后|从.*到)/u;
const RELATIONSHIP = /(?:关系|朋友|敌人|同伴|喜欢|讨厌|信任|认识|属于|父母|兄弟|恋人)/u;
const EVENT = /(?:发生|事件|经历|做过|说过|见过|战斗|离开|抵达|死亡|承诺|答应)/u;
const STATE = /(?:状态|位置|地点|数量|多少|拥有|持有|健康|伤|计划|目标|是否还在)/u;
const CAPABILITY = /(?:能力|能够|能否|能做什么|可以做什么|可以怎样|如何感知|怎样感知|感知范围|协助侦察|侦察能力|功能|作用)/u;
const DIRECTIVE = /(?:指挥|指令|命令|下令|安排|分工|应对|调度)/u;
const CAUSAL = /(?:为什么|原因|导致|因此|因果|怎么会|缘由|知不知道|是否知道)/u;
const WORLD = /(?:世界|规则|设定|世界观)/u;
const NARRATOR = /(?:旁白|叙事|镜头|读者)/u;

function unique(values: Iterable<string>): string[] { return [...new Set([...values].map(value => value.trim()).filter(Boolean))]; }

function tokens(value: string): string[] {
  const result = new Set<string>();
  for (const segment of value.normalize('NFKC').matchAll(/[\p{Script=Han}]{2,}|[a-z0-9_:-]{2,}/giu)) result.add(segment[0]!.toLocaleLowerCase());
  return [...result];
}

function actorNames(query: string): string[] {
  const quoted = [...query.matchAll(/[“‘"']([^”’"']{1,32})[”’"']/gu)].map(match => match[1]!.trim());
  const addressed = [...query.matchAll(/(?:^|[，,。！？!?\s])([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·_-]{0,31})(?=[，,：:]|你|您|请)/gu)].map(match => match[1]!.trim());
  return unique([...quoted, ...addressed]);
}

function kinds(query: string): string[] {
  const result: string[] = [];
  if (RELATIONSHIP.test(query)) result.push('relationship');
  if (EVENT.test(query)) result.push('event');
  if (DIRECTIVE.test(query)) result.push('event', 'commitment', 'goal');
  if (CAPABILITY.test(query)) result.push('capability');
  if (STATE.test(query)) result.push('state', 'location', 'goal');
  if (WORLD.test(query)) result.push('world_rule');
  return unique(result);
}

function splitSubQueries(query: string): string[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const parts = normalized
    .split(/[？?；;\n]|(?:，|,)(?=[^，,]{2,}(?:是否|为什么|现在|当前|知不知道|还在))/u)
    .map(value => value.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.slice(0, 8) : [normalized];
}

function resolveNamedOwners(names: readonly string[], context: RecallIntentContext): string[] {
  return unique(names.map(name => context.resolveOwnerName?.(name) ?? '').filter(Boolean));
}

function targetsForSubQuery(value: string, names: readonly string[], ownerIds: readonly string[], castPlan?: GenerationCastPlan): string[] {
  const matched: string[] = [];
  names.forEach((name, index) => { if (value.includes(name) && ownerIds[index]) matched.push(ownerIds[index]!); });
  if (matched.length > 0) return unique(matched);
  return unique([
    ...(castPlan?.viewpointOwnerId ? [castPlan.viewpointOwnerId] : []),
    ...(castPlan?.requiredOwnerIds ?? []),
  ]);
}

export function planRecallIntentByRules(query: string, context: RecallIntentContext = {}): RecallIntentPlan {
  const facets = new Set<RecallIntentFacet>();
  if (TIME.test(query) || TIMELINE.test(query)) facets.add('time');
  if (RELATIONSHIP.test(query)) facets.add('relationship');
  if (EVENT.test(query)) facets.add('event');
  if (STATE.test(query)) facets.add('state');
  const names = actorNames(query);
  const namedOwnerIds = resolveNamedOwners(names, context);
  if (names.length > 0 || context.castPlan) facets.add('actor');
  const terms = tokens(query);
  const parts = splitSubQueries(query);
  const multiHop = CAUSAL.test(query) && (parts.length > 1 || names.length > 1 || facets.size >= 3);
  const complexity = multiHop ? 'multi_hop' : parts.length > 1 || facets.size >= 3 ? 'multi_topic' : 'direct';
  if (complexity !== 'direct') facets.add('complexity');
  const temporal = TIME.test(query) && CURRENT.test(query) ? 'mixed' : TIME.test(query) ? 'historical' : CURRENT.test(query) ? 'current' : 'unspecified';
  const timeMode = TIMELINE.test(query) || temporal === 'mixed' ? 'timeline' : temporal === 'historical' ? 'historical' : temporal === 'current' ? 'current' : 'unknown';
  const actorMode = WORLD.test(query)
    ? 'world'
    : NARRATOR.test(query)
      ? 'narrator'
      : namedOwnerIds.length > 0
        ? 'named_actors'
        : context.castPlan
          ? (context.castPlan.requiredOwnerIds.length <= 1 ? 'single_pov' : 'planned_cast')
          : 'planned_cast';
  const requestedKinds = kinds(query);
  const subQueries: GenerationRecallSubQuery[] = parts.map((part, index) => ({
    id: `subquery:${index + 1}`,
    query: part,
    targetOwnerIds: targetsForSubQuery(part, names, namedOwnerIds, context.castPlan),
    targetKinds: kinds(part).length > 0 ? kinds(part) : requestedKinds,
  }));
  return {
    query,
    timeMode,
    actorMode,
    namedOwnerIds,
    entityKeys: unique(context.entityKeys ?? []),
    requestedKinds,
    subQueries,
    complexity,
    graphHops: complexity === 'multi_hop' ? 2 : complexity === 'multi_topic' ? 1 : 0,
    requireVerification: complexity !== 'direct' || timeMode === 'timeline',
    terms,
    source: 'rules',
    facets: [...facets],
    actorNames: names,
    temporal,
  };
}

export async function planRecallIntent(query: string, llm?: RecallIntentLlm, context: RecallIntentContext = {}): Promise<RecallIntentPlan> {
  const deterministic = planRecallIntentByRules(query, context);
  if (!llm || deterministic.complexity === 'direct') return deterministic;
  try {
    const proposal = await llm.plan(query);
    const allowedComplexity = proposal.complexity === 'multi_hop' || proposal.complexity === 'multi_topic' || proposal.complexity === 'direct'
      ? proposal.complexity
      : deterministic.complexity;
    return {
      ...deterministic,
      ...proposal,
      query,
      terms: proposal.terms?.filter(Boolean).slice(0, 32) ?? deterministic.terms,
      namedOwnerIds: proposal.namedOwnerIds?.filter(Boolean).slice(0, 16) ?? deterministic.namedOwnerIds,
      entityKeys: proposal.entityKeys?.filter(Boolean).slice(0, 24) ?? deterministic.entityKeys,
      requestedKinds: proposal.requestedKinds?.filter(Boolean).slice(0, 16) ?? deterministic.requestedKinds,
      subQueries: proposal.subQueries?.filter(item => item?.query).slice(0, 8) ?? deterministic.subQueries,
      complexity: allowedComplexity,
      graphHops: proposal.graphHops === 2 || proposal.graphHops === 1 || proposal.graphHops === 0 ? proposal.graphHops : deterministic.graphHops,
      source: 'llm',
      facets: proposal.facets?.filter((facet): facet is RecallIntentFacet => ['time', 'actor', 'event', 'relationship', 'state', 'complexity'].includes(facet)).slice(0, 8) ?? deterministic.facets,
      actorNames: proposal.actorNames?.filter(Boolean).slice(0, 16) ?? deterministic.actorNames,
      temporal: proposal.temporal === 'current' || proposal.temporal === 'historical' || proposal.temporal === 'mixed' || proposal.temporal === 'unspecified' ? proposal.temporal : deterministic.temporal,
    };
  } catch {
    return { ...deterministic, source: 'rules-fallback' };
  }
}

