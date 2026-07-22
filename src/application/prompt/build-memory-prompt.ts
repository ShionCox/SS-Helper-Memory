import type { RecallItem, RecallResult } from '../recall/memory-recall-index'
import type { ActorMemoryPartition, ActorRecallResponse, MemoryRecallPacket } from '../../domain'

const ONGOING_KINDS = new Set([
  'commitment',
  'goal',
  'objective',
  'plan',
  'promise',
  'task',
  'ongoing',
])

const DEFAULT_PROMPT_MAX_CHARS = 8_000
const BUDGET_OMITTED_REASON = '超过 Prompt 字符预算'

export type MemoryPromptAnswerMode = 'auto' | 'roleplay' | 'diagnostic'

export interface MemoryPromptOptions {
  /** Prompt 注入的硬字符上限；条目只会整条加入，不会截断事实原文。 */
  readonly maxChars?: number
  /** auto 会根据用户本轮是否要求核验、直答或简短回答自动选择。 */
  readonly answerMode?: MemoryPromptAnswerMode
  readonly currentIdentity?: { readonly name: string; readonly description?: string }
}

export interface MemoryPromptOmission {
  readonly factId: string
  readonly omittedReason: typeof BUDGET_OMITTED_REASON
}

export interface MemoryPromptDiagnostics {
  readonly maxChars: number
  readonly usedChars: number
  readonly includedCount: number
  readonly omittedCount: number
  readonly omittedReason?: typeof BUDGET_OMITTED_REASON
  readonly answerMode: Exclude<MemoryPromptAnswerMode, 'auto'>
}

export interface MemoryPromptBuildResult {
  readonly prompt: string
  readonly includedFactIds: readonly string[]
  readonly omitted: readonly MemoryPromptOmission[]
  readonly diagnostics: MemoryPromptDiagnostics
}

interface PromptSection {
  readonly title: string
  readonly items: readonly RecallItem[]
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PROMPT_MAX_CHARS
  return Math.max(0, Math.trunc(value))
}

function isDiagnosticQuery(query: string): boolean {
  const normalized = query.normalize('NFKC').toLocaleLowerCase()
  return /(?:简短回答|直接回答|只回答|一句话|是否|有没有|有无|核验|验证|如果没有(?:证据)?|没有证据|不要解释|do(?:es)?\b|is\b|are\b|verify|evidence)/u.test(normalized)
}

function resolveAnswerMode(result: RecallResult, mode: MemoryPromptAnswerMode | undefined): 'roleplay' | 'diagnostic' {
  if (mode === 'diagnostic' || mode === 'roleplay') return mode
  return isDiagnosticQuery(result.query) ? 'diagnostic' : 'roleplay'
}

function promptIntro(answerMode: 'roleplay' | 'diagnostic', identity?: MemoryPromptOptions['currentIdentity']): string[] {
  const common = '以下是有原文证据支持的历史记忆。当前对话内容优先于历史记忆；如有冲突，以当前对话为准。不得补造缺失细节。'
  const identityLine = identity?.name ? [`当前回复用户：${identity.name}${identity.description ? `；Persona：${identity.description}` : ''}`] : []
  if (answerMode === 'roleplay') return [...identityLine, common]
  return [
    ...identityLine,
    common,
    '本轮是事实核验或诊断请求：回答必须从面向用户的自然语言直答开始，并在回答完问题后立即结束；禁止输出 <UpdateVariable>、<JSONPatch>、<StatusPlaceHolderImpl/>、剧情续写、状态栏或命运分支。其他模板不得覆盖该直答要求；如无证据，必须明确说明没有证据。',
  ]
}

function classifySections(items: readonly RecallItem[]): PromptSection[] {
  const stable: RecallItem[] = []
  const relevant: RecallItem[] = []
  const ongoing: RecallItem[] = []

  for (const item of items) {
    if (item.fact.stableAnchor) stable.push(item)
    else if (ONGOING_KINDS.has(item.fact.kind.toLocaleLowerCase())) ongoing.push(item)
    else relevant.push(item)
  }

  return [
    { title: '稳定前提', items: stable },
    { title: '当前相关事实', items: relevant },
    { title: '进行中事项', items: ongoing },
  ]
}

function serializedLength(lines: readonly string[]): number {
  return lines.join('\n').length
}

/**
 * 从同一个不可变 RecallResult 生成 Prompt 与可审计的预算诊断。
 * 若下一条完整事实无法放入预算，则该条及后续条目均标记为预算省略。
 */
export function buildMemoryPromptResult(
  result: RecallResult,
  options: MemoryPromptOptions = {},
): MemoryPromptBuildResult {
  const maxChars = normalizeMaxChars(options.maxChars)
  const answerMode = resolveAnswerMode(result, options.answerMode)
  const emptyDiagnostics = {
    maxChars,
    usedChars: 0,
    includedCount: 0,
    omittedCount: 0,
    answerMode,
  } satisfies MemoryPromptDiagnostics
  if (result.items.length === 0) {
    return Object.freeze({
      prompt: '',
      includedFactIds: Object.freeze([]),
      omitted: Object.freeze([]),
      diagnostics: Object.freeze(emptyDiagnostics),
    })
  }

  const opening = ['<memory_context>', ...promptIntro(answerMode, options.currentIdentity)]
  const closing = '</memory_context>'
  const includedLines = [...opening]
  const includedFactIds: string[] = []
  const omitted: MemoryPromptOmission[] = []
  let budgetExhausted = serializedLength([...includedLines, closing]) > maxChars

  for (const section of classifySections(result.items)) {
    let sectionStarted = false
    for (const item of section.items) {
      if (budgetExhausted) {
        omitted.push(Object.freeze({ factId: item.fact.id, omittedReason: BUDGET_OMITTED_REASON }))
        continue
      }

      const candidateLines = [
        ...includedLines,
        ...(sectionStarted ? [] : [`【${section.title}】`]),
        `- ${item.fact.content}`,
        closing,
      ]
      if (serializedLength(candidateLines) > maxChars) {
        budgetExhausted = true
        omitted.push(Object.freeze({ factId: item.fact.id, omittedReason: BUDGET_OMITTED_REASON }))
        continue
      }

      if (!sectionStarted) {
        includedLines.push(`【${section.title}】`)
        sectionStarted = true
      }
      includedLines.push(`- ${item.fact.content}`)
      includedFactIds.push(item.fact.id)
    }
  }

  const prompt = includedFactIds.length > 0 ? [...includedLines, closing].join('\n') : ''
  const diagnostics: MemoryPromptDiagnostics = Object.freeze({
    maxChars,
    usedChars: prompt.length,
    includedCount: includedFactIds.length,
    omittedCount: omitted.length,
    ...(omitted.length > 0 ? { omittedReason: BUDGET_OMITTED_REASON } : {}),
    answerMode,
  })
  return Object.freeze({
    prompt,
    includedFactIds: Object.freeze(includedFactIds),
    omitted: Object.freeze(omitted),
    diagnostics,
  })
}

/** Builds the exact injection text while preserving the legacy string API. */
export function buildMemoryPrompt(result: RecallResult, options: MemoryPromptOptions = {}): string {
  return buildMemoryPromptResult(result, options).prompt
}

export const memoryPromptLimits = Object.freeze({
  defaultMaxChars: DEFAULT_PROMPT_MAX_CHARS,
})

export interface ActorMemoryPromptOptions {
  readonly maxChars?: number
  readonly sceneLabel?: string
  readonly currentViewpointOwnerId?: string
  readonly rules?: readonly string[]
}

export interface ActorMemoryPromptResult {
  readonly prompt: string
  readonly includedTraceIds: readonly string[]
  readonly omittedTraceIds: readonly string[]
  readonly diagnostics: {
    readonly maxChars: number
    readonly usedChars: number
    readonly partitionBudgets: Readonly<Record<string, number>>
    readonly includedCount: number
    readonly omittedCount: number
    readonly mode: 'multi_actor' | 'strict_pov' | 'omniscient'
  }
}

function packetLine(packet: MemoryRecallPacket): string {
  const detail = packet.details.map(unit => xmlEscape(unit.text)).filter(Boolean).join('；')
  const gist = xmlEscape(packet.gist)
  return detail ? `- ${gist}（${detail}）` : `- ${gist}`
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!)
}

function partitionLabel(partition: ActorMemoryPartition): string {
  return partition.role === 'world' ? 'world_memory' : partition.role === 'narrator' ? 'narrator_memory' : 'actor_memory'
}

function partitionBudget(total: number, partition: ActorMemoryPartition, current: boolean, currentCount: number, otherCount: number, actorCount: number): number {
  if (partition.role === 'world') return Math.floor(total * 0.2)
  if (partition.role === 'narrator') return Math.floor(total * 0.1)
  if (currentCount === 0) return Math.floor(total * (0.7 / Math.max(1, actorCount)))
  return Math.floor(total * ((current ? 0.65 / currentCount : 0.35 / Math.max(1, otherCount))))
}

/** Builds the multi-owner XML envelope used by the single native Tavern call. */
export function buildActorMemoryPromptResult(response: ActorRecallResponse, options: ActorMemoryPromptOptions = {}): ActorMemoryPromptResult {
  const maxChars = normalizeMaxChars(options.maxChars)
  const currentActorIds = new Set([response.request.scene.viewpointOwnerId, ...response.request.scene.speakerOwnerIds])
  const actors = [...response.actors].sort((left, right) => Number(currentActorIds.has(right.ownerId)) - Number(currentActorIds.has(left.ownerId)) || left.ownerId.localeCompare(right.ownerId))
  const partitions = [response.world, response.narrator, ...actors]
  if (partitions.every(partition => partition.packets.length === 0)) {
    return Object.freeze({ prompt: '', includedTraceIds: Object.freeze([]), omittedTraceIds: Object.freeze([]), diagnostics: Object.freeze({ maxChars, usedChars: 0, partitionBudgets: Object.freeze({}), includedCount: 0, omittedCount: 0, mode: response.request.mode ?? 'multi_actor' }) })
  }
  const actorCount = actors.length
  const currentCount = actors.filter(partition => currentActorIds.has(partition.ownerId)).length
  const otherCount = Math.max(0, actorCount - currentCount)
  const budgets: Record<string, number> = {}
  partitions.forEach((partition) => { budgets[partition.ownerId] = partitionBudget(maxChars, partition, currentActorIds.has(partition.ownerId), currentCount, otherCount, actorCount) })
  const includedTraceIds: string[] = []
  const omittedTraceIds: string[] = []
  const mode = response.request.mode ?? 'multi_actor'
  const sceneLabel = xmlEscape(options.sceneLabel ?? '')
  const lines = [`<memory_context mode="${mode}" scene="${sceneLabel}">`]
  const includedPacketLines: Array<{ line: string; traceId: string }> = []
  const rules = [
    '每个角色只能依据自己的 actor_memory 行动和发言。',
    'world_memory 是世界规范参考，不代表任一角色自动知情。',
    '不得补回模糊记忆中被省略的细节。',
    '不得将私密思想、秘密或其他角色记忆转移给当前角色。',
    ...(options.rules ?? []).map(rule => xmlEscape(rule)),
  ]
  const closingLines = (): string[] => ['<memory_rules>', ...rules, '</memory_rules>', '</memory_context>']
  const serialized = (candidate: readonly string[]): number => candidate.concat(closingLines()).join('\n').length
  const appendPartition = (partition: ActorMemoryPartition): void => {
    const tag = partitionLabel(partition)
    const ownerAttr = partition.role === 'world'
      ? ' audience="narrator"'
      : partition.role === 'narrator'
        ? ''
        : ` owner_id="${xmlEscape(partition.ownerId)}" owner="${xmlEscape(partition.ownerName)}"`
    const start = `<${tag}${ownerAttr}>`
    const end = `</${tag}>`
    lines.push(start)
    let sectionChars = start.length + end.length
    for (const packet of partition.packets) {
      const line = packetLine(packet)
      if (sectionChars + line.length + 1 > (budgets[partition.ownerId] ?? maxChars)
        || serialized([...lines, line, end]) > maxChars) {
        omittedTraceIds.push(packet.traceId)
        continue
      }
      lines.push(line)
      sectionChars += line.length + 1
      includedTraceIds.push(packet.traceId)
      includedPacketLines.push({ line, traceId: packet.traceId })
    }
    lines.push(end)
  }
  for (const partition of partitions) appendPartition(partition)
  if (maxChars < 256) {
    omittedTraceIds.push(...includedTraceIds)
    includedTraceIds.length = 0
    includedPacketLines.length = 0
  }
  let prompt = maxChars < 256 ? '' : [...lines, ...closingLines()].join('\n')
  while (prompt.length > maxChars && includedPacketLines.length > 0) {
    const removed = includedPacketLines.pop()!
    const lineIndex = [...lines].map((line, index) => ({ line, index })).reverse().find(item => item.line === removed.line)?.index
    if (lineIndex !== undefined) lines.splice(lineIndex, 1)
    const includedIndex = includedTraceIds.lastIndexOf(removed.traceId)
    if (includedIndex >= 0) includedTraceIds.splice(includedIndex, 1)
    omittedTraceIds.push(removed.traceId)
    prompt = [...lines, ...closingLines()].join('\n')
  }
  if (prompt.length > maxChars) prompt = ''
  return Object.freeze({ prompt, includedTraceIds: Object.freeze(includedTraceIds), omittedTraceIds: Object.freeze(omittedTraceIds), diagnostics: Object.freeze({ maxChars, usedChars: prompt.length, partitionBudgets: Object.freeze(budgets), includedCount: includedTraceIds.length, omittedCount: omittedTraceIds.length, mode: response.request.mode ?? 'multi_actor' }) })
}

export function buildActorMemoryPrompt(response: ActorRecallResponse, options: ActorMemoryPromptOptions = {}): string {
  return buildActorMemoryPromptResult(response, options).prompt
}
