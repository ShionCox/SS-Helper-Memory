import type { ActorMemoryTrace, RecallExposure } from '../../domain';
import { rehearsalAllowed } from './memory-strength';

export interface ExposureUpdate {
  readonly exposure: RecallExposure;
  readonly trace?: ActorMemoryTrace;
}

/** Separates “candidate was injected” from “the model actually used it”. */
export class RecallExposureTracker {
  private readonly exposures = new Map<string, RecallExposure>();
  private readonly traces = new Map<string, ActorMemoryTrace>();

  constructor(initialTraces: readonly ActorMemoryTrace[] = []) { for (const trace of initialTraces) this.traces.set(trace.id, structuredClone(trace)); }

  expose(input: Omit<RecallExposure, 'id' | 'createdAt'>): RecallExposure {
    const exposure: RecallExposure = { ...input, id: `recall-exposure:${crypto.randomUUID()}`, createdAt: Date.now() };
    this.exposures.set(exposure.id, exposure);
    return structuredClone(exposure);
  }

  markUsed(exposureId: string, confidence: number, explicitRecall = false, newObservation = false): ExposureUpdate {
    const exposure = this.exposures.get(exposureId);
    if (!exposure) throw new Error('RecallExposure 不存在。');
    const used = true;
    const updatedExposure = { ...exposure, used, confidence };
    this.exposures.set(exposureId, updatedExposure);
    const trace = this.traces.get(exposure.traceId);
    if (trace && rehearsalAllowed({ confidence, used, explicitRecall, newObservation })) {
      const updatedTrace: ActorMemoryTrace = { ...trace, rehearsalCount: trace.rehearsalCount + 1, strength: Math.min(100, trace.strength + 2), lastRehearsedAt: Date.now(), traceRevision: trace.traceRevision + 1, updatedAt: Date.now() };
      this.traces.set(trace.id, updatedTrace);
      return { exposure: structuredClone(updatedExposure), trace: structuredClone(updatedTrace) };
    }
    return { exposure: structuredClone(updatedExposure), ...(trace ? { trace: structuredClone(trace) } : {}) };
  }

  listExposures(): RecallExposure[] { return [...this.exposures.values()].map(exposure => structuredClone(exposure)); }
  listTraces(): ActorMemoryTrace[] { return [...this.traces.values()].map(trace => structuredClone(trace)); }
}

