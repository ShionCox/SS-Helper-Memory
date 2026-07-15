import { describe, expect, it } from 'vitest'

import { MemoryRecallIndex, type RecallFact } from '../src/application/recall/memory-recall-index'
import { buildMemoryPrompt } from '../src/application/prompt/build-memory-prompt'

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0
}

describe('recall performance', () => {
  it('keeps recall p95 below 200ms and prompt assembly p95 below 300ms at 10k facts', () => {
    const facts: RecallFact[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `fact-${index}`,
      chatKey: 'chat-performance',
      kind: index % 7 === 0 ? 'commitment' : 'identity',
      subjectKey: `character:${index % 80}`,
      predicateKey: index % 7 === 0 ? 'promised' : 'preference',
      objectKey: `object:${index % 300}`,
      content: index % 113 === 0
        ? `罗兰承诺带回银色钥匙，记录 ${index}。`
        : `人物 ${index % 80} 的普通生活记忆 ${index}。`,
      entityKeys: [`character:${index % 80}`, `object:${index % 300}`],
      confidence: 0.9,
      status: 'active',
      evidenceRefs: [`evidence-${index}`],
      updatedAt: Date.now() - index * 1_000,
    }))
    const index = new MemoryRecallIndex(facts)
    const recallTimes: number[] = []
    const promptTimes: number[] = []

    for (let run = 0; run < 24; run += 1) {
      const recallStart = performance.now()
      const result = index.recall({
        chatKey: 'chat-performance',
        query: '罗兰的银色钥匙承诺',
        entityKeys: ['character:33', 'object:146'],
        maxItems: 12,
      })
      recallTimes.push(performance.now() - recallStart)

      const promptStart = performance.now()
      buildMemoryPrompt(result)
      promptTimes.push(performance.now() - promptStart)
    }

    expect(percentile95(recallTimes)).toBeLessThanOrEqual(200)
    expect(percentile95(promptTimes)).toBeLessThanOrEqual(300)
  })
})
