import type {
  LlmToolDefinition,
  NormalizedToolCall,
  NormalizedToolResult,
  PlainData,
} from '@ss-helper/sdk';
import type { MemoryTokenUsage } from '../../domain';
import type { SupportedEvidenceDirectory } from '../ingest/types';

export type ExtractionMode = 'single' | 'agent';
export type ExtractionStageKey = 'single' | 'entities' | 'content' | 'repair';
export type AgentToolPolicy = 'off' | 'read_only';
export type CaptureCollection =
  | 'actorCandidates'
  | 'locationCandidates'
  | 'itemCandidates'
  | 'episodes'
  | 'claims'
  | 'inventoryOperations';
export type AgentToolName =
  | 'entity.resolve_context'
  | 'scene.resolve_context'
  | 'inventory.resolve_context'
  | 'memory.resolve_update_context'
  | 'reference.get_details';

export interface AgentPipelineSettings {
  readonly extractionMode: ExtractionMode;
  readonly agentConcurrency: 1 | 2;
  readonly agentToolPolicy: AgentToolPolicy;
}

export interface ExtractionRunContext {
  readonly pipelineRunId: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly workflowLabel: string;
  readonly workflowKind: string;
  readonly jobId?: string;
  readonly batchIndex?: number;
  readonly batchCount?: number;
  readonly mode: ExtractionMode;
  readonly agentConcurrency: 1 | 2;
  readonly agentToolPolicy: AgentToolPolicy;
  readonly settingsRevision: number;
  readonly routeRevision: number;
  readonly dataRevision: number;
  readonly sourceBatchDigest: string;
  readonly routeSnapshotDigest: string;
  readonly settingsSnapshotDigest: string;
  readonly sourceRefs: readonly string[];
  readonly writableSourceRefs: readonly string[];
  readonly evidenceDirectory: SupportedEvidenceDirectory;
  readonly signal: AbortSignal;
}

export interface ExtractionStageSpec {
  readonly key: ExtractionStageKey;
  readonly taskKey: string;
  readonly description: string;
  readonly execution: 'structured' | 'tool_turn';
  readonly ownedCollections: readonly CaptureCollection[];
  readonly allowedTools: readonly AgentToolName[];
  readonly maxToolRounds: 0 | 1 | 2;
}

export interface ToolReadSetEntry {
  readonly kind: 'actor' | 'location' | 'inventory' | 'fact' | 'scene';
  readonly ref: string;
  readonly recordId: string;
  readonly revision: number;
  readonly contentDigest: string;
  readonly stage: ExtractionStageKey;
}

export interface ToolResultEnvelope {
  readonly ok: boolean;
  readonly tool: AgentToolName;
  readonly callId: string;
  readonly contextOnly: true;
  readonly evidenceAllowed: false;
  readonly trust: 'stored_user_data';
  readonly instructionsAllowed: false;
  readonly dataRevision: number;
  readonly readSet: readonly Omit<ToolReadSetEntry, 'recordId' | 'stage'>[];
  readonly truncated: boolean;
  readonly nextCursor?: string;
  readonly data?: PlainData;
  readonly failure?: { readonly reasonCode: string; readonly message: string };
}

export interface AgentToolContext {
  readonly pipelineRunId: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly stage: ExtractionStageKey;
  readonly requestId?: string;
  readonly toolSessionRound?: number;
  readonly allowedTools: ReadonlySet<AgentToolName>;
  readonly dataRevision: number;
  readonly signal: AbortSignal;
}

export interface AgentToolGatewayPort {
  definitions(names: readonly AgentToolName[]): readonly LlmToolDefinition[];
  executeBatch(calls: readonly NormalizedToolCall[], context: AgentToolContext): Promise<readonly NormalizedToolResult[]>;
  readSet(): readonly ToolReadSetEntry[];
  verifyReadSet(ignoredStages?: readonly ExtractionStageKey[]): Promise<{
    readonly valid: boolean;
    readonly staleStages: readonly ExtractionStageKey[];
    readonly staleEntries: readonly ToolReadSetEntry[];
  }>;
}

export interface ExtractionStageAudit {
  readonly stage: ExtractionStageKey;
  readonly stageAttemptId?: string;
  readonly attemptNo?: number;
  readonly taskKey: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly requestId?: string;
  readonly resourceId?: string;
  readonly model?: string;
  readonly toolRounds: number;
  readonly toolCalls: number;
  readonly latencyMs: number;
  readonly reasonCode?: string;
}

export interface AgentToolAudit {
  readonly pipelineRunId: string;
  readonly stage: ExtractionStageKey;
  readonly requestId?: string;
  readonly toolSessionRound?: number;
  readonly callId: string;
  readonly tool: AgentToolName;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly readCount: number;
  readonly resultCount?: number;
  readonly truncated: boolean;
  readonly instructionLikeTextDetected: boolean;
  readonly parameterSummary?: PlainData;
  readonly reasonCode?: string;
}

export interface UpdateDecisionAudit {
  readonly stage: ExtractionStageKey;
  readonly candidateLocalId: string;
  readonly currentRef?: string;
  readonly comparison?: string;
  readonly decision: string;
  readonly reasonCode: string;
  readonly evidenceSpanIds: readonly string[];
  readonly toolCallIds: readonly string[];
  readonly readSetDigest?: string;
  readonly temporalDecision?: string;
  readonly reviewItemId?: string;
}

export interface ExtractionPipelineAudit {
  readonly pipelineRunId: string;
  readonly workflowLabel: string;
  readonly workflowKind: string;
  readonly jobId?: string;
  readonly batchIndex?: number;
  readonly batchCount?: number;
  readonly mode: ExtractionMode;
  readonly toolPolicy: AgentToolPolicy;
  readonly sourceBatchDigest: string;
  readonly evidenceSetHash: string;
  readonly routeSnapshotDigest: string;
  readonly settingsSnapshotDigest: string;
  readonly promptVersion: 1;
  readonly stageSchemaVersion: 1;
  readonly toolDefinitionVersion: 1;
  readonly toolResultSchemaVersion: 1;
  readonly providerAdapterVersion: number;
  readonly capabilitySnapshotId?: string;
  readonly stages: readonly ExtractionStageAudit[];
  readonly toolCalls: readonly AgentToolAudit[];
  readonly updateDecisions: readonly UpdateDecisionAudit[];
  readonly totalUsage: MemoryTokenUsage | null;
  readonly wallClockLatencyMs: number;
}

export interface TemporalState {
  readonly eventTimeText?: string;
  readonly validFrom?: number;
  readonly validUntil?: number;
  readonly observedAt: number;
  readonly ingestedAt: number;
  readonly supersededAt?: number;
}

export interface MemoryReviewItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly pipelineRunId: string;
  readonly stage: ExtractionStageKey;
  readonly candidateLocalId: string;
  readonly reasonCode: string;
  readonly sourceRefs: readonly string[];
  readonly evidenceSpanIds: readonly string[];
  readonly candidateSummary: PlainData;
  readonly currentStateSummary?: PlainData;
  readonly readSetSummary?: {
    readonly digest: string;
    readonly readCount: number;
    readonly stale: boolean;
    readonly changedRefs: readonly string[];
  };
  readonly toolCallSummary?: {
    readonly callCount: number;
    readonly failedCount: number;
    readonly tools: readonly AgentToolName[];
    readonly callIds: readonly string[];
  };
  readonly status: 'pending' | 'accepted' | 'rejected' | 'edited' | 'expired';
  readonly createdAt: number;
  readonly resolvedAt?: number;
  readonly resolution?: PlainData;
}
