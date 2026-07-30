import type {
  ChatMessageSnapshot,
  PlainData,
  FinalPromptSnapshot,
  SSHelperFailureContext,
  WorkspacePort,
} from '@ss-helper/sdk';
import {
  SDK_PACKAGE_VERSION,
  createSSHelperError,
  readSSHelperFailure,
} from '@ss-helper/sdk';
import {
  ACTIVE_CONFIDENCE_THRESHOLD,
  MAX_FACT_CONTENT_LENGTH,
  MIN_FACT_CONTENT_LENGTH,
  createCanonicalKey,
  createFactSlotKey,
  normalizeFactContent,
  FactListOptions,
  MainChatUsage,
  GenerationRecallDetail,
  GenerationRecallLookupTarget,
  GenerationPromptSnapshotChunk,
  GenerationPromptSnapshotManifest,
  GenerationPromptSnapshotMetadata,
  GenerationPromptSnapshotPayload,
  ManualFactInput,
  MemoryEvidence,
  MemoryFact,
  MemoryFactVector,
  MemoryFactVectorCoverage,
  MemoryFactVectorTarget,
  MemoryGraphEdge,
  MemoryGraphNode,
  MemoryGraphProjection,
  MemoryRecallLog,
  MemorySettingRecord,
  UpsertMemoryFactVectorInput,
  deriveMemoryGraphProjection,
  graphNodeId,
  isGraphBackedFact,
  stableMemoryRecordKey,
} from '../domain';
import { float32ArrayToArrayBuffer, sha256Content } from './vector/vector-utils';
import { startMemoryPerformanceSpan, traceMemoryStartup } from '../host/runtime-feedback';
import {
  memoryStoreFor,
  type MemoryStore,
  type StoreOperation,
  type StoreRecord as WorkspaceRecord,
  type StoreVectorInfo as WorkspaceVectorInfo,
} from './memory-store';
import { MEMORY_WORKSPACE_COLLECTIONS } from './memory-workspace-schema';
import type { MemoryPage, MemoryPageRequest } from '../ui/memory-page';

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;
const QUERY_PAGE_SIZE = 1_000;
const TRANSACTION_BATCH_SIZE = 500;
const LOOKUP_CHUNK_SIZE = 100;
const PROMPT_SNAPSHOT_CHUNK_BYTES = 256 * 1024;
const PROMPT_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const SETTINGS_WORKSPACE_ID = 'settings:global';
const COLLECTIONS = MEMORY_WORKSPACE_COLLECTIONS;

export interface MemoryWorkspaceHealth {
  connected: boolean;
  serverVersion: string;
  nodeVersion: string;
  protocolVersion: number;
  sqliteVersion: string;
  schemaVersion: number;
  databasePath: string;
  databaseSizeBytes: number;
  workspaceSizeBytes: number;
  currentChatSizeBytes: number;
  walMode: string;
  tableCounts: Record<string, number>;
  tableBytes: Record<string, number | null>;
  vectorCoverage?: { indexedFacts?: number; eligibleFacts?: number; ratio?: number; ready?: number; totalFacts?: number; coverage?: number };
  failure?: SSHelperFailureContext;
}

function asPlain(value: unknown): PlainData { return structuredClone(value) as PlainData; }
function paginationStalledError(scope: string): Error {
  return createSSHelperError('WORKSPACE_CONFLICT', {
    stage: 'memory.persistence.pagination',
    collection: scope,
  });
}

function clampLimit(limit: number | undefined): number {
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit ?? DEFAULT_SEARCH_LIMIT)));
}

function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${uuid}`;
}

interface FactSlotValue {
  chatKey: string;
  slotKey: string;
  factId: string;
}

function normalizedChatKey(chatKey: string): string {
  const value = chatKey.trim();
  if (!value) throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.chat-key' });
  return value;
}

function factSlotRecordId(chatKey: string, slotKey: string): string {
  return `fact-head:${encodeURIComponent(normalizedChatKey(chatKey))}:${encodeURIComponent(slotKey)}`;
}

function factBelongsToChat(fact: MemoryFact | undefined, chatKey: string): fact is MemoryFact {
  return fact?.chatKey === normalizedChatKey(chatKey);
}

function compareSlotFacts(left: MemoryFact, right: MemoryFact): number {
  return Number(right.status === 'active') - Number(left.status === 'active')
    || right.freshestEvidenceAt - left.freshestEvidenceAt
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id);
}

function selectedSlotFact(facts: readonly MemoryFact[]): MemoryFact | undefined {
  return [...facts]
    .filter((fact) => fact.status === 'active' || fact.status === 'pending')
    .sort(compareSlotFacts)[0];
}

function slotValue(chatKey: string, slotKey: string, factId: string): FactSlotValue {
  return { chatKey: normalizedChatKey(chatKey), slotKey, factId };
}

function isFactSlotValue(value: unknown): value is FactSlotValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FactSlotValue>;
  return typeof candidate.chatKey === 'string' && candidate.chatKey.trim().length > 0
    && typeof candidate.slotKey === 'string' && candidate.slotKey.length > 0
    && typeof candidate.factId === 'string' && candidate.factId.length > 0;
}

function dataChatKey(value: PlainData | undefined): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as { chatKey?: unknown }).chatKey;
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
}

const textEncoder = new TextEncoder();
function textBytes(value: string | undefined): number {
  return value ? textEncoder.encode(value).byteLength : 0;
}

function splitUtf8(value: string, maximumBytes = PROMPT_SNAPSHOT_CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of value) {
    const size = textEncoder.encode(character).byteLength;
    if (bytes > 0 && bytes + size > maximumBytes) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current || value.length === 0) chunks.push(current);
  return chunks;
}

function containsExactText(value: unknown, expected: string): boolean {
  if (!expected) return true;
  if (typeof value === 'string') return value.includes(expected);
  if (Array.isArray(value)) return value.some(item => containsExactText(item, expected));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(item => containsExactText(item, expected));
  return false;
}

export interface PreparedGenerationPromptSnapshot {
  readonly manifest: GenerationPromptSnapshotManifest;
  readonly chunks: readonly GenerationPromptSnapshotChunk[];
  readonly metadata: GenerationPromptSnapshotMetadata;
}

function plainBytes(value: PlainData | undefined): number {
  return value === undefined ? 0 : textBytes(JSON.stringify(value));
}

function recordPayloadBytes(record: WorkspaceRecord): number {
  return textBytes(record.recordId) + plainBytes(record.value);
}

function vectorPayloadBytes(vector: WorkspaceVectorInfo): number {
  return textBytes(vector.recordId)
    + textBytes(vector.model)
    + plainBytes(vector.metadata)
    + Math.max(0, vector.dimensions) * Float32Array.BYTES_PER_ELEMENT;
}

function samePlainData(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function evidenceId(factId: string, sourceRef: string, excerpt: string): string {
  return `evidence:${factId}:${stableHash(`${sourceRef}\n${excerpt}`)}`;
}


/** Memory 的唯一仓储。领域逻辑留在 Memory，持久化只使用 SDK 通用 WorkspacePort。 */
export class MemoryRepository {
  private healthSnapshot: MemoryWorkspaceHealth | null = null;
  private workspaceId = '';
  private sourceChatKey = '';

  private readonly store: MemoryStore;

  constructor(readonly workspace: WorkspacePort) {
    this.store = memoryStoreFor(workspace);
  }

  bind(workspaceId: string, sourceChatKey: string): void {
    const nextWorkspaceId = workspaceId.trim();
    const nextChatKey = sourceChatKey.trim();
    const workspaceChanged = this.workspaceId !== nextWorkspaceId;
    const chatChanged = this.sourceChatKey !== nextChatKey;
    this.workspaceId = nextWorkspaceId;
    this.sourceChatKey = nextChatKey;
    if (workspaceChanged) {
      this.healthSnapshot = null;
    } else if (chatChanged && this.healthSnapshot) {
      // Workspace totals remain valid, but this value is scoped to the old
      // chat. Never present it as the newly bound chat's usage.
      this.healthSnapshot = {
        ...this.healthSnapshot,
        currentChatSizeBytes: 0,
      };
    }
  }

  private requireChatKey(chatKey = this.sourceChatKey): string {
    const value = normalizedChatKey(chatKey);
    if (this.sourceChatKey && value !== this.sourceChatKey) {
      throw createSSHelperError('MEMORY_STALE_GENERATION_SCOPE', {
        stage: 'memory.repository.chat-scope',
      });
    }
    return value;
  }

  private requireWorkspaceId(): string {
    if (!this.workspaceId) {
      throw createSSHelperError('MEMORY_CAPTURE_NOT_BOUND', {
        stage: 'memory.repository.workspace-binding',
      });
    }
    return this.workspaceId;
  }

  private async ensureCollections(workspaceId: string): Promise<void> {
    await this.store.bind(
      workspaceId,
      workspaceId === SETTINGS_WORKSPACE_ID
        ? [{ name: 'settings', indexes: ['key'] }]
        : Object.entries(COLLECTIONS).map(([name, indexes]) => ({ name, indexes })),
      { kind: workspaceId.startsWith('group:') ? 'group' : workspaceId === SETTINGS_WORKSPACE_ID ? 'settings' : 'host_card' },
    );
  }

  private async ensureGenerationRecallDetailsCollection(workspaceId: string): Promise<void> {
    await this.store.bind(
      workspaceId,
      [{
        name: 'generation-recall-details',
        indexes: [...COLLECTIONS['generation-recall-details']],
      }],
      { kind: workspaceId.startsWith('group:') ? 'group' : 'host_card' },
    );
  }

  async open(): Promise<void> {
    const finish = startMemoryPerformanceSpan('repository.open');
    const health = await this.store.health();
    if (!health.ready) {
      finish('error');
      throw createSSHelperError('WORKSPACE_DATABASE_UNAVAILABLE', {
        stage: 'memory.repository.open.health',
      });
    }
    try {
      await this.ensureCollections(SETTINGS_WORKSPACE_ID);
    } catch (cause) {
      finish('error');
      const failure = readSSHelperFailure(cause, {
        reasonCode: 'MEMORY_CHAT_BIND_FAILED',
        stage: 'memory.repository.open.settings',
      })!;
      throw createSSHelperError(failure.reasonCode, failure);
    }
    try {
      if (this.workspaceId) await this.ensureCollections(this.workspaceId);
    } catch (cause) {
      finish('error');
      const failure = readSSHelperFailure(cause, {
        reasonCode: 'MEMORY_CHAT_BIND_FAILED',
        stage: 'memory.repository.open.chat',
      })!;
      throw createSSHelperError(failure.reasonCode, failure);
    }
    this.healthSnapshot = this.toHealthSnapshot(health);
    finish();
  }

  close(): void {
    this.healthSnapshot = null;
  }

  getHealthSnapshot(): MemoryWorkspaceHealth | null {
    return this.healthSnapshot ? structuredClone(this.healthSnapshot) : null;
  }

  async readHealth(): Promise<MemoryWorkspaceHealth> {
    const finish = startMemoryPerformanceSpan('repository.health.basic');
    const health = await this.store.health();
    const previous = this.healthSnapshot;
    this.healthSnapshot = this.toHealthSnapshot(health, previous ? {
      workspaceSizeBytes: previous.workspaceSizeBytes,
      currentChatSizeBytes: previous.currentChatSizeBytes,
      tableCounts: previous.tableCounts,
      tableBytes: previous.tableBytes,
    } : {});
    finish(health.ready ? 'success' : 'error');
    return structuredClone(this.healthSnapshot);
  }

  private toHealthSnapshot(
    health: Awaited<ReturnType<MemoryStore['health']>>,
    sizes: {
      readonly workspaceSizeBytes?: number;
      readonly currentChatSizeBytes?: number;
      readonly tableCounts?: Record<string, number>;
      readonly tableBytes?: Record<string, number | null>;
    } = {},
  ): MemoryWorkspaceHealth {
    return {
      connected: health.ready,
      serverVersion: SDK_PACKAGE_VERSION,
      nodeVersion: health.nodeVersion ?? 'N/A',
      protocolVersion: 0,
      sqliteVersion: health.sqliteVersion ?? 'N/A',
      schemaVersion: health.schemaVersion,
      databasePath: `data/_ss-helper-v0/${health.database}`,
      databaseSizeBytes: health.databaseSizeBytes ?? 0,
      workspaceSizeBytes: sizes.workspaceSizeBytes ?? 0,
      currentChatSizeBytes: sizes.currentChatSizeBytes ?? 0,
      walMode: health.walMode ?? 'N/A',
      tableCounts: sizes.tableCounts ?? {},
      tableBytes: sizes.tableBytes ?? {},
      ...(health.failure ? { failure: structuredClone(health.failure) } : {}),
    };
  }

  async refreshHealth(_chatKey?: string): Promise<MemoryWorkspaceHealth> {
    const finish = startMemoryPerformanceSpan('repository.health.detailed');
    traceMemoryStartup('repository:health-begin');
    const health = await this.store.health();
    traceMemoryStartup(`repository:health-${health.ready ? 'ready' : 'degraded'}`);
    const tableCounts: Record<string, number> = {};
    const tableBytes: Record<string, number | null> = {};
    const chatKey = _chatKey?.trim() || this.sourceChatKey;
    let workspaceSizeBytes = 0;
    let currentChatSizeBytes = 0;
    if (health.ready && this.workspaceId) {
      // A chat/identity switch can introduce a workspace after Memory startup.
      // Always make its schema available before querying health counters.
      await this.ensureCollections(this.workspaceId);
      traceMemoryStartup('repository:health-collections-ready');
      for (const name of Object.keys(COLLECTIONS)) {
        traceMemoryStartup(`repository:health-list-${name}`);
        const records = await this.listAllRecordRows(name);
        const tableName = name.replaceAll('-', '_');
        const size = records.reduce((total, record) => total + recordPayloadBytes(record), 0);
        tableCounts[tableName] = records.length;
        tableBytes[tableName] = size;
        workspaceSizeBytes += size;
        if (chatKey) currentChatSizeBytes += records
          .filter((record) => dataChatKey(record.value) === chatKey)
          .reduce((total, record) => total + recordPayloadBytes(record), 0);
      }
      traceMemoryStartup('repository:health-list-vectors');
      const vectors = await this.listAllVectors();
      const vectorSize = vectors.reduce((total, vector) => total + vectorPayloadBytes(vector), 0);
      tableCounts.fact_vectors = vectors.length;
      tableBytes.fact_vectors = vectorSize;
      workspaceSizeBytes += vectorSize;
      if (chatKey) currentChatSizeBytes += vectors
        .filter((vector) => dataChatKey(vector.metadata) === chatKey)
        .reduce((total, vector) => total + vectorPayloadBytes(vector), 0);
    }
    traceMemoryStartup('repository:health-snapshot');
    this.healthSnapshot = this.toHealthSnapshot(health, {
      workspaceSizeBytes,
      currentChatSizeBytes,
      tableCounts,
      tableBytes,
    });
    finish(health.ready ? 'success' : 'error');
    return structuredClone(this.healthSnapshot);
  }

  private async transactInBatches(workspaceId: string, operations: readonly StoreOperation[]): Promise<void> {
    for (let offset = 0; offset < operations.length; offset += TRANSACTION_BATCH_SIZE) {
      await this.store.apply({ workspaceId, operations: operations.slice(offset, offset + TRANSACTION_BATCH_SIZE) });
    }
  }

  private async listAllRecordRows(collection: string, filter: Record<string, PlainData> = {}, orderBy?: { field: string; direction: 'asc' | 'desc' }, workspaceId = this.requireWorkspaceId()): Promise<WorkspaceRecord[]> {
    const records: WorkspaceRecord[] = []; let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.store.scan({ workspaceId, collection, filter, ...(orderBy ? { orderBy } : {}), ...(cursor ? { cursor } : {}), limit: QUERY_PAGE_SIZE });
      records.push(...page.records);
      const nextCursor = page.nextCursor ?? undefined;
      if (nextCursor !== undefined && seenCursors.has(nextCursor)) throw paginationStalledError(`记录集合 ${collection}`);
      if (nextCursor !== undefined) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return records;
  }

  private async listAllRows<T>(collection: string, filters: Record<string, PlainData> = {}): Promise<T[]> {
    return (await this.listAllRecordRows(collection, filters)).map((record) => record.value as T);
  }

  private async listAllFacts(chatKey: string, filters: Record<string, PlainData> = {}): Promise<MemoryFact[]> {
    return this.listAllRows<MemoryFact>('facts', { ...filters, chatKey: this.requireChatKey(chatKey) });
  }

  private async listAllVectors(chatKey?: string) {
    const vectors = []; let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await this.store.vectors.list({
        workspaceId: this.requireWorkspaceId(),
        collection: 'facts',
        ...(chatKey ? { metadata: { chatKey: this.requireChatKey(chatKey) } } : {}),
        ...(cursor ? { cursor } : {}),
        limit: QUERY_PAGE_SIZE,
      });
      vectors.push(...page.vectors);
      const nextCursor = page.nextCursor ?? undefined;
      if (nextCursor !== undefined && seenCursors.has(nextCursor)) throw paginationStalledError('向量集合');
      if (nextCursor !== undefined) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return vectors;
  }

  async listFacts(chatKey: string, options: FactListOptions = {}): Promise<MemoryFact[]> {
    const facts = await this.listAllFacts(chatKey, {
      ...(options.status ? { status: options.status } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    });
    return options.limit === undefined ? facts : facts.slice(0, clampLimit(options.limit));
  }

  list(chatKey: string, options: FactListOptions = {}): Promise<MemoryFact[]> {
    return this.listFacts(chatKey, options);
  }

  /**
   * Graph records are a derived cache, but every read remains chat-scoped at
   * the repository boundary.  Callers never receive another chat's nodes or
   * edges even when they share the same character Workspace collection.
   */
  async listGraphNodes(chatKey: string): Promise<MemoryGraphNode[]> {
    chatKey = this.requireChatKey(chatKey);
    return (await this.listAllRows<MemoryGraphNode>('graph-nodes', { chatKey }))
      .filter((node) => node.chatKey === chatKey && typeof node.id === 'string' && typeof node.entityKey === 'string')
      .map((node) => structuredClone(node));
  }

  async listGraphEdges(chatKey: string): Promise<MemoryGraphEdge[]> {
    chatKey = this.requireChatKey(chatKey);
    return (await this.listAllRows<MemoryGraphEdge>('graph-edges', { chatKey }))
      .filter((edge) => edge.chatKey === chatKey && typeof edge.id === 'string' && typeof edge.backingFactId === 'string')
      .map((edge) => structuredClone(edge));
  }

  async getGraphProjection(chatKey: string): Promise<MemoryGraphProjection> {
    const [nodes, edges] = await Promise.all([this.listGraphNodes(chatKey), this.listGraphEdges(chatKey)]);
    return {
      nodes: Object.freeze(nodes.sort((left, right) => left.id.localeCompare(right.id))),
      edges: Object.freeze(edges.sort((left, right) => left.id.localeCompare(right.id))),
    };
  }

  /**
   * Reconcile only deterministic graph records.  Facts are intentionally read
   * and committed elsewhere; this independent repair is safe to repeat after
   * any fact transaction, rollback, or archive import.
   */
  async reconcileGraphProjection(
    chatKey: string,
    projection: MemoryGraphProjection,
    retryAttempt = 0,
  ): Promise<void> {
    chatKey = this.requireChatKey(chatKey);
    const workspaceId = this.requireWorkspaceId();
    try {
      const [currentNodes, currentEdges] = await Promise.all([
        this.listAllRecordRows('graph-nodes', { chatKey }),
        this.listAllRecordRows('graph-edges', { chatKey }),
      ]);
      const nodeById = new Map(currentNodes.map((record) => [record.recordId, record]));
      const edgeById = new Map(currentEdges.map((record) => [record.recordId, record]));
      const desiredNodes = projection.nodes.filter((node) => node.chatKey === chatKey);
      const desiredEdges = projection.edges.filter((edge) => edge.chatKey === chatKey);
      const upserts: StoreOperation[] = [];
      for (const node of desiredNodes) {
        const current = nodeById.get(node.id);
        if (current && samePlainData(current.value, node)) continue;
        upserts.push({
          action: 'upsert', collection: 'graph-nodes', recordId: node.id,
          value: asPlain(node), expectedVersion: current?.version ?? 0,
        });
      }
      for (const edge of desiredEdges) {
        const current = edgeById.get(edge.id);
        if (current && samePlainData(current.value, edge)) continue;
        upserts.push({
          action: 'upsert', collection: 'graph-edges', recordId: edge.id,
          value: asPlain(edge), expectedVersion: current?.version ?? 0,
        });
      }
      const desiredNodeIds = new Set(desiredNodes.map((node) => node.id));
      const desiredEdgeIds = new Set(desiredEdges.map((edge) => edge.id));
      const deletes: StoreOperation[] = [
        ...currentEdges
          .filter((record) => !desiredEdgeIds.has(record.recordId))
          .map((record) => ({ action: 'delete' as const, collection: 'graph-edges', recordId: record.recordId, expectedVersion: record.version })),
        ...currentNodes
          .filter((record) => !desiredNodeIds.has(record.recordId))
          .map((record) => ({ action: 'delete' as const, collection: 'graph-nodes', recordId: record.recordId, expectedVersion: record.version })),
      ];
      // Write nodes/edges before deleting stale records. A partial retry can
      // therefore only leave redundant cache records, never dangling desired
      // edges; the next deterministic pass removes the redundant entries.
      await this.transactInBatches(workspaceId, [...upserts, ...deletes]);
    } catch (error) {
      if (readSSHelperFailure(error)?.reasonCode === 'WORKSPACE_CONFLICT' && retryAttempt < 1) {
        return this.reconcileGraphProjection(chatKey, projection, retryAttempt + 1);
      }
      throw error;
    }
  }

  async searchFacts(chatKey: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<MemoryFact[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return (await this.listAllFacts(chatKey)).filter((fact) => [fact.content, fact.canonicalKey, ...fact.entityKeys].some((value) => value.toLocaleLowerCase().includes(needle))).slice(0, clampLimit(limit));
  }

  search(chatKey: string, query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<MemoryFact[]> {
    return this.searchFacts(chatKey, query, limit);
  }

  async getFact(chatKey: string, id: string): Promise<MemoryFact | undefined> {
    const result = await this.store.read({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: id });
    const fact = result?.value as MemoryFact | undefined;
    return factBelongsToChat(fact, chatKey) ? fact : undefined;
  }

  async upsertManualFact(chatKey: string, input: ManualFactInput): Promise<MemoryFact> {
    chatKey = this.requireChatKey(chatKey);
    const content = normalizeFactContent(input.content);
    if (Array.from(content).length < MIN_FACT_CONTENT_LENGTH || Array.from(content).length > MAX_FACT_CONTENT_LENGTH) {
      throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.manual-fact.content' });
    }
    const confidence = input.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.manual-fact.confidence' });
    }
    const id = input.id ?? createId('fact');
    const previousRecord = await this.store.read({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: id });
    const previous = previousRecord?.value as MemoryFact | undefined;
    if (previous && !factBelongsToChat(previous, chatKey)) {
      throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.repository.manual-fact.lookup' });
    }
    const slotKey = createFactSlotKey(input.subjectKey, input.predicateKey);
    if (previous && previous.slotKey !== slotKey && (previous.supersedesId || previous.supersededById)) {
      throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'memory.repository.manual-fact.history' });
    }
    const slotFacts = (await this.listFacts(chatKey))
      .filter(item => item.slotKey === slotKey && (item.status === 'active' || item.status === 'pending'))
      .sort((left, right) => {
        const status = Number(right.status === 'active') - Number(left.status === 'active');
        return status
          || right.freshestEvidenceAt - left.freshestEvidenceAt
          || right.updatedAt - left.updatedAt
          || left.id.localeCompare(right.id);
      });
    const expectedSlotFactId = slotFacts[0]?.id ?? null;
    const now = Date.now();
    const sourceRef = `manual:${id}`;
    const evidenceKey = evidenceId(id, sourceRef, content);
    const requestedStatus = input.status ?? previous?.status ?? 'active';
    const status = requestedStatus === 'active' && confidence < ACTIVE_CONFIDENCE_THRESHOLD
      ? 'pending'
      : requestedStatus;
    const fact: MemoryFact = {
      id,
      chatKey,
      kind: input.kind,
      subjectKey: input.subjectKey.trim(),
      predicateKey: input.predicateKey.trim(),
      ...(input.objectKey === undefined ? {} : { objectKey: input.objectKey.trim() }),
      canonicalKey: createCanonicalKey(input.subjectKey, input.predicateKey, input.objectKey),
      slotKey,
      content,
      entityKeys: [...new Set(input.entityKeys ?? [])],
      confidence,
      status,
      sourceRefs: [sourceRef],
      evidenceIds: [evidenceKey],
      freshestEvidenceAt: now,
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.stableAnchor === undefined ? {} : { stableAnchor: input.stableAnchor }),
      ...(input.scope === undefined ? {} : { scope: structuredClone(input.scope) }),
      origin: 'manual',
      revision: (previous?.revision ?? 0) + 1,
      ...(previous?.supersedesId ? { supersedesId: previous.supersedesId } : {}),
      ...(previous?.supersededById ? { supersededById: previous.supersededById } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    const evidence: MemoryEvidence = {
      id: evidenceKey,
      factId: id,
      chatKey,
      sourceRef,
      sourceType: 'manual',
      excerpt: content,
      occurredAt: now,
      createdAt: now,
    };
    const conflicting = !previous && (status === 'active' || status === 'pending')
      ? slotFacts[0]
      : undefined;
    if (conflicting) fact.supersedesId = conflicting.id;
    const relatedFacts = conflicting ? [{
      ...conflicting,
      status: 'superseded' as const,
      supersededById: id,
      revision: conflicting.revision + 1,
      updatedAt: now,
    }] : [];
    const workspaceId = this.requireWorkspaceId();
    const slotRecordId = factSlotRecordId(chatKey, slotKey);
    const slotRecord = await this.store.read({ workspaceId, collection: 'fact-heads', recordId: slotRecordId });
    const currentSlot = slotRecord?.value;
    if (slotRecord && (!isFactSlotValue(currentSlot)
      || currentSlot.chatKey !== chatKey
      || currentSlot.slotKey !== slotKey
      || currentSlot.factId !== expectedSlotFactId)) {
      throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'memory.repository.manual-fact.slot' });
    }
    const operations: StoreOperation[] = [
      { action: 'upsert', collection: 'facts', recordId: fact.id, value: asPlain(fact), expectedVersion: previousRecord?.version ?? 0 },
      { action: 'upsert', collection: 'evidence', recordId: evidence.id, value: asPlain(evidence) },
    ];
    for (const related of relatedFacts) {
      const record = await this.store.read({ workspaceId, collection: 'facts', recordId: related.id });
      operations.push({ action: 'upsert', collection: 'facts', recordId: related.id, value: asPlain(related), expectedVersion: record?.version ?? 0 });
    }
    if (status === 'active' || status === 'pending') operations.push({ action: 'upsert', collection: 'fact-heads', recordId: slotRecordId, value: asPlain(slotValue(chatKey, slotKey, fact.id)), expectedVersion: slotRecord?.version ?? 0 });
    this.requireChatKey(chatKey);
    await this.store.apply({ workspaceId, operations });
    return fact;
  }

  upsert(chatKey: string, input: ManualFactInput): Promise<MemoryFact> {
    return this.upsertManualFact(chatKey, input);
  }

  async removeFact(chatKey: string, id: string): Promise<boolean> {
    chatKey = this.requireChatKey(chatKey);
    const workspaceId = this.requireWorkspaceId();
    const targetRecord = await this.store.read({ workspaceId, collection: 'facts', recordId: id });
    const target = targetRecord?.value as MemoryFact | undefined;
    if (!target || !targetRecord || !factBelongsToChat(target, chatKey)) return false;
    const relatedIds = [target.supersedesId, target.supersededById].filter((value): value is string => Boolean(value));
    const relatedRecords = await Promise.all(relatedIds.map((recordId) => this.store.read({ workspaceId, collection: 'facts', recordId })));
    if (relatedRecords.some(item => !item || !factBelongsToChat(item.value as unknown as MemoryFact, chatKey))) {
      throw createSSHelperError('WORKSPACE_CONFLICT', { stage: 'memory.repository.remove-fact.history' });
    }
    const operations: StoreOperation[] = [{ action: 'delete', collection: 'facts', recordId: id, expectedVersion: targetRecord.version }];
    for (const record of relatedRecords) {
      const value = structuredClone(record!.value as unknown as MemoryFact);
      if (value.supersededById === id) { delete value.supersededById; value.status = 'active'; }
      if (value.supersedesId === id) delete value.supersedesId;
      value.revision += 1; value.updatedAt = Date.now();
      operations.push({ action: 'upsert', collection: 'facts', recordId: value.id, value: asPlain(value), expectedVersion: record!.version });
    }
    const evidence = await this.listAllRecordRows('evidence', { chatKey, factId: id });
    for (const record of evidence) operations.push({ action: 'delete', collection: 'evidence', recordId: record.recordId, expectedVersion: record.version });
    if (target.slotKey) {
      const slotRecordId = factSlotRecordId(chatKey, target.slotKey);
      const slot = await this.store.read({ workspaceId, collection: 'fact-heads', recordId: slotRecordId });
      if (slot) {
        const replacement = selectedSlotFact(relatedRecords.map((record) => record!.value as unknown as MemoryFact));
        operations.push(replacement
          ? { action: 'upsert', collection: 'fact-heads', recordId: slotRecordId, value: asPlain(slotValue(chatKey, target.slotKey, replacement.id)), expectedVersion: slot.version }
          : { action: 'delete', collection: 'fact-heads', recordId: slotRecordId, expectedVersion: slot.version });
      }
    }
    this.requireChatKey(chatKey);
    await this.store.apply({ workspaceId, operations });
    await this.store.vectors.delete({ workspaceId, collection: 'facts', recordId: id }).catch(() => false);
    return true;
  }

  remove(chatKey: string, id: string): Promise<boolean> {
    return this.removeFact(chatKey, id);
  }

  async listEvidence(chatKey: string, factId: string): Promise<MemoryEvidence[]> {
    return this.listAllRows<MemoryEvidence>('evidence', { chatKey: this.requireChatKey(chatKey), factId });
  }

  async addMainChatUsage(usage: MainChatUsage): Promise<void> {
    await this.addMainChatUsageForScope({
      workspaceId: this.requireWorkspaceId(),
      chatKey: this.requireChatKey(usage.chatKey),
    }, usage);
  }

  async pageCollection<T>(
    collection: keyof typeof COLLECTIONS,
    request: MemoryPageRequest,
    scope: Readonly<Record<string, PlainData>> = {},
  ): Promise<MemoryPage<T>> {
    if (request.signal?.aborted) throw request.signal.reason;
    const page = await this.store.scan({
      workspaceId: this.requireWorkspaceId(),
      collection,
      filter: { ...scope, ...request.filter },
      ...(request.where === undefined ? {} : { where: request.where }),
      ...(request.orderBy === undefined ? {} : { orderBy: request.orderBy }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      limit: Math.max(1, Math.min(500, Math.trunc(request.limit))),
      includeTotal: request.includeTotal === true,
    });
    if (request.signal?.aborted) throw request.signal.reason;
    return {
      items: page.records.map(record => record.value as unknown as T),
      nextCursor: page.nextCursor,
      ...(page.total === undefined ? {} : { total: page.total }),
    };
  }

  async pageFacts(chatKey: string, request: MemoryPageRequest): Promise<MemoryPage<MemoryFact>> {
    chatKey = this.requireChatKey(chatKey);
    const needle = request.query?.trim().toLocaleLowerCase() ?? '';
    const limit = Math.max(1, Math.min(500, Math.trunc(request.limit)));
    const baseFilter = { chatKey, ...request.filter };
    if (!needle) {
      if (request.signal?.aborted) throw request.signal.reason;
      const page = await this.store.scan({
        workspaceId: this.requireWorkspaceId(),
        collection: 'facts',
        filter: baseFilter,
        ...(request.where === undefined ? {} : { where: request.where }),
        ...(request.orderBy === undefined ? {} : { orderBy: request.orderBy }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        limit,
        includeTotal: request.includeTotal === true,
      });
      if (request.signal?.aborted) throw request.signal.reason;
      return {
        items: page.records.map(record => record.value as unknown as MemoryFact),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    }

    const matches: MemoryFact[] = [];
    let cursor = request.cursor;
    let nextCursor: string | null = cursor ?? null;
    const seen = new Set<string>();
    do {
      if (request.signal?.aborted) throw request.signal.reason;
      const page = await this.store.scan({
        workspaceId: this.requireWorkspaceId(),
        collection: 'facts',
        filter: baseFilter,
        ...(request.where === undefined ? {} : { where: request.where }),
        ...(request.orderBy === undefined ? {} : { orderBy: request.orderBy }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.max(1, limit - matches.length),
      });
      for (const record of page.records) {
        const fact = record.value as unknown as MemoryFact;
        if ([fact.content, fact.canonicalKey, ...fact.entityKeys].some(value => value.toLocaleLowerCase().includes(needle))) {
          matches.push(fact);
          if (matches.length >= limit) break;
        }
      }
      nextCursor = page.nextCursor;
      if (matches.length >= limit || nextCursor === null) break;
      if (seen.has(nextCursor)) throw paginationStalledError('事实搜索');
      seen.add(nextCursor);
      cursor = nextCursor;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } while (cursor);
    return { items: matches, nextCursor };
  }

  async listEvidenceForFacts(chatKey: string, factIds: readonly string[], signal?: AbortSignal): Promise<MemoryEvidence[]> {
    chatKey = this.requireChatKey(chatKey);
    const ids = [...new Set(factIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const evidence: MemoryEvidence[] = [];
    let cursor: string | undefined;
    do {
      if (signal?.aborted) throw signal.reason;
      const page = await this.store.scan({
        workspaceId: this.requireWorkspaceId(),
        collection: 'evidence',
        filter: { chatKey },
        where: [{ field: 'factId', op: 'in', value: ids }],
        ...(cursor === undefined ? {} : { cursor }),
        limit: QUERY_PAGE_SIZE,
      });
      evidence.push(...page.records.map(record => record.value as unknown as MemoryEvidence));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return evidence;
  }

  async addMainChatUsageForScope(
    scope: { readonly workspaceId: string; readonly chatKey: string },
    usage: MainChatUsage,
  ): Promise<void> {
    const workspaceId = scope.workspaceId.trim();
    const chatKey = normalizedChatKey(scope.chatKey);
    if (!workspaceId || usage.chatKey !== chatKey) {
      throw createSSHelperError('INVALID_PAYLOAD', {
        stage: 'memory.repository.usage.scope',
      });
    }
    const result = await this.store.apply({
      workspaceId,
      idempotencyKey: `main-usage:${usage.id}`,
      operations: [{
        action: 'upsert',
        collection: 'usage',
        recordId: usage.id,
        value: asPlain(usage),
      }],
    });
  }

  async commitMainChatGeneration(usage: MainChatUsage, detail: GenerationRecallDetail, snapshot?: PreparedGenerationPromptSnapshot): Promise<void> {
    await this.commitMainChatGenerationForScope({
      workspaceId: this.requireWorkspaceId(),
      chatKey: this.requireChatKey(usage.chatKey),
    }, usage, detail, snapshot);
  }

  async prepareGenerationPromptSnapshot(
    scope: { readonly workspaceId: string; readonly chatKey: string },
    detailId: string,
    memoryInjection: string,
    prompt: FinalPromptSnapshot | undefined,
    createdAt: number,
  ): Promise<PreparedGenerationPromptSnapshot> {
    const workspaceId = scope.workspaceId.trim();
    const chatKey = normalizedChatKey(scope.chatKey);
    const snapshotId = `${detailId}:prompt-snapshot`;
    const serialized = prompt === undefined ? '' : JSON.stringify(prompt);
    const byteLength = textBytes(serialized);
    const sha256 = await sha256Content(serialized);
    const kind = prompt?.kind ?? 'unknown';
    const messageCount = prompt?.kind === 'chat' ? prompt.messages.length : undefined;
    const verifiedIncludesMemory = prompt?.kind === 'chat'
      ? containsExactText(prompt.messages, memoryInjection)
      : prompt?.kind === 'text' ? prompt.prompt.includes(memoryInjection) : false;
    const captureStatus = prompt === undefined ? 'unavailable' as const
      : byteLength > PROMPT_SNAPSHOT_MAX_BYTES ? 'too_large' as const : 'available' as const;
    const texts = captureStatus === 'available' ? splitUtf8(serialized) : [];
    const metadata: GenerationPromptSnapshotMetadata = {
      snapshotId, kind, ...(messageCount === undefined ? {} : { messageCount }), byteLength, sha256,
      chunkCount: texts.length, captureStatus, verifiedIncludesMemory,
    };
    const manifest: GenerationPromptSnapshotManifest = {
      id: snapshotId, workspaceId, chatKey, detailId, memoryInjection, createdAt, ...metadata,
    };
    const chunks = texts.map((content, index): GenerationPromptSnapshotChunk => ({
      id: `${snapshotId}:chunk:${index}`, workspaceId, chatKey, snapshotId, index, content,
    }));
    return { manifest, chunks, metadata };
  }

  async commitMainChatGenerationForScope(
    scope: { readonly workspaceId: string; readonly chatKey: string },
    usage: MainChatUsage,
    detail: GenerationRecallDetail,
    snapshot?: PreparedGenerationPromptSnapshot,
  ): Promise<void> {
    const workspaceId = scope.workspaceId.trim();
    const chatKey = normalizedChatKey(scope.chatKey);
    if (!workspaceId) {
      throw createSSHelperError('INVALID_PAYLOAD', {
        stage: 'memory.repository.generation-recall.scope',
      });
    }
    if (detail.chatKey !== chatKey || detail.workspaceId !== workspaceId
      || usage.chatKey !== chatKey || usage.generationRecallDetailId !== detail.id) {
      throw createSSHelperError('INVALID_PAYLOAD', {
        stage: 'memory.repository.generation-recall.commit',
      });
    }
    if (snapshot !== undefined && (snapshot.manifest.workspaceId !== workspaceId
      || snapshot.manifest.chatKey !== chatKey || snapshot.manifest.detailId !== detail.id
      || detail.promptSnapshot?.snapshotId !== snapshot.manifest.snapshotId)) {
      throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.generation-prompt-snapshot.scope' });
    }
    const [existingUsage, existingDetail, existingManifest] = await Promise.all([
      this.store.read({ workspaceId, collection: 'usage', recordId: usage.id }),
      this.store.read({ workspaceId, collection: 'generation-recall-details', recordId: detail.id }),
      snapshot === undefined ? Promise.resolve(null) : this.store.read({ workspaceId, collection: 'generation-prompt-snapshots', recordId: snapshot.manifest.id }),
    ]);
    if (existingUsage !== null && existingDetail !== null && (snapshot === undefined || existingManifest !== null)) return;
    if (existingUsage !== null || existingDetail !== null || existingManifest !== null) {
      throw createSSHelperError('WORKSPACE_CONFLICT', {
        stage: 'memory.repository.generation-recall.partial-record',
      });
    }
    const operations: StoreOperation[] = [
      {
        action: 'upsert', collection: 'usage', recordId: usage.id, value: asPlain(usage), expectedVersion: 0,
      },
      {
        action: 'upsert', collection: 'generation-recall-details', recordId: detail.id, value: asPlain(detail), expectedVersion: 0,
      },
    ];
    if (snapshot !== undefined) {
      operations.push({ action: 'upsert', collection: 'generation-prompt-snapshots', recordId: snapshot.manifest.id, value: asPlain(snapshot.manifest), expectedVersion: 0 });
      operations.push(...snapshot.chunks.map(chunk => ({ action: 'upsert' as const, collection: 'generation-prompt-snapshot-chunks', recordId: chunk.id, value: asPlain(chunk), expectedVersion: 0 })));
    }
    const result = await this.store.apply({
      workspaceId,
      idempotencyKey: `generation-recall:${detail.id}`,
      operations,
    });
    const expected: Array<{ collection: string; recordId: string }> = [
      { collection: 'usage', recordId: usage.id },
      { collection: 'generation-recall-details', recordId: detail.id },
      ...(snapshot === undefined ? [] : [
        { collection: 'generation-prompt-snapshots', recordId: snapshot.manifest.id },
        ...snapshot.chunks.map(chunk => ({ collection: 'generation-prompt-snapshot-chunks', recordId: chunk.id })),
      ]),
    ];
    if (result.results.length !== expected.length || expected.some((item, index) => {
      const committed = result.results[index];
      return committed?.action !== 'upsert'
        || committed.collection !== item.collection
        || committed.recordId !== item.recordId
        || !Number.isInteger(committed.revision)
        || committed.revision < 1;
    })) {
      throw createSSHelperError('INVALID_PAYLOAD', {
        stage: 'memory.repository.generation-recall.result',
      });
    }
  }

  async loadGenerationPromptSnapshot(workspaceId: string, chatKey: string, snapshotId: string, signal?: AbortSignal): Promise<GenerationPromptSnapshotPayload | undefined> {
    workspaceId = workspaceId.trim(); chatKey = normalizedChatKey(chatKey); snapshotId = snapshotId.trim();
    if (!workspaceId || !snapshotId) throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.generation-prompt-snapshot.read' });
    if (signal?.aborted) throw signal.reason;
    if (!this.store.hasSession(workspaceId)) await this.ensureCollections(workspaceId);
    const record = await this.store.read({ workspaceId, collection: 'generation-prompt-snapshots', recordId: snapshotId });
    if (record === null) return undefined;
    const manifest = record.value as unknown as GenerationPromptSnapshotManifest;
    if (manifest.workspaceId !== workspaceId || manifest.chatKey !== chatKey || manifest.snapshotId !== snapshotId) {
      throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.generation-prompt-snapshot.manifest' });
    }
    if (manifest.captureStatus !== 'available') return { manifest };
    const rows = await this.listAllRecordRows('generation-prompt-snapshot-chunks', { chatKey, snapshotId }, undefined, workspaceId);
    const chunks = rows.map(row => row.value as unknown as GenerationPromptSnapshotChunk).sort((left, right) => left.index - right.index);
    if (signal?.aborted) throw signal.reason;
    if (chunks.length !== manifest.chunkCount || chunks.some((chunk, index) => chunk.index !== index || chunk.snapshotId !== snapshotId)) {
      throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.generation-prompt-snapshot.chunks' });
    }
    const serialized = chunks.map(chunk => chunk.content).join('');
    if (textBytes(serialized) !== manifest.byteLength || await sha256Content(serialized) !== manifest.sha256) {
      throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.generation-prompt-snapshot.integrity' });
    }
    let request: GenerationPromptSnapshotPayload['request'];
    try { request = JSON.parse(serialized) as GenerationPromptSnapshotPayload['request']; }
    catch { throw createSSHelperError('INVALID_JSON', { stage: 'memory.repository.generation-prompt-snapshot.parse' }); }
    if (request?.kind !== manifest.kind) throw createSSHelperError('INVALID_PAYLOAD', { stage: 'memory.repository.generation-prompt-snapshot.kind' });
    return { manifest, request };
  }

  async listMainChatUsage(chatKey: string): Promise<MainChatUsage[]> {
    return this.listAllRows<MainChatUsage>('usage', { chatKey: this.requireChatKey(chatKey) });
  }

  async listGenerationRecallDetails(chatKey: string): Promise<GenerationRecallDetail[]> {
    return this.listAllRows<GenerationRecallDetail>('generation-recall-details', {
      chatKey: this.requireChatKey(chatKey),
    });
  }

  async findGenerationRecallDetailsForTargets(
    workspaceId: string,
    chatKey: string,
    targets: readonly GenerationRecallLookupTarget[],
    signal?: AbortSignal,
  ): Promise<GenerationRecallDetail[]> {
    workspaceId = workspaceId.trim();
    chatKey = normalizedChatKey(chatKey);
    if (!workspaceId || !chatKey) {
      throw createSSHelperError('INVALID_PAYLOAD', {
        stage: 'memory.repository.generation-recall.lookup-scope',
      });
    }
    if (targets.length === 0) return [];
    if (!this.store.hasSession(workspaceId)) await this.ensureGenerationRecallDetailsCollection(workspaceId);
    if (signal?.aborted) throw signal.reason;
    const found = new Map<string, GenerationRecallDetail>();
    const scanValues = async (field: 'messageId' | 'messageIndex', values: readonly (string | number)[]): Promise<void> => {
      for (let offset = 0; offset < values.length; offset += LOOKUP_CHUNK_SIZE) {
        const chunk = values.slice(offset, offset + LOOKUP_CHUNK_SIZE);
        let cursor: string | undefined;
        do {
          if (signal?.aborted) throw signal.reason;
          const page = await this.store.scan({
            workspaceId,
            collection: 'generation-recall-details',
            filter: { chatKey },
            where: [{ field, op: 'in', value: chunk }],
            orderBy: { field: 'createdAt', direction: 'desc' },
            ...(cursor === undefined ? {} : { cursor }),
            limit: QUERY_PAGE_SIZE,
          });
          for (const record of page.records) {
            const detail = record.value as unknown as GenerationRecallDetail;
            if (detail.previewState !== 'invalidated') found.set(detail.id, detail);
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
    };

    const messageIndexes = [...new Set(targets.map(target => target.messageIndex))];
    const messageIds = [...new Set(targets.flatMap(target => target.messageIds).filter(Boolean))];
    await Promise.all([
      scanValues('messageIndex', messageIndexes),
      scanValues('messageId', messageIds),
    ]);
    if (signal?.aborted) throw signal.reason;
    return [...found.values()].sort((left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  }

  async applyGenerationRecallMessageDeletion(chatKey: string, messageIndex: number, deletedCount: number, invalidatedAt = Date.now()): Promise<number> {
    chatKey = this.requireChatKey(chatKey);
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || !Number.isSafeInteger(deletedCount) || deletedCount <= 0) return 0;
    const records = await this.listAllRecordRows('generation-recall-details', { chatKey });
    const endIndex = messageIndex + deletedCount;
    const changed = records.filter((record) => {
      const value = record.value as unknown as GenerationRecallDetail;
      return value.messageIndex >= messageIndex;
    }).map((record) => {
      const value = record.value as unknown as GenerationRecallDetail;
      if (value.messageIndex < endIndex) return {
        record,
        value: this.invalidatedGenerationRecallDetail(value, 'message_deleted', invalidatedAt),
        purgeSnapshot: value.previewState !== 'invalidated',
      };
      const nextIndex = value.messageIndex - deletedCount;
      return {
        record,
        value: {
          ...value,
          messageIndex: nextIndex,
          ...(value.messageIdIsSynthetic === true ? { messageId: String(nextIndex) } : {}),
        },
        purgeSnapshot: false,
      };
    });
    return this.writeGenerationRecallChanges(chatKey, changed);
  }

  async applyGenerationRecallMessageEdit(chatKey: string, edited: ChatMessageSnapshot, invalidatedAt = Date.now()): Promise<number> {
    chatKey = this.requireChatKey(chatKey);
    const records = await this.listAllRecordRows('generation-recall-details', { chatKey });
    const variantId = edited.variantId ?? '';
    const fingerprint = stableMemoryRecordKey(edited.text);
    const changed = records.filter((record) => {
      const value = record.value as unknown as GenerationRecallDetail;
      return value.previewState !== 'invalidated' && value.messageIndex === edited.index
        && (value.variantId ?? '') === variantId && value.outputFingerprint !== fingerprint;
    }).map((record) => ({
      record,
      value: this.invalidatedGenerationRecallDetail(record.value as unknown as GenerationRecallDetail, 'message_edited', invalidatedAt),
      purgeSnapshot: true,
    }));
    return this.writeGenerationRecallChanges(chatKey, changed);
  }

  async applyGenerationRecallSwipeDeletion(chatKey: string, messageIndex: number, deletedVariantId: string, invalidatedAt = Date.now()): Promise<number> {
    chatKey = this.requireChatKey(chatKey);
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) return 0;
    const deletedVariant = /^\d+$/u.test(deletedVariantId) ? Number(deletedVariantId) : undefined;
    const records = await this.listAllRecordRows('generation-recall-details', { chatKey });
    const changed = records.filter((record) => {
      const value = record.value as unknown as GenerationRecallDetail;
      if (value.messageIndex !== messageIndex) return false;
      const variant = value.variantId ?? '';
      return variant === deletedVariantId || (deletedVariant !== undefined && /^\d+$/u.test(variant) && Number(variant) > deletedVariant);
    }).map((record) => {
      const value = record.value as unknown as GenerationRecallDetail;
      if ((value.variantId ?? '') === deletedVariantId) return {
        record,
        value: this.invalidatedGenerationRecallDetail(value, 'swipe_deleted', invalidatedAt),
        purgeSnapshot: value.previewState !== 'invalidated',
      };
      return { record, value: { ...value, variantId: String(Number(value.variantId) - 1) }, purgeSnapshot: false };
    });
    return this.writeGenerationRecallChanges(chatKey, changed);
  }

  private invalidatedGenerationRecallDetail(
    value: GenerationRecallDetail,
    reason: NonNullable<GenerationRecallDetail['invalidationReason']>,
    invalidatedAt: number,
  ): GenerationRecallDetail {
    const { promptSnapshot: _snapshot, ...safe } = value;
    return { ...safe, previewState: 'invalidated', invalidatedAt, invalidationReason: reason };
  }

  private async writeGenerationRecallChanges(
    chatKey: string,
    changed: readonly { record: WorkspaceRecord; value: GenerationRecallDetail; purgeSnapshot: boolean }[],
  ): Promise<number> {
    if (changed.length === 0) return 0;
    const snapshotRecords = await Promise.all(changed.filter(change => change.purgeSnapshot).map(async ({ record }) => {
      const value = record.value as unknown as GenerationRecallDetail;
      const snapshotId = value.promptSnapshot?.snapshotId;
      if (!snapshotId) return [] as Array<{ collection: string; record: WorkspaceRecord }>;
      const manifest = await this.store.read({ workspaceId: this.requireWorkspaceId(), collection: 'generation-prompt-snapshots', recordId: snapshotId });
      const chunks = await this.listAllRecordRows('generation-prompt-snapshot-chunks', { chatKey, snapshotId });
      return [
        ...(manifest === null ? [] : [{ collection: 'generation-prompt-snapshots', record: manifest }]),
        ...chunks.map(chunk => ({ collection: 'generation-prompt-snapshot-chunks', record: chunk })),
      ];
    }));
    await this.store.apply({
      workspaceId: this.requireWorkspaceId(),
      operations: [
        ...changed.map(({ record, value }) => ({
          action: 'upsert' as const,
          collection: 'generation-recall-details',
          recordId: record.recordId,
          value: asPlain(value),
          expectedVersion: record.version,
        })),
        ...snapshotRecords.flat().map(({ collection, record }) => ({
          action: 'delete' as const,
          collection,
          recordId: record.recordId,
          expectedVersion: record.version,
        })),
      ],
    });
    return changed.length;
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const result = await this.store.read({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key });
    const value = result?.value as unknown as MemorySettingRecord | undefined;
    return value?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.ensureCollections(SETTINGS_WORKSPACE_ID); const current = await this.store.read({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key });
    const setting: MemorySettingRecord = { id: key, namespace: 'stx_memory', key, value, updatedAt: Date.now() };
    await this.store.write({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key, value: asPlain(setting), expectedVersion: current?.version ?? 0 });
  }

  async setSettings(values: Record<string, unknown>): Promise<void> {
    await this.ensureCollections(SETTINGS_WORKSPACE_ID); const operations: StoreOperation[] = [];
    for (const [key, value] of Object.entries(values)) {
      const current = await this.store.read({ workspaceId: SETTINGS_WORKSPACE_ID, collection: 'settings', recordId: key });
      operations.push({ action: 'upsert', collection: 'settings', recordId: key, value: asPlain({ id: key, namespace: 'stx_memory', key, value, updatedAt: Date.now() }), expectedVersion: current?.version ?? 0 });
    }
    await this.store.apply({ workspaceId: SETTINGS_WORKSPACE_ID, operations });
  }

  async addRecallLog(log: MemoryRecallLog): Promise<void> {
    this.requireChatKey(log.chatKey);
    const { injectedPrompt: _sensitivePrompt, ...safeLog } = log;
    await this.store.write({ workspaceId: this.requireWorkspaceId(), collection: 'recall-logs', recordId: log.id, value: asPlain(safeLog) });
  }

  async getLastRecall(chatKey: string): Promise<MemoryRecallLog | undefined> {
    chatKey = this.requireChatKey(chatKey);
    const page = await this.store.scan({ workspaceId: this.requireWorkspaceId(), collection: 'recall-logs', filter: { chatKey }, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 1 });
    return page.records[0]?.value as unknown as MemoryRecallLog | undefined;
  }

  async clearCurrentChatData(chatKey: string): Promise<void> {
    chatKey = this.requireChatKey(chatKey);
    const workspaceId = this.requireWorkspaceId();
    const [evidenceRecords, jobRecords, auditRecords, usageRecords, logRecords, recallDetailRecords, promptSnapshotRecords, promptChunkRecords, factRecords, slotRecords, graphNodeRecords, graphEdgeRecords] = await Promise.all([
      this.listAllRecordRows('evidence', { chatKey }), this.listAllRecordRows('capture-jobs', { chatKey }), this.listAllRecordRows('change-audits', { chatKey }),
      this.listAllRecordRows('usage', { chatKey }), this.listAllRecordRows('recall-logs', { chatKey }),
      this.listAllRecordRows('generation-recall-details', { chatKey }),
      this.listAllRecordRows('generation-prompt-snapshots', { chatKey }), this.listAllRecordRows('generation-prompt-snapshot-chunks', { chatKey }),
      this.listAllRecordRows('facts', { chatKey }),
      this.listAllRecordRows('fact-heads', { chatKey }),
      this.listAllRecordRows('graph-nodes', { chatKey }), this.listAllRecordRows('graph-edges', { chatKey }),
    ]);
    const collections = [
      ['evidence', evidenceRecords], ['capture-jobs', jobRecords], ['change-audits', auditRecords],
      ['usage', usageRecords], ['recall-logs', logRecords], ['generation-recall-details', recallDetailRecords],
      ['generation-prompt-snapshots', promptSnapshotRecords], ['generation-prompt-snapshot-chunks', promptChunkRecords],
      ['facts', factRecords], ['fact-heads', slotRecords],
      ['graph-edges', graphEdgeRecords], ['graph-nodes', graphNodeRecords],
    ] as const;
    const operations: StoreOperation[] = collections.flatMap(([collection, records]) => records.map((record) => ({
      action: 'delete' as const, collection, recordId: record.recordId, expectedVersion: record.version,
    })));
    this.requireChatKey(chatKey);
    await this.transactInBatches(workspaceId, operations);
    await this.store.vectors.clear({ workspaceId, collection: 'facts', metadata: { chatKey } });
  }

  async getChatKeys(): Promise<string[]> {
    const values = await Promise.all(['facts', 'evidence', 'capture-jobs', 'change-audits', 'usage', 'recall-logs', 'generation-recall-details', 'generation-prompt-snapshots', 'generation-prompt-snapshot-chunks', 'graph-nodes', 'graph-edges'].map((collection) => this.listAllRecordRows(collection)));
    return [...new Set(values.flat().map((record) => (record.value as unknown as { chatKey?: string }).chatKey).filter((value): value is string => Boolean(value)))].sort();
  }

  async upsertFactVector(input: UpsertMemoryFactVectorInput): Promise<MemoryFactVector> {
    const chatKey = this.requireChatKey(input.chatKey);
    const fact = await this.getFact(chatKey, input.factId);
    if (!fact) throw createSSHelperError('WORKSPACE_NOT_FOUND', { stage: 'memory.repository.vector.fact' });
    const now = input.updatedAt ?? Date.now();
    const contentHash = await sha256Content(input.content);
    const vector = float32ArrayToArrayBuffer(input.vector);
    await this.store.vectors.upsert({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: input.factId, model: input.model, vector: Array.from(input.vector), metadata: { chatKey, contentHash, resourceId: input.resourceId, dimensions: input.vector.length, updatedAt: now } });
    return {
      factId: input.factId,
      chatKey,
      contentHash,
      resourceId: input.resourceId,
      model: input.model,
      dimensions: input.vector.length,
      vector,
      createdAt: now,
      updatedAt: now,
    };
  }

  async deleteFactVector(chatKey: string, factId: string): Promise<boolean> {
    if (!await this.getFact(chatKey, factId)) return false;
    return this.store.vectors.delete({ workspaceId: this.requireWorkspaceId(), collection: 'facts', recordId: factId });
  }

  async clearFactVectors(chatKey: string): Promise<number> {
    return this.store.vectors.clear({ workspaceId: this.requireWorkspaceId(), collection: 'facts', metadata: { chatKey: this.requireChatKey(chatKey) } });
  }

  async getFactVectorCoverage(chatKey: string, target: MemoryFactVectorTarget): Promise<MemoryFactVectorCoverage> {
    chatKey = this.requireChatKey(chatKey);
    const facts = (await this.listAllFacts(chatKey)).filter((fact) => fact.status === 'active' || fact.status === 'pending'); const vectors = await this.listAllVectors(chatKey); const byId = new Map(vectors.map((item) => [item.recordId, item]));
    const readyFactIds: string[] = []; const missingFactIds: string[] = []; const staleFactIds: string[] = [];
    for (const fact of facts) { const vector = byId.get(fact.id); const metadata = vector?.metadata as { resourceId?: string; dimensions?: number } | undefined; if (!vector) missingFactIds.push(fact.id); else if (vector.model !== target.model || metadata?.resourceId !== target.resourceId || (target.dimensions !== undefined && metadata?.dimensions !== target.dimensions)) staleFactIds.push(fact.id); else readyFactIds.push(fact.id); }
    const factIds = new Set(facts.map((fact) => fact.id)); const orphanedFactIds = vectors.filter((item) => !factIds.has(item.recordId)).map((item) => item.recordId); const totalFacts = facts.length;
    return { chatKey, totalFacts, ready: readyFactIds.length, missing: missingFactIds.length, stale: staleFactIds.length, orphaned: orphanedFactIds.length, coverage: totalFacts ? readyFactIds.length / totalFacts : 1, readyFactIds, missingFactIds, staleFactIds, orphanedFactIds };
  }

  async listFactsNeedingVectorRebuild(
    chatKey: string,
    target: MemoryFactVectorTarget,
    limit = 32,
  ): Promise<MemoryFact[]> {
    const coverage = await this.getFactVectorCoverage(chatKey, target); const ids = new Set([...coverage.missingFactIds, ...coverage.staleFactIds]);
    return (await this.listAllFacts(chatKey)).filter((fact) => ids.has(fact.id)).slice(0, Math.min(32, Math.max(1, Math.trunc(limit))));
  }

  vectorSearch(input: {
    chatKey: string;
    vector: readonly number[] | Float32Array;
    limit?: number;
    resourceId?: string;
    model?: string;
  }): Promise<Array<{ factId: string; score: number }>> {
    const metadata = { chatKey: this.requireChatKey(input.chatKey), ...(input.resourceId ? { resourceId: input.resourceId } : {}) };
    return this.store.vectors.search({ workspaceId: this.requireWorkspaceId(), collection: 'facts', vector: Array.from(input.vector), ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.model ? { model: input.model } : {}), metadata }).then((hits) => hits.map((hit) => ({ factId: hit.recordId, score: hit.score })));
  }

  async clearAllMemory(): Promise<number> {
    const removed = await this.store.reset([SETTINGS_WORKSPACE_ID]);
    if (this.workspaceId) await this.ensureCollections(this.workspaceId);
    return removed;
  }

  async exportBackup(): Promise<Blob> {
    throw createSSHelperError('MEMORY_ARCHIVE_EXPORT_DISABLED', {
      stage: 'memory.repository.archive.export',
    });
  }

  async importBackup(file: File): Promise<void> {
    void file;
    throw createSSHelperError('MEMORY_ARCHIVE_IMPORT_DISABLED', {
      stage: 'memory.repository.archive.import',
    });
  }

  async checkIntegrity(): Promise<{ ok: boolean; message: string }> {
    const sqlite = await this.store.integrity(); if (!sqlite.ok) return { ok: false, message: sqlite.messages.join('；') };
    const [facts, evidence, slots, vectors, graphNodes, graphEdges] = await Promise.all([
      this.listAllRecordRows('facts'), this.listAllRows<MemoryEvidence>('evidence'), this.listAllRecordRows('fact-heads'), this.listAllVectors(),
      this.listAllRows<MemoryGraphNode>('graph-nodes'), this.listAllRows<MemoryGraphEdge>('graph-edges'),
    ]);
    const factById = new Map(facts.map((item) => [item.recordId, item.value as unknown as MemoryFact]));
    const expectedGraph = deriveMemoryGraphProjection([...factById.values()]);
    const expectedNodes = new Map(expectedGraph.nodes.map((node) => [node.id, node]));
    const expectedEdges = new Map(expectedGraph.edges.map((edge) => [edge.id, edge]));
    const graphNodeById = new Map(graphNodes.map((node) => [node.id, node]));
    const problems = [
      ...facts.flatMap((item) => {
        const fact = item.value as unknown as MemoryFact;
        const messages: string[] = [];
        if (!fact.chatKey?.trim()) messages.push(`事实 ${item.recordId} 缺少聊天标识，已从聊天视图隔离`);
        if (fact.id !== item.recordId) messages.push(`事实 ${item.recordId} 的内部 ID 不一致`);
        for (const relatedId of [fact.supersedesId, fact.supersededById].filter((value): value is string => Boolean(value))) {
          const related = factById.get(relatedId);
          if (related && related.chatKey !== fact.chatKey) messages.push(`事实 ${item.recordId} 的历史链指向其他聊天 ${relatedId}`);
        }
        return messages;
      }),
      ...evidence.flatMap((item) => {
        const fact = factById.get(item.factId);
        if (!item.chatKey?.trim()) return [`证据 ${item.id} 缺少聊天标识，已从聊天视图隔离`];
        if (!fact) return [`证据 ${item.id} 缺少事实 ${item.factId}`];
        return fact.chatKey === item.chatKey ? [] : [`证据 ${item.id} 与事实 ${item.factId} 属于不同聊天`];
      }),
      ...slots.flatMap((item) => {
        if (!isFactSlotValue(item.value)) return [`事实头 ${item.recordId} 无效`];
        const fact = factById.get(item.value.factId);
        if (!fact) return [`事实头 ${item.recordId} 指向不存在的事实 ${item.value.factId}`];
        if (fact.chatKey !== item.value.chatKey) return [`事实头 ${item.recordId} 与事实 ${item.value.factId} 属于不同聊天`];
        if (fact.slotKey !== item.value.slotKey) return [`事实头 ${item.recordId} 的业务槽位与事实 ${item.value.factId} 不一致`];
        return item.recordId === factSlotRecordId(item.value.chatKey, item.value.slotKey) ? [] : [`事实头 ${item.recordId} 的聊天级记录 ID 不正确`];
      }),
      ...vectors.flatMap((item) => {
        const fact = factById.get(item.recordId);
        const metadata = item.metadata as { chatKey?: string } | undefined;
        if (!fact) return [`向量 ${item.recordId} 缺少事实`];
        if (!metadata?.chatKey) return [`向量 ${item.recordId} 缺少聊天标识，已停止参与召回`];
        return metadata.chatKey === fact.chatKey ? [] : [`向量 ${item.recordId} 与事实属于不同聊天，已停止参与召回`];
      }),
      ...graphNodes.flatMap((node) => {
        if (!node.chatKey?.trim()) return [`图节点 ${node.id} 缺少聊天标识`];
        if (node.id !== graphNodeId(node.chatKey, node.entityKey)) return [`图节点 ${node.id} 的确定性 ID 不正确`];
        const expected = expectedNodes.get(node.id);
        return expected && samePlainData(node, expected) ? [] : [`图节点 ${node.id} 未由当前有效事实派生`];
      }),
      ...graphEdges.flatMap((edge) => {
        const fact = factById.get(edge.backingFactId);
        if (!edge.chatKey?.trim()) return [`图边 ${edge.id} 缺少聊天标识`];
        if (!fact || fact.chatKey !== edge.chatKey || !isGraphBackedFact(fact)) return [`图边 ${edge.id} 缺少有效背书事实 ${edge.backingFactId}`];
        const from = graphNodeById.get(edge.fromNodeId);
        const to = graphNodeById.get(edge.toNodeId);
        if (!from || !to || from.chatKey !== edge.chatKey || to.chatKey !== edge.chatKey) return [`图边 ${edge.id} 指向缺失或跨聊天节点`];
        const expected = expectedEdges.get(edge.id);
        return expected && samePlainData(edge, expected) ? [] : [`图边 ${edge.id} 未与 backing fact 保持同步`];
      }),
      ...[...expectedNodes.keys()].filter((id) => !graphNodeById.has(id)).map((id) => `图节点 ${id} 尚未回填`),
      ...[...expectedEdges.keys()].filter((id) => !graphEdges.some((edge) => edge.id === id)).map((id) => `图边 ${id} 尚未回填`),
    ];
    return { ok: problems.length === 0, message: problems.length ? problems.join('；') : 'SQLite 与 Memory workspace 完整性检查通过。' };
  }

}
