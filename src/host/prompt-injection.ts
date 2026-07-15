import type { PromptMessageSnapshot } from '@ss-helper/sdk';
import {
  buildMemoryPromptResult,
  type MemoryPromptDiagnostics,
  type MemoryPromptOptions,
} from '../application/prompt';
import type { RecallResult } from '../application/recall';

export interface PromptRecallPort {
  preview(input: { query: string; maxItems?: number }): Promise<RecallResult>;
}

export interface PromptInjectionResult {
  injected: boolean;
  recall: RecallResult | null;
  prompt: string;
  promptDiagnostics: MemoryPromptDiagnostics | null;
}

/** Builds an immutable contribution for HostPort.prompt without mutating Tavern prompt arrays. */
export async function buildMemoryPromptContribution(
  messages: readonly PromptMessageSnapshot[],
  recall: PromptRecallPort,
  maxItems: number,
  options: MemoryPromptOptions = {},
): Promise<PromptInjectionResult> {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const query = typeof latestUser?.content === 'string' ? latestUser.content.trim() : '';
  if (!query) return { injected: false, recall: null, prompt: '', promptDiagnostics: null };
  const result = await recall.preview({ query, maxItems });
  const built = buildMemoryPromptResult(result, options);
  return {
    injected: Boolean(built.prompt),
    recall: result,
    prompt: built.prompt,
    promptDiagnostics: built.diagnostics,
  };
}
