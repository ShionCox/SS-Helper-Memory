import { DEFAULT_MEMORY_TRAITS, type MemoryDetailUnit, type MemoryFact, type MemoryRecallPacket, type ActorMemoryTrace, type MemoryTraits } from '../../domain';

export interface MemoryStrengthConfig {
  readonly halfLifeMs?: number;
  readonly rehearsalGain?: number;
  readonly emotionalGain?: number;
  /** Current-query cue match (0–1), supplied by objective recall. */
  readonly cueMatch?: number;
  readonly interference?: number;
  /** Owner-specific characteristics override the global defaults. */
  readonly traits?: MemoryTraits;
}

export const MEMORY_STRENGTH_LEVELS = Object.freeze({ exact: 85, clear: 65, gist: 45, fragment: 25, forgotten: 1 });
export const DEFAULT_MEMORY_STRENGTH_CONFIG = Object.freeze({ ...DEFAULT_MEMORY_TRAITS });

function clamp(value: number, min = 0, max = 100): number { return Math.max(min, Math.min(max, value)); }

export function effectiveMemoryStrength(trace: ActorMemoryTrace, now = Date.now(), config: MemoryStrengthConfig = {}): number {
  // Resolve all parameters in one place. Callers may provide owner traits and
  // a request-local cue match, while omitted values always use the same v0
  // defaults; this keeps offline evaluation and production recall identical.
  const resolved = {
    halfLifeMs: config.halfLifeMs ?? config.traits?.halfLifeMs ?? DEFAULT_MEMORY_STRENGTH_CONFIG.halfLifeMs,
    rehearsalGain: config.rehearsalGain ?? config.traits?.rehearsalGain ?? DEFAULT_MEMORY_STRENGTH_CONFIG.rehearsalGain,
    emotionalGain: config.emotionalGain ?? config.traits?.emotionalGain ?? DEFAULT_MEMORY_STRENGTH_CONFIG.emotionalGain,
    interference: config.interference ?? config.traits?.interference ?? DEFAULT_MEMORY_STRENGTH_CONFIG.interference,
    cueMatch: config.cueMatch,
  };
  const halfLife = Math.max(1, resolved.halfLifeMs);
  const elapsed = Math.max(0, now - (trace.lastRehearsedAt ?? trace.updatedAt));
  const decay = Math.exp(-elapsed / halfLife);
  const rehearsal = 1 + Math.max(0, trace.rehearsalCount) * resolved.rehearsalGain;
  // Domain salience is 0–1. Accept legacy-looking 0–100 fixtures defensively
  // without changing the persisted v0 contract.
  const salience = trace.emotionalSalience > 1 ? trace.emotionalSalience / 100 : trace.emotionalSalience;
  const emotion = 1 + clamp(salience, 0, 1) * resolved.emotionalGain;
  const cue = clamp(resolved.cueMatch ?? 1, 0, 1);
  const interference = Math.max(0, resolved.interference);
  const clarity = clamp(trace.clarity, 0, 100) / 100;
  // S_eff = clamp(S0 × exp(-Δt/τ) × R × E × C - I, 0, 100)
  return clamp(trace.strength * decay * rehearsal * emotion * clarity * cue - interference);
}

export function deterministicSeed(ownerId: string, factId: string, traceRevision: number, sceneEpoch: string): string {
  let hash = 2166136261;
  for (const char of `${ownerId}\0${factId}\0${traceRevision}\0${sceneEpoch}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function seedNumber(seed: string): number {
  return Number.parseInt(seed.slice(0, 8), 16) / 0xffffffff;
}

function gist(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  if (!normalized) return '一段相关记忆';
  // A gist is a derived, intentionally lossy representation.  Never let a
  // short fact silently become an exact detail at the 45/25 strength levels.
  const sentence = normalized.split(/[。！？!?；;]/u)[0]?.trim() || normalized;
  const max = Math.min(72, Math.max(3, Math.ceil(sentence.length * 0.72)));
  if (sentence.length <= 3) return `${sentence.slice(0, Math.max(1, sentence.length - 1))}…`;
  return sentence.length > max ? `${sentence.slice(0, Math.max(2, max - 1))}…` : `${sentence.slice(0, Math.max(2, sentence.length - 1))}…`;
}

type RecallFact = Pick<MemoryFact, 'id' | 'content'>;

function detailUnits(trace: ActorMemoryTrace, fact: RecallFact): MemoryDetailUnit[] {
  return [{ id: `detail:${trace.id}:gist`, traceId: trace.id, text: gist(fact.content), sensitivity: 'gist', minStrength: MEMORY_STRENGTH_LEVELS.fragment, sourceFactId: fact.id },
    { id: `detail:${trace.id}:exact`, traceId: trace.id, text: fact.content, sensitivity: 'exact', minStrength: MEMORY_STRENGTH_LEVELS.exact, sourceFactId: fact.id }];
}

/**
 * Builds the exact packet shape used by actor recall from an already resolved
 * effective strength.  The workbench uses this for the read-only strength
 * indicator so hovering a threshold previews the same gist/detail omissions
 * that production recall would emit, without mutating the persisted trace.
 */
export function buildMemoryRecallPacketAtStrength(
  trace: ActorMemoryTrace,
  fact: RecallFact,
  effectiveStrengthValue: number,
  sceneEpoch = 'default',
): MemoryRecallPacket | null {
  const strength = clamp(effectiveStrengthValue);
  if (strength <= 0 || strength < MEMORY_STRENGTH_LEVELS.forgotten) return null;
  const seed = deterministicSeed(trace.ownerId, trace.factId, trace.traceRevision, sceneEpoch);
  const available = detailUnits(trace, fact).filter(detail => strength >= detail.minStrength);
  const useExact = strength >= MEMORY_STRENGTH_LEVELS.exact;
  const packetDetails = useExact ? available : available.filter(detail => detail.sensitivity !== 'exact');
  const omittedDetailCount = detailUnits(trace, fact).length - packetDetails.length;
  const clarity = strength >= MEMORY_STRENGTH_LEVELS.clear ? trace.clarity : strength >= MEMORY_STRENGTH_LEVELS.gist ? Math.min(trace.clarity, 65) : Math.min(trace.clarity, 35);
  const packetGist = strength >= MEMORY_STRENGTH_LEVELS.gist ? gist(fact.content) : (seedNumber(seed) > 0.15 ? '关于某件事的模糊记忆' : '一段不清晰的相关记忆');
  return { traceId: trace.id, factId: fact.id, ownerId: trace.ownerId, gist: packetGist, details: packetDetails, effectiveStrength: strength, clarity, deterministicSeed: seed, omittedDetailCount };
}

/** Builds a packet without handing forbidden fact details to a fuzzy rewriter. */
export function buildMemoryRecallPacket(trace: ActorMemoryTrace, fact: RecallFact, now = Date.now(), sceneEpoch = 'default', config?: MemoryStrengthConfig): MemoryRecallPacket | null {
  return buildMemoryRecallPacketAtStrength(trace, fact, effectiveMemoryStrength(trace, now, config), sceneEpoch);
}

export function rehearsalAllowed(input: { readonly confidence: number; readonly used: boolean; readonly explicitRecall?: boolean; readonly newObservation?: boolean }): boolean {
  return input.used && (input.explicitRecall === true || input.newObservation === true || input.confidence >= 0.85);
}
