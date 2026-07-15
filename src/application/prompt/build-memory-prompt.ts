import type { RecallItem, RecallResult } from '../recall/memory-recall-index'

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

function promptIntro(answerMode: 'roleplay' | 'diagnostic'): string[] {
  const common = '以下是有原文证据支持的历史记忆。当前对话内容优先于历史记忆；如有冲突，以当前对话为准。不得补造缺失细节。'
  if (answerMode === 'roleplay') return [common]
  return [
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

  const opening = ['<memory_context>', ...promptIntro(answerMode)]
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
