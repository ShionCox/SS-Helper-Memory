import { createSSHelperError, readSSHelperFailure, type PlainData } from '@ss-helper/sdk';
import type { AutomaticIngestRejection, InventoryState, MemoryFact } from '../../domain';
import type { MultiActorMemoryRepository } from '../../infrastructure';
import {
  readMemoryLlmClient,
  type MemoryLlmClient,
} from '../ingest/llm-extractor';
import { buildSupportedEvidenceDirectory } from '../ingest/supported-evidence-directory';
import type { MemoryExtractionInput, StructuredCaptureResult, StructuredCandidateAttempt, StructuredClaim, StructuredInventoryOperation } from '../ingest/types';
import { AgentToolGateway } from '../tools/agent-tool-gateway';
import { FactUpdatePlanner, InventoryUpdatePlanner, SceneUpdatePlanner, TemporalStateResolver } from '../update';
import { DeterministicContextPrefetcher } from './context-prefetcher';
import { EXTRACTION_STAGE_SPECS } from './extraction-stage-specs';
import { ExtractionStageRunner, type StageRunResult } from './stage-runner';
import type {
  AgentPipelineSettings,
  ExtractionPipelineAudit,
  ExtractionRunContext,
  ExtractionStageAudit,
  ExtractionStageKey,
  MemoryReviewItem,
  ToolReadSetEntry,
  UpdateDecisionAudit,
} from './extraction-types';

const EMPTY_CAPTURE = Object.freeze({
  actorCandidates: [], locationCandidates: [], itemCandidates: [], episodes: [], claims: [], inventoryOperations: [],
} satisfies StructuredCaptureResult);

function plain(value: unknown): PlainData { return JSON.parse(JSON.stringify(value)) as PlainData; }
function objectRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function applyClaimEdit(claim: StructuredClaim, payload: PlainData | undefined): StructuredClaim {
  const edit = objectRecord(payload);
  const next: StructuredClaim = { ...claim };
  for (const field of ['subjectRef', 'subjectText', 'predicateKey', 'objectRef', 'objectText', 'content', 'episodeLocalId'] as const) {
    const value = typeof edit[field] === 'string' ? String(edit[field]).trim() : '';
    if (value) next[field] = value;
  }
  if (typeof edit.confidence === 'number' && Number.isFinite(edit.confidence) && edit.confidence >= 0 && edit.confidence <= 1) next.confidence = edit.confidence;
  if (typeof edit.stableAnchor === 'boolean') next.stableAnchor = edit.stableAnchor;
  return next;
}

function applyInventoryEdit(operation: StructuredInventoryOperation, payload: PlainData | undefined): StructuredInventoryOperation {
  const edit = objectRecord(payload);
  const next: StructuredInventoryOperation = { ...operation };
  for (const field of ['itemRef', 'rawAmount', 'unit', 'stateNote'] as const) if (typeof edit[field] === 'string') next[field] = String(edit[field]).trim();
  if (typeof edit.amount === 'number' && Number.isFinite(edit.amount) && edit.amount >= 0) next.amount = edit.amount;
  if (['increase', 'decrease', 'set', 'remove'].includes(String(edit.operation))) next.operation = String(edit.operation) as StructuredInventoryOperation['operation'];
  if (['count', 'volume', 'weight', 'durability', 'charge', 'condition', 'other'].includes(String(edit.measureKind))) next.measureKind = String(edit.measureKind) as StructuredInventoryOperation['measureKind'];
  if (['exact', 'approximate', 'range', 'unknown'].includes(String(edit.precision))) next.precision = String(edit.precision) as StructuredInventoryOperation['precision'];
  return next;
}

async function sha256(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return `sha256:${[...bytes].map(item => item.toString(16).padStart(2, '0')).join('')}`;
}

function usageFromStages(stages: readonly StageRunResult[]) {
  const rows = stages.map(item => item.output.audit?.usage).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (rows.length === 0) return null;
  const sum = (field: keyof NonNullable<(typeof rows)[number]>): number | null => {
    const values = rows.map(item => item[field]).filter((item): item is number => typeof item === 'number');
    return values.length === 0 ? null : values.reduce((total, item) => total + item, 0);
  };
  return { promptTokens: sum('promptTokens'), completionTokens: sum('completionTokens'), cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'), totalTokens: sum('totalTokens') };
}

function stageFailure(stage: ExtractionStageKey, error: unknown, latencyMs: number): { result: StageRunResult; rejection: AutomaticIngestRejection } {
  const failure = readSSHelperFailure(error, { reasonCode: 'MEMORY_EXTRACTION_STAGE_FAILED', stage: `memory.extraction.${stage}` })!;
  const issue = {
    path: failure.path ?? '$',
    keyword: failure.keyword ?? 'stage',
    expected: failure.expected ?? 'a validated fixed-stage result',
  };
  const audit: ExtractionStageAudit = {
    stage, stageAttemptId: `memory-stage:${stage}:${crypto.randomUUID()}`, taskKey: EXTRACTION_STAGE_SPECS[stage].taskKey,
    status: failure.reasonCode === 'MEMORY_EXTRACTION_PIPELINE_CANCELLED' || failure.reasonCode === 'CANCELLED' ? 'cancelled' : 'failed',
    toolRounds: 0, toolCalls: 0, latencyMs, reasonCode: failure.reasonCode,
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
  };
  return {
    result: { output: { ...EMPTY_CAPTURE }, audit },
    rejection: {
      id: `pipeline:${stage}:${crypto.randomUUID()}`,
      index: 0,
      code: 'schema_validation_failed',
      message: `固定阶段 ${stage} 未返回可提交结果。`,
      recordType: 'batch',
      fieldPath: issue.path,
      issues: [issue],
      failure,
      status: 'unresolved',
      repairAttempts: 0,
      ...(failure.requestId ? { requestId: failure.requestId } : {}),
    },
  };
}

function mergeStages(stages: readonly StageRunResult[], rejections: readonly AutomaticIngestRejection[]): StructuredCaptureResult {
  return {
    actorCandidates: stages.flatMap(item => item.output.actorCandidates),
    locationCandidates: stages.flatMap(item => item.output.locationCandidates),
    itemCandidates: stages.flatMap(item => item.output.itemCandidates ?? []),
    episodes: stages.flatMap(item => item.output.episodes),
    claims: stages.flatMap(item => item.output.claims),
    inventoryOperations: stages.flatMap(item => item.output.inventoryOperations ?? []),
    rejections: [...stages.flatMap(item => item.output.rejections ?? []), ...rejections],
    diagnostics: {
      parser: 'fixed-stage-v0',
      deterministicRepairs: stages.reduce((total, item) => total + (item.output.diagnostics?.deterministicRepairs ?? 0), 0),
      schemaRepairCalls: stages.reduce((total, item) => total + (item.output.diagnostics?.schemaRepairCalls ?? 0), 0),
      transportMode: stages.some(item => item.output.diagnostics?.transportMode === 'native_strict') ? 'native_strict' : 'json_object_validated',
    },
  };
}

function candidateAttemptFromStage(result: StageRunResult, attemptIndex: number): StructuredCandidateAttempt {
  const output = result.output;
  const collection = <T extends { localId: string; sourceRef?: string; sourceRefs?: readonly string[]; evidenceExcerpt?: string; evidenceExcerpts?: readonly string[]; summary?: string }>(items: readonly T[]) => items.map(item => ({
    localId: item.localId,
    sourceRefs: item.sourceRefs ? [...item.sourceRefs] : item.sourceRef ? [item.sourceRef] : [],
    evidenceExcerpts: item.evidenceExcerpts ? [...item.evidenceExcerpts] : item.evidenceExcerpt ? [item.evidenceExcerpt] : [],
    summary: item.summary ?? item.evidenceExcerpt ?? item.localId,
    normalizedCandidate: plain(item),
  }));
  return {
    stage: result.audit.stage,
    stageAttemptId: result.audit.stageAttemptId ?? `memory-stage:${result.audit.stage}:${attemptIndex}`,
    attemptIndex,
    collections: {
      actorCandidates: collection(output.actorCandidates),
      locationCandidates: collection(output.locationCandidates),
      itemCandidates: collection(output.itemCandidates ?? []),
      episodes: collection(output.episodes),
      claims: collection(output.claims),
      inventoryOperations: collection(output.inventoryOperations ?? []),
    },
  };
}

function attachCandidateAttempts(output: StructuredCaptureResult, attempts: readonly StageRunResult[]): StructuredCaptureResult {
  return {
    ...output,
    candidateAttempts: attempts.map((attempt, index) => candidateAttemptFromStage(attempt, index)),
  };
}

function uniqueStages(values: readonly ExtractionStageKey[]): ExtractionStageKey[] {
  return [...new Set(values)];
}

function stagesRequiringRerun(entries: readonly ToolReadSetEntry[]): ExtractionStageKey[] {
  const stages = new Set<ExtractionStageKey>();
  for (const entry of entries) {
    // A fact revision is reloaded by FactUpdatePlanner and cannot change source
    // evidence or entity mapping. Other stored context can affect identity,
    // scene, quantity direction, or time-slot interpretation and must rerun.
    if (entry.kind === 'fact') continue;
    stages.add(entry.stage);
    if (entry.stage === 'entities') stages.add('content');
  }
  return [...stages];
}

export class ExtractionPipelineCoordinator {
  readonly #prefetcher: DeterministicContextPrefetcher;
  readonly #runner: ExtractionStageRunner;
  readonly #temporal = new TemporalStateResolver();
  readonly #factPlanner = new FactUpdatePlanner();
  readonly #inventoryPlanner = new InventoryUpdatePlanner();
  readonly #scenePlanner = new SceneUpdatePlanner();
  #settingsRevision = 0;
  #settingsDigest = '';

  constructor(
    private readonly getSettings: () => AgentPipelineSettings,
    private readonly repository?: MultiActorMemoryRepository,
    private readonly getLlm: () => MemoryLlmClient | null = readMemoryLlmClient,
  ) {
    this.#prefetcher = new DeterministicContextPrefetcher(repository);
    this.#runner = new ExtractionStageRunner(getLlm);
  }

  async extract(input: MemoryExtractionInput): Promise<StructuredCaptureResult> {
    const startedAt = Date.now();
    const currentSettings = this.getSettings();
    const settings = input.runtimeExtraction
      ? { ...currentSettings, ...input.runtimeExtraction }
      : currentSettings;
    const prefetched = await this.#prefetcher.prefetch(input);
    const routeRequest = this.getLlm()?.inspect?.getTaskStatus?.(Object.values(EXTRACTION_STAGE_SPECS).map(item => item.taskKey));
    const routeSnapshot = routeRequest ? await routeRequest.catch(() => undefined) : undefined;
    const settingsDigest = await sha256(settings);
    if (settingsDigest !== this.#settingsDigest) { this.#settingsDigest = settingsDigest; this.#settingsRevision += 1; }
    const sourceRefs = input.sources.map(source => source.id);
    const writableSourceRefs = input.writableSourceRefs ?? sourceRefs;
    const evidenceDirectory = buildSupportedEvidenceDirectory(input.sources, writableSourceRefs);
    const signal = input.signal ?? new AbortController().signal;
    const context: ExtractionRunContext = {
      pipelineRunId: `memory-pipeline:${crypto.randomUUID()}`,
      workspaceId: input.workspaceId ?? this.repository?.boundWorkspaceId ?? '',
      chatKey: input.chatKey,
      workflowLabel: input.workflow?.label ?? (settings.extractionMode === 'agent' ? 'Agent 记忆提取' : '单次记忆提取'),
      workflowKind: input.workflow?.kind ?? (settings.extractionMode === 'agent' ? 'agent' : 'single'),
      ...(input.workflow?.jobId ? { jobId: input.workflow.jobId } : {}),
      ...(input.workflow?.batchIndex === undefined ? {} : { batchIndex: input.workflow.batchIndex }),
      ...(input.workflow?.batchCount === undefined ? {} : { batchCount: input.workflow.batchCount }),
      mode: settings.extractionMode,
      agentConcurrency: settings.agentConcurrency,
      agentToolPolicy: settings.agentToolPolicy,
      settingsRevision: this.#settingsRevision,
      routeRevision: routeSnapshot?.revision ?? 0,
      dataRevision: prefetched.dataRevision,
      sourceBatchDigest: await sha256(input.sources.map(source => ({ id: source.id, floor: source.floor, createdAt: source.createdAt, content: source.content }))),
      routeSnapshotDigest: await sha256(routeSnapshot ?? { revision: 0, assignments: [] }),
      settingsSnapshotDigest: settingsDigest,
      sourceRefs,
      writableSourceRefs,
      evidenceDirectory,
      signal,
    };
    if (signal.aborted) throw createSSHelperError('MEMORY_EXTRACTION_PIPELINE_CANCELLED', { stage: 'memory.extraction.start' });
    if (input.repair) {
      const gateways: AgentToolGateway[] = [];
      const attempts: StageRunResult[] = [];
      let repairInput = prefetched.input;
      let repairContext = context;
      let gateway = new AgentToolGateway(repairInput, this.repository);
      gateways.push(gateway);
      let result = await this.#runner.run('repair', repairInput, repairContext, gateway);
      attempts.push(result);
      let guard = await gateway.verifyReadSet();
      if (stagesRequiringRerun(guard.staleEntries).includes('repair')) {
        const refreshed = await this.#prefetcher.prefetch(input);
        repairInput = refreshed.input;
        repairContext = { ...context, dataRevision: refreshed.dataRevision };
        gateway = new AgentToolGateway(repairInput, this.repository);
        gateways.push(gateway);
        result = await this.#runner.run('repair', repairInput, repairContext, gateway);
        attempts.push(result);
        guard = await gateway.verifyReadSet();
      }
      if (stagesRequiringRerun(guard.staleEntries).includes('repair')) {
        throw createSSHelperError('MEMORY_AGENT_TOOL_STALE_REVISION', { stage: 'memory.extraction.repair.read-set' });
      }
      const audit = this.buildAudit(context, attempts, gateways, [], startedAt);
      return { ...attachCandidateAttempts(result.output, attempts), audit: { ...result.output.audit, pipeline: audit } };
    }
    if (input.stage && input.stage !== 'single') {
      const gateways: AgentToolGateway[] = [];
      const attempts: StageRunResult[] = [];
      let finalInput = prefetched.input;
      let finalContext = { ...context, mode: 'single' as const, agentToolPolicy: 'off' as const };
      let gateway = new AgentToolGateway(finalInput, this.repository);
      gateways.push(gateway);
      let stageResult = await this.#runner.run(input.stage, finalInput, finalContext, gateway);
      attempts.push(stageResult);
      let guard = await gateway.verifyReadSet();
      if (stagesRequiringRerun(guard.staleEntries).includes(input.stage)) {
        const refreshed = await this.#prefetcher.prefetch(input);
        finalInput = refreshed.input;
        finalContext = { ...finalContext, dataRevision: refreshed.dataRevision };
        gateway = new AgentToolGateway(finalInput, this.repository);
        gateways.push(gateway);
        stageResult = await this.#runner.run(input.stage, finalInput, finalContext, gateway);
        attempts.push(stageResult);
        guard = await gateway.verifyReadSet();
      }
      const staleStages = stagesRequiringRerun(guard.staleEntries);
      const planned = await this.planUpdates(stageResult.output, finalInput, finalContext, staleStages.length === 0, staleStages, guard.staleEntries, gateways);
      const audit = this.buildAudit(finalContext, attempts, gateways, planned.decisions, startedAt);
      return { ...attachCandidateAttempts({ ...planned.output, reviewItems: planned.reviewItems }, attempts), audit: { ...stageResult.output.audit, pipeline: audit } };
    }
    if (input.stage === 'single' || settings.extractionMode === 'single') {
      const gateways: AgentToolGateway[] = [];
      const attempts: StageRunResult[] = [];
      let finalInput = prefetched.input;
      let finalContext = {
        ...context,
        mode: 'single' as const,
        agentToolPolicy: 'off' as const,
      };
      let gateway = new AgentToolGateway(finalInput, this.repository);
      gateways.push(gateway);
      let single = await this.#runner.run('single', finalInput, finalContext, gateway);
      attempts.push(single);
      let guard = await gateway.verifyReadSet();
      if (stagesRequiringRerun(guard.staleEntries).includes('single')) {
        const refreshed = await this.#prefetcher.prefetch(input);
        finalInput = refreshed.input;
        finalContext = { ...finalContext, dataRevision: refreshed.dataRevision };
        gateway = new AgentToolGateway(finalInput, this.repository);
        gateways.push(gateway);
        single = await this.#runner.run('single', finalInput, finalContext, gateway);
        attempts.push(single);
        guard = await gateway.verifyReadSet();
      }
      const staleStages = stagesRequiringRerun(guard.staleEntries);
      const planned = await this.planUpdates(single.output, finalInput, finalContext, staleStages.length === 0, staleStages, guard.staleEntries, gateways);
      const audit = this.buildAudit(finalContext, attempts, gateways, planned.decisions, startedAt);
      return { ...attachCandidateAttempts({ ...planned.output, reviewItems: planned.reviewItems }, attempts), audit: { ...single.output.audit, pipeline: audit } };
    }

    const gateways: AgentToolGateway[] = [];
    let gateway = new AgentToolGateway(prefetched.input, this.repository);
    gateways.push(gateway);
    const rejections: AutomaticIngestRejection[] = [];
    const allAttempts: StageRunResult[] = [];
    const safeRun = async (stage: 'entities' | 'content', stageInput: MemoryExtractionInput, stageContext: ExtractionRunContext, stageGateway: AgentToolGateway): Promise<StageRunResult> => {
      const began = Date.now();
      try {
        const result = await this.#runner.run(stage, stageInput, stageContext, stageGateway);
        allAttempts.push(result);
        return result;
      }
      catch (error) {
        const failed = stageFailure(stage, error, Date.now() - began);
        rejections.push(failed.rejection);
        allAttempts.push(failed.result);
        return failed.result;
      }
    };
    let entities = await safeRun('entities', prefetched.input, context, gateway);
    const downstreamInput = (base: MemoryExtractionInput, entityResult: StageRunResult): MemoryExtractionInput => ({
      ...base,
      knownActorContext: [
        ...(base.knownActorContext ?? []),
        ...entityResult.output.actorCandidates.map(item => ({ referenceId: item.localId, canonicalName: item.displayName, aliases: [...item.aliases], status: 'pending' as const })),
      ],
      knownLocationContext: [
        ...(base.knownLocationContext ?? []),
        ...entityResult.output.locationCandidates.map(item => ({ referenceId: item.localId, canonicalName: item.displayName, aliases: [...item.aliases], status: 'pending' as const })),
      ],
    });
    let downstream: MemoryExtractionInput = downstreamInput(prefetched.input, entities);
    await gateway.registerPendingReferences(downstream);
    let content = await safeRun('content', downstream, context, gateway);
    const initialGateway = gateway;
    let finalInput = prefetched.input;
    let finalContext = context;
    let guard = await gateway.verifyReadSet();
    const rerunStages = stagesRequiringRerun(guard.staleEntries);
    if (rerunStages.length > 0) {
      const refreshed = await this.#prefetcher.prefetch(input);
      finalInput = refreshed.input;
      finalContext = { ...context, dataRevision: refreshed.dataRevision };
      gateway = new AgentToolGateway(finalInput, this.repository);
      gateways.push(gateway);
      if (rerunStages.includes('entities')) entities = await safeRun('entities', finalInput, finalContext, gateway);
      downstream = downstreamInput(finalInput, entities);
      await gateway.registerPendingReferences(downstream);
      const rerunContent = rerunStages.includes('content');
      if (rerunContent) content = await safeRun('content', downstream, finalContext, gateway);
      const [unaffectedGuard, retryGuard] = await Promise.all([
        initialGateway.verifyReadSet(rerunStages),
        gateway.verifyReadSet(),
      ]);
      guard = {
        valid: unaffectedGuard.valid && retryGuard.valid,
        staleStages: uniqueStages([...unaffectedGuard.staleStages, ...retryGuard.staleStages]),
        staleEntries: [...unaffectedGuard.staleEntries, ...retryGuard.staleEntries],
      };
    }
    const finalStages = [entities, content];
    const merged = mergeStages(finalStages, rejections);
    const staleStages = stagesRequiringRerun(guard.staleEntries);
    const planned = await this.planUpdates(merged, finalInput, finalContext, staleStages.length === 0, staleStages, guard.staleEntries, gateways);
    const audit = this.buildAudit(context, allAttempts, gateways, planned.decisions, startedAt);
    return { ...attachCandidateAttempts({ ...planned.output, reviewItems: planned.reviewItems }, allAttempts), audit: { ...planned.output.audit, pipeline: audit } };
  }

  private buildAudit(
    context: ExtractionRunContext,
    stages: readonly StageRunResult[],
    gateways: readonly AgentToolGateway[],
    updateDecisions: readonly UpdateDecisionAudit[],
    startedAt: number,
  ): ExtractionPipelineAudit {
    const capabilitySnapshotId = stages.map(item => item.audit.requestId).find(Boolean);
    return {
      pipelineRunId: context.pipelineRunId,
      workflowLabel: context.workflowLabel,
      workflowKind: context.workflowKind,
      ...(context.jobId ? { jobId: context.jobId } : {}),
      ...(context.batchIndex === undefined ? {} : { batchIndex: context.batchIndex }),
      ...(context.batchCount === undefined ? {} : { batchCount: context.batchCount }),
      mode: context.mode,
      toolPolicy: context.agentToolPolicy,
      sourceBatchDigest: context.sourceBatchDigest,
      evidenceSetHash: context.evidenceDirectory.evidenceSetHash,
      routeSnapshotDigest: context.routeSnapshotDigest,
      settingsSnapshotDigest: context.settingsSnapshotDigest,
      promptVersion: 1,
      stageSchemaVersion: 1,
      toolDefinitionVersion: 1,
      toolResultSchemaVersion: 1,
      providerAdapterVersion: 1,
      ...(capabilitySnapshotId ? { capabilitySnapshotId } : {}),
      stages: stages.map(item => item.audit),
      toolCalls: gateways.flatMap(gateway => gateway.audits()),
      updateDecisions,
      totalUsage: usageFromStages(stages),
      wallClockLatencyMs: Date.now() - startedAt,
    };
  }

  private async planUpdates(
    capture: StructuredCaptureResult,
    input: MemoryExtractionInput,
    context: ExtractionRunContext,
    readSetValid: boolean,
    staleStages: readonly ExtractionStageKey[],
    staleEntries: readonly ToolReadSetEntry[],
    gateways: readonly AgentToolGateway[],
  ): Promise<{ output: StructuredCaptureResult; reviewItems: MemoryReviewItem[]; decisions: UpdateDecisionAudit[] }> {
    const [facts, states, scenes] = this.repository
      ? await Promise.all([this.repository.listFacts(), this.repository.listInventoryStates(), this.repository.listSceneStates()])
      : [[], [], []] as [MemoryFact[], InventoryState[], Awaited<ReturnType<MultiActorMemoryRepository['listSceneStates']>>];
    const decisions: UpdateDecisionAudit[] = [];
    const reviews: MemoryReviewItem[] = [];
    const reviewOverride = input.reviewOverride;
    const workingCapture: StructuredCaptureResult = {
      ...capture,
      claims: capture.claims.map(claim => reviewOverride?.candidateLocalId === claim.localId
        ? { ...(reviewOverride.action === 'edit' ? applyClaimEdit(claim, reviewOverride.payload) : claim), ...(reviewOverride.action === 'accept' || reviewOverride.action === 'edit' ? { reviewApproved: true } : {}) }
        : claim),
      inventoryOperations: (capture.inventoryOperations ?? []).map(operation => reviewOverride?.candidateLocalId === operation.localId
        ? { ...(reviewOverride.action === 'edit' ? applyInventoryEdit(operation, reviewOverride.payload) : operation), ...(reviewOverride.action === 'merge' && typeof objectRecord(reviewOverride.payload).targetRef === 'string' ? { itemRef: String(objectRecord(reviewOverride.payload).targetRef) } : {}), ...(reviewOverride.action === 'accept' || reviewOverride.action === 'edit' || reviewOverride.action === 'merge' ? { reviewApproved: true } : {}) }
        : operation),
    };
    const knownItemIds = new Map((input.knownInventoryContext ?? []).map(item => [item.referenceId, item.itemId]));
    const referenceNames = new Map([
      ...(input.knownActorContext ?? []).map(item => [item.referenceId, item.canonicalName] as const),
      ...(input.knownLocationContext ?? []).map(item => [item.referenceId, item.canonicalName] as const),
      ...workingCapture.actorCandidates.map(item => [item.localId, item.displayName] as const),
      ...workingCapture.locationCandidates.map(item => [item.localId, item.displayName] as const),
    ]);
    const decisionStage = (owned: 'entities' | 'content'): ExtractionStageKey => context.mode === 'single' || input.stage === 'single' ? 'single' : owned;
    const stageToolCallIds = (stage: ExtractionStageKey): string[] => gateways.flatMap(gateway => gateway.audits()).filter(item => item.stage === stage).map(item => item.callId);
    const stageReadSet = (stage: ExtractionStageKey): ToolReadSetEntry[] => gateways.flatMap(gateway => gateway.readSet()).filter(item => item.stage === stage);
    const stageDigests = new Map<ExtractionStageKey, string>();
    for (const stage of uniqueStages([decisionStage('entities'), decisionStage('content')])) stageDigests.set(stage, await sha256(stageReadSet(stage)));
    const evidenceIds = (sourceRefs: readonly string[], excerpt?: string): string[] => context.evidenceDirectory.spans
      .filter(span => sourceRefs.includes(span.sourceRef) && (!excerpt || span.text === excerpt))
      .map(span => span.evidenceSpanId);
    const contentStage = decisionStage('content');
    const entitiesStage = decisionStage('entities');
    const reviewTrace = (stage: ExtractionStageKey): Pick<MemoryReviewItem, 'readSetSummary' | 'toolCallSummary'> => {
      const calls = gateways.flatMap(gateway => gateway.audits()).filter(item => item.stage === stage);
      return {
        readSetSummary: {
          digest: stageDigests.get(stage)!,
          readCount: stageReadSet(stage).length,
          stale: staleStages.includes(stage),
          changedRefs: [...new Set(staleEntries.filter(item => item.stage === stage).map(item => item.ref))],
        },
        toolCallSummary: {
          callCount: calls.length,
          failedCount: calls.filter(item => !item.ok).length,
          tools: [...new Set(calls.map(item => item.tool))],
          callIds: calls.map(item => item.callId),
        },
      };
    };
    const claims = workingCapture.claims.flatMap(claim => {
      const temporal = this.#temporal.resolve(claim, input.sources);
      const comparableClaim = { ...claim };
      if (claim.subjectRef && referenceNames.has(claim.subjectRef)) { delete comparableClaim.subjectRef; comparableClaim.subjectText = referenceNames.get(claim.subjectRef); }
      if (claim.objectRef && referenceNames.has(claim.objectRef)) { delete comparableClaim.objectRef; comparableClaim.objectText = referenceNames.get(claim.objectRef); }
      const basePlan = this.#factPlanner.plan(comparableClaim, facts, temporal, readSetValid || !staleStages.includes(contentStage));
      if (reviewOverride?.candidateLocalId === claim.localId && reviewOverride.action === 'merge') {
        const targetRef = typeof objectRecord(reviewOverride.payload).targetRef === 'string' ? String(objectRecord(reviewOverride.payload).targetRef) : '';
        const target = facts.find(fact => fact.id === targetRef) ?? (/^F\d+$/u.test(targetRef) ? basePlan.current : undefined);
        if (!target) {
          decisions.push({ stage: contentStage, candidateLocalId: claim.localId, decision: 'reject', reasonCode: 'MEMORY_UPDATE_PENDING_REVIEW', evidenceSpanIds: evidenceIds([claim.sourceRef], claim.evidenceExcerpt), toolCallIds: stageToolCallIds(contentStage), ...(stageDigests.get(contentStage) ? { readSetDigest: stageDigests.get(contentStage)! } : {}) });
          return [];
        }
        const { subjectRef: _subjectRef, objectRef: _objectRef, ...claimWithoutRefs } = claim;
        const mergedClaim: StructuredClaim = {
          ...claimWithoutRefs,
          kind: target.kind,
          subjectText: target.subjectKey,
          predicateKey: target.predicateKey,
          objectText: target.objectKey ?? '',
          content: target.content,
          confidence: Math.max(claim.confidence, target.confidence),
          reviewApproved: true,
        };
        decisions.push({ stage: contentStage, candidateLocalId: claim.localId, currentRef: target.id, decision: 'merge', reasonCode: 'MEMORY_REVIEW_APPROVED', evidenceSpanIds: evidenceIds([claim.sourceRef], claim.evidenceExcerpt), toolCallIds: stageToolCallIds(contentStage), ...(stageDigests.get(contentStage) ? { readSetDigest: stageDigests.get(contentStage)! } : {}) });
        return [mergedClaim];
      }
      const plan = claim.reviewApproved && basePlan.decision === 'pending_review'
        ? { ...basePlan, decision: basePlan.current ? 'supersede' as const : 'create' as const, reasonCode: 'MEMORY_REVIEW_APPROVED' }
        : basePlan;
      const itemEvidenceIds = evidenceIds([claim.sourceRef], claim.evidenceExcerpt);
      const review = plan.decision === 'pending_review' ? this.reviewItem(context, contentStage, claim.localId, plan.reasonCode, [claim.sourceRef], itemEvidenceIds, plain({ kind: claim.kind, subject: claim.subjectRef ?? claim.subjectText, predicate: claim.predicateKey, content: claim.content.slice(0, 240) }), reviewTrace(contentStage), plan.current ? plain({ factId: plan.current.id, content: plan.current.content.slice(0, 240), revision: plan.current.revision }) : undefined) : undefined;
      if (review) reviews.push(review);
      decisions.push({ stage: contentStage, candidateLocalId: claim.localId, ...(plan.current ? { currentRef: plan.current.id } : {}), comparison: plan.reasonCode, decision: plan.decision, reasonCode: plan.reasonCode, evidenceSpanIds: itemEvidenceIds, toolCallIds: stageToolCallIds(contentStage), ...(stageDigests.get(contentStage) ? { readSetDigest: stageDigests.get(contentStage)! } : {}), temporalDecision: plan.decision === 'append_history' ? 'historical' : 'current', ...(review ? { reviewItemId: review.id } : {}) });
      return ['duplicate_noop', 'pending_review', 'reject'].includes(plan.decision) ? [] : [claim];
    });
    const inventoryCandidates = workingCapture.inventoryOperations ?? [];
    const inventoryOperations = [...new Map(inventoryCandidates.map(operation => [
      `${operation.itemRef}\u0000${operation.measureKind}\u0000${operation.unit}\u0000${operation.operation}\u0000${operation.amount ?? ''}`,
      operation,
    ])).values()].flatMap(operation => {
      const itemId = knownItemIds.get(operation.itemRef);
      const current = itemId ? states.find(state => state.itemId === itemId && state.measureKind === operation.measureKind) : undefined;
      const basePlan = this.#inventoryPlanner.plan(operation, current, this.#temporal.resolve(operation, input.sources), readSetValid || !staleStages.includes(contentStage));
      const plan = operation.reviewApproved && basePlan.decision === 'pending_review'
        ? { decision: current ? (operation.operation === 'set' ? 'set_snapshot' as const : 'apply_delta' as const) : 'create_item' as const, reasonCode: 'MEMORY_REVIEW_APPROVED' }
        : basePlan;
      const itemEvidenceIds = evidenceIds([operation.sourceRef], operation.evidenceExcerpt);
      const review = plan.decision === 'pending_review' ? this.reviewItem(context, contentStage, operation.localId, plan.reasonCode, [operation.sourceRef], itemEvidenceIds, plain({ itemRef: operation.itemRef, operation: operation.operation, measureKind: operation.measureKind, amount: operation.amount, unit: operation.unit }), reviewTrace(contentStage), current ? plain({ itemId: current.itemId, amount: current.amount, unit: current.unit, revision: current.revision }) : undefined) : undefined;
      if (review) reviews.push(review);
      decisions.push({ stage: contentStage, candidateLocalId: operation.localId, ...(current ? { currentRef: current.id } : {}), comparison: plan.reasonCode, decision: plan.decision, reasonCode: plan.reasonCode, evidenceSpanIds: itemEvidenceIds, toolCallIds: stageToolCallIds(contentStage), ...(stageDigests.get(contentStage) ? { readSetDigest: stageDigests.get(contentStage)! } : {}), temporalDecision: plan.decision === 'append_history' ? 'historical' : 'current', ...(review ? { reviewItemId: review.id } : {}) });
      if (['duplicate_noop', 'pending_review', 'reject'].includes(plan.decision)) return [];
      return [{ ...operation, ...(plan.decision === 'append_history' ? { updateDecision: 'append_history' as const } : {}) }];
    });
    if (!input.stage || input.stage === 'single' || input.stage === 'entities') {
      const sceneTemporal = { observedAt: Date.now(), ingestedAt: Date.now() };
      const currentScene = scenes.sort((a, b) => b.updatedAtFloor - a.updatedAtFloor)[0];
      const scenePlan = this.#scenePlanner.plan(currentScene, input.sources, sceneTemporal, readSetValid || !staleStages.includes(entitiesStage), workingCapture.locationCandidates.map(item => item.localId));
      const sceneSourceRefs = workingCapture.locationCandidates.map(item => item.sourceRef);
      decisions.push({ stage: entitiesStage, candidateLocalId: workingCapture.locationCandidates[0]?.localId ?? 'scene', ...(currentScene ? { currentRef: currentScene.id } : {}), comparison: scenePlan.reasonCode, decision: scenePlan.decision, reasonCode: scenePlan.reasonCode, evidenceSpanIds: evidenceIds(sceneSourceRefs), toolCallIds: stageToolCallIds(entitiesStage), ...(stageDigests.get(entitiesStage) ? { readSetDigest: stageDigests.get(entitiesStage)! } : {}) });
    }
    return { output: { ...workingCapture, claims, inventoryOperations }, reviewItems: reviews, decisions };
  }

  private reviewItem(
    context: ExtractionRunContext,
    stage: ExtractionStageKey,
    candidateLocalId: string,
    reasonCode: string,
    sourceRefs: readonly string[],
    evidenceSpanIds: readonly string[],
    candidateSummary: PlainData,
    trace: Pick<MemoryReviewItem, 'readSetSummary' | 'toolCallSummary'>,
    currentStateSummary?: PlainData,
  ): MemoryReviewItem {
    return {
      id: `memory-review:${crypto.randomUUID()}`,
      workspaceId: context.workspaceId,
      chatKey: context.chatKey,
      pipelineRunId: context.pipelineRunId,
      stage,
      candidateLocalId,
      reasonCode,
      sourceRefs: [...sourceRefs],
      evidenceSpanIds: [...evidenceSpanIds],
      candidateSummary,
      ...trace,
      ...(currentStateSummary === undefined ? {} : { currentStateSummary }),
      status: 'pending',
      createdAt: Date.now(),
    };
  }
}
