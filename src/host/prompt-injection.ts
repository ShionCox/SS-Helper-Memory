import type { PromptMessageSnapshot } from '@ss-helper/sdk';
import {
  buildMemoryPromptResult,
  buildActorMemoryPromptResult,
  type MemoryPromptDiagnostics,
  type MemoryPromptOptions,
  type ActorMemoryPromptOptions,
  type ActorMemoryPromptResult,
} from '../application/prompt';
import type { RecallResult } from '../application/recall';
import type { ActorRecallResponse } from '../domain';

export interface PromptRecallPort {
  preview(input: { query: string; maxItems?: number }): Promise<RecallResult>;
}

export interface PromptInjectionResult {
  injected: boolean;
  recall: RecallResult | null;
  prompt: string;
  promptDiagnostics: MemoryPromptDiagnostics | null;
}

export interface ActorPromptInjectionResult {
  injected: boolean;
  recall: ActorRecallResponse | null;
  prompt: string;
  promptDiagnostics: ActorMemoryPromptResult['diagnostics'] | null;
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

export async function buildActorMemoryPromptContribution(
  messages: readonly PromptMessageSnapshot[],
  recall: (query: string, maxItems: number) => Promise<ActorRecallResponse>,
  maxItems: number,
  options: ActorMemoryPromptOptions = {},
): Promise<ActorPromptInjectionResult> {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const query = typeof latestUser?.content === 'string' ? latestUser.content.trim() : '';
  if (!query) return { injected: false, recall: null, prompt: '', promptDiagnostics: null };
  const result = await recall(query, maxItems);
  const built = buildActorMemoryPromptResult(result, options);
  return { injected: Boolean(built.prompt), recall: result, prompt: built.prompt, promptDiagnostics: built.diagnostics };
}
