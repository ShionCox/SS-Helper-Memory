/**
 * Deterministic, dependency-free P7 evaluator.
 *
 * The evaluator deliberately accepts metrics rather than model clients.  A
 * fixed JSONL fixture and a fake extractor can therefore run in CI without
 * network access, while a later real-model runner can feed the same records
 * and compare its report to this baseline.
 */

export interface OfflineAttributionCheck {
  readonly expectedOwnerId: string;
  readonly actualOwnerId: string;
}

export interface OfflineLeakageCheck {
  readonly targetOwnerId: string;
  readonly forbiddenMarkers: readonly string[];
  readonly output: string;
}

export interface OfflineFuzzyCheck {
  readonly allowedText: readonly string[];
  readonly forbiddenText?: readonly string[];
  readonly generatedText: string;
}

export interface OfflineGroundingCheck {
  readonly referencedTraceIds: readonly string[];
  readonly legalTraceIds: readonly string[];
}

export interface OfflineDreamCheck {
  readonly rolledBack: boolean;
  readonly derivedInvalidated: boolean;
}

export interface OfflinePerformanceCheck {
  readonly objectiveRecallMs: number;
  readonly actorFilterPromptMs: number;
  readonly promptChars: number;
}

export interface OfflineMemoryEvalCase {
  readonly id: string;
  readonly attribution?: readonly OfflineAttributionCheck[];
  readonly leakage?: readonly OfflineLeakageCheck[];
  readonly fuzzy?: readonly OfflineFuzzyCheck[];
  readonly grounding?: readonly OfflineGroundingCheck[];
  readonly dream?: readonly OfflineDreamCheck[];
  readonly performance?: readonly OfflinePerformanceCheck[];
}

export interface OfflineMemoryEvalReport {
  readonly caseCount: number;
  readonly attributionAccuracy: number;
  readonly attributionChecks: number;
  readonly leakageRate: number;
  readonly leakageChecks: number;
  readonly fuzzyFabricationRate: number;
  readonly fuzzyChecks: number;
  readonly groundingViolationRate: number;
  readonly groundingChecks: number;
  readonly dreamRollbackPassRate: number;
  readonly dreamChecks: number;
  readonly objectiveRecallP95Ms: number;
  readonly actorFilterPromptP95Ms: number;
  readonly promptCharsP95: number;
  readonly pass: boolean;
}

const rate = (numerator: number, denominator: number): number => denominator === 0 ? 0 : numerator / denominator;

function percentile95(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

function includesForbidden(output: string, marker: string): boolean {
  const value = marker.trim();
  return value.length > 0 && output.includes(value);
}

/** Runs the fixed-set metrics with no timestamps, randomness, or LLM calls. */
export function evaluateOfflineMemoryCases(cases: readonly OfflineMemoryEvalCase[]): OfflineMemoryEvalReport {
  const attribution = cases.flatMap(item => item.attribution ?? []);
  const leakage = cases.flatMap(item => item.leakage ?? []);
  const fuzzy = cases.flatMap(item => item.fuzzy ?? []);
  const grounding = cases.flatMap(item => item.grounding ?? []);
  const dream = cases.flatMap(item => item.dream ?? []);
  const performance = cases.flatMap(item => item.performance ?? []);

  const attributionCorrect = attribution.filter(item => item.expectedOwnerId === item.actualOwnerId).length;
  const leakageViolations = leakage.reduce((total, item) => total + item.forbiddenMarkers.filter(marker => includesForbidden(item.output, marker)).length, 0);
  const leakageChecks = leakage.reduce((total, item) => total + item.forbiddenMarkers.length, 0);
  const fuzzyViolations = fuzzy.filter(item => item.allowedText.length === 0
    || !item.allowedText.some(value => item.generatedText.includes(value))
    || (item.forbiddenText ?? []).some(value => includesForbidden(item.generatedText, value))).length;
  const groundingViolations = grounding.filter(item => item.referencedTraceIds.some(traceId => !item.legalTraceIds.includes(traceId))).length;
  const dreamPassed = dream.filter(item => item.rolledBack && item.derivedInvalidated).length;

  const report: OfflineMemoryEvalReport = {
    caseCount: cases.length,
    attributionAccuracy: rate(attributionCorrect, attribution.length),
    attributionChecks: attribution.length,
    leakageRate: rate(leakageViolations, leakageChecks),
    leakageChecks,
    fuzzyFabricationRate: rate(fuzzyViolations, fuzzy.length),
    fuzzyChecks: fuzzy.length,
    groundingViolationRate: rate(groundingViolations, grounding.length),
    groundingChecks: grounding.length,
    dreamRollbackPassRate: rate(dreamPassed, dream.length),
    dreamChecks: dream.length,
    objectiveRecallP95Ms: percentile95(performance.map(item => item.objectiveRecallMs)),
    actorFilterPromptP95Ms: percentile95(performance.map(item => item.actorFilterPromptMs)),
    promptCharsP95: percentile95(performance.map(item => item.promptChars)),
    pass: attribution.length === 0 || attributionCorrect / attribution.length >= 0.95,
  };
  return {
    ...report,
    pass: report.pass
      && report.leakageRate === 0
      && report.fuzzyFabricationRate === 0
      && report.groundingViolationRate === 0
      && (dream.length === 0 || report.dreamRollbackPassRate === 1)
      && (performance.length === 0 || (report.objectiveRecallP95Ms <= 200 && report.actorFilterPromptP95Ms <= 300)),
  };
}
