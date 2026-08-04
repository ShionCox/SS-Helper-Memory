import {
  createSSHelperError,
  readSSHelperFailure,
  type LlmToolDefinition,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type PlainData,
} from '@ss-helper/sdk';
import type { MultiActorMemoryRepository } from '../../infrastructure';
import type { MemoryExtractionInput } from '../ingest/types';
import type {
  AgentToolAudit,
  AgentToolContext,
  AgentToolGatewayPort,
  AgentToolName,
  ExtractionStageKey,
  ToolReadSetEntry,
  ToolResultEnvelope,
} from '../extraction/extraction-types';
import { buildAgentToolDefinitions } from './agent-tool-definitions';
import { sanitizeToolValue } from './tool-result-taint-guard';

const MAX_CALLS_PER_ROUND = 6;
const MAX_ITEMS = 50;
const MAX_CHARS = 12_000;
const TOOL_TIMEOUT_MS = 3_000;
const DETAIL_FIELDS = new Set(['canonicalName', 'aliases', 'status', 'category', 'states', 'history', 'kind', 'subjectKey', 'predicateKey', 'objectKey', 'content', 'validFrom', 'validUntil', 'sceneId', 'locationId', 'presentOwnerIds', 'updatedAtFloor', 'revision']);
const TOOL_NAMES = new Set<AgentToolName>([
  'entity.resolve_context',
  'scene.resolve_context',
  'inventory.resolve_context',
  'memory.resolve_update_context',
  'reference.get_details',
]);

interface IssuedReference {
  readonly kind: ToolReadSetEntry['kind'];
  readonly recordId: string;
  readonly ref: string;
  readonly revision: number;
  readonly contentDigest: string;
  readonly value: PlainData;
  readonly tracked: boolean;
}

interface GatewayScope {
  readonly pipelineRunId: string;
  readonly workspaceId: string;
  readonly chatKey: string;
  readonly dataRevision: number;
}

function plain(value: unknown): PlainData {
  return JSON.parse(JSON.stringify(value)) as PlainData;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
}

function revisionOf(value: Record<string, unknown>): number {
  let resolved = 0;
  for (const key of ['revision', 'traceRevision', 'updatedAt', 'updatedAtFloor', 'createdAt']) {
    const candidate = Number(value[key]);
    if (Number.isFinite(candidate) && candidate >= 0) resolved = Math.max(resolved, Math.trunc(candidate));
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const item of child) resolved = Math.max(resolved, revisionOf(record(item)));
  }
  return resolved;
}

async function digest(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return `sha256:${[...bytes].map(item => item.toString(16).padStart(2, '0')).join('')}`;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createSSHelperError('MEMORY_EXTRACTION_PIPELINE_CANCELLED', { stage: 'memory.agent.tool.abort' });
}

function stringList(value: unknown, field: string, maxItems = 20): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: field, keyword: 'type', expected: `1..${maxItems} non-empty strings` });
  }
  return value.map(item => String(item).trim());
}

function enumStringList(value: unknown, field: string, allowed: readonly string[], maxItems: number): string[] {
  const values = stringList(value, field, maxItems);
  if (values.some(item => !allowed.includes(item))) throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: field, keyword: 'enum', expected: allowed.join('|') });
  return values;
}

function boundedLimit(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_ITEMS) {
    throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: 'limit', keyword: 'range', expected: 'integer 1..50' });
  }
  return Number(value);
}

function exactKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(args).find(key => !allowed.includes(key));
  if (extra) throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: extra, keyword: 'additionalProperties', expected: 'no additional properties' });
}

function parameterSummary(args: Record<string, unknown>): PlainData {
  const listSizes: Record<string, number> = {};
  for (const [key, value] of Object.entries(args)) if (Array.isArray(value)) listSizes[key] = value.length;
  return {
    keys: Object.keys(args).sort(),
    listSizes,
  };
}

function project(value: PlainData, fields: readonly string[]): PlainData {
  const source = record(value);
  return plain({ ref: source.ref, ...Object.fromEntries(fields.filter(field => field in source).map(field => [field, source[field]])) });
}

export class AgentToolGateway implements AgentToolGatewayPort {
  readonly #issued = new Map<string, IssuedReference>();
  readonly #refByRecord = new Map<string, string>();
  readonly #readSet = new Map<string, ToolReadSetEntry>();
  readonly #audits: AgentToolAudit[] = [];
  readonly #counters = { actor: 0, location: 0, inventory: 0, fact: 0, scene: 0 };
  #prefetchedSeeded = false;
  #scope?: GatewayScope;

  constructor(
    private readonly input: MemoryExtractionInput,
    private readonly repository?: MultiActorMemoryRepository,
  ) {}

  definitions(names: readonly AgentToolName[]): readonly LlmToolDefinition[] {
    return buildAgentToolDefinitions(names);
  }

  audits(): readonly AgentToolAudit[] { return this.#audits.map(item => ({ ...item })); }
  readSet(): readonly ToolReadSetEntry[] { return [...this.#readSet.values()].map(item => ({ ...item })); }

  async registerPendingReferences(input: MemoryExtractionInput): Promise<void> {
    await Promise.all([
      ...(input.knownActorContext ?? [])
        .filter(item => !item.ownerId)
        .map(item => this.issue('actor', item.referenceId, plain({ canonicalName: item.canonicalName, aliases: item.aliases, status: item.status }), item.referenceId, false)),
      ...(input.knownLocationContext ?? [])
        .filter(item => !item.locationId)
        .map(item => this.issue('location', item.referenceId, plain({ canonicalName: item.canonicalName, aliases: item.aliases, status: item.status }), item.referenceId, false)),
    ]);
  }

  async executeBatch(calls: readonly NormalizedToolCall[], context: AgentToolContext): Promise<readonly NormalizedToolResult[]> {
    assertNotAborted(context.signal);
    this.bindScope(context);
    if (calls.length < 1 || calls.length > MAX_CALLS_PER_ROUND) {
      throw createSSHelperError('LLM_TOOL_CALL_LIMIT_EXCEEDED', { stage: 'memory.agent.tool.batch' });
    }
    await this.seedPrefetchedReferences();
    const validated = calls.map(call => this.validate(call, context));
    const unique = new Map<string, Promise<ToolResultEnvelope>>();
    const results = await Promise.all(validated.map(async ({ call, name }) => {
      const key = `${name}\0${JSON.stringify(call.arguments)}`;
      let operation = unique.get(key);
      if (!operation) {
        operation = this.executeOne(call, name, context);
        unique.set(key, operation);
      }
      const envelope = await operation;
      return { callId: call.callId, name, ok: envelope.ok, content: { ...envelope, callId: call.callId } as PlainData } satisfies NormalizedToolResult;
    }));
    return results;
  }

  async verifyReadSet(ignoredStages: readonly ExtractionStageKey[] = []): Promise<{ readonly valid: boolean; readonly staleStages: readonly ExtractionStageKey[]; readonly staleEntries: readonly ToolReadSetEntry[] }> {
    if (!this.repository || this.#readSet.size === 0) return { valid: true, staleStages: [], staleEntries: [] };
    const current = await this.loadCurrentRecords();
    const staleStages = new Set<ExtractionStageKey>();
    const staleEntries: ToolReadSetEntry[] = [];
    for (const entry of this.#readSet.values()) {
      if (ignoredStages.includes(entry.stage)) continue;
      const value = current.get(`${entry.kind}:${entry.recordId}`);
      if (!value || revisionOf(value) !== entry.revision || await digest(this.safeSummary(entry.kind, value)) !== entry.contentDigest) {
        staleStages.add(entry.stage);
        staleEntries.push({ ...entry });
      }
    }
    return { valid: staleStages.size === 0, staleStages: [...staleStages], staleEntries };
  }

  private bindScope(context: AgentToolContext): void {
    const repositoryWorkspace = this.repository?.boundWorkspaceId ?? '';
    if (context.chatKey !== this.input.chatKey
      || (this.input.workspaceId && context.workspaceId !== this.input.workspaceId)
      || (repositoryWorkspace && context.workspaceId !== repositoryWorkspace)) {
      throw createSSHelperError('MEMORY_AGENT_TOOL_NOT_ALLOWED', { stage: 'memory.agent.tool.scope' });
    }
    const scope = { pipelineRunId: context.pipelineRunId, workspaceId: context.workspaceId, chatKey: context.chatKey, dataRevision: context.dataRevision };
    if (!this.#scope) { this.#scope = scope; return; }
    if (Object.entries(scope).some(([key, value]) => this.#scope?.[key as keyof GatewayScope] !== value)) {
      throw createSSHelperError('MEMORY_AGENT_TOOL_NOT_ALLOWED', { stage: 'memory.agent.tool.scope' });
    }
  }

  private validate(call: NormalizedToolCall, context: AgentToolContext): { call: NormalizedToolCall; name: AgentToolName } {
    const name = call.name as AgentToolName;
    if (!TOOL_NAMES.has(name) || !context.allowedTools.has(name)) {
      throw createSSHelperError('MEMORY_AGENT_TOOL_NOT_ALLOWED', { stage: 'memory.agent.tool.validate' });
    }
    if (!call.callId.trim()) throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: 'callId', keyword: 'minLength', expected: 'non-empty string' });
    const args = record(call.arguments);
    if (name === 'reference.get_details') {
      exactKeys(args, ['refs', 'fields']);
      for (const ref of stringList(args.refs, 'refs')) if (!this.#issued.has(ref)) {
        throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: 'refs', keyword: 'enum', expected: 'references issued in this pipeline' });
      }
      if (args.fields !== undefined) for (const field of stringList(args.fields, 'fields')) if (!DETAIL_FIELDS.has(field)) {
        throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: 'fields', keyword: 'enum', expected: 'safe detail fields' });
      }
      return { call, name };
    }
    if (name === 'entity.resolve_context' || name === 'inventory.resolve_context') {
      exactKeys(args, name === 'inventory.resolve_context' ? ['mentions', 'needs', 'category', 'limit'] : ['mentions', 'needs', 'limit']);
      stringList(args.mentions, 'mentions');
      enumStringList(args.needs, 'needs', name === 'entity.resolve_context' ? ['identity', 'aliases', 'presence', 'location'] : ['identity', 'current_state', 'recent_history', 'aliases'], 4);
      boundedLimit(args.limit);
      if (args.category !== undefined && (typeof args.category !== 'string' || args.category.length > 80)) throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: 'category', keyword: 'type', expected: 'string up to 80 characters; empty means no category filter' });
    } else if (name === 'scene.resolve_context') {
      exactKeys(args, ['query', 'needs', 'limit']);
      if (typeof args.query !== 'string' || !args.query.trim()) throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: 'query', keyword: 'type', expected: 'non-empty string' });
      enumStringList(args.needs, 'needs', ['current', 'recent', 'presence', 'transitions'], 4); boundedLimit(args.limit);
    } else {
      exactKeys(args, ['subject', 'predicate', 'object', 'content', 'needs', 'limit']);
      if (typeof args.subject !== 'string' || !args.subject.trim() || typeof args.predicate !== 'string' || !args.predicate.trim()) {
        throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: 'subject/predicate', keyword: 'type', expected: 'non-empty strings' });
      }
      for (const field of ['object', 'content']) if (args[field] !== undefined && (typeof args[field] !== 'string' || !args[field].trim())) throw createSSHelperError('MEMORY_AGENT_TOOL_ARGUMENT_INVALID', { stage: 'memory.agent.tool.validate', path: field, keyword: 'type', expected: 'non-empty string' });
      enumStringList(args.needs, 'needs', ['current', 'history', 'entity'], 3); boundedLimit(args.limit);
    }
    return { call, name };
  }

  private async executeOne(call: NormalizedToolCall, name: AgentToolName, context: AgentToolContext): Promise<ToolResultEnvelope> {
    const startedAt = Date.now();
    let detected = false;
    try {
      const query = this.query(name, record(call.arguments), context);
      const raw = await Promise.race([
        query,
        new Promise<never>((_, reject) => setTimeout(() => reject(createSSHelperError('MEMORY_AGENT_TOOL_TIMEOUT', { stage: 'memory.agent.tool.query' })), TOOL_TIMEOUT_MS)),
      ]);
      assertNotAborted(context.signal);
      const sanitized = sanitizeToolValue(raw.data);
      detected = sanitized.instructionLikeTextDetected;
      let data = plain(sanitized.value);
      let truncated = raw.truncated;
      if (JSON.stringify(data).length > MAX_CHARS) {
        data = plain({ items: Array.isArray(record(data).items) ? (record(data).items as unknown[]).slice(0, 10) : [], contentTruncated: true });
        truncated = true;
      }
      const readSet = raw.refs.flatMap(ref => {
        const remembered = this.rememberRead(ref, context.stage);
        return remembered ? [remembered] : [];
      });
      const envelope: ToolResultEnvelope = {
        ok: true, tool: name, callId: call.callId,
        contextOnly: true, evidenceAllowed: false, trust: 'stored_user_data', instructionsAllowed: false,
        dataRevision: context.dataRevision,
        readSet: readSet.map(({ recordId: _recordId, stage: _stage, ...entry }) => entry),
        truncated,
        ...(raw.nextCursor ? { nextCursor: raw.nextCursor } : {}),
        data,
      };
      const resultCount = Array.isArray(record(data).items) ? (record(data).items as unknown[]).length : 0;
      this.#audits.push({ pipelineRunId: context.pipelineRunId, stage: context.stage, ...(context.requestId ? { requestId: context.requestId } : {}), ...(context.toolSessionRound === undefined ? {} : { toolSessionRound: context.toolSessionRound }), callId: call.callId, tool: name, ok: true, latencyMs: Date.now() - startedAt, readCount: readSet.length, resultCount, truncated, instructionLikeTextDetected: detected, parameterSummary: parameterSummary(record(call.arguments)) });
      return envelope;
    } catch (error) {
      const failure = readSSHelperFailure(error, { reasonCode: 'INTERNAL_ERROR', stage: 'memory.agent.tool.query' })!;
      this.#audits.push({ pipelineRunId: context.pipelineRunId, stage: context.stage, ...(context.requestId ? { requestId: context.requestId } : {}), ...(context.toolSessionRound === undefined ? {} : { toolSessionRound: context.toolSessionRound }), callId: call.callId, tool: name, ok: false, latencyMs: Date.now() - startedAt, readCount: 0, resultCount: 0, truncated: false, instructionLikeTextDetected: detected, reasonCode: failure.reasonCode, parameterSummary: parameterSummary(record(call.arguments)) });
      return {
        ok: false, tool: name, callId: call.callId,
        contextOnly: true, evidenceAllowed: false, trust: 'stored_user_data', instructionsAllowed: false,
        dataRevision: context.dataRevision, readSet: [], truncated: false,
        failure: { reasonCode: failure.reasonCode, message: '只读查询未返回可用结果。' },
      };
    }
  }

  private async query(name: AgentToolName, args: Record<string, unknown>, context: AgentToolContext): Promise<{ data: PlainData; refs: IssuedReference[]; truncated: boolean; nextCursor?: string }> {
    assertNotAborted(context.signal);
    if (name === 'reference.get_details') {
      const refs = stringList(args.refs, 'refs').map(ref => this.#issued.get(ref)!);
      const fields = args.fields === undefined ? undefined : stringList(args.fields, 'fields');
      return { data: { items: refs.map(item => fields ? plain({ ref: item.ref, ...Object.fromEntries(fields.filter(field => field in record(item.value)).map(field => [field, record(item.value)[field]])) }) : item.value) }, refs, truncated: false };
    }
    if (name === 'entity.resolve_context') return this.queryEntities(stringList(args.mentions, 'mentions'), enumStringList(args.needs, 'needs', ['identity', 'aliases', 'presence', 'location'], 4), boundedLimit(args.limit));
    if (name === 'scene.resolve_context') return this.queryScenes(String(args.query), enumStringList(args.needs, 'needs', ['current', 'recent', 'presence', 'transitions'], 4), boundedLimit(args.limit));
    if (name === 'inventory.resolve_context') return this.queryInventory(stringList(args.mentions, 'mentions'), enumStringList(args.needs, 'needs', ['identity', 'current_state', 'recent_history', 'aliases'], 4), boundedLimit(args.limit), typeof args.category === 'string' ? args.category : undefined);
    return this.queryMemory(String(args.subject), String(args.predicate), enumStringList(args.needs, 'needs', ['current', 'history', 'entity'], 3), boundedLimit(args.limit), typeof args.object === 'string' ? args.object : undefined, typeof args.content === 'string' ? args.content : undefined);
  }

  private async queryEntities(mentions: readonly string[], needs: readonly string[], limit: number) {
    const wanted = mentions.map(normalized);
    const owners = this.repository ? await this.repository.listOwners() : [];
    const locations = this.repository ? await this.repository.listLocations() : [];
    const candidates = [
      ...(this.input.knownActorContext ?? []).map(item => ({ kind: 'actor' as const, id: item.ownerId ?? item.referenceId, preferredRef: item.referenceId, tracked: Boolean(item.ownerId), value: { canonicalName: item.canonicalName, aliases: item.aliases, status: item.status } })),
      ...owners.map(item => ({ kind: 'actor' as const, id: item.id, tracked: true, value: { canonicalName: item.canonicalName ?? item.displayName, aliases: item.aliases ?? [], status: item.status, updatedAt: item.updatedAt } })),
      ...(this.input.knownLocationContext ?? []).map(item => ({ kind: 'location' as const, id: item.locationId ?? item.referenceId, preferredRef: item.referenceId, tracked: Boolean(item.locationId), value: { canonicalName: item.canonicalName, aliases: item.aliases, status: item.status } })),
      ...locations.map(item => ({ kind: 'location' as const, id: item.id, tracked: true, value: { canonicalName: item.canonicalName, aliases: item.aliases ?? [], status: item.status, updatedAt: item.updatedAt } })),
    ].filter(item => [normalized(item.value.canonicalName), ...(item.value.aliases as string[]).map(normalized)].some(name => wanted.includes(name)))
      .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
    const selected = candidates.slice(0, limit);
    const refs = await Promise.all(selected.map(item => this.issue(item.kind, item.id, item.value, 'preferredRef' in item && typeof item.preferredRef === 'string' ? item.preferredRef : undefined, item.tracked)));
    const fields = [...new Set(needs.flatMap(need => need === 'identity' ? ['canonicalName', 'status'] : need === 'aliases' ? ['aliases'] : need === 'presence' ? ['status'] : []))];
    return { data: { items: refs.map(item => project(item.value, fields)) }, refs, truncated: candidates.length > selected.length };
  }

  private async queryScenes(query: string, needs: readonly string[], limit: number) {
    const states = this.repository ? await this.repository.listSceneStates() : [];
    const selected = states.filter(item => !query.trim() || normalized(JSON.stringify(item)).includes(normalized(query))).sort((a, b) => Number(b.updatedAtFloor) - Number(a.updatedAtFloor) || a.id.localeCompare(b.id)).slice(0, limit);
    const refs = await Promise.all(selected.map(item => this.issue('scene', item.id, this.safeSummary('scene', record(item)))));
    const fields = [...new Set(needs.flatMap(need => need === 'presence' ? ['presentOwnerIds'] : ['sceneId', 'locationId', 'presentOwnerIds', 'updatedAtFloor', 'revision']))];
    return { data: { items: refs.map(item => project(item.value, fields)) }, refs, truncated: states.length > selected.length };
  }

  private async queryInventory(mentions: readonly string[], needs: readonly string[], limit: number, category?: string) {
    const wanted = mentions.map(normalized);
    const [items, states, events] = this.repository ? await Promise.all([this.repository.listInventoryItems(), this.repository.listInventoryStates(), this.repository.listInventoryEvents()]) : [[], [], []];
    const known = (this.input.knownInventoryContext ?? []).map(item => ({ id: item.itemId ?? item.referenceId, preferredRef: item.referenceId, tracked: Boolean(item.itemId), canonicalName: item.canonicalName, aliases: item.aliases, category: item.category, states: item.states }));
    const merged = [...known, ...items.map(item => ({ id: item.id, tracked: true, canonicalName: item.canonicalName, aliases: item.aliases ?? [], category: item.category, states: states.filter(state => state.itemId === item.id), history: events.filter(event => event.itemId === item.id).slice(-20) }))]
      .filter(item => [normalized(item.canonicalName), ...item.aliases.map(normalized)].some(name => wanted.includes(name)) && (!category || normalized(item.category) === normalized(category)))
      .sort((a, b) => a.id.localeCompare(b.id));
    const selected = merged.slice(0, limit);
    const refs = await Promise.all(selected.map(item => this.issue('inventory', item.id, this.safeSummary('inventory', record(item)), 'preferredRef' in item ? item.preferredRef : undefined, item.tracked)));
    const fields = [...new Set(needs.flatMap(need => need === 'identity' ? ['canonicalName', 'category'] : need === 'aliases' ? ['aliases'] : need === 'current_state' ? ['states'] : need === 'recent_history' ? ['history'] : []))];
    return { data: { items: refs.map(item => project(item.value, fields)) }, refs, truncated: merged.length > selected.length };
  }

  private async queryMemory(subject: string, predicate: string, needs: readonly string[], limit: number, object?: string, content?: string) {
    const facts = this.repository ? await this.repository.listFacts() : [];
    const existing = (this.input.existingMemoryContext ?? []).map(item => ({ id: item.factId ?? item.referenceId, tracked: Boolean(item.factId), ...item }));
    const candidates = [...existing, ...facts].filter(item => normalized(item.subjectKey) === normalized(subject)
      && (!predicate.trim() || normalized(item.predicateKey) === normalized(predicate))
      && (!object || normalized(record(item).objectKey) === normalized(object))
      && (!content || normalized(record(item).content).includes(normalized(content))))
      .sort((a, b) => Number(record(b).updatedAt ?? record(b).validFrom ?? 0) - Number(record(a).updatedAt ?? record(a).validFrom ?? 0) || a.id.localeCompare(b.id));
    const selected = candidates.slice(0, limit);
    const refs = await Promise.all(selected.map(item => this.issue('fact', item.id, this.safeSummary('fact', record(item)), String(record(item).referenceId ?? '') || undefined, Boolean(record(item).tracked ?? true))));
    const fields = [...new Set(needs.flatMap(need => need === 'entity' ? ['subjectKey', 'objectKey'] : ['kind', 'subjectKey', 'predicateKey', 'objectKey', 'content', 'status', 'validFrom', 'validUntil', 'revision']))];
    return { data: { items: refs.map(item => project(item.value, fields)) }, refs, truncated: candidates.length > selected.length };
  }

  private safeSummary(kind: ToolReadSetEntry['kind'], value: Record<string, unknown>): PlainData {
    if (kind === 'actor') return plain({ canonicalName: value.canonicalName ?? value.displayName, aliases: value.aliases ?? [], status: value.status });
    if (kind === 'location') return plain({ canonicalName: value.canonicalName, aliases: value.aliases ?? [], status: value.status });
    if (kind === 'inventory') return plain({ canonicalName: value.canonicalName, aliases: value.aliases ?? [], category: value.category, states: value.states ?? [], history: value.history ?? [] });
    if (kind === 'scene') return plain({ sceneId: value.sceneId ?? value.id, locationId: value.locationId, presentOwnerIds: value.presentOwnerIds ?? [], updatedAtFloor: value.updatedAtFloor, revision: value.revision });
    return plain({ kind: value.kind, subjectKey: value.subjectKey, predicateKey: value.predicateKey, objectKey: value.objectKey, content: value.content, status: value.status, validFrom: value.validFrom, validUntil: value.validUntil, revision: value.revision });
  }

  private async issue(kind: IssuedReference['kind'], recordId: string, raw: PlainData, preferredRef?: string, tracked = true): Promise<IssuedReference> {
    const key = `${kind}:${recordId}`;
    const existingRef = this.#refByRecord.get(key);
    if (existingRef) {
      const existing = this.#issued.get(existingRef)!;
      if (!tracked || existing.tracked) return existing;
      const summary = record(raw);
      const safe = this.safeSummary(kind, summary);
      const upgraded: IssuedReference = { kind, recordId, ref: existing.ref, revision: revisionOf(summary), contentDigest: await digest(safe), value: plain({ ref: existing.ref, ...record(safe) }), tracked: true };
      this.#issued.set(existing.ref, upgraded);
      return upgraded;
    }
    const prefix = kind === 'actor' ? 'A' : kind === 'location' ? 'L' : kind === 'inventory' ? 'O' : kind === 'fact' ? 'F' : 'S';
    let ref = '';
    const canKeepPreferredRef = preferredRef
      && (/^[ALOSF]\d{1,4}$/u.test(preferredRef) || (!tracked && /^[A-Za-z0-9_.:-]{1,80}$/u.test(preferredRef)));
    if (canKeepPreferredRef && !this.#issued.has(preferredRef)) {
      ref = preferredRef;
      this.#counters[kind] = Math.max(this.#counters[kind], Number(preferredRef.slice(1)) || 0);
    } else {
      do ref = `${prefix}${String(++this.#counters[kind]).padStart(2, '0')}`;
      while (this.#issued.has(ref));
    }
    const summary = record(raw);
    const safe = this.safeSummary(kind, summary);
    const value = plain({ ref, ...record(safe) });
    const issued: IssuedReference = { kind, recordId, ref, revision: revisionOf(summary), contentDigest: await digest(safe), value, tracked };
    this.#issued.set(ref, issued); this.#refByRecord.set(key, ref);
    return issued;
  }

  private rememberRead(issued: IssuedReference, stage: ExtractionStageKey): ToolReadSetEntry | undefined {
    if (!issued.tracked) return undefined;
    const entry = { kind: issued.kind, ref: issued.ref, recordId: issued.recordId, revision: issued.revision, contentDigest: issued.contentDigest, stage } satisfies ToolReadSetEntry;
    this.#readSet.set(`${stage}:${issued.kind}:${issued.recordId}`, entry);
    return entry;
  }

  private async seedPrefetchedReferences(): Promise<void> {
    if (this.#prefetchedSeeded) return;
    this.#prefetchedSeeded = true;
    await Promise.all([
      ...(this.input.knownActorContext ?? []).map(item => this.issue('actor', item.ownerId ?? item.referenceId, plain({ canonicalName: item.canonicalName, aliases: item.aliases, status: item.status, revision: item.recordRevision }), item.referenceId, Boolean(item.ownerId && item.recordRevision !== undefined))),
      ...(this.input.knownLocationContext ?? []).map(item => this.issue('location', item.locationId ?? item.referenceId, plain({ canonicalName: item.canonicalName, aliases: item.aliases, status: item.status, revision: item.recordRevision }), item.referenceId, Boolean(item.locationId && item.recordRevision !== undefined))),
      ...(this.input.knownInventoryContext ?? []).map(item => this.issue('inventory', item.itemId ?? item.referenceId, plain({ canonicalName: item.canonicalName, aliases: item.aliases, category: item.category, states: item.states, revision: item.recordRevision }), item.referenceId, Boolean(item.itemId && item.recordRevision !== undefined))),
      ...(this.input.existingMemoryContext ?? []).map(item => this.issue('fact', item.factId ?? item.referenceId, plain({ ...item, revision: item.recordRevision }), item.referenceId, Boolean(item.factId && item.recordRevision !== undefined))),
    ]);
  }

  private async loadCurrentRecords(): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>();
    if (!this.repository) return map;
    const [owners, locations, items, states, events, facts, scenes] = await Promise.all([
      this.repository.listOwners(), this.repository.listLocations(), this.repository.listInventoryItems(),
      this.repository.listInventoryStates(), this.repository.listInventoryEvents(), this.repository.listFacts(), this.repository.listSceneStates(),
    ]);
    for (const item of owners) map.set(`actor:${item.id}`, record(item));
    for (const item of locations) map.set(`location:${item.id}`, record(item));
    for (const item of items) map.set(`inventory:${item.id}`, record({ ...item, states: states.filter(state => state.itemId === item.id), history: events.filter(event => event.itemId === item.id).slice(-20) }));
    for (const item of facts) map.set(`fact:${item.id}`, record(item));
    for (const item of scenes) map.set(`scene:${item.id}`, record(item));
    return map;
  }
}
