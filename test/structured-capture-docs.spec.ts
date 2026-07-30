import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('structured Capture documentation contract', () => {
  it('keeps the root, Memory and LLM rules linked to the concise guide', () => {
    const guide = readFileSync(new URL('../docs/structured-capture.md', import.meta.url), 'utf8');
    const rootAgents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
    const memoryAgents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
    const llmAgents = readFileSync(new URL('../../SS-Helper-LLM/AGENTS.md', import.meta.url), 'utf8');

    expect(guide).toContain('未知 `kind` 不会自动变成 `other`');
    expect(guide).toContain('最多进行三次真实调用');
    expect(guide).toContain('resolutionMode: degraded');
    expect(rootAgents).toContain('SS-Helper-Memory/docs/structured-capture.md');
    expect(memoryAgents).toContain('docs/structured-capture.md');
    expect(llmAgents).toContain('../SS-Helper-Memory/docs/structured-capture.md');
  });
});
