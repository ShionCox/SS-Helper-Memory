import type {
  GenerationCastPlan,
  GenerationRecallIntentKind,
  GenerationRecallIntentPlan,
  GenerationRecallSubQuery,
  RecallOwnerScope,
} from '../../domain';
import { createSSHelperError } from '@ss-helper/sdk';
import {
  MEMORY_PLUGIN_ID,
  readMemoryLlmClient,
  type MemoryLlmClient,
} from '../ingest/llm-extractor';
import { RecallOwnerScopeResolver } from './recall-owner-scope-resolver';

export type RecallIntentFacet = 'time' | 'actor' | 'event' | 'relationship' | 'state' | 'complexity';

export interface RecallIntentPlan extends GenerationRecallIntentPlan {
  readonly facets: readonly RecallIntentFacet[];
  readonly actorNames: readonly string[];
  readonly temporal: 'current' | 'historical' | 'mixed' | 'unspecified';
  readonly intentKind: GenerationRecallIntentKind;
  readonly topicTerms: readonly string[];
  readonly ownerScope: RecallOwnerScope;
  readonly recentContextSatisfied: boolean;
}

export interface RecallIntentKnownOwner {
  readonly ownerId: string;
  readonly names: readonly string[];
}

export interface RecallIntentConversationItem {
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'metadata';
  readonly content: string;
}

export interface RecallIntentLlm {
  plan(query: string, context?: RecallIntentContext): Promise<Partial<RecallIntentPlan>>;
}

export interface RecallIntentContext {
  readonly castPlan?: GenerationCastPlan;
  readonly resolveOwnerName?: (name: string) => string | undefined;
  readonly entityKeys?: readonly string[];
  readonly knownOwners?: readonly RecallIntentKnownOwner[];
  readonly recentConversation?: readonly RecallIntentConversationItem[];
}

const TIME = /(?:之前|曾经|当时|历史|最早|最初|起初|后来|先后|过去|未来|明天|昨天|多久|何时|什么时候)/u;
const CURRENT = /(?:当前|现在|目前|最新|最后|还剩|剩余|现有|最终|此刻|这里)/u;
const TIMELINE = /(?:变化|经过|一路|时间线|先.*后|从.*到)/u;
const RELATIONSHIP = /(?:关系|朋友|敌人|同伴|喜欢|讨厌|信任|认识|属于|父母|兄弟|恋人)/u;
const EVENT = /(?:发生|事件|经历|做过|说过|见过|战斗|离开|抵达|死亡|承诺|答应)/u;
const STATE = /(?:状态|位置|地点|数量|多少|拥有|持有|健康|伤|计划|目标|是否还在)/u;
const CAPABILITY = /(?:能力|能够|能否|能做什么|可以做什么|可以怎样|如何感知|怎样感知|感知范围|协助侦察|侦察能力|功能|作用)/u;
const IDENTITY = /(?:是谁|是什么人|身份|叫什么|哪位)/u;
const DIRECTIVE = /(?:指挥|指令|命令|下令|安排|分工|应对|调度|接下来|下一步|行动)/u;
const KNOWLEDGE = /(?:知道|知不知道|是否知道|记得|回忆|听说|认为|经历过|见过)/u;
const CAUSAL = /(?:为什么|原因|导致|因此|因果|怎么会|缘由|知不知道|是否知道)/u;
const WORLD = /(?:世界|规则|设定|世界观)/u;
const NARRATOR = /(?:旁白|叙事|镜头|读者)/u;
const DEFINITION = /(?:是什么|是什麼|何谓|何謂|定义|定義|含义|含義|原理|机制|機制|指什么|指什麼)/u;
const IMPACT = /(?:影响|影响了|区别|差异|危害|危险|价值|用途|利用|利弊|优缺点)/u;
const PROTECTION = /(?:防护|安全措施|生存原则|物理隔离|防化服|防毒面具|暴露|污染|晶化)/u;
const EXPLICIT_MEMORY = /(?:根据|基于)[^。！？\n]{0,24}(?:当前|已有|你的)?记忆|(?:当前|已有|你的)记忆|回忆一下|你记得|调用记忆/u;
const RESTATEMENT = /(?:概括|总结|缩短|简短|一句话|换句话|重述|复述|刚才|上文|上述)/u;

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))];
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function tokens(value: string): string[] {
  const result = new Set<string>();
  for (const segment of value.normalize('NFKC').matchAll(/[\p{Script=Han}]{2,}|[a-z0-9_:-]{2,}/giu)) result.add(segment[0]!.toLocaleLowerCase());
  return [...result];
}

function quotedActorNames(query: string): string[] {
  const quoted = [...query.matchAll(/[“‘"']([^”’"']{1,32})[”’"']/gu)].map(match => match[1]!.trim());
  const addressed = [...query.matchAll(/(?:^|[，,。！？!?\s])([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·_-]{0,31})(?=[，,：:]|你|您|请)/gu)].map(match => match[1]!.trim());
  return unique([...quoted, ...addressed]);
}

function knownActorMatches(query: string, context: RecallIntentContext): Array<{ ownerId: string; name: string }> {
  const text = normalized(query);
  const matches: Array<{ ownerId: string; name: string }> = [];
  for (const owner of context.knownOwners ?? []) {
    const name = unique(owner.names).sort((left, right) => right.length - left.length)
      .find(candidate => normalized(candidate).length >= 2 && text.includes(normalized(candidate)));
    if (name) matches.push({ ownerId: owner.ownerId, name });
  }
  for (const name of quotedActorNames(query)) {
    const ownerId = context.resolveOwnerName?.(name);
    if (ownerId && !matches.some(match => match.ownerId === ownerId)) matches.push({ ownerId, name });
  }
  return matches;
}

function kinds(query: string): string[] {
  const result: string[] = [];
  if (IDENTITY.test(query)) result.push('identity');
  if (RELATIONSHIP.test(query)) result.push('relationship');
  if (EVENT.test(query)) result.push('event');
  if (DIRECTIVE.test(query)) result.push('event', 'commitment', 'goal');
  if (CAPABILITY.test(query)) result.push('capability');
  if (STATE.test(query)) result.push('state', 'location', 'goal');
  if (WORLD.test(query) || DEFINITION.test(query) || PROTECTION.test(query)) result.push('world_rule');
  return unique(result);
}

function splitSubQueries(query: string): string[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const parts = normalizedQuery
    .split(/[？?；;\n]|(?:，|,)(?=[^，,]{2,}(?:是否|为什么|现在|当前|知不知道|还在))/u)
    .map(value => value.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.slice(0, 8) : [normalizedQuery];
}

function extractTopicTerms(query: string, entityKeys: readonly string[], actorNames: readonly string[]): string[] {
  const cleaned = query.normalize('NFKC')
    .replace(/(?:请你?|麻烦你?|根据(?:当前|已有|你的)?记忆|基于(?:当前|已有|你的)?记忆|用(?:一|1)句话|简短地?|直接|只需要|说明|解释)/gu, ' ')
    .replace(/[。！？!?]/gu, ' ')
    .trim();
  const definitionSubject = cleaned.match(/([^，,；;\s]{1,32}?)(?:是什么|是什麼|何谓|何謂|的?定义|的?定義|的?含义|的?含義|的?原理|的?机制|的?機制|指什么|指什麼)/u)?.[1];
  const causalSubject = cleaned.match(/([^，,；;\s]{1,32}?)(?:为什么|為什麼|为何|為何|怎么会|怎麼會)/u)?.[1];
  const impactSubject = cleaned.match(/([^，,；;\s]{1,32}?)(?:的?影响|的?影響|的?危害|的?危险|的?危險|的?价值|的?價值|的?用途|的?区别|的?區別|的?差异|的?差異)/u)?.[1];
  const affectedObjects = [...cleaned.matchAll(/(?:利用|使用|关于|關於|涉及)([\p{Script=Han}A-Za-z0-9_-]{2,16})/gu)].map(match => match[1]!);
  const normalizedQuery = normalized(query);
  const matchedEntities = entityKeys.filter(key => normalized(key).length >= 2 && normalizedQuery.includes(normalized(key)));
  const subjects = [definitionSubject, causalSubject, impactSubject]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(value => value.trim().replace(/(?:为什么|為什麼|为何|為何|怎么会|怎麼會)$/u, ''))
    .filter(Boolean);
  return unique([...subjects, ...affectedObjects, ...matchedEntities, ...actorNames]).slice(0, 16);
}

function recentContextSatisfied(query: string, topicTerms: readonly string[], context: RecallIntentContext): boolean {
  if (EXPLICIT_MEMORY.test(query) || !RESTATEMENT.test(query)) return false;
  const latestAssistant = [...(context.recentConversation ?? [])].reverse().find(item => item.role === 'assistant' && item.content.trim());
  if (!latestAssistant) return false;
  if (topicTerms.length === 0) return true;
  const content = normalized(latestAssistant.content);
  return topicTerms.some(term => content.includes(normalized(term)));
}

function classifyIntent(query: string, namedOwnerIds: readonly string[], recentSatisfied: boolean): GenerationRecallIntentKind {
  if (recentSatisfied) return 'recent_context';
  if (RELATIONSHIP.test(query) && namedOwnerIds.length > 0) return 'relationship';
  if (KNOWLEDGE.test(query) && namedOwnerIds.length > 0) return 'actor_knowledge';
  if ((IDENTITY.test(query) || STATE.test(query) || CAPABILITY.test(query) || CAUSAL.test(query) || IMPACT.test(query)) && namedOwnerIds.length > 0) return 'actor_entity';
  if (PROTECTION.test(query) && namedOwnerIds.length === 0) return 'world_knowledge';
  if (DIRECTIVE.test(query)) return 'scene_action';
  if (TIMELINE.test(query) || TIME.test(query)) return 'timeline';
  if (WORLD.test(query) || DEFINITION.test(query) || IMPACT.test(query)) return 'world_knowledge';
  return 'general';
}

function actorModeFor(query: string, intentKind: GenerationRecallIntentKind, namedOwnerIds: readonly string[], castPlan?: GenerationCastPlan): GenerationRecallIntentPlan['actorMode'] {
  if (intentKind === 'world_knowledge') return 'world';
  if (NARRATOR.test(query)) return 'narrator';
  if (namedOwnerIds.length > 0) return 'named_actors';
  return castPlan?.requiredOwnerIds.length === 1 ? 'single_pov' : 'planned_cast';
}

function subQueriesFor(parts: readonly string[], names: readonly string[], ownerIds: readonly string[], scope: RecallOwnerScope, requestedKinds: readonly string[]): GenerationRecallSubQuery[] {
  return parts.map((part, index) => {
    const targeted = unique(names.flatMap((name, ownerIndex) => part.includes(name) && ownerIds[ownerIndex] ? [ownerIds[ownerIndex]!] : []));
    return {
      id: `subquery:${index + 1}`,
      query: part,
      targetOwnerIds: targeted.length > 0 ? targeted : [...scope.ownerIds],
      targetKinds: kinds(part).length > 0 ? kinds(part) : requestedKinds,
    };
  });
}

export function planRecallIntentByRules(query: string, context: RecallIntentContext = {}): RecallIntentPlan {
  const facets = new Set<RecallIntentFacet>();
  if (TIME.test(query) || TIMELINE.test(query)) facets.add('time');
  if (RELATIONSHIP.test(query)) facets.add('relationship');
  if (EVENT.test(query)) facets.add('event');
  if (STATE.test(query)) facets.add('state');
  const matches = knownActorMatches(query, context);
  const names = matches.map(match => match.name);
  const namedOwnerIds = unique(matches.map(match => match.ownerId));
  if (namedOwnerIds.length > 0) facets.add('actor');
  const topicTerms = extractTopicTerms(query, context.entityKeys ?? [], names);
  const recentSatisfied = recentContextSatisfied(query, topicTerms, context);
  const intentKind = classifyIntent(query, namedOwnerIds, recentSatisfied);
  const ownerScope = new RecallOwnerScopeResolver().resolve({ intentKind, namedOwnerIds, castPlan: context.castPlan });
  const parts = recentSatisfied ? [] : splitSubQueries(query);
  const multiHop = CAUSAL.test(query) && (parts.length > 1 || namedOwnerIds.length > 1 || facets.size >= 3);
  const complexity = multiHop ? 'multi_hop' : parts.length > 1 || facets.size >= 3 ? 'multi_topic' : 'direct';
  if (complexity !== 'direct') facets.add('complexity');
  const temporal = TIME.test(query) && CURRENT.test(query) ? 'mixed' : TIME.test(query) ? 'historical' : CURRENT.test(query) ? 'current' : 'unspecified';
  const timeMode = TIMELINE.test(query) || temporal === 'mixed' ? 'timeline' : temporal === 'historical' ? 'historical' : temporal === 'current' ? 'current' : 'unknown';
  const requestedKinds = kinds(query);
  return {
    query,
    timeMode,
    actorMode: actorModeFor(query, intentKind, namedOwnerIds, context.castPlan),
    namedOwnerIds,
    entityKeys: unique(context.entityKeys ?? []),
    requestedKinds,
    subQueries: subQueriesFor(parts, names, namedOwnerIds, ownerScope, requestedKinds),
    complexity,
    graphHops: complexity === 'multi_hop' ? 2 : complexity === 'multi_topic' ? 1 : 0,
    requireVerification: complexity !== 'direct' || timeMode === 'timeline',
    terms: unique([...topicTerms, ...tokens(query)]),
    source: 'rules',
    intentKind,
    topicTerms,
    ownerScope,
    recentContextSatisfied: recentSatisfied,
    facets: [...facets],
    actorNames: names,
    temporal,
  };
}

export class LlmRecallIntentPlanner implements RecallIntentLlm {
  constructor(private readonly getLlm: () => MemoryLlmClient | null = readMemoryLlmClient) {}

  async plan(query: string, context: RecallIntentContext = {}): Promise<Partial<RecallIntentPlan>> {
    const llm = this.getLlm();
    if (!llm) throw createSSHelperError('MEMORY_LLM_CLIENT_UNAVAILABLE', { stage: 'memory.recall.intent' });
    const allowedOwnerIds = unique((context.knownOwners ?? []).map(owner => owner.ownerId));
    const response = await llm.runTask<Record<string, unknown>>({
      consumer: MEMORY_PLUGIN_ID,
      taskKey: 'memory_recall_intent',
      taskDescription: '为复杂问题选择记忆召回意图与明确人物，不生成回答',
      taskKind: 'generation',
      input: { messages: [
        { role: 'system', content: '只分类召回意图。人物 ownerId 只能从候选列表选择；不得根据场景在场关系扩大人物范围。' },
        { role: 'user', content: JSON.stringify({ query, owners: (context.knownOwners ?? []).map(owner => ({ ownerId: owner.ownerId, names: owner.names })) }) },
      ] },
      schema: {
        type: 'object', additionalProperties: false,
        required: ['intentKind', 'namedOwnerIds', 'topicTerms', 'complexity', 'graphHops'],
        properties: {
          intentKind: { type: 'string', enum: ['world_knowledge', 'actor_entity', 'actor_knowledge', 'scene_action', 'relationship', 'timeline', 'general'] },
          namedOwnerIds: { type: 'array', maxItems: 16, items: { type: 'string', ...(allowedOwnerIds.length > 0 ? { enum: allowedOwnerIds } : {}) } },
          topicTerms: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 64 } },
          complexity: { type: 'string', enum: ['direct', 'multi_topic', 'multi_hop'] },
          graphHops: { type: 'integer', minimum: 0, maximum: 2 },
        },
      },
      budget: { maxTokens: 400, maxLatencyMs: 3_000 },
      enqueue: { displayMode: 'silent' },
    });
    if (!response.ok) throw response.failure;
    const row = response.data;
    const allowedIntentKinds: GenerationRecallIntentKind[] = ['world_knowledge', 'actor_entity', 'actor_knowledge', 'scene_action', 'relationship', 'timeline', 'general'];
    return {
      intentKind: allowedIntentKinds.includes(row.intentKind as GenerationRecallIntentKind) ? row.intentKind as GenerationRecallIntentKind : undefined,
      namedOwnerIds: Array.isArray(row.namedOwnerIds) ? row.namedOwnerIds.map(String).filter(ownerId => allowedOwnerIds.includes(ownerId)) : [],
      topicTerms: Array.isArray(row.topicTerms) ? row.topicTerms.map(String).map(value => value.trim()).filter(Boolean).slice(0, 16) : [],
      complexity: row.complexity === 'direct' || row.complexity === 'multi_topic' || row.complexity === 'multi_hop' ? row.complexity : undefined,
      graphHops: row.graphHops === 0 || row.graphHops === 1 || row.graphHops === 2 ? row.graphHops : undefined,
    };
  }
}

export async function planRecallIntent(query: string, llm?: RecallIntentLlm, context: RecallIntentContext = {}): Promise<RecallIntentPlan> {
  const deterministic = planRecallIntentByRules(query, context);
  if (!llm || deterministic.complexity === 'direct' || deterministic.intentKind !== 'general') return deterministic;
  try {
    const proposal = await llm.plan(query, context);
    const intentKind = proposal.intentKind && proposal.intentKind !== 'recent_context' ? proposal.intentKind : deterministic.intentKind;
    const allowedOwners = new Set((context.knownOwners ?? []).map(owner => owner.ownerId));
    const namedOwnerIds = unique(proposal.namedOwnerIds ?? deterministic.namedOwnerIds).filter(ownerId => allowedOwners.size === 0 || allowedOwners.has(ownerId));
    const topicTerms = unique(proposal.topicTerms ?? deterministic.topicTerms).slice(0, 16);
    const ownerScope = new RecallOwnerScopeResolver().resolve({ intentKind, namedOwnerIds, castPlan: context.castPlan });
    const complexity = proposal.complexity === 'multi_hop' || proposal.complexity === 'multi_topic' || proposal.complexity === 'direct' ? proposal.complexity : deterministic.complexity;
    return {
      ...deterministic,
      intentKind,
      namedOwnerIds,
      topicTerms,
      ownerScope,
      complexity,
      graphHops: proposal.graphHops === 2 || proposal.graphHops === 1 || proposal.graphHops === 0 ? proposal.graphHops : deterministic.graphHops,
      terms: unique([...topicTerms, ...deterministic.terms]).slice(0, 32),
      subQueries: subQueriesFor(splitSubQueries(query), deterministic.actorNames, namedOwnerIds, ownerScope, deterministic.requestedKinds),
      source: 'llm',
    };
  } catch {
    return { ...deterministic, source: 'rules-fallback' };
  }
}
