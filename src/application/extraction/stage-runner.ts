import { createSSHelperError, readSSHelperFailure, type LlmWorkflowTrace, type NormalizedToolResult, type PlainData } from '@ss-helper/sdk';
import type { AutomaticIngestRejection } from '../../domain';
import type { MemoryLlmClient, MemoryLlmMeta, MemoryLlmUsage } from '../ingest/llm-extractor';
import {
  auditFromResponse,
  buildExtractionStageSchema,
  buildStructuredRepairSchema,
  memoryLlmUsageFromError,
  normalizeStructuredCapture,
  memoryLlmUsageFromProvider,
  mergeMemoryLlmUsage,
  serializeExtractionInput,
  StructuredMemoryCaptureExtractor,
  systemPrompt,
} from '../ingest/llm-extractor';
import { buildSupportedEvidenceDirectory } from '../ingest/supported-evidence-directory';
import type { MemoryExtractionInput, StructuredCaptureResult } from '../ingest/types';
import type { AgentToolGateway } from '../tools/agent-tool-gateway';
import { stageSystemPrompt } from './extraction-stage-prompts';
import { EXTRACTION_STAGE_SPECS } from './extraction-stage-specs';
import type { AgentToolName, ExtractionRunContext, ExtractionStageAudit, ExtractionStageKey } from './extraction-types';

export interface StageRunResult {
  readonly output: StructuredCaptureResult;
  readonly audit: ExtractionStageAudit;
}

function repairTargets(input: MemoryExtractionInput) {
  if (!input.repair) return [];
  return input.repair.targets?.length ? input.repair.targets : [{ repairId: 'repair-item-1', issues: input.repair.issues }];
}

function repairAllowedTools(input: MemoryExtractionInput): readonly AgentToolName[] {
  const collection = input.repair?.collection;
  if (collection === 'actorCandidates' || collection === 'locationCandidates') return ['entity.resolve_context', 'scene.resolve_context', 'reference.get_details'];
  if (collection === 'itemCandidates' || collection === 'inventoryOperations') return ['inventory.resolve_context', 'scene.resolve_context', 'reference.get_details'];
  if (collection === 'episodes' || collection === 'claims') return ['scene.resolve_context', 'memory.resolve_update_context', 'reference.get_details'];
  return [];
}

function allowedTools(stage: ExtractionStageKey, input: MemoryExtractionInput): readonly AgentToolName[] {
  return stage === 'repair' ? repairAllowedTools(input) : EXTRACTION_STAGE_SPECS[stage].allowedTools;
}

function workflowTrace(stage: ExtractionStageKey, context: ExtractionRunContext): LlmWorkflowTrace {
  const spec = EXTRACTION_STAGE_SPECS[stage];
  return {
    workflowId: context.pipelineRunId,
    workflowLabel: context.workflowLabel,
    workflowKind: context.workflowKind,
    ...(context.jobId ? { jobId: context.jobId } : {}),
    ...(context.batchIndex === undefined ? {} : { batchIndex: context.batchIndex }),
    ...(context.batchCount === undefined ? {} : { batchCount: context.batchCount }),
    stageKey: spec.taskKey,
    stageDescription: spec.description,
  };
}

function toolArgumentFailureResults(
  calls: readonly { readonly callId: string; readonly name: string }[],
  error: unknown,
  context: ExtractionRunContext,
): readonly NormalizedToolResult[] | undefined {
  const failure = readSSHelperFailure(error);
  if (failure?.reasonCode !== 'MEMORY_AGENT_TOOL_ARGUMENT_INVALID') return undefined;
  const safeFailure = {
    reasonCode: failure.reasonCode,
    stage: failure.stage,
    ...(failure.path ? { path: failure.path } : {}),
    ...(failure.keyword ? { keyword: failure.keyword } : {}),
    ...(failure.expected ? { expected: failure.expected } : {}),
  };
  return calls.map(call => ({
    callId: call.callId,
    name: call.name,
    ok: false,
    content: {
      ok: false,
      tool: call.name,
      callId: call.callId,
      contextOnly: true,
      evidenceAllowed: false,
      trust: 'stored_user_data',
      instructionsAllowed: false,
      dataRevision: context.dataRevision,
      readSet: [],
      truncated: false,
      failure: {
        ...safeFailure,
        message: '工具参数未通过本地校验，请按字段错误重新调用。',
      },
    } as PlainData,
  }));
}

function repairPrompt(input: MemoryExtractionInput): string {
  if (!input.repair) return '';
  return [
    input.repair.mode === 'conservative'
      ? '这是证据变化后的最后一次保守复核。可选字段没有直接证据时必须留空，引用数组只能保留 supportedReferences 中的成员。'
      : '这是第一次定向复核。只依据本次 sourceBlocks 重新提取；不要复用、猜测或补写上一轮失败 JSON。',
    `目标集合：${input.repair.collection}`,
    `修复次数：${input.repair.attempt ?? 1}/${input.repair.maxAttempts ?? 2}`,
    `复核目标：${JSON.stringify(repairTargets(input).map(target => ({ repairId: target.repairId, issues: target.issues.slice(0, 16) })))}`,
    'supportedReferences 是当前字段唯一允许使用的闭集。必须逐字复制 ref；目录外实体不得引用或猜测。',
    '每个 repairId 必须且只能返回一次 decision。证据充分时 emit 且 items 恰好一项；否则 drop 且 items 为空。',
    'emit 项仍会经过完整 Schema、证据、领域校验和提交守卫；工具结果只能消歧，不能充当证据。',
  ].join('\n');
}

function normalizeRepairOutput(
  value: unknown,
  input: MemoryExtractionInput,
  evidenceDirectory: ReturnType<typeof buildSupportedEvidenceDirectory>,
  meta: MemoryLlmMeta,
): StructuredCaptureResult {
  const repair = input.repair!;
  const targets = repairTargets(input);
  const allowedRepairIds = new Set(targets.map(target => target.repairId));
  const seenRepairIds = new Set<string>();
  const emittedLocalIds = new Set<string>();
  const repairDecisions: NonNullable<StructuredCaptureResult['repairDecisions']> = [];
  const emittedItems: unknown[] = [];
  const rows = Array.isArray((value as { decisions?: unknown[] })?.decisions) ? (value as { decisions: unknown[] }).decisions : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const decision = row as { repairId?: unknown; action?: unknown; items?: unknown };
    const repairId = typeof decision.repairId === 'string' ? decision.repairId : '';
    const items = Array.isArray(decision.items) ? decision.items : [];
    if (!allowedRepairIds.has(repairId) || seenRepairIds.has(repairId)) continue;
    if (decision.action === 'drop' && items.length === 0) {
      seenRepairIds.add(repairId);
      repairDecisions.push({ repairId, action: 'drop' });
      continue;
    }
    if (decision.action !== 'emit' || items.length !== 1) continue;
    const localId = items[0] && typeof items[0] === 'object' && !Array.isArray(items[0]) ? String((items[0] as { localId?: unknown }).localId ?? '').trim() : '';
    if (!localId) continue;
    seenRepairIds.add(repairId);
    if (emittedLocalIds.has(localId)) { repairDecisions.push({ repairId, action: 'drop' }); continue; }
    emittedLocalIds.add(localId);
    emittedItems.push(items[0]);
    repairDecisions.push({ repairId, action: 'emit', localId });
  }
  const normalizedData = {
    actorCandidates: repair.collection === 'actorCandidates' ? emittedItems : [],
    locationCandidates: repair.collection === 'locationCandidates' ? emittedItems : [],
    itemCandidates: repair.collection === 'itemCandidates' ? emittedItems : [],
    episodes: repair.collection === 'episodes' ? emittedItems : [],
    claims: repair.collection === 'claims' ? emittedItems : [],
    inventoryOperations: repair.collection === 'inventoryOperations' ? emittedItems : [],
  };
  const writable = new Set(input.writableSourceRefs ?? input.sources.map(source => source.id));
  const capture = normalizeStructuredCapture(normalizedData, input.sources.filter(source => writable.has(source.id)), evidenceDirectory, meta);
  const emittedMetadata = new Map<string, { itemIndex: number; sourceRefs: readonly string[] }>([
    ...capture.actorCandidates.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
    ...capture.locationCandidates.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
    ...(capture.itemCandidates ?? []).map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
    ...capture.episodes.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [...item.sourceRefs] }] as const),
    ...capture.claims.map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
    ...(capture.inventoryOperations ?? []).map((item, itemIndex) => [item.localId, { itemIndex, sourceRefs: [item.sourceRef] }] as const),
  ]);
  return {
    ...capture,
    repairDecisions: repairDecisions.map((decision) => {
      if (decision.action !== 'emit') return decision;
      const metadata = emittedMetadata.get(decision.localId ?? '');
      return { ...decision, ...(metadata ? { itemIndex: metadata.itemIndex } : {}), sourceRefs: [...(metadata?.sourceRefs ?? [])] };
    }),
  };
}

export class ExtractionStageRunner {
  readonly #structured: StructuredMemoryCaptureExtractor;

  constructor(private readonly getLlm: () => MemoryLlmClient | null) {
    this.#structured = new StructuredMemoryCaptureExtractor(getLlm);
  }

  async run(
    stage: ExtractionStageKey,
    input: MemoryExtractionInput,
    context: ExtractionRunContext,
    gateway: AgentToolGateway,
  ): Promise<StageRunResult> {
    const startedAt = Date.now();
    const stageAttemptId = `memory-stage:${stage}:${crypto.randomUUID()}`;
    if (EXTRACTION_STAGE_SPECS[stage].execution === 'structured' || context.mode !== 'agent') {
      const tracedInput = { ...input, llmTrace: workflowTrace(stage, context) };
      const output = await this.#structured.extract(stage === 'repair' ? tracedInput : { ...tracedInput, stage });
      return {
        output,
        audit: {
          stage, stageAttemptId, taskKey: EXTRACTION_STAGE_SPECS[stage].taskKey, status: 'completed',
          ...(output.audit?.requestId ? { requestId: output.audit.requestId } : {}),
          ...(output.audit?.resourceId ? { resourceId: output.audit.resourceId } : {}),
          ...(output.audit?.model ? { model: output.audit.model } : {}),
          toolRounds: 0, toolCalls: 0, latencyMs: Date.now() - startedAt,
        },
      };
    }
    if (context.agentToolPolicy !== 'read_only') {
      throw createSSHelperError('LLM_TOOL_CAPABILITY_UNVERIFIED', {
        stage: 'memory.extraction.tools.policy',
      });
    }
    return this.runWithTools(stage, input, context, gateway, startedAt, stageAttemptId);
  }

  private async runWithTools(
    stage: ExtractionStageKey,
    input: MemoryExtractionInput,
    context: ExtractionRunContext,
    gateway: AgentToolGateway,
    startedAt: number,
    stageAttemptId: string,
  ): Promise<StageRunResult> {
    const llm = this.getLlm();
    if (!llm?.toolTurn) throw createSSHelperError('LLM_TOOL_CALLS_UNSUPPORTED', { stage: 'memory.extraction.tools.start' });
    const spec = EXTRACTION_STAGE_SPECS[stage];
    const stageTools = allowedTools(stage, input);
    const sourceRefs = input.writableSourceRefs ?? input.sources.map(source => source.id);
    const evidenceDirectory = buildSupportedEvidenceDirectory(input.sources, sourceRefs);
    const schema = stage === 'repair'
      ? buildStructuredRepairSchema(sourceRefs, input.repair!.collection, input.repair!.maxItems, input.repair!.referenceDirectory, evidenceDirectory, repairTargets(input).map(target => target.repairId))
      : buildExtractionStageSchema(stage, sourceRefs, evidenceDirectory);
    const messages = [
      { role: 'system' as const, content: `${stageSystemPrompt(systemPrompt(input), stage, true)}${stage === 'repair' ? `\n${repairPrompt(input)}` : ''}` },
      { role: 'user' as const, content: serializeExtractionInput(input, evidenceDirectory) },
    ];
    const validationCollections = stage === 'entities'
      ? ['actorCandidates', 'locationCandidates']
      : stage === 'content'
        ? ['episodes', 'claims', 'itemCandidates', 'inventoryOperations']
          : [];
    const startRequest = (requestMessages: typeof messages) => ({
      task: spec.taskKey,
      pipelineRunId: context.pipelineRunId,
      chatKey: context.chatKey,
      input: { messages: requestMessages } as PlainData,
      outputSchema: schema as PlainData,
      tools: gateway.definitions(stageTools),
      timeoutMs: 600_000,
      trace: workflowTrace(stage, context),
      ...(input.repair?.parentRequestId ? { parentRequestId: input.repair.parentRequestId } : {}),
      ...(validationCollections.length > 0 ? { validationMode: 'itemized_partial' as const, validationCollections } : {}),
    });
    let sessionId: string | undefined;
    let parentRequestId: string | undefined;
    let rounds = 0;
    let callCount = 0;
    let responseUsage: MemoryLlmUsage | undefined;
    try {
      let turn = await llm.toolTurn(startRequest(messages), context.signal);
      const firstUsage = memoryLlmUsageFromProvider(turn.usage);
      responseUsage = mergeMemoryLlmUsage(responseUsage, firstUsage);
      await input.onUsage?.(firstUsage);
      parentRequestId = turn.requestId;
      let schemaRepairAttempted = false;
      let toolArgumentRepairAttempted = false;
      while (true) {
        while (turn.state === 'tool_calls') {
        sessionId = turn.toolSessionId;
        rounds += 1;
        callCount += turn.calls.length;
        if (rounds > spec.maxToolRounds || callCount > 6) {
          throw createSSHelperError('LLM_TOOL_CALL_LIMIT_EXCEEDED', { stage: 'memory.extraction.tools.limit', requestId: turn.requestId });
        }
        let results: readonly NormalizedToolResult[];
        try {
          results = await gateway.executeBatch(turn.calls, {
            pipelineRunId: context.pipelineRunId,
            workspaceId: context.workspaceId,
            chatKey: context.chatKey,
            stage,
            requestId: turn.requestId,
            toolSessionRound: turn.diagnostics.toolSessionRound,
            allowedTools: new Set(stageTools),
            dataRevision: context.dataRevision,
            signal: context.signal,
          });
        } catch (error) {
          const retryResults = !toolArgumentRepairAttempted
            ? toolArgumentFailureResults(turn.calls, error, context)
            : undefined;
          if (!retryResults) throw error;
          toolArgumentRepairAttempted = true;
          results = retryResults;
        }
        turn = await llm.toolTurn({
          task: spec.taskKey,
          pipelineRunId: context.pipelineRunId,
          chatKey: context.chatKey,
          toolSessionId: sessionId,
          toolResults: results,
          ...(parentRequestId ? { parentRequestId } : {}),
          timeoutMs: 600_000,
          trace: workflowTrace(stage, context),
        }, context.signal);
        const turnUsage = memoryLlmUsageFromProvider(turn.usage);
        responseUsage = mergeMemoryLlmUsage(responseUsage, turnUsage);
        await input.onUsage?.(turnUsage);
        }
        if (turn.state === 'final' && turn.validationIssues?.length && !schemaRepairAttempted && validationCollections.length > 0) {
          schemaRepairAttempted = true;
          sessionId = undefined;
          const repairMessages = [
            {
              role: 'system' as const,
              content: `${messages[0].content}\n【固定阶段校验重试】上一轮有单项未通过 Schema。只重新输出一个完整且合法的 JSON 根对象；数组中每一项都必须满足 Schema，尤其 operation 只能使用枚举值。不要解释、不要 Markdown。安全问题：${JSON.stringify(turn.validationIssues.slice(0, 16))}`,
            },
            messages[1],
          ];
          turn = await llm.toolTurn(startRequest(repairMessages), context.signal);
          const retryUsage = memoryLlmUsageFromProvider(turn.usage);
          responseUsage = mergeMemoryLlmUsage(responseUsage, retryUsage);
          await input.onUsage?.(retryUsage);
          parentRequestId = turn.requestId;
          continue;
        }
        break;
      }
      sessionId = undefined;
      const meta: MemoryLlmMeta = {
        requestId: turn.requestId,
        ...(turn.route.resourceId ? { resourceId: turn.route.resourceId } : {}),
        model: turn.route.model,
        latencyMs: Date.now() - startedAt,
      };
      const writable = new Set(sourceRefs);
      const normalizedInput = stage === 'single' ? turn.output as unknown : {
        actorCandidates: stage === 'entities' ? (turn.output as Record<string, unknown>).actorCandidates ?? [] : [],
        locationCandidates: stage === 'entities' ? (turn.output as Record<string, unknown>).locationCandidates ?? [] : [],
        itemCandidates: stage === 'content' ? (turn.output as Record<string, unknown>).itemCandidates ?? [] : [],
        episodes: stage === 'content' ? (turn.output as Record<string, unknown>).episodes ?? [] : [],
        claims: stage === 'content' ? (turn.output as Record<string, unknown>).claims ?? [] : [],
        inventoryOperations: stage === 'content' ? (turn.output as Record<string, unknown>).inventoryOperations ?? [] : [],
      };
      const output = stage === 'repair'
        ? normalizeRepairOutput(turn.output, input, evidenceDirectory, meta)
        : normalizeStructuredCapture(normalizedInput, input.sources.filter(source => writable.has(source.id)), evidenceDirectory, meta);
      const schemaRejections: AutomaticIngestRejection[] = (turn.itemRejections ?? []).map((item, index) => ({
        ...(() => {
          const rawItems = (turn.output as Record<string, unknown> | undefined)?.[item.collection];
          const raw = Array.isArray(rawItems) ? rawItems[item.itemIndex] : undefined;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
          const snapshot = JSON.parse(JSON.stringify(raw)) as PlainData;
          const localId = typeof (raw as Record<string, unknown>).localId === 'string' ? String((raw as Record<string, unknown>).localId).trim() : '';
          return {
            candidateSnapshot: snapshot,
            ...(localId ? { candidateLocalId: localId } : {}),
          };
        })(),
        id: `schema:${turn.requestId}:${item.collection}:${item.itemIndex}:${index}`,
        index: item.itemIndex,
        code: 'schema_validation_failed',
        message: `结构化项目未通过 Schema：${item.issues.map(issue => `${issue.path} ${issue.keyword} expected ${issue.expected}`).join('; ')}`,
        recordType: item.collection === 'actorCandidates' ? 'actor'
          : item.collection === 'locationCandidates' ? 'location'
            : item.collection === 'itemCandidates' ? 'item'
              : item.collection === 'episodes' ? 'episode'
                : item.collection === 'claims' ? 'claim'
                  : item.collection === 'inventoryOperations' ? 'inventory'
                    : 'batch',
        ...(item.issues[0]?.path ? { fieldPath: item.issues[0].path } : {}),
        issues: item.issues.map(issue => ({ path: issue.path, keyword: issue.keyword, expected: issue.expected })),
        sourceRefs: [...item.sourceRefs],
        requestId: turn.requestId,
        ...(turn.route.resourceId ? { resourceId: turn.route.resourceId } : {}),
        ...(turn.route.model ? { model: turn.route.model } : {}),
        status: 'unresolved',
        repairAttempts: schemaRepairAttempted ? 1 : 0,
      }));
      output.rejections = [...(output.rejections ?? []), ...schemaRejections];
      output.audit = auditFromResponse({ meta, usage: responseUsage });
      output.diagnostics = { ...output.diagnostics, transportMode: 'native_strict' };
      return {
        output,
        audit: {
          stage, stageAttemptId, taskKey: spec.taskKey, status: 'completed', requestId: turn.requestId,
          ...(turn.route.resourceId ? { resourceId: turn.route.resourceId } : {}), model: turn.route.model,
          toolRounds: rounds, toolCalls: callCount, latencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      if (sessionId && llm.cancelToolSession) await llm.cancelToolSession(sessionId, context.signal.aborted ? 'cancelled' : 'pipeline_disposed').catch(() => undefined);
      const failureUsage = memoryLlmUsageFromError(error);
      if (failureUsage) await input.onUsage?.(failureUsage);
      throw error;
    }
  }
}
