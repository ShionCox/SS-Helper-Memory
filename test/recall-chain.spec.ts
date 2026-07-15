import { describe, expect, it } from 'vitest'

import { MemoryRecallIndex, type RecallFact } from '../src/application/recall/memory-recall-index'
import { buildMemoryPrompt } from '../src/application/prompt/build-memory-prompt'

const NOW = Date.parse('2026-07-12T12:00:00.000Z')

function fact(overrides: Partial<RecallFact> = {}): RecallFact {
  return {
    id: crypto.randomUUID(),
    chatKey: 'chat-a',
    kind: 'identity',
    subjectKey: 'character:alice',
    predicateKey: 'likes',
    objectKey: 'food:tea',
    content: '爱丽丝喜欢喝伯爵红茶，不加糖。',
    entityKeys: ['character:alice', 'food:tea'],
    confidence: 0.92,
    status: 'active',
    evidenceRefs: ['evidence-1'],
    updatedAt: NOW - 60_000,
    ...overrides,
  }
}

describe('MemoryRecallIndex', () => {
  it('only selects the newest active fact from the same temporal slot', () => {
    const index = new MemoryRecallIndex([
      fact({
        id: 'older-location',
        kind: 'state',
        subjectKey: 'character:alice',
        predicateKey: 'current_location',
        objectKey: 'place:harbor',
        content: '爱丽丝当前位于银湾港口。',
        validFrom: NOW - 120_000,
        updatedAt: NOW - 120_000,
      }),
      fact({
        id: 'newer-location',
        kind: 'state',
        subjectKey: 'character:alice',
        predicateKey: 'current_location',
        objectKey: 'place:palace',
        content: '爱丽丝当前位于北境王宫。',
        validFrom: NOW - 60_000,
        updatedAt: NOW - 60_000,
      }),
    ])

    const result = index.recall({ chatKey: 'chat-a', query: '爱丽丝当前位于哪里？', now: NOW })

    expect(result.items.map(item => item.fact.id)).toEqual(['newer-location'])
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: 'older-location', selected: false, omittedReason: '同一时序槽位已有更新事实' }),
    ]))
  })

  it('only admits active, evidenced, sufficiently confident and currently valid facts', () => {
    const eligible = fact({ id: 'eligible' })
    const index = new MemoryRecallIndex([
      eligible,
      fact({ id: 'pending', status: 'pending' }),
      fact({ id: 'superseded', status: 'superseded' }),
      fact({ id: 'invalid', status: 'invalid' }),
      fact({ id: 'unsupported', evidenceRefs: [] }),
      fact({ id: 'uncertain', confidence: 0.74 }),
      fact({ id: 'expired', validUntil: NOW - 1 }),
      fact({ id: 'future', validFrom: NOW + 1 }),
      fact({ id: 'other-chat', chatKey: 'chat-b' }),
    ])

    const result = index.recall({ chatKey: 'chat-a', query: '爱丽丝 红茶', now: NOW })

    expect(result.items.map(item => item.fact.id)).toEqual(['eligible'])
  })

  it('combines lexical, entity and active scene matches without an LLM fallback', () => {
    const index = new MemoryRecallIndex([
      fact({ id: 'tea', content: '爱丽丝喜欢伯爵红茶。' }),
      fact({
        id: 'harbor',
        kind: 'location',
        subjectKey: 'place:harbor',
        predicateKey: 'weather',
        objectKey: 'fog',
        content: '银湾港口的清晨常有浓雾。',
        entityKeys: ['place:harbor', 'weather:fog'],
      }),
      fact({
        id: 'scene-person',
        content: '罗兰是本场景的守门人。',
        entityKeys: ['character:roland'],
        scope: { sceneKeys: ['scene:gate'], characterKeys: ['character:roland'] },
      }),
    ])

    const result = index.recall({
      chatKey: 'chat-a',
      query: '港口的雾怎么样',
      entityKeys: ['place:harbor'],
      sceneKeys: ['scene:gate'],
      characterKeys: ['character:roland'],
      now: NOW,
    })

    expect(result.items[0]?.fact.id).toBe('harbor')
    expect(result.items.some(item => item.fact.id === 'tea')).toBe(false)
    expect(result.diagnostics.llmCalls).toBe(0)
  })

  it('returns only matching stable anchors when the query has no relevant hit', () => {
    const index = new MemoryRecallIndex([
      fact({ id: 'unrelated-first', content: '欧阳喜欢蓝色外套。', entityKeys: ['character:ouyang'] }),
      fact({
        id: 'matching-anchor',
        kind: 'world_rule',
        content: '王宫内禁止使用传送魔法。',
        entityKeys: ['world:oracle'],
        stableAnchor: true,
        scope: { worldKeys: ['world:oracle'] },
      }),
      fact({
        id: 'foreign-anchor',
        kind: 'world_rule',
        content: '学院内禁止使用火焰魔法。',
        entityKeys: ['world:academy'],
        stableAnchor: true,
        scope: { worldKeys: ['world:academy'] },
      }),
    ])

    const result = index.recall({
      chatKey: 'chat-a',
      query: '今天晚饭吃什么',
      worldKeys: ['world:oracle'],
      now: NOW,
    })

    expect(result.items.map(item => item.fact.id)).toEqual(['matching-anchor'])
  })

  it('limits matching stable anchors to three and clamps maxItems to 4..30', () => {
    const anchors = Array.from({ length: 8 }, (_, index) => fact({
      id: `anchor-${index}`,
      kind: 'world_rule',
      content: `神谕世界稳定规则第${index}条。`,
      stableAnchor: true,
      scope: { worldKeys: ['world:oracle'] },
      entityKeys: ['world:oracle'],
    }))
    const relevant = Array.from({ length: 40 }, (_, index) => fact({
      id: `relevant-${index}`,
      content: `伯爵红茶相关记忆第${index}条。`,
      entityKeys: ['food:tea'],
    }))
    const index = new MemoryRecallIndex([...anchors, ...relevant])

    const minimum = index.recall({
      chatKey: 'chat-a', query: '红茶', worldKeys: ['world:oracle'], maxItems: 1, now: NOW,
    })
    const defaults = index.recall({
      chatKey: 'chat-a', query: '红茶', worldKeys: ['world:oracle'], now: NOW,
    })
    const maximum = index.recall({
      chatKey: 'chat-a', query: '红茶', worldKeys: ['world:oracle'], maxItems: 99, now: NOW,
    })

    expect(minimum.maxItems).toBe(4)
    expect(minimum.items).toHaveLength(4)
    expect(minimum.items.filter(item => item.fact.stableAnchor)).toHaveLength(3)
    expect(defaults.maxItems).toBe(12)
    expect(defaults.items).toHaveLength(12)
    expect(maximum.maxItems).toBe(30)
    expect(maximum.items).toHaveLength(30)
    expect(maximum.items.filter(item => item.fact.stableAnchor)).toHaveLength(3)
  })

  it('updates and removes facts incrementally without rebuilding the index', () => {
    const index = new MemoryRecallIndex([fact({ id: 'mutable', content: '爱丽丝喜欢红茶。' })])

    expect(index.recall({ chatKey: 'chat-a', query: '红茶', now: NOW }).items).toHaveLength(1)

    index.upsert(fact({ id: 'mutable', content: '爱丽丝改为喜欢咖啡。', objectKey: 'food:coffee' }))
    expect(index.recall({ chatKey: 'chat-a', query: '红茶', now: NOW }).items).toHaveLength(0)
    expect(index.recall({ chatKey: 'chat-a', query: '咖啡', now: NOW }).items[0]?.fact.id).toBe('mutable')

    index.remove('mutable')
    expect(index.recall({ chatKey: 'chat-a', query: '咖啡', now: NOW }).items).toHaveLength(0)
  })

  it('keeps explicitly named identity, goal and commitment in a multi-intent query', () => {
    const index = new MemoryRecallIndex([
      fact({ id: 'alice-identity', kind: 'identity', subjectKey: '爱丽丝', content: '爱丽丝是北境登记在册的星图师。' }),
      fact({ id: 'alice-goal', kind: 'goal', subjectKey: '爱丽丝', content: '爱丽丝当前目标是修复北境航路星图。' }),
      fact({ id: 'alice-promise', kind: 'commitment', subjectKey: '爱丽丝', content: '爱丽丝承诺在黎明前交还银色钥匙。' }),
      ...Array.from({ length: 20 }, (_, index) => fact({
        id: `noise-${index}`,
        kind: 'relationship',
        subjectKey: `路人${index}`,
        content: `路人${index}与北境商队保持普通往来。`,
      })),
    ])
    const ids = index.recall({
      chatKey: 'chat-a',
      query: '爱丽丝是谁，她当前有什么目标和承诺？',
      now: NOW,
    }).items.map(item => item.fact.id)

    expect(ids).toEqual(expect.arrayContaining(['alice-identity', 'alice-goal', 'alice-promise']))
  })

  it('does not recall a known subject\'s unrelated facts for an unknown explicitly named entity', () => {
    const index = new MemoryRecallIndex([
      fact({
        id: 'weapon',
        kind: 'event',
        subjectKey: '白夕小时',
        content: '白夕小时为白夕叶组装了名为裂空之矛的长柄武器。',
        entityKeys: ['白夕小时', '白夕叶', '裂空之矛'],
      }),
      fact({
        id: 'shopping',
        kind: 'event',
        subjectKey: '白夕小时',
        content: '白夕小时去超市补充了饮用水和长期食品。',
        entityKeys: ['白夕小时', '超市'],
      }),
    ])

    const result = index.recall({
      chatKey: 'chat-a',
      query: '白夕小时是否拥有一艘名为银翼号的宇宙飞船？如果没有证据必须明确说没有。',
      now: NOW,
    })

    expect(result.items).toEqual([])
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ selected: false, omittedReason: '未命中查询中明确命名的实体' }),
    ]))
  })

  it('keeps normal early, middle and character-setting recall after the lexical hard gate', () => {
    const index = new MemoryRecallIndex([
      fact({
        id: 'early-shopping',
        kind: 'event',
        subjectKey: '白夕小时',
        content: '白夕小时最早去超市补充了饮用水和长期食品。',
        entityKeys: ['白夕小时', '超市'],
      }),
      fact({
        id: 'middle-battle',
        kind: 'event',
        subjectKey: '沈夜',
        content: '沈夜在泳池战斗中被击败，留下黯欲之种。',
        entityKeys: ['沈夜', '黯欲之种'],
      }),
      fact({
        id: 'purple-identity',
        kind: 'identity',
        subjectKey: '紫罗',
        content: '紫罗是拥有翠绿色长发的人形侦察体。',
        entityKeys: ['紫罗'],
      }),
    ])

    expect(index.recall({ chatKey: 'chat-a', query: '最早去超市补充了什么？', now: NOW }).items[0]?.fact.id)
      .toBe('early-shopping')
    expect(index.recall({ chatKey: 'chat-a', query: '沈夜战斗中发生了什么？', now: NOW }).items[0]?.fact.id)
      .toBe('middle-battle')
    expect(index.recall({ chatKey: 'chat-a', query: '紫罗是谁？', now: NOW }).items[0]?.fact.id)
      .toBe('purple-identity')
  })

  it('still recalls an explicitly named entity when that exact name is evidenced', () => {
    const index = new MemoryRecallIndex([
      fact({
        id: 'known-ship',
        kind: 'state',
        subjectKey: '银翼号',
        content: '银翼号是一艘由白夕小时持有的宇宙飞船。',
        entityKeys: ['白夕小时', '银翼号'],
      }),
      fact({ id: 'unrelated', subjectKey: '白夕小时', content: '白夕小时喜欢喝伯爵红茶。', entityKeys: ['白夕小时'] }),
    ])

    const ids = index.recall({
      chatKey: 'chat-a',
      query: '白夕小时是否拥有一艘名为银翼号的宇宙飞船？',
      now: NOW,
    }).items.map(item => item.fact.id)

    expect(ids).toEqual(['known-ship'])
  })

  it('treats a leading 号-suffixed name in a status question as an explicit entity', () => {
    const unrelated = fact({
      id: 'water-shortage',
      kind: 'state',
      subjectKey: '饮用水',
      content: '白夕小队当前饮用水储备极度匮乏，剩余纯净水最多只能维持不到二十四小时。',
      entityKeys: ['白夕小队', '饮用水'],
    })
    const query = '银翼号目前停在哪里、还剩多少燃料？'

    const missing = new MemoryRecallIndex([unrelated]).recall({ chatKey: 'chat-a', query, now: NOW })
    expect(missing.items).toEqual([])
    expect(missing.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: 'water-shortage', selected: false, omittedReason: '未命中查询中明确命名的实体' }),
    ]))

    const knownShip = fact({
      id: 'known-ship-status',
      kind: 'state',
      subjectKey: '银翼号',
      content: '银翼号目前停靠在东京湾，剩余燃料为百分之六十。',
      entityKeys: ['银翼号', '东京湾'],
    })
    const evidenced = new MemoryRecallIndex([unrelated, knownShip]).recall({ chatKey: 'chat-a', query, now: NOW })
    expect(evidenced.items.map(item => item.fact.id)).toEqual(['known-ship-status'])
  })

  it('lets the latest variable snapshot cover older state unless the query explicitly asks for history', () => {
    const index = new MemoryRecallIndex([
      fact({
        id: 'weapon-old', kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '剩余弹药',
        content: '紫能高压手枪当前剩余弹药为1发。', entityKeys: ['紫能高压手枪'], validFrom: 10, updatedAt: 10,
      }),
      fact({
        id: 'weapon-current', kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '当前状态',
        content: '最新变量状态确认：紫能高压手枪已重新充能，剩余击发次数为10。', entityKeys: ['紫能高压手枪'],
        sourceRefs: ['state:last:hash'], evidenceRefs: [], validFrom: 20, updatedAt: 20,
      }),
    ])

    const current = index.recall({ chatKey: 'chat-a', query: '紫能高压手枪最后确认剩余几次？', now: NOW })
    expect(current.items.map(item => item.fact.id)).toEqual(['weapon-current'])
    expect(current.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: 'weapon-old', omittedReason: '最新变量状态已覆盖更早事实' }),
    ]))

    const history = index.recall({ chatKey: 'chat-a', query: '紫能高压手枪曾经到现在的变化是什么？', now: NOW })
    expect(history.items.map(item => item.fact.id)).toEqual(expect.arrayContaining(['weapon-current', 'weapon-old']))
  })

  it('adds a lexical temporal safety candidate when pure vector misses the latest snapshot', () => {
    const index = new MemoryRecallIndex([
      fact({
        id: 'weapon-old-vector', kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '剩余弹药',
        content: '紫能高压手枪当前剩余弹药为1发。', entityKeys: ['紫能高压手枪'], validFrom: 10, updatedAt: 10,
      }),
      fact({
        id: 'weapon-current-lexical', kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '当前状态',
        content: '最新变量状态确认：紫能高压手枪已重新充能，剩余击发次数为10。', entityKeys: ['紫能高压手枪'],
        sourceRefs: ['state:last:hash'], evidenceRefs: [], validFrom: 20, updatedAt: 20,
      }),
    ])

    const current = index.recall(
      { chatKey: 'chat-a', query: '紫能高压手枪最后确认还剩几次？', now: NOW },
      { mode: 'vector', vectorScores: new Map([['weapon-old-vector', 0.64]]) },
    )
    expect(current.items.map(item => item.fact.id)).toEqual(['weapon-current-lexical'])

    const history = index.recall(
      { chatKey: 'chat-a', query: '紫能高压手枪一路变化到现在还剩几次？', now: NOW },
      { mode: 'vector', vectorScores: new Map([['weapon-old-vector', 0.64]]) },
    )
    expect(history.items.map(item => item.fact.id)).toEqual(expect.arrayContaining([
      'weapon-current-lexical',
      'weapon-old-vector',
    ]))
  })

  it('reserves the latest temporal candidate inside a four-item hybrid pool', () => {
    const latest = fact({
      id: 'latest-gun-snapshot', kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '当前状态',
      content: '最新变量状态确认：紫能高压手枪剩余击发次数为10。', entityKeys: ['紫能高压手枪'],
      sourceRefs: ['state:last:hash'], evidenceRefs: [], validFrom: 20, updatedAt: 20,
    })
    const old = fact({
      id: 'old-gun-vector', kind: 'state', subjectKey: '紫能高压手枪', predicateKey: '剩余弹药',
      content: '紫能高压手枪当前剩余弹药为1发。', entityKeys: ['紫能高压手枪'], validFrom: 10, updatedAt: 10,
    })
    const noise = Array.from({ length: 5 }, (_, index) => fact({
      id: `vector-noise-${index}`, kind: 'event', content: `紫色装备相关战斗记录 ${index}。`, updatedAt: 5 - index,
    }))
    const vectorScores = new Map<string, number>([
      ['old-gun-vector', 0.91],
      ...noise.map((item, index): [string, number] => [item.id, 0.9 - index / 100]),
    ])
    const result = new MemoryRecallIndex([latest, old, ...noise]).recall(
      { chatKey: 'chat-a', query: '最后确认时紫色手枪还剩几次？', maxItems: 4, now: NOW },
      { mode: 'hybrid', vectorScores },
    )

    expect(result.items).toHaveLength(4)
    expect(result.items[0]?.fact.id).toBe('latest-gun-snapshot')
  })
})

describe('memory prompt', () => {
  it('uses one immutable RecallResult for preview and prompt assembly', () => {
    const index = new MemoryRecallIndex([
      fact({
        id: 'stable',
        kind: 'world_rule',
        content: '王宫内禁止使用传送魔法。',
        stableAnchor: true,
        scope: { worldKeys: ['world:oracle'] },
        entityKeys: ['world:oracle'],
      }),
      fact({ id: 'relevant', kind: 'relationship', content: '爱丽丝信任罗兰。', entityKeys: ['character:alice', 'character:roland'] }),
      fact({ id: 'ongoing', kind: 'commitment', content: '爱丽丝承诺在黎明前带回钥匙。', entityKeys: ['character:alice', 'item:key'] }),
    ])
    const result = index.recall({
      chatKey: 'chat-a',
      query: '爱丽丝和罗兰要完成什么',
      entityKeys: ['character:alice', 'character:roland', 'item:key'],
      worldKeys: ['world:oracle'],
      now: NOW,
    })

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.items)).toBe(true)
    expect(Object.isFrozen(result.items[0])).toBe(true)

    const prompt = buildMemoryPrompt(result)
    expect(prompt).toContain('【稳定前提】')
    expect(prompt).toContain('【当前相关事实】')
    expect(prompt).toContain('【进行中事项】')
    expect(prompt).toContain('当前对话内容优先于历史记忆')
    expect(prompt).toContain('不得补造缺失细节')
    expect(prompt).not.toMatch(/score|reasonCodes|BM25|confidence/i)
  })

  it('does not inject anything when recall is empty', () => {
    const result = new MemoryRecallIndex([]).recall({ chatKey: 'chat-a', query: '任意问题', now: NOW })
    expect(buildMemoryPrompt(result)).toBe('')
  })

  it('enforces a hard character budget without cutting a fact line', async () => {
    const { buildMemoryPromptResult } = await import('../src/application/prompt/build-memory-prompt')
    const index = new MemoryRecallIndex([
      fact({ id: 'first', kind: 'relationship', content: '爱丽丝信任罗兰。', entityKeys: ['character:alice', 'character:roland'] }),
      fact({ id: 'second', kind: 'relationship', content: '爱丽丝与罗兰约定在黎明前会合。', entityKeys: ['character:alice', 'character:roland'] }),
      fact({ id: 'third', kind: 'relationship', content: '罗兰会在王宫北门等待爱丽丝。', entityKeys: ['character:alice', 'character:roland'] }),
    ])
    const result = index.recall({
      chatKey: 'chat-a', query: '爱丽丝和罗兰的约定', entityKeys: ['character:alice', 'character:roland'], now: NOW,
    })

    const unbounded = buildMemoryPromptResult(result)
    const maxChars = unbounded.prompt.length - 10
    const built = buildMemoryPromptResult(result, { maxChars })

    expect(built.prompt.length).toBeLessThanOrEqual(maxChars)
    expect(built.prompt).toMatch(/<memory_context>[\s\S]*<\/memory_context>/)
    expect(built.diagnostics.omittedCount).toBeGreaterThan(0)
    expect(built.diagnostics.omittedReason).toBe('超过 Prompt 字符预算')
    expect(built.omitted.every(item => item.omittedReason === '超过 Prompt 字符预算')).toBe(true)
    for (const item of result.items) {
      const line = `- ${item.fact.content}`
      expect(built.prompt.includes(item.fact.content)).toBe(built.prompt.includes(line))
    }
  })

  it('adds direct-answer priority for diagnostic questions without changing roleplay prompts', async () => {
    const { buildMemoryPromptResult } = await import('../src/application/prompt/build-memory-prompt')
    const index = new MemoryRecallIndex([fact({ id: 'known', content: '爱丽丝拥有一把银色钥匙。' })])
    const diagnostic = index.recall({ chatKey: 'chat-a', query: '简短回答：爱丽丝是否拥有银色钥匙？', now: NOW })
    const roleplay = index.recall({ chatKey: 'chat-a', query: '爱丽丝拿着钥匙走进大厅。', now: NOW })

    const diagnosticPrompt = buildMemoryPromptResult(diagnostic, { answerMode: 'auto' })
    const roleplayPrompt = buildMemoryPromptResult(roleplay, { answerMode: 'auto' })

    expect(diagnosticPrompt.diagnostics.answerMode).toBe('diagnostic')
    expect(diagnosticPrompt.prompt).toContain('自然语言直答开始')
    expect(diagnosticPrompt.prompt).toContain('禁止输出 <UpdateVariable>、<JSONPatch>、<StatusPlaceHolderImpl/>')
    expect(roleplayPrompt.diagnostics.answerMode).toBe('roleplay')
    expect(roleplayPrompt.prompt).not.toContain('先直接回答用户问题')
  })
})
