export type RecallFactStatus = 'active' | 'pending' | 'superseded' | 'invalid'

export interface RecallScope {
  readonly characterKeys?: readonly string[]
  readonly worldKeys?: readonly string[]
  readonly sceneKeys?: readonly string[]
}

/**
 * Read model consumed by the local recall index. It is intentionally structural
 * so the persistence layer can map its domain record without coupling recall to
 * a repository implementation.
 */
export interface RecallFact {
  readonly id: string
  readonly chatKey: string
  readonly kind: string
  readonly subjectKey: string
  readonly predicateKey: string
  readonly objectKey?: string
  /** Persistence-level subject/predicate conflict slot, when available. */
  readonly slotKey?: string
  readonly content: string
  readonly entityKeys: readonly string[]
  readonly confidence: number
  readonly status: RecallFactStatus
  /** At least one persisted evidence/source reference is required for recall. */
  readonly evidenceRefs?: readonly string[]
  readonly evidenceIds?: readonly string[]
  readonly sourceRefs?: readonly string[]
  readonly stableAnchor?: boolean
  readonly scope?: RecallScope
  readonly validFrom?: number
  readonly validUntil?: number
  readonly updatedAt: number
}

export interface RecallQuery {
  readonly chatKey: string
  readonly query: string
  readonly entityKeys?: readonly string[]
  readonly characterKeys?: readonly string[]
  readonly worldKeys?: readonly string[]
  readonly sceneKeys?: readonly string[]
  readonly maxItems?: number
  readonly now?: number
}

export interface RecallReason {
  readonly lexical: boolean
  readonly vector?: boolean
  readonly graph?: boolean
  readonly entity: boolean
  readonly context: boolean
  readonly stableAnchor: boolean
}

export interface RecallItem {
  readonly fact: RecallFact
  readonly score: number
  readonly reason: RecallReason
  readonly lexicalScore?: number
  readonly vectorScore?: number
  readonly graphScore?: number
  readonly lexicalRank?: number
  readonly vectorRank?: number
  readonly graphRank?: number
  readonly fusionScore?: number
  readonly rerankScore?: number
}

export interface RecallDiagnostics {
  readonly candidateCount: number
  readonly eligibleCount: number
  readonly selectedCount: number
  readonly llmCalls: number
  readonly requestedMode?: 'auto' | 'lexical' | 'vector' | 'hybrid'
  readonly resolvedMode?: 'lexical' | 'vector' | 'hybrid'
  readonly lexicalCandidateCount?: number
  readonly vectorCandidateCount?: number
  readonly graphCandidateCount?: number
  readonly graphHitCount?: number
  readonly graphSeedNodeCount?: number
  readonly graphLatencyMs?: number
  readonly graphDegradedReason?: string
  readonly fusedCandidateCount?: number
  readonly degradedReason?: string
  readonly embedding?: RecallLlmStageDiagnostic
  readonly rerank?: RecallLlmStageDiagnostic
  readonly totalExtraLatencyMs?: number
}

export interface RecallLlmStageDiagnostic {
  readonly requested: boolean
  readonly success: boolean
  readonly cached?: boolean
  readonly requestId?: string
  readonly resourceId?: string
  readonly model?: string
  readonly latencyMs?: number
  readonly usage?: {
    readonly promptTokens: number | null
    readonly completionTokens: number | null
    readonly cacheReadTokens: number | null
    readonly cacheWriteTokens: number | null
    readonly totalTokens: number | null
  } | null
  readonly error?: string
  readonly fallbackUsed?: boolean
}

export interface RecallCandidateDecision {
  readonly factId: string
  readonly score: number
  readonly selected: boolean
  readonly reasonCodes: readonly string[]
  readonly omittedReason?: string
  readonly lexicalScore?: number
  readonly vectorScore?: number
  readonly graphScore?: number
  readonly lexicalRank?: number
  readonly vectorRank?: number
  readonly graphRank?: number
  readonly fusionScore?: number
  readonly rerankScore?: number
}

export interface RecallExternalSignals {
  readonly mode: 'lexical' | 'vector' | 'hybrid'
  readonly vectorScores?: ReadonlyMap<string, number>
  /** Fact ids nominated by the fact-backed relation graph. */
  readonly graphScores?: ReadonlyMap<string, number>
  /** 仅供混合召回编排扩大 rerank 候选池；公开设置仍受 4–30 条约束。 */
  readonly candidateLimit?: number
}

export interface RecallResult {
  readonly chatKey: string
  readonly query: string
  readonly maxItems: number
  readonly createdAt: number
  readonly items: readonly RecallItem[]
  readonly candidates: readonly RecallCandidateDecision[]
  readonly diagnostics: RecallDiagnostics
}

interface IndexedFact {
  readonly fact: RecallFact
  readonly normalizedText: string
  readonly tokenCounts: ReadonlyMap<string, number>
  readonly tokenLength: number
}

const DEFAULT_MAX_ITEMS = 12
const MIN_MAX_ITEMS = 4
const MAX_MAX_ITEMS = 30
const MAX_STABLE_ANCHORS = 3
const MIN_CONFIDENCE = 0.75
const RECENCY_HALF_LIFE_MS = 1000 * 60 * 60 * 24 * 30
const CRITICAL_KINDS = new Set(['identity', 'goal', 'commitment'])
const TEMPORAL_SLOT_KINDS = new Set(['state', 'status', 'location'])
const HISTORICAL_QUERY_PATTERN = /(?:曾经|当时|之前|历史|过程|最早|最初|一开始|中段|先后|一路|变化|如何发展|起初|后来)/u
const CURRENT_STATE_QUERY_PATTERN = /(?:最新状态|最后确认|当前|现在|目前|还剩|剩余|还能|现有|最终确认)/u
const STATE_HISTORY_TOPIC_PATTERN = /(?:状态|数量|多少|几次|次数|弹药|剩余|还剩|变化|一路|先后)/u

const MULTI_TOPIC_FACETS = Object.freeze([
  { id: 'water', query: /(?:饮水|饮用水|水源|纯净水|气泡水)/u, terms: ['饮用水', '纯净水', '气泡水', '水源'], preferOldest: true },
  { id: 'food', query: /(?:食物|口粮|罐头|脱水蔬菜|高热量)/u, terms: ['食物', '口粮', '罐头', '脱水蔬菜', '高热量'], preferOldest: true },
  { id: 'melee', query: /(?:近战|折叠刀|战术短刃|长矛|裂空之矛)/u, terms: ['近战', '折叠刀', '战术短刃', '长矛', '裂空之矛'], preferOldest: true },
  { id: 'power', query: /(?:供能|能源|电源|电池|太阳能|燃料电池)/u, terms: ['能源', '电源', '电池', '太阳能', '燃料电池'], preferOldest: true },
  { id: 'pool-final', query: /(?:泳池|沈夜|敌人最终|最终结局)/u, terms: ['沈夜', '碎裂', '死亡', '二段孵化', '排污阀'] },
  { id: 'pool-core', query: /(?:危险核心|遗留核心|黯欲之种)/u, terms: ['黯欲之种', '危险核心', '紫黑', '精神污染'] },
  { id: 'green-origin', query: /(?:绿色小女孩|人类幼体|来源|从何而来)/u, terms: ['紫罗', '分化', '人类幼体', '本体枯萎'] },
  { id: 'building-radar', query: /(?:雷达|扫描整栋楼|三维热源)/u, terms: ['雷达', '扫描', '整栋楼', '三维热源'] },
  { id: 'charged-gun', query: /(?:紫能高压手枪|紫色高压手枪|剩余次数|还能开几次)/u, terms: ['紫能高压手枪', '核心碎裂', '重新压入核心', '剩余', '击发'] },
] as const)

function requestedFacets(query: string): readonly (typeof MULTI_TOPIC_FACETS)[number][] {
  return MULTI_TOPIC_FACETS.filter(facet => facet.query.test(query))
}

function facetMatchScore(item: RecallItem, terms: readonly string[]): number {
  const text = [item.fact.content, item.fact.subjectKey, item.fact.predicateKey, item.fact.objectKey ?? '', ...item.fact.entityKeys]
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase()
  return terms.reduce((score, term) => score + (text.includes(term.toLocaleLowerCase()) ? 1 : 0), 0)
}

const CJK_STOP_CHARS = new Set([
  '的', '了', '在', '是', '和', '与', '及', '要', '什', '么', '怎', '样', '吗', '呢', '啊', '今', '天',
  '当', '前', '这', '那', '个', '一', '些', '有', '无', '我', '你', '他', '她', '它', '们', '就', '都', '又', '很',
])

function clampMaxItems(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ITEMS
  return Math.min(MAX_MAX_ITEMS, Math.max(MIN_MAX_ITEMS, Math.trunc(value)))
}

function normalizedKeys(keys: readonly string[] | undefined): Set<string> {
  return new Set((keys ?? []).map(key => key.trim().toLocaleLowerCase()).filter(Boolean))
}

function tokenize(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const tokens: string[] = []

  for (const match of normalized.matchAll(/[a-z0-9_:-]+|[\p{Script=Han}]+/gu)) {
    const segment = match[0]
    if (/^[a-z0-9_:-]+$/.test(segment)) {
      if (segment.length > 1) tokens.push(segment)
      continue
    }

    const chars = [...segment]
    for (const char of chars) {
      if (!CJK_STOP_CHARS.has(char)) tokens.push(char)
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      const left = chars[index]
      const right = chars[index + 1]
      if (left !== undefined && right !== undefined && !CJK_STOP_CHARS.has(left) && !CJK_STOP_CHARS.has(right)) {
        tokens.push(`${left}${right}`)
      }
    }
  }

  return tokens
}

/**
 * 提取用户明确声明的专名。此类查询的核心约束是“这个名字是否存在”，
 * 不能因为人物名或通用动词命中就注入同一人物的其他记忆。
 */
function explicitNamedTerms(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const terms = new Set<string>()
  const patterns = [
    /[“‘"']([\p{Script=Han}a-z0-9_:-]{2,32})[”’"']/gu,
    /(?:名为|名叫|叫做|称为|代号为|编号为)\s*([\p{Script=Han}a-z0-9_:-]{2,32}?)(?=的|[，。？！,!?；;\s]|$)/gu,
  ]

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const term = match[1]?.trim()
      if (term) terms.add(term)
    }
  }

  const directNamedEntity = normalized.match(
    /^(?:请问|我想知道|请告诉我)?\s*([\p{Script=Han}a-z0-9_:-]{2,31}号)\s*(?:宇宙飞船|飞船|舰船|列车|车辆|机体)?\s*(?=目前|当前|现在|还剩|剩余|停在|停靠|位于|在哪里|在哪儿)/u,
  )?.[1]?.trim()
  if (directNamedEntity) terms.add(directNamedEntity)

  return [...terms]
}

function hasMinimumLexicalOverlap(queryTokens: readonly string[], documentTokens: ReadonlyMap<string, number>): boolean {
  let strongMatches = 0
  let singleHanMatches = 0

  for (const token of new Set(queryTokens)) {
    if (!documentTokens.has(token)) continue
    if (/^[\p{Script=Han}]{2,}$/u.test(token) || /^[a-z0-9_:-]{2,}$/u.test(token)) strongMatches += 1
    else if (/^[\p{Script=Han}]$/u.test(token)) singleHanMatches += 1
  }

  return strongMatches > 0 || singleHanMatches >= 2
}

function tokenCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size > right.size) return intersects(right, left)
  for (const value of left) if (right.has(value)) return true
  return false
}

function overlapRatio(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let overlap = 0
  for (const value of left) if (right.has(value)) overlap += 1
  return overlap / Math.max(1, Math.min(left.size, right.size))
}

function scopeScore(fact: RecallFact, query: RecallQuery): number {
  if (!fact.scope) return 0
  const factCharacters = normalizedKeys(fact.scope.characterKeys)
  const factWorlds = normalizedKeys(fact.scope.worldKeys)
  const factScenes = normalizedKeys(fact.scope.sceneKeys)
  const queryCharacters = normalizedKeys(query.characterKeys)
  const queryWorlds = normalizedKeys(query.worldKeys)
  const queryScenes = normalizedKeys(query.sceneKeys)

  let score = 0
  let dimensions = 0
  if (factCharacters.size > 0) {
    dimensions += 1
    if (intersects(factCharacters, queryCharacters)) score += 1
  }
  if (factWorlds.size > 0) {
    dimensions += 1
    if (intersects(factWorlds, queryWorlds)) score += 1
  }
  if (factScenes.size > 0) {
    dimensions += 1
    if (intersects(factScenes, queryScenes)) score += 1
  }
  return dimensions === 0 ? 0 : score / dimensions
}

function hasMatchingAnchorScope(fact: RecallFact, query: RecallQuery): boolean {
  if (!fact.stableAnchor || !fact.scope) return false
  return scopeScore(fact, query) > 0
}

function isEligible(fact: RecallFact, query: RecallQuery, now: number): boolean {
  const evidenceCount = (fact.evidenceRefs?.length ?? 0)
    + (fact.evidenceIds?.length ?? 0)
    + (fact.sourceRefs?.length ?? 0)
  const historical = HISTORICAL_QUERY_PATTERN.test(query.query)
  return fact.chatKey === query.chatKey
    && (fact.status === 'active' || (historical && fact.status === 'superseded'))
    && fact.confidence >= MIN_CONFIDENCE
    && evidenceCount > 0
    && (fact.validFrom === undefined || fact.validFrom <= now)
    && (historical || fact.validUntil === undefined || fact.validUntil >= now)
}

/**
 * 优先沿用持久层已经校验过的 slotKey。旧数据没有 slotKey 时，带有效期的
 * 事实及 state/status/location 仍按主语 + 谓词兜底，避免两个 active 值
 * 同时进入 Prompt。
 */
function temporalSlotKey(fact: RecallFact): string | null {
  const kind = fact.kind.trim().toLocaleLowerCase()
  const persistedSlot = fact.slotKey?.trim().toLocaleLowerCase()
  const temporal = Boolean(persistedSlot)
    || fact.validFrom !== undefined
    || fact.validUntil !== undefined
    || TEMPORAL_SLOT_KINDS.has(kind)
  if (!temporal) return null

  const scope = fact.scope
  const scopeKey = [
    ...(scope?.characterKeys ?? []),
    ...(scope?.worldKeys ?? []),
    ...(scope?.sceneKeys ?? []),
  ]
    .map(key => key.trim().toLocaleLowerCase())
    .filter(Boolean)
    .sort()
    .join('|')
  return [
    fact.chatKey.trim().toLocaleLowerCase(),
    persistedSlot ?? [
      fact.subjectKey.trim().toLocaleLowerCase(),
      fact.predicateKey.trim().toLocaleLowerCase(),
    ].join('|'),
    scopeKey,
  ].join('\u0000')
}

function isNewerTemporalFact(left: RecallFact, right: RecallFact): boolean {
  const leftEffectiveAt = left.validFrom ?? left.updatedAt
  const rightEffectiveAt = right.validFrom ?? right.updatedAt
  return leftEffectiveAt > rightEffectiveAt
    || (leftEffectiveAt === rightEffectiveAt && left.updatedAt > right.updatedAt)
    || (leftEffectiveAt === rightEffectiveAt && left.updatedAt === right.updatedAt && left.id > right.id)
}

function isStateSnapshotFact(fact: RecallFact): boolean {
  return fact.kind.trim().toLocaleLowerCase() === 'state'
    && (fact.sourceRefs ?? fact.evidenceRefs ?? []).some(sourceRef => sourceRef.startsWith('state:'))
}

function normalizedSubject(fact: RecallFact): string {
  return fact.subjectKey.trim().toLocaleLowerCase()
}

function isCoveredBySnapshot(fact: RecallFact, snapshot: RecallFact): boolean {
  if (fact.id === snapshot.id || !isNewerTemporalFact(snapshot, fact)) return false
  const subject = normalizedSubject(snapshot)
  if (!subject) return false
  return normalizedSubject(fact) === subject || normalizedKeys(fact.entityKeys).has(subject)
}

function ineligibleReason(fact: RecallFact, query: RecallQuery, now: number): string | null {
  if (fact.chatKey !== query.chatKey) return '不属于当前聊天'
  const historical = HISTORICAL_QUERY_PATTERN.test(query.query)
  if (fact.status !== 'active' && !(historical && fact.status === 'superseded')) return `状态为 ${fact.status}`
  if (fact.confidence < MIN_CONFIDENCE) return '置信度低于 0.75'
  const evidenceCount = (fact.evidenceRefs?.length ?? 0)
    + (fact.evidenceIds?.length ?? 0)
    + (fact.sourceRefs?.length ?? 0)
  if (evidenceCount === 0) return '缺少来源证据'
  if (fact.validFrom !== undefined && fact.validFrom > now) return '尚未生效'
  if (!historical && fact.validUntil !== undefined && fact.validUntil < now) return '已经失效'
  return null
}

function freezeFact(fact: RecallFact): RecallFact {
  const scope = fact.scope
    ? Object.freeze({
        characterKeys: Object.freeze([...(fact.scope.characterKeys ?? [])]),
        worldKeys: Object.freeze([...(fact.scope.worldKeys ?? [])]),
        sceneKeys: Object.freeze([...(fact.scope.sceneKeys ?? [])]),
      })
    : undefined
  const frozen = {
    ...fact,
    entityKeys: Object.freeze([...fact.entityKeys]),
    ...(fact.evidenceRefs ? { evidenceRefs: Object.freeze([...fact.evidenceRefs]) } : {}),
    ...(fact.evidenceIds ? { evidenceIds: Object.freeze([...fact.evidenceIds]) } : {}),
    ...(fact.sourceRefs ? { sourceRefs: Object.freeze([...fact.sourceRefs]) } : {}),
    ...(scope ? { scope } : {}),
  }
  return Object.freeze(frozen)
}

function freezeItem(item: RecallItem): RecallItem {
  return Object.freeze({
    ...item,
    fact: freezeFact(item.fact),
    reason: Object.freeze({ ...item.reason }),
  })
}

/** Incrementally maintained, per-session local index. Recall never invokes an LLM. */
export class MemoryRecallIndex {
  private readonly records = new Map<string, IndexedFact>()
  private readonly postings = new Map<string, Set<string>>()
  private readonly chatIds = new Map<string, Set<string>>()
  private readonly entityIds = new Map<string, Set<string>>()
  private readonly characterIds = new Map<string, Set<string>>()
  private readonly worldIds = new Map<string, Set<string>>()
  private readonly sceneIds = new Map<string, Set<string>>()
  private totalTokenLength = 0

  constructor(facts: Iterable<RecallFact> = []) {
    for (const fact of facts) this.upsert(fact)
  }

  get size(): number {
    return this.records.size
  }

  upsert(fact: RecallFact): void {
    this.remove(fact.id)

    const document = [
      fact.content,
      fact.kind,
      fact.subjectKey,
      fact.predicateKey,
      fact.objectKey ?? '',
      ...fact.entityKeys,
    ].join(' ')
    const tokens = tokenize(document)
    const indexed: IndexedFact = {
      fact: {
        ...fact,
        entityKeys: [...fact.entityKeys],
        ...(fact.evidenceRefs ? { evidenceRefs: [...fact.evidenceRefs] } : {}),
        ...(fact.evidenceIds ? { evidenceIds: [...fact.evidenceIds] } : {}),
        ...(fact.sourceRefs ? { sourceRefs: [...fact.sourceRefs] } : {}),
      },
      normalizedText: document.normalize('NFKC').toLocaleLowerCase(),
      tokenCounts: tokenCounts(tokens),
      tokenLength: tokens.length,
    }
    this.records.set(fact.id, indexed)
    this.totalTokenLength += indexed.tokenLength

    for (const token of indexed.tokenCounts.keys()) this.addToIndex(this.postings, token, fact.id)
    this.addToIndex(this.chatIds, fact.chatKey, fact.id)
    for (const entityKey of normalizedKeys(fact.entityKeys)) this.addToIndex(this.entityIds, entityKey, fact.id)
    for (const key of normalizedKeys(fact.scope?.characterKeys)) this.addToIndex(this.characterIds, key, fact.id)
    for (const key of normalizedKeys(fact.scope?.worldKeys)) this.addToIndex(this.worldIds, key, fact.id)
    for (const key of normalizedKeys(fact.scope?.sceneKeys)) this.addToIndex(this.sceneIds, key, fact.id)
  }

  remove(factId: string): boolean {
    const existing = this.records.get(factId)
    if (!existing) return false

    this.records.delete(factId)
    this.totalTokenLength -= existing.tokenLength
    for (const token of existing.tokenCounts.keys()) this.removeFromIndex(this.postings, token, factId)
    this.removeFromIndex(this.chatIds, existing.fact.chatKey, factId)
    for (const entityKey of normalizedKeys(existing.fact.entityKeys)) this.removeFromIndex(this.entityIds, entityKey, factId)
    for (const key of normalizedKeys(existing.fact.scope?.characterKeys)) this.removeFromIndex(this.characterIds, key, factId)
    for (const key of normalizedKeys(existing.fact.scope?.worldKeys)) this.removeFromIndex(this.worldIds, key, factId)
    for (const key of normalizedKeys(existing.fact.scope?.sceneKeys)) this.removeFromIndex(this.sceneIds, key, factId)
    return true
  }

  replace(facts: Iterable<RecallFact>): void {
    this.records.clear()
    this.postings.clear()
    this.chatIds.clear()
    this.entityIds.clear()
    this.characterIds.clear()
    this.worldIds.clear()
    this.sceneIds.clear()
    this.totalTokenLength = 0
    for (const fact of facts) this.upsert(fact)
  }

  recall(query: RecallQuery, signals?: RecallExternalSignals): RecallResult {
    const createdAt = query.now ?? Date.now()
    const maxItems = signals?.candidateLimit === undefined
      ? clampMaxItems(query.maxItems)
      : Math.min(60, Math.max(1, Math.trunc(signals.candidateLimit)))
    const mode = signals?.mode ?? 'lexical'
    const vectorScores = signals?.vectorScores ?? new Map<string, number>()
    const graphScores = signals?.graphScores ?? new Map<string, number>()
    const facets = requestedFacets(query.query)
    const queryTokens = [...new Set([
      ...tokenize(query.query),
      ...(facets.length >= 2 ? facets.flatMap(facet => facet.terms.flatMap(term => tokenize(term))) : []),
    ])]
    const namedTerms = explicitNamedTerms(query.query)
    const queryEntities = normalizedKeys(query.entityKeys)
    const normalizedQueryTextForEntities = query.query.normalize('NFKC').toLocaleLowerCase()
    for (const entityKey of this.entityIds.keys()) {
      if (entityKey.length >= 2 && normalizedQueryTextForEntities.includes(entityKey)) queryEntities.add(entityKey)
    }
    const lexicalCandidateIds = new Set<string>()

    for (const token of queryTokens) {
      for (const factId of this.postings.get(token) ?? []) lexicalCandidateIds.add(factId)
    }
    for (const entityKey of queryEntities) {
      for (const factId of this.entityIds.get(entityKey) ?? []) lexicalCandidateIds.add(factId)
    }
    this.addScopeCandidates(lexicalCandidateIds, this.characterIds, query.characterKeys)
    this.addScopeCandidates(lexicalCandidateIds, this.worldIds, query.worldKeys)
    this.addScopeCandidates(lexicalCandidateIds, this.sceneIds, query.sceneKeys)
    const preserveHistoricalStates = HISTORICAL_QUERY_PATTERN.test(query.query)
    const requestsCurrentState = CURRENT_STATE_QUERY_PATTERN.test(query.query)
    const needsTemporalSafety = requestsCurrentState
      || (preserveHistoricalStates && STATE_HISTORY_TOPIC_PATTERN.test(query.query))
    const candidateIds = mode === 'vector'
      ? new Set<string>()
      : new Set(lexicalCandidateIds)
    if (mode !== 'lexical') {
      for (const [factId, score] of vectorScores) {
        if (Number.isFinite(score) && score > 0) candidateIds.add(factId)
      }
    }
    for (const [factId, score] of graphScores) {
      if (Number.isFinite(score) && score > 0) candidateIds.add(factId)
    }
    if (mode === 'vector' && needsTemporalSafety) {
      for (const factId of lexicalCandidateIds) {
        const fact = this.records.get(factId)?.fact
        if (fact && (temporalSlotKey(fact) !== null || isStateSnapshotFact(fact))) candidateIds.add(factId)
      }
    }

    const averageDocumentLength = this.records.size === 0
      ? 1
      : Math.max(1, this.totalTokenLength / this.records.size)
    const regular: RecallItem[] = []
    const anchors: RecallItem[] = []
    const omitted: RecallCandidateDecision[] = []
    let eligibleCount = 0
    const temporalWinners = new Map<string, RecallFact>()
    const stateSnapshotWinners = new Map<string, RecallFact>()

    for (const factId of candidateIds) {
      const fact = this.records.get(factId)?.fact
      if (!fact || !isEligible(fact, query, createdAt)) continue
      if (isStateSnapshotFact(fact)) {
        const subject = normalizedSubject(fact)
        const currentSnapshot = stateSnapshotWinners.get(subject)
        if (subject && (!currentSnapshot || isNewerTemporalFact(fact, currentSnapshot))) stateSnapshotWinners.set(subject, fact)
      }
      const slotKey = temporalSlotKey(fact)
      if (!slotKey) continue
      const current = temporalWinners.get(slotKey)
      if (!current || isNewerTemporalFact(fact, current)) temporalWinners.set(slotKey, fact)
    }

    for (const factId of candidateIds) {
      const indexed = this.records.get(factId)
      if (!indexed) continue
      const eligibilityReason = ineligibleReason(indexed.fact, query, createdAt)
      if (eligibilityReason || !isEligible(indexed.fact, query, createdAt)) {
        omitted.push(Object.freeze({ factId, score: 0, selected: false, reasonCodes: Object.freeze([]), omittedReason: eligibilityReason ?? '不符合召回条件' }))
        continue
      }
      eligibleCount += 1
      const snapshotWinner = [...stateSnapshotWinners.values()].find(snapshot => isCoveredBySnapshot(indexed.fact, snapshot))
      if (!preserveHistoricalStates && snapshotWinner && !isStateSnapshotFact(indexed.fact)) {
        omitted.push(Object.freeze({
          factId,
          score: 0,
          selected: false,
          reasonCodes: Object.freeze([]),
          omittedReason: '最新变量状态已覆盖更早事实',
        }))
        continue
      }
      const slotKey = temporalSlotKey(indexed.fact)
      if (!preserveHistoricalStates && slotKey && temporalWinners.get(slotKey)?.id !== indexed.fact.id) {
        omitted.push(Object.freeze({
          factId,
          score: 0,
          selected: false,
          reasonCodes: Object.freeze([]),
          omittedReason: '同一时序槽位已有更新事实',
        }))
        continue
      }

      const lexicalScore = this.bm25(indexed, queryTokens, averageDocumentLength)
      const factEntities = normalizedKeys(indexed.fact.entityKeys)
      const entityScore = overlapRatio(queryEntities, factEntities)
      const contextScore = scopeScore(indexed.fact, query)
      const matchingAnchor = hasMatchingAnchorScope(indexed.fact, query)
      const lexical = lexicalScore > 0
      const vectorScore = vectorScores.get(indexed.fact.id)
      const vector = mode !== 'lexical' && vectorScore !== undefined && Number.isFinite(vectorScore) && vectorScore > 0
      const graphScore = graphScores.get(indexed.fact.id)
      const graph = graphScore !== undefined && Number.isFinite(graphScore) && graphScore > 0
      const entity = entityScore > 0
      const context = contextScore > 0

      if (namedTerms.length > 0 && !namedTerms.some(term => indexed.normalizedText.includes(term))) {
        omitted.push(Object.freeze({
          factId,
          score: 0,
          selected: false,
          reasonCodes: Object.freeze([]),
          omittedReason: '未命中查询中明确命名的实体',
        }))
        continue
      }
      if (lexical && !vector && !graph && !entity && !context && !matchingAnchor && !hasMinimumLexicalOverlap(queryTokens, indexed.tokenCounts)) {
        omitted.push(Object.freeze({
          factId,
          score: 0,
          selected: false,
          reasonCodes: Object.freeze([]),
          omittedReason: '词项重合低于召回硬门槛',
        }))
        continue
      }

      if (!lexical && !vector && !graph && !entity && !context && !matchingAnchor) {
        omitted.push(Object.freeze({ factId, score: 0, selected: false, reasonCodes: Object.freeze([]), omittedReason: '与本轮查询无相关性' }))
        continue
      }
      if (indexed.fact.stableAnchor && !matchingAnchor) {
        omitted.push(Object.freeze({ factId, score: 0, selected: false, reasonCodes: Object.freeze([]), omittedReason: '稳定锚点与当前作用域不匹配' }))
        continue
      }

      const age = Math.max(0, createdAt - indexed.fact.updatedAt)
      const recencyScore = Math.pow(0.5, age / RECENCY_HALF_LIFE_MS)
      const temporalScore = indexed.fact.validFrom !== undefined || indexed.fact.validUntil !== undefined ? 1 : 0.5
      const normalizedLexical = lexicalScore / (lexicalScore + 3)
      const score = normalizedLexical * 0.58
        + entityScore * 0.18
        + contextScore * 0.14
        + temporalScore * 0.05
        + recencyScore * 0.05
        + (matchingAnchor ? 0.04 : 0)
        + (isStateSnapshotFact(indexed.fact) ? 0.12 : 0)
      const item: RecallItem = {
        fact: indexed.fact,
        score,
        lexicalScore: score,
        ...(vector ? { vectorScore } : {}),
        ...(graph ? { graphScore } : {}),
        reason: { lexical, vector, graph, entity, context, stableAnchor: matchingAnchor },
      }

      if (matchingAnchor) anchors.push(item)
      else regular.push(item)
    }

    const byScore = (left: RecallItem, right: RecallItem): number =>
      right.score - left.score
      || right.fact.updatedAt - left.fact.updatedAt
      || left.fact.id.localeCompare(right.fact.id)
    const allEligible = [...anchors, ...regular]
    const lexicalRanked = allEligible.filter(item => lexicalCandidateIds.has(item.fact.id)).sort(byScore)
    const vectorRanked = allEligible
      .filter(item => item.vectorScore !== undefined)
      .sort((left, right) => (right.vectorScore ?? 0) - (left.vectorScore ?? 0)
        || right.fact.updatedAt - left.fact.updatedAt
        || left.fact.id.localeCompare(right.fact.id))
    const graphRanked = allEligible
      .filter(item => item.graphScore !== undefined)
      .sort((left, right) => (right.graphScore ?? 0) - (left.graphScore ?? 0)
        || right.fact.updatedAt - left.fact.updatedAt
        || left.fact.id.localeCompare(right.fact.id))
    const lexicalRanks = new Map(lexicalRanked.map((item, index) => [item.fact.id, index + 1]))
    const vectorRanks = new Map(vectorRanked.map((item, index) => [item.fact.id, index + 1]))
    const graphRanks = new Map(graphRanked.map((item, index) => [item.fact.id, index + 1]))
    const applyModeScore = (item: RecallItem): RecallItem => {
      const lexicalRank = lexicalRanks.get(item.fact.id)
      const vectorRank = vectorRanks.get(item.fact.id)
      const graphRank = graphRanks.get(item.fact.id)
      const fusionScore = mode === 'hybrid'
        ? (lexicalRank === undefined ? 0 : 0.4 / (60 + lexicalRank))
          + (vectorRank === undefined ? 0 : 0.4 / (60 + vectorRank))
          + (graphRank === undefined ? 0 : 0.2 / (60 + graphRank))
        : undefined
      const score = mode === 'vector'
        ? item.vectorScore ?? 0
        : mode === 'hybrid'
          ? fusionScore ?? 0
          : item.score
      return {
        ...item,
        score,
        ...(lexicalRank === undefined ? {} : { lexicalRank }),
        ...(vectorRank === undefined ? {} : { vectorRank }),
        ...(graphRank === undefined ? {} : { graphRank }),
        ...(fusionScore === undefined ? {} : { fusionScore }),
      }
    }
    anchors.splice(0, anchors.length, ...anchors.map(applyModeScore))
    regular.splice(0, regular.length, ...regular.map(applyModeScore))
    anchors.sort(byScore)
    regular.sort(byScore)

    const selectedAnchors = anchors.slice(0, Math.min(MAX_STABLE_ANCHORS, maxItems))
    const regularCutoff = mode === 'lexical'
      ? preserveHistoricalStates
        ? 0.08
        : Math.max(0.08, (regular[0]?.score ?? 0) * 0.82)
      : 0
    const normalizedQueryText = query.query.normalize('NFKC').toLocaleLowerCase()
    const explicitlyNamedCriticalSubject = (item: RecallItem): boolean =>
      CRITICAL_KINDS.has(item.fact.kind.toLocaleLowerCase())
      && normalizedQueryText.includes(item.fact.subjectKey.normalize('NFKC').toLocaleLowerCase())
    const isTemporalSafetyItem = (item: RecallItem): boolean => mode !== 'lexical'
      && needsTemporalSafety
      && lexicalCandidateIds.has(item.fact.id)
      && (temporalSlotKey(item.fact) !== null || isStateSnapshotFact(item.fact))
    const relevantRegular = regular.filter(item => mode === 'vector'
      ? item.reason.vector || isTemporalSafetyItem(item)
      : item.score > regularCutoff || item.reason.entity || item.reason.context || explicitlyNamedCriticalSubject(item))
    const temporalSafetyLimit = preserveHistoricalStates ? 2 : 1
    const temporalSafetyItems = relevantRegular
      .filter(isTemporalSafetyItem)
      .sort((left, right) => (right.lexicalScore ?? 0) - (left.lexicalScore ?? 0)
        || right.fact.updatedAt - left.fact.updatedAt
        || left.fact.id.localeCompare(right.fact.id))
      .slice(0, temporalSafetyLimit)
    const temporalSafetyIds = new Set(temporalSafetyItems.map(item => item.fact.id))
    const initialHistoryQuery = /(?:最早|最初|一开始|起初)/u.test(query.query)
    const diversifiedItems: RecallItem[] = []
    if (facets.length >= 2) {
      for (const facet of facets) {
        const best = relevantRegular
          .filter(item => !diversifiedItems.some(selected => selected.fact.id === item.fact.id))
          .map(item => ({ item, facetScore: facetMatchScore(item, facet.terms) }))
          .filter(entry => entry.facetScore > 0)
          .sort((left, right) => (initialHistoryQuery && 'preferOldest' in facet && facet.preferOldest
            ? left.item.fact.updatedAt - right.item.fact.updatedAt
            : 0)
            || right.facetScore - left.facetScore
            || right.item.score - left.item.score
            || left.item.fact.id.localeCompare(right.item.fact.id))[0]?.item
        if (best) diversifiedItems.push(best)
      }
    }
    const diversifiedIds = new Set(diversifiedItems.map(item => item.fact.id))
    const selectedRegular = [
      ...diversifiedItems,
      ...temporalSafetyItems.filter(item => !diversifiedIds.has(item.fact.id)),
      ...relevantRegular.filter(item => !temporalSafetyIds.has(item.fact.id) && !diversifiedIds.has(item.fact.id)),
    ].slice(0, maxItems - selectedAnchors.length)
    const items = Object.freeze([...selectedAnchors, ...selectedRegular].map(freezeItem))
    const selectedIds = new Set(items.map(item => item.fact.id))
    const candidates = Object.freeze([
      ...[...anchors, ...regular].map(item => Object.freeze({
        factId: item.fact.id,
        score: item.score,
        selected: selectedIds.has(item.fact.id),
        reasonCodes: Object.freeze(Object.entries(item.reason).filter(([, matched]) => matched).map(([reason]) => reason)),
        ...(item.lexicalScore === undefined ? {} : { lexicalScore: item.lexicalScore }),
        ...(item.vectorScore === undefined ? {} : { vectorScore: item.vectorScore }),
        ...(item.graphScore === undefined ? {} : { graphScore: item.graphScore }),
        ...(item.lexicalRank === undefined ? {} : { lexicalRank: item.lexicalRank }),
        ...(item.vectorRank === undefined ? {} : { vectorRank: item.vectorRank }),
        ...(item.graphRank === undefined ? {} : { graphRank: item.graphRank }),
        ...(item.fusionScore === undefined ? {} : { fusionScore: item.fusionScore }),
        ...(selectedIds.has(item.fact.id)
          ? {}
          : {
              omittedReason: item.score < regularCutoff
                && !item.reason.stableAnchor
                && !item.reason.entity
                && !item.reason.context
                && !explicitlyNamedCriticalSubject(item)
                ? '相关性低于本轮阈值'
                : '超过召回条目上限',
            }),
      })),
      ...omitted,
    ])
    const diagnostics = Object.freeze({
      candidateCount: candidateIds.size,
      eligibleCount,
      selectedCount: items.length,
      llmCalls: 0 as const,
      requestedMode: mode,
      resolvedMode: mode,
      lexicalCandidateCount: lexicalCandidateIds.size,
      vectorCandidateCount: vectorScores.size,
      graphCandidateCount: graphScores.size,
      fusedCandidateCount: mode === 'hybrid' ? candidateIds.size : undefined,
    })

    return Object.freeze({
      chatKey: query.chatKey,
      query: query.query,
      maxItems,
      createdAt,
      items,
      candidates,
      diagnostics,
    })
  }

  private bm25(indexed: IndexedFact, queryTokens: readonly string[], averageDocumentLength: number): number {
    if (queryTokens.length === 0) return 0
    const k1 = 1.2
    const b = 0.75
    let score = 0
    const documentCount = Math.max(1, this.records.size)

    for (const token of queryTokens) {
      const frequency = indexed.tokenCounts.get(token) ?? 0
      if (frequency === 0) continue
      const documentFrequency = this.postings.get(token)?.size ?? 0
      const inverseDocumentFrequency = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
      const denominator = frequency + k1 * (1 - b + b * indexed.tokenLength / averageDocumentLength)
      score += inverseDocumentFrequency * frequency * (k1 + 1) / denominator
    }
    return score
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, factId: string): void {
    const values = index.get(key) ?? new Set<string>()
    values.add(factId)
    index.set(key, values)
  }

  private addScopeCandidates(
    candidates: Set<string>,
    index: ReadonlyMap<string, ReadonlySet<string>>,
    keys: readonly string[] | undefined,
  ): void {
    for (const key of normalizedKeys(keys)) {
      for (const factId of index.get(key) ?? []) candidates.add(factId)
    }
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, factId: string): void {
    const values = index.get(key)
    if (!values) return
    values.delete(factId)
    if (values.size === 0) index.delete(key)
  }
}

export const recallLimits = Object.freeze({
  default: DEFAULT_MAX_ITEMS,
  min: MIN_MAX_ITEMS,
  max: MAX_MAX_ITEMS,
  stableAnchors: MAX_STABLE_ANCHORS,
})
