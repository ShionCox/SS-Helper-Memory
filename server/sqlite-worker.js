import { parentPort, workerData } from 'node:worker_threads';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import { BUSINESS_TABLES, migrateDatabase, PROTOCOL_VERSION, SCHEMA_VERSION } from './schema.js';
import packageMetadata from './package.json' with { type: 'json' };

const SERVER_VERSION = packageMetadata.version;
const MAX_QUERY_LIMIT = 10_000;
const MAX_DEDUP_ROWS = 10_000;
const DEDUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const STATUS_CACHE_MS = 5_000;
const dbPath = path.resolve(workerData.dbPath);
let db;
let lastError = null;
const statusCache = new Map();
const importMarkerPath = `${dbPath}.import-marker.json`;
const previousBackupPath = `${dbPath}.before-import`;
const ACTIVE_CONFIDENCE_THRESHOLD = 0.75;
const FACT_STATUSES = new Set(['active', 'pending', 'superseded', 'invalid']);

function fail(message, code = 'INVALID_REQUEST') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} 必须是非空字符串。`);
  return value.trim();
}

function integer(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) fail(`${name} 必须是大于等于 ${minimum} 的整数。`);
  return value;
}

function object(value, name = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} 必须是对象。`);
  return value;
}

function json(value) {
  return JSON.stringify(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashText(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function factEmbeddingText(fact) {
  return [
    `类型：${fact.kind}`,
    `主体：${fact.subjectKey}`,
    `谓词：${fact.predicateKey}`,
    fact.objectKey ? `对象：${fact.objectKey}` : '',
    Array.isArray(fact.entityKeys) && fact.entityKeys.length > 0 ? `实体：${fact.entityKeys.join('、')}` : '',
    `事实：${fact.content}`,
  ].filter(Boolean).join('\n');
}

function parsePayload(row) {
  return row ? JSON.parse(row.payload_json) : undefined;
}

function assertExistingChat(table, idColumn, id, chatKey, label) {
  const existing = db.prepare(`SELECT chat_key FROM ${table} WHERE ${idColumn} = ?`).get(id);
  if (existing && existing.chat_key !== chatKey) fail(`${label} 不能从其他聊天移动到当前聊天。`, 'CROSS_CHAT');
}

function assertFactOwner(factId, chatKey, label = '记录') {
  const owner = db.prepare('SELECT chat_key FROM facts WHERE id = ?').get(factId);
  if (!owner) fail(`${label} 引用的事实不存在：${factId}`, 'NOT_FOUND');
  if (owner.chat_key !== chatKey) fail(`${label} 与事实不属于同一聊天。`, 'CROSS_CHAT');
}

function assertJobOwner(jobId, chatKey, label = '记录') {
  const owner = db.prepare('SELECT chat_key FROM jobs WHERE id = ?').get(jobId);
  if (!owner) fail(`${label} 引用的任务不存在：${jobId}`, 'NOT_FOUND');
  if (owner.chat_key !== chatKey) fail(`${label} 与任务不属于同一聊天。`, 'CROSS_CHAT');
}

function rowsToPayload(rows) {
  return rows.map(parsePayload);
}

function normalizeKeyPart(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function expectedCanonicalKey(fact) {
  return [fact.subjectKey, fact.predicateKey, fact.objectKey].map(normalizeKeyPart).join('::');
}

function expectedSlotKey(fact) {
  return [fact.subjectKey, fact.predicateKey].map(normalizeKeyPart).join('::');
}

function assertFactShape(fact) {
  object(fact, 'fact');
  text(fact.id, 'fact.id');
  text(fact.chatKey, 'fact.chatKey');
  text(fact.subjectKey, 'fact.subjectKey');
  text(fact.predicateKey, 'fact.predicateKey');
  text(fact.content, 'fact.content');
  if (fact.canonicalKey !== expectedCanonicalKey(fact)) fail(`事实 ${fact.id} canonicalKey 与结构化字段不一致。`, 'INVALID_FACT');
  if (fact.slotKey !== expectedSlotKey(fact)) fail(`事实 ${fact.id} slotKey 与结构化字段不一致。`, 'INVALID_FACT');
  if (!FACT_STATUSES.has(fact.status)) fail(`事实 ${fact.id} status 非法。`, 'INVALID_FACT');
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) fail(`事实 ${fact.id} confidence 非法。`, 'INVALID_FACT');
  if (fact.origin === 'automatic' && fact.status === 'active' && fact.confidence < ACTIVE_CONFIDENCE_THRESHOLD) {
    fail(`自动事实 ${fact.id} 置信度不足，不能保持 active。`, 'INVALID_FACT');
  }
  if (!Number.isInteger(fact.revision) || fact.revision < 1) fail(`事实 ${fact.id} revision 非法。`, 'INVALID_FACT');
}

function validateFactGraph(chatKey, incomingFacts, incomingEvidence = [], deletedFactIds = []) {
  const finalFacts = new Map(rowsToPayload(db.prepare('SELECT payload_json FROM facts WHERE chat_key = ?').all(chatKey)).map(fact => [fact.id, fact]));
  const incomingIds = new Set();
  for (const fact of incomingFacts) {
    assertFactShape(fact);
    if (fact.chatKey !== chatKey) fail('事实图不能跨聊天。', 'CROSS_CHAT');
    if (incomingIds.has(fact.id)) fail(`事实 ${fact.id} 在同一事务中重复。`, 'INVALID_FACT');
    incomingIds.add(fact.id);
    finalFacts.set(fact.id, fact);
  }
  for (const factIdValue of deletedFactIds) {
    const factId = text(factIdValue, 'deletedFactIds[]');
    if (incomingIds.has(factId)) fail(`事实 ${factId} 不能在同一事务中同时写入和删除。`, 'INVALID_FACT');
    const owner = db.prepare('SELECT chat_key FROM facts WHERE id = ?').get(factId);
    if (owner && owner.chat_key !== chatKey) fail(`不能删除其他聊天的事实 ${factId}。`, 'CROSS_CHAT');
    finalFacts.delete(factId);
  }
  const incomingEvidenceById = new Map();
  for (const item of incomingEvidence) {
    object(item, 'evidence');
    text(item.id, 'evidence.id');
    text(item.factId, 'evidence.factId');
    if (item.chatKey !== chatKey) fail('证据与事实图不属于同一聊天。', 'CROSS_CHAT');
    const owner = finalFacts.get(item.factId);
    if (!owner) fail(`证据 ${item.id} 引用了不存在的事实。`, 'INVALID_EVIDENCE');
    if (incomingEvidenceById.has(item.id)) fail(`证据 ${item.id} 在同一事务中重复。`, 'INVALID_EVIDENCE');
    incomingEvidenceById.set(item.id, item);
  }
  for (const fact of incomingFacts) {
    const evidenceIds = Array.isArray(fact.evidenceIds) ? fact.evidenceIds : [];
    if (fact.origin === 'automatic' && fact.status === 'active' && evidenceIds.length === 0) {
      fail(`自动 active 事实 ${fact.id} 缺少证据。`, 'INVALID_EVIDENCE');
    }
    for (const evidenceId of evidenceIds) {
      const incoming = incomingEvidenceById.get(evidenceId);
      if (incoming && incoming.factId === fact.id && incoming.chatKey === chatKey) continue;
      const stored = db.prepare('SELECT fact_id, chat_key FROM evidence WHERE id = ?').get(evidenceId);
      if (!stored || stored.fact_id !== fact.id || stored.chat_key !== chatKey) {
        fail(`事实 ${fact.id} 的证据 ${evidenceId} 归属无效。`, 'INVALID_EVIDENCE');
      }
    }
  }
  const currentFactBySlot = new Map();
  for (const fact of finalFacts.values()) {
    if (fact.status !== 'active' && fact.status !== 'pending') continue;
    const slotKey = typeof fact.slotKey === 'string' ? fact.slotKey.trim() : '';
    if (!slotKey) fail(`当前事实 ${fact.id} 缺少 slotKey。`, 'INVALID_FACT_GRAPH');
    const existingFactId = currentFactBySlot.get(slotKey);
    if (existingFactId && existingFactId !== fact.id) {
      fail(`事实槽位 ${slotKey} 同时存在多个当前事实：${existingFactId}、${fact.id}。`, 'INVALID_FACT_GRAPH');
    }
    currentFactBySlot.set(slotKey, fact.id);
  }
  for (const fact of finalFacts.values()) {
    if (fact.status === 'superseded' && !fact.supersededById) fail(`事实 ${fact.id} 标记为 superseded 但缺少 supersededById。`, 'INVALID_FACT_GRAPH');
    if (fact.supersededById && fact.status !== 'superseded') fail(`事实 ${fact.id} 存在 supersededById 但状态不是 superseded。`, 'INVALID_FACT_GRAPH');
    if (fact.supersedesId === fact.id || fact.supersededById === fact.id) fail(`事实 ${fact.id} 的替代链形成自环。`, 'INVALID_FACT_GRAPH');
    if (fact.supersedesId) {
      const previous = finalFacts.get(fact.supersedesId);
      if (!previous || previous.supersededById !== fact.id) fail(`事实 ${fact.id} 的 supersedes 链不是双向一致。`, 'INVALID_FACT_GRAPH');
    }
    if (fact.supersededById) {
      const next = finalFacts.get(fact.supersededById);
      if (!next || next.supersedesId !== fact.id) fail(`事实 ${fact.id} 的 supersededBy 链不是双向一致。`, 'INVALID_FACT_GRAPH');
    }
    const visited = new Set([fact.id]);
    let cursor = fact;
    while (cursor.supersedesId) {
      if (visited.has(cursor.supersedesId)) fail(`事实 ${fact.id} 的替代链形成环。`, 'INVALID_FACT_GRAPH');
      visited.add(cursor.supersedesId);
      cursor = finalFacts.get(cursor.supersedesId);
      if (!cursor) break;
    }
  }
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

const REQUIRED_COLUMNS = Object.freeze({
  facts: ['id', 'chat_key', 'canonical_key', 'content', 'status', 'supersedes_id', 'superseded_by_id', 'payload_json'],
  evidence: ['id', 'fact_id', 'chat_key', 'payload_json'],
  jobs: ['id', 'chat_key', 'status', 'payload_json'],
  settings: ['id', 'namespace', 'key', 'payload_json'],
  recall_logs: ['id', 'chat_key', 'created_at', 'payload_json'],
  job_batch_audits: ['id', 'chat_key', 'job_id', 'batch_index', 'payload_json'],
  main_chat_usage: ['id', 'chat_key', 'message_id', 'payload_json'],
  batch_snapshots: ['id', 'chat_key', 'job_id', 'batch_index', 'payload_json'],
  fact_vectors: ['fact_id', 'chat_key', 'dimensions', 'vector'],
  schema_migrations: ['version', 'applied_at'],
  request_dedup: ['request_id', 'action', 'response_json', 'created_at'],
  metadata: ['key', 'value', 'updated_at'],
});

function validateCandidate(candidate) {
  const integrityRows = candidate.prepare('PRAGMA integrity_check').all();
  if (integrityRows.length !== 1 || integrityRows[0].integrity_check !== 'ok') fail('SQLite 备份完整性检查失败。');
  const foreignKeys = candidate.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length > 0) fail('SQLite 备份存在外键损坏。');
  const tables = new Set(candidate.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of [...BUSINESS_TABLES, 'schema_migrations', 'request_dedup', 'metadata']) {
    if (!tables.has(table)) fail(`SQLite 备份缺少表：${table}`);
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(candidate.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const column of required) if (!columns.has(column)) fail(`SQLite 备份的 ${table} 缺少关键列：${column}`);
  }
  const metadataVersion = candidate.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value;
  const migrationVersion = Number(candidate.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version);
  if (String(metadataVersion) !== String(SCHEMA_VERSION) || migrationVersion !== SCHEMA_VERSION) {
    fail(`SQLite 备份 schema 版本必须为 ${SCHEMA_VERSION}。`, 'SCHEMA_MISMATCH');
  }
}

async function recoverInterruptedImport() {
  if (!await exists(importMarkerPath)) return;
  let marker = {};
  try { marker = JSON.parse(await readFile(importMarkerPath, 'utf8')); } catch { /* 使用保守恢复。 */ }
  const previous = previousBackupPath;
  const temp = typeof marker.temp === 'string' && path.dirname(marker.temp) === path.dirname(dbPath) ? marker.temp : null;
  const currentExists = await exists(dbPath);
  const previousExists = await exists(previous);
  if (!currentExists && previousExists) await rename(previous, dbPath);
  else if (currentExists && marker.stage === 'installed') {
    let candidate;
    try {
      candidate = new DatabaseSync(dbPath, { readOnly: true });
      validateCandidate(candidate);
    } catch {
      candidate?.close(); candidate = null;
      if (previousExists) {
        await rm(dbPath, { force: true });
        await rename(previous, dbPath);
      }
    } finally { candidate?.close(); }
  }
  if (temp) await rm(temp, { force: true });
  await rm(previous, { force: true });
  await rm(importMarkerPath, { force: true });
}

function openDatabase() {
  db = new DatabaseSync(dbPath);
  migrateDatabase(db);
}

async function initialize() {
  await mkdir(path.dirname(dbPath), { recursive: true });
  await recoverInterruptedImport();
  openDatabase();
}

function upsertFact(fact) {
  object(fact, 'fact');
  text(fact.id, 'fact.id');
  text(fact.chatKey, 'fact.chatKey');
  text(fact.canonicalKey, 'fact.canonicalKey');
  text(fact.content, 'fact.content');
  assertExistingChat('facts', 'id', fact.id, fact.chatKey, '事实');
  for (const linkedId of [fact.supersedesId, fact.supersededById].filter(Boolean)) {
    const linked = db.prepare('SELECT chat_key FROM facts WHERE id = ?').get(linkedId);
    if (linked && linked.chat_key !== fact.chatKey) fail('事实替代链不能跨聊天。', 'CROSS_CHAT');
  }
  const inbound = db.prepare('SELECT chat_key FROM facts WHERE supersedes_id = ? OR superseded_by_id = ?').all(fact.id, fact.id);
  if (inbound.some(row => row.chat_key !== fact.chatKey)) fail('事实替代链不能跨聊天。', 'CROSS_CHAT');
  db.prepare(`
    INSERT INTO facts(
      id, chat_key, kind, subject_key, predicate_key, object_key, canonical_key, slot_key,
      content, confidence, status, freshest_evidence_at, valid_from, valid_until, origin,
      revision, supersedes_id, superseded_by_id, created_at, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      chat_key=excluded.chat_key, kind=excluded.kind, subject_key=excluded.subject_key,
      predicate_key=excluded.predicate_key, object_key=excluded.object_key,
      canonical_key=excluded.canonical_key, slot_key=excluded.slot_key, content=excluded.content,
      confidence=excluded.confidence, status=excluded.status,
      freshest_evidence_at=excluded.freshest_evidence_at, valid_from=excluded.valid_from,
      valid_until=excluded.valid_until, origin=excluded.origin, revision=excluded.revision,
      supersedes_id=excluded.supersedes_id, superseded_by_id=excluded.superseded_by_id,
      updated_at=excluded.updated_at, payload_json=excluded.payload_json
  `).run(
    fact.id, fact.chatKey, fact.kind, fact.subjectKey, fact.predicateKey, fact.objectKey ?? null,
    fact.canonicalKey, fact.slotKey ?? null, fact.content, fact.confidence, fact.status,
    fact.freshestEvidenceAt, fact.validFrom ?? null, fact.validUntil ?? null, fact.origin,
    fact.revision, fact.supersedesId ?? null, fact.supersededById ?? null,
    fact.createdAt, fact.updatedAt, json(fact),
  );
  db.prepare('DELETE FROM fact_vectors WHERE fact_id = ? AND content_hash <> ?')
    .run(fact.id, hashText(factEmbeddingText(fact)));
}

function upsertEvidence(evidence) {
  object(evidence, 'evidence');
  text(evidence.id, 'evidence.id');
  text(evidence.factId, 'evidence.factId');
  text(evidence.chatKey, 'evidence.chatKey');
  assertExistingChat('evidence', 'id', evidence.id, evidence.chatKey, '证据');
  assertFactOwner(evidence.factId, evidence.chatKey, '证据');
  db.prepare(`
    INSERT INTO evidence(id, fact_id, chat_key, source_ref, source_type, occurred_at, created_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET fact_id=excluded.fact_id, chat_key=excluded.chat_key,
      source_ref=excluded.source_ref, source_type=excluded.source_type,
      occurred_at=excluded.occurred_at, payload_json=excluded.payload_json
  `).run(evidence.id, evidence.factId, evidence.chatKey, evidence.sourceRef, evidence.sourceType,
    evidence.occurredAt, evidence.createdAt, json(evidence));
}

function putJob(job) {
  object(job, 'job');
  text(job.id, 'job.id');
  text(job.chatKey, 'job.chatKey');
  assertExistingChat('jobs', 'id', job.id, job.chatKey, '任务');
  db.prepare(`
    INSERT INTO jobs(id, chat_key, type, status, created_at, updated_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET chat_key=excluded.chat_key, type=excluded.type,
      status=excluded.status, updated_at=excluded.updated_at, payload_json=excluded.payload_json
  `).run(text(job.id, 'job.id'), text(job.chatKey, 'job.chatKey'), job.type, job.status,
    job.createdAt, job.updatedAt, json(job));
}

function putAudit(audit) {
  object(audit, 'audit');
  text(audit.id, 'audit.id');
  text(audit.chatKey, 'audit.chatKey');
  assertExistingChat('job_batch_audits', 'id', audit.id, audit.chatKey, '批次审计');
  assertJobOwner(text(audit.jobId, 'audit.jobId'), audit.chatKey, '批次审计');
  db.prepare(`
    INSERT INTO job_batch_audits(id, chat_key, job_id, batch_index, completed_at, request_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET completed_at=excluded.completed_at,
      request_id=excluded.request_id, payload_json=excluded.payload_json
  `).run(text(audit.id, 'audit.id'), text(audit.chatKey, 'audit.chatKey'), text(audit.jobId, 'audit.jobId'),
    integer(audit.batchIndex, 'audit.batchIndex'), audit.completedAt, audit.requestId ?? null, json(audit));
}

function putSnapshot(snapshot) {
  object(snapshot, 'snapshot');
  text(snapshot.id, 'snapshot.id');
  text(snapshot.chatKey, 'snapshot.chatKey');
  assertExistingChat('batch_snapshots', 'id', snapshot.id, snapshot.chatKey, '批次快照');
  assertJobOwner(text(snapshot.jobId, 'snapshot.jobId'), snapshot.chatKey, '批次快照');
  for (const state of snapshot.factStates ?? []) {
    text(state.id, 'snapshot.factStates.id');
    if (state.before && state.before.chatKey !== snapshot.chatKey) fail('快照包含其他聊天的事实。', 'CROSS_CHAT');
  }
  for (const state of snapshot.evidenceStates ?? []) {
    text(state.factId, 'snapshot.evidenceStates.factId');
    for (const evidence of state.before ?? []) {
      if (evidence.chatKey !== snapshot.chatKey || evidence.factId !== state.factId) {
        fail('快照包含其他聊天或无归属的证据。', 'CROSS_CHAT');
      }
    }
  }
  db.prepare(`
    INSERT INTO batch_snapshots(id, chat_key, job_id, batch_index, created_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(text(snapshot.id, 'snapshot.id'), text(snapshot.chatKey, 'snapshot.chatKey'),
    text(snapshot.jobId, 'snapshot.jobId'), integer(snapshot.batchIndex, 'snapshot.batchIndex'),
    snapshot.createdAt, json(snapshot));
}

function putRecallLog(log) {
  object(log, 'log');
  text(log.id, 'log.id');
  text(log.chatKey, 'log.chatKey');
  assertExistingChat('recall_logs', 'id', log.id, log.chatKey, '召回日志');
  db.prepare(`
    INSERT INTO recall_logs(id, chat_key, query, created_at, payload_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET query=excluded.query, created_at=excluded.created_at, payload_json=excluded.payload_json
  `).run(text(log.id, 'log.id'), text(log.chatKey, 'log.chatKey'), String(log.query ?? ''), log.createdAt, json(log));
}

function putUsage(usage) {
  object(usage, 'usage');
  text(usage.id, 'usage.id');
  text(usage.chatKey, 'usage.chatKey');
  assertExistingChat('main_chat_usage', 'id', usage.id, usage.chatKey, '聊天用量');
  db.prepare(`
    INSERT INTO main_chat_usage(id, chat_key, message_id, recall_log_id, captured_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET recall_log_id=excluded.recall_log_id,
      captured_at=excluded.captured_at, payload_json=excluded.payload_json
  `).run(text(usage.id, 'usage.id'), text(usage.chatKey, 'usage.chatKey'),
    text(usage.messageId, 'usage.messageId'), usage.recallLogId ?? null, usage.capturedAt, json(usage));
}

function putSetting(setting) {
  object(setting, 'setting');
  const now = setting.updatedAt ?? Date.now();
  const record = {
    id: setting.id ?? `stx_memory:${text(setting.key, 'setting.key')}`,
    namespace: setting.namespace ?? 'stx_memory',
    key: text(setting.key, 'setting.key'),
    value: setting.value,
    updatedAt: now,
  };
  db.prepare(`
    INSERT INTO settings(id, namespace, key, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET id=excluded.id, updated_at=excluded.updated_at, payload_json=excluded.payload_json
  `).run(record.id, record.namespace, record.key, record.updatedAt, json(record));
  return record;
}

function float32Buffer(values) {
  if (!Array.isArray(values) && !(values instanceof Float32Array)) fail('vector 必须是数值数组。');
  if (values.length === 0 || values.length > 65_536) fail('vector 维度必须介于 1 和 65536。');
  const floats = Float32Array.from(values);
  for (const value of floats) if (!Number.isFinite(value)) fail('vector 不能包含 NaN 或 Infinity。');
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function upsertVector(input) {
  object(input, 'vector payload');
  const blob = float32Buffer(input.vector);
  const dimensions = blob.byteLength / Float32Array.BYTES_PER_ELEMENT;
  const factRow = db.prepare('SELECT chat_key, payload_json FROM facts WHERE id = ?').get(text(input.factId, 'factId'));
  if (!factRow) fail(`向量引用的事实不存在：${input.factId}`, 'NOT_FOUND');
  if (factRow.chat_key !== text(input.chatKey, 'chatKey')) fail('向量与事实不属于同一聊天。', 'CROSS_CHAT');
  assertExistingChat('fact_vectors', 'fact_id', input.factId, input.chatKey, '向量');
  const contentHash = hashText(factEmbeddingText(parsePayload(factRow)));
  if (input.contentHash && input.contentHash !== contentHash) fail('向量内容哈希与当前事实不一致。', 'STALE_VECTOR');
  const now = input.updatedAt ?? Date.now();
  db.prepare(`
    INSERT INTO fact_vectors(fact_id, chat_key, content_hash, resource_id, model, dimensions, vector, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET chat_key=excluded.chat_key, content_hash=excluded.content_hash,
      resource_id=excluded.resource_id, model=excluded.model, dimensions=excluded.dimensions,
      vector=excluded.vector, updated_at=excluded.updated_at
  `).run(input.factId, input.chatKey, contentHash,
    text(input.resourceId, 'resourceId'), text(input.model, 'model'), dimensions, blob,
    input.createdAt ?? now, now);
  return { ...input, vector: undefined, dimensions, createdAt: input.createdAt ?? now, updatedAt: now };
}

function tableCounts(chatKey) {
  const result = {};
  for (const table of BUSINESS_TABLES) {
    const column = table === 'settings' ? null : table === 'fact_vectors' ? 'chat_key' : 'chat_key';
    result[table] = chatKey && column
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(chatKey).count)
      : Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  }
  return result;
}

function tableBytes() {
  const result = Object.fromEntries(BUSINESS_TABLES.map(table => [table, null]));
  try {
    const rows = db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all();
    for (const row of rows) if (Object.hasOwn(result, row.name)) result[row.name] = Number(row.bytes);
  } catch {
    // SQLite 构建未启用 dbstat 时必须保持 null，不使用估算值冒充真实占用。
  }
  return result;
}

function vectorCoverage(chatKey, target = {}, eligibleOnly = false, includeIds = true) {
  const allFacts = rowsToPayload(db.prepare('SELECT payload_json FROM facts WHERE chat_key = ?').all(chatKey));
  const facts = eligibleOnly ? allFacts.filter(fact => fact.status === 'active') : allFacts;
  const vectors = new Map(db.prepare(`SELECT fact_id, content_hash, resource_id, model, dimensions
    FROM fact_vectors WHERE chat_key = ?`).all(chatKey).map(row => [row.fact_id, row]));
  const allFactIds = new Set(allFacts.map(fact => fact.id));
  const readyFactIds = [];
  const missingFactIds = [];
  const staleFactIds = [];
  for (const fact of facts) {
    const vector = vectors.get(fact.id);
    if (!vector) missingFactIds.push(fact.id);
    else if (
      vector.content_hash !== hashText(factEmbeddingText(fact))
      || (target.resourceId && vector.resource_id !== target.resourceId)
      || (target.model && vector.model !== target.model)
      || (target.dimensions && vector.dimensions !== target.dimensions)
    ) staleFactIds.push(fact.id);
    else readyFactIds.push(fact.id);
  }
  // superseded/pending 事实的向量仍服务历史状态查询，不能误报为孤儿。
  const orphanedFactIds = [...vectors.keys()].filter(id => !allFactIds.has(id));
  const total = facts.length;
  return {
    chatKey,
    totalFacts: total,
    ready: readyFactIds.length,
    missing: missingFactIds.length,
    stale: staleFactIds.length,
    orphaned: orphanedFactIds.length,
    coverage: total === 0 ? 0 : readyFactIds.length / total,
    indexedFacts: readyFactIds.length,
    eligibleFacts: total,
    ratio: total === 0 ? 0 : readyFactIds.length / total,
    readyFactIds: includeIds ? readyFactIds : [],
    missingFactIds: includeIds ? missingFactIds : [],
    staleFactIds: includeIds ? staleFactIds : [],
    orphanedFactIds: includeIds ? orphanedFactIds : [],
  };
}

async function status(chatKey) {
  const cacheKey = chatKey ?? '';
  const cached = statusCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= STATUS_CACHE_MS) return cached.value;
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  const walMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  const databaseSizeBytes = (await stat(dbPath).catch(() => ({ size: 0 }))).size;
  const value = {
    connected: true,
    serverVersion: SERVER_VERSION,
    nodeVersion: process.version,
    protocolVersion: PROTOCOL_VERSION,
    sqliteVersion,
    schemaVersion: SCHEMA_VERSION,
    databasePath: '_memory/memory.sqlite3',
    databaseSizeBytes,
    walMode,
    tableCounts: tableCounts(chatKey),
    tableBytes: tableBytes(),
    vectorCoverage: chatKey ? vectorCoverage(chatKey, {}, true, false) : null,
    lastError,
  };
  statusCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function boundedLimit(value, fallback = 500) {
  return Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.trunc(value ?? fallback)));
}

function queryRecords(table, where = '', params = [], order = '', limit = 500, offset = 0) {
  const sql = `SELECT payload_json FROM ${table}${where ? ` WHERE ${where}` : ''}${order ? ` ORDER BY ${order}` : ''} LIMIT ? OFFSET ?`;
  return rowsToPayload(db.prepare(sql).all(...params, boundedLimit(limit), Math.max(0, Math.trunc(offset ?? 0))));
}

function query(input) {
  object(input, 'query');
  const resource = text(input.resource, 'resource');
  const filters = input.filters && typeof input.filters === 'object' ? input.filters : {};
  const chatKey = input.chatKey;
  const limit = input.limit;
  const offset = input.offset;
  switch (resource) {
    case 'facts': {
      text(chatKey, 'chatKey');
      const clauses = ['chat_key = ?'];
      const params = [chatKey];
      if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
      if (filters.kind) { clauses.push('kind = ?'); params.push(filters.kind); }
      if (filters.query) {
        clauses.push('(content LIKE ? ESCAPE \'\\\' OR subject_key LIKE ? ESCAPE \'\\\' OR predicate_key LIKE ? ESCAPE \'\\\')');
        const escaped = String(filters.query).replace(/[\\%_]/g, '\\$&');
        params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
      }
      return queryRecords('facts', clauses.join(' AND '), params, 'updated_at DESC', limit, offset);
    }
    case 'fact': {
      const id = text(filters.id, 'filters.id');
      const key = text(chatKey, 'chatKey');
      return parsePayload(db.prepare('SELECT payload_json FROM facts WHERE id = ? AND chat_key = ?').get(id, key)) ?? null;
    }
    case 'evidence': {
      text(chatKey, 'chatKey');
      const clauses = ['chat_key = ?']; const params = [chatKey];
      if (filters.factId) { clauses.push('fact_id = ?'); params.push(filters.factId); }
      return queryRecords('evidence', clauses.join(' AND '), params, 'occurred_at DESC', limit, offset);
    }
    case 'jobs': return queryRecords('jobs', 'chat_key = ?', [text(chatKey, 'chatKey')], 'updated_at DESC', limit, offset);
    case 'job_batch_audits': {
      const clauses = ['chat_key = ?']; const params = [text(chatKey, 'chatKey')];
      if (filters.jobId) { clauses.push('job_id = ?'); params.push(filters.jobId); }
      return queryRecords('job_batch_audits', clauses.join(' AND '), params, 'completed_at DESC', limit, offset);
    }
    case 'main_chat_usage': return queryRecords('main_chat_usage', 'chat_key = ?', [text(chatKey, 'chatKey')], 'captured_at DESC', limit, offset);
    case 'settings': {
      const rows = queryRecords('settings', 'namespace = ?', [filters.namespace ?? 'stx_memory'], 'updated_at DESC', limit, offset);
      return filters.key ? rows.find(row => row.key === filters.key) ?? null : rows;
    }
    case 'recall_logs': return queryRecords('recall_logs', 'chat_key = ?', [text(chatKey, 'chatKey')], 'created_at DESC', limit, offset);
    case 'fact_vectors': {
      const key = text(chatKey, 'chatKey');
      const mapVector = row => ({
        factId: row.factId, chatKey: row.chatKey, contentHash: row.contentHash,
        resourceId: row.resourceId, model: row.model, dimensions: row.dimensions,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
      });
      if (filters.factId) {
        const row = db.prepare(`SELECT fact_id AS factId, chat_key AS chatKey, content_hash AS contentHash,
          resource_id AS resourceId, model, dimensions, created_at AS createdAt, updated_at AS updatedAt
          FROM fact_vectors WHERE fact_id = ? AND chat_key = ?`).get(filters.factId, key);
        return row ? mapVector(row) : null;
      }
      return db.prepare(`SELECT fact_id AS factId, chat_key AS chatKey, content_hash AS contentHash,
        resource_id AS resourceId, model, dimensions, created_at AS createdAt, updated_at AS updatedAt
        FROM fact_vectors WHERE chat_key = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(key, boundedLimit(limit), Math.max(0, Math.trunc(offset ?? 0))).map(mapVector);
    }
    case 'vector_coverage': return vectorCoverage(text(chatKey, 'chatKey'), filters.target ?? filters);
    case 'vector_rebuild': {
      const key = text(chatKey, 'chatKey');
      const coverage = vectorCoverage(key, filters.target ?? filters);
      const ids = [...coverage.missingFactIds, ...coverage.staleFactIds].slice(0, boundedLimit(limit, 32));
      if (ids.length === 0) return [];
      return ids.map(id => parsePayload(db.prepare('SELECT payload_json FROM facts WHERE id = ?').get(id)));
    }
    case 'chat_keys': return db.prepare('SELECT DISTINCT chat_key AS chatKey FROM facts ORDER BY chat_key').all().map(row => row.chatKey);
    case 'integrity': return integrity();
    default: fail(`不允许查询资源：${resource}`, 'NOT_ALLOWED');
  }
}

function integrity() {
  const rows = db.prepare('PRAGMA integrity_check').all();
  const messages = rows.map(row => row.integrity_check);
  return { ok: messages.length === 1 && messages[0] === 'ok', messages };
}

function captureBatchSnapshot(job, payload) {
  const batchIndex = integer(job.checkpoint?.batchIndex ?? 0, 'job.checkpoint.batchIndex');
  const id = `batch-snapshot:${job.id}:${batchIndex}`;
  if (db.prepare('SELECT 1 FROM batch_snapshots WHERE id = ?').get(id)) return;
  const affectedIds = new Set();
  for (const fact of payload.facts ?? []) {
    affectedIds.add(fact.id);
    if (fact.supersedesId) affectedIds.add(fact.supersedesId);
    if (fact.supersededById) affectedIds.add(fact.supersededById);
  }
  for (const item of payload.evidence ?? []) affectedIds.add(item.factId);
  for (const factId of payload.deletedFactIds ?? []) affectedIds.add(text(factId, 'deletedFactIds[]'));
  const factStates = [...affectedIds].sort().map(factId => ({
    id: factId,
    before: parsePayload(db.prepare('SELECT payload_json FROM facts WHERE id = ? AND chat_key = ?').get(factId, job.chatKey)) ?? null,
  }));
  const evidenceStates = [...affectedIds].sort().map(factId => ({
    factId,
    before: rowsToPayload(db.prepare('SELECT payload_json FROM evidence WHERE fact_id = ? AND chat_key = ? ORDER BY id').all(factId, job.chatKey)),
  }));
  putSnapshot({
    id,
    chatKey: job.chatKey,
    jobId: job.id,
    batchIndex,
    mode: 'inverse-v1',
    factStates,
    evidenceStates,
    createdAt: Date.now(),
  });
}

function assertIngestBase(payload, chatKey) {
  const revisions = payload.baseRevisions ?? {};
  if (revisions && typeof revisions !== 'object') fail('baseRevisions 必须是对象。');
  for (const [factId, expected] of Object.entries(revisions)) {
    const row = db.prepare('SELECT chat_key, revision FROM facts WHERE id = ?').get(factId);
    const matches = expected === null ? !row : row?.chat_key === chatKey && Number(row.revision) === Number(expected);
    if (!matches) fail(`事实 ${factId} 已被其他事务修改。`, 'REVISION_CONFLICT');
  }
  const slots = payload.baseSlotFactIds ?? {};
  if (slots && typeof slots !== 'object') fail('baseSlotFactIds 必须是对象。');
  for (const [slotKey, expectedId] of Object.entries(slots)) {
    const current = db.prepare(`SELECT id FROM facts WHERE chat_key = ? AND slot_key = ?
      AND status IN ('active','pending')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
        freshest_evidence_at DESC, updated_at DESC, id ASC LIMIT 1`).get(chatKey, slotKey)?.id ?? null;
    if (current !== expectedId) fail(`事实槽位 ${slotKey} 已被其他事务修改。`, 'REVISION_CONFLICT');
  }
  if (Array.isArray(payload.expectedFactIds)) {
    for (const factId of payload.expectedFactIds) {
      const row = db.prepare('SELECT chat_key FROM facts WHERE id = ?').get(factId);
      if (row?.chat_key !== chatKey) fail(`预期事实 ${factId} 已不存在或归属变化。`, 'REVISION_CONFLICT');
    }
  }
}

function assertFactUpsertBase(payload, chatKey) {
  const factId = text(payload.fact?.id, 'fact.id');
  const existing = db.prepare('SELECT chat_key, revision FROM facts WHERE id = ?').get(factId);
  if (existing) {
    if (existing.chat_key !== chatKey) fail('事实不能跨聊天修改。', 'CROSS_CHAT');
    if (!Number.isInteger(payload.expectedRevision)
      || Number(existing.revision) !== Number(payload.expectedRevision)) {
      fail(`事实 ${factId} 已被其他事务修改。`, 'REVISION_CONFLICT');
    }
  } else if (payload.expectedRevision !== undefined && payload.expectedRevision !== null) {
    fail(`事实 ${factId} 已不存在或归属变化。`, 'REVISION_CONFLICT');
  }

  if (!Object.prototype.hasOwnProperty.call(payload, 'expectedSlotFactId')) {
    fail('fact.upsert 必须提供 expectedSlotFactId。', 'REVISION_CONFLICT');
  }
  const slotKey = text(payload.fact?.slotKey, 'fact.slotKey');
  const currentSlotFactId = db.prepare(`SELECT id FROM facts WHERE chat_key = ? AND slot_key = ?
    AND status IN ('active','pending')
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
      freshest_evidence_at DESC, updated_at DESC, id ASC LIMIT 1`).get(chatKey, slotKey)?.id ?? null;
  if (currentSlotFactId !== payload.expectedSlotFactId) {
    fail(`事实槽位 ${slotKey} 已被其他事务修改。`, 'REVISION_CONFLICT');
  }

  const expectedRelated = payload.expectedRelatedRevisions ?? {};
  if (!expectedRelated || typeof expectedRelated !== 'object' || Array.isArray(expectedRelated)) {
    fail('expectedRelatedRevisions 必须是对象。');
  }
  for (const related of payload.relatedFacts ?? []) {
    const row = db.prepare('SELECT chat_key, revision FROM facts WHERE id = ?').get(related.id);
    const expected = expectedRelated[related.id];
    if (!row || row.chat_key !== chatKey || !Number.isInteger(expected) || Number(row.revision) !== Number(expected)) {
      fail(`关联事实 ${related.id} 已被其他事务修改。`, 'REVISION_CONFLICT');
    }
  }
}

function rollbackBatch(payload) {
  const jobId = text(payload.jobId, 'jobId');
  const batchIndex = integer(payload.batchIndex, 'batchIndex');
  const rows = db.prepare(`SELECT payload_json FROM batch_snapshots
    WHERE job_id = ? AND batch_index >= ? ORDER BY batch_index DESC`).all(jobId, batchIndex);
  if (rows.length === 0 || !rows.some(row => parsePayload(row).batchIndex === batchIndex)) {
    fail(`未找到任务 ${jobId} 第 ${batchIndex} 批的回滚快照。`, 'NOT_FOUND');
  }
  const snapshots = rowsToPayload(rows);
  const snapshot = snapshots.at(-1);
  if (payload.chatKey && snapshot.chatKey !== payload.chatKey) fail('不能跨聊天执行批次回滚。', 'CROSS_CHAT');
  for (const inverse of snapshots) {
    if (inverse.chatKey !== snapshot.chatKey || inverse.mode !== 'inverse-v1') fail('批次逆向快照格式无效。', 'INVALID_SNAPSHOT');
    for (const state of inverse.factStates ?? []) {
      db.prepare('DELETE FROM fact_vectors WHERE fact_id = ? AND chat_key = ?').run(state.id, snapshot.chatKey);
      if (!state.before) db.prepare('DELETE FROM facts WHERE id = ? AND chat_key = ?').run(state.id, snapshot.chatKey);
      else upsertFact(state.before);
    }
    for (const state of inverse.evidenceStates ?? []) {
      db.prepare('DELETE FROM evidence WHERE fact_id = ? AND chat_key = ?').run(state.factId, snapshot.chatKey);
      for (const item of state.before ?? []) upsertEvidence(item);
    }
  }
  const jobRow = db.prepare('SELECT payload_json FROM jobs WHERE id = ?').get(jobId);
  if (jobRow) {
    const job = parsePayload(jobRow);
    job.status = 'paused';
    job.checkpoint = { ...job.checkpoint, batchIndex: Math.max(0, batchIndex - 1) };
    job.updatedAt = Date.now();
    putJob(job);
  }
  const rolledBackAt = Date.now();
  const auditRows = db.prepare('SELECT payload_json FROM job_batch_audits WHERE job_id = ? AND batch_index >= ?').all(jobId, batchIndex);
  for (const auditRow of auditRows) putAudit({ ...parsePayload(auditRow), rolledBackAt });
  db.prepare('DELETE FROM batch_snapshots WHERE job_id = ? AND batch_index >= ?').run(jobId, batchIndex);
  return snapshot;
}

function executeAction(action, payload) {
  object(payload);
  switch (action) {
    case 'fact.upsert': {
      const chatKey = text(payload.fact?.chatKey, 'fact.chatKey');
      const relatedFacts = Array.isArray(payload.relatedFacts) ? payload.relatedFacts : [];
      const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
      assertExistingChat('facts', 'id', payload.fact.id, chatKey, '事实');
      assertFactUpsertBase(payload, chatKey);
      if ((payload.fact.status === 'active' || payload.fact.status === 'pending')
        && payload.expectedSlotFactId
        && payload.expectedSlotFactId !== payload.fact.id) {
        const replaced = relatedFacts.find(item => item.id === payload.expectedSlotFactId);
        if (!replaced
          || replaced.status === 'active'
          || replaced.status === 'pending'
          || payload.fact.supersedesId !== replaced.id
          || replaced.supersededById !== payload.fact.id) {
          fail('同一事实槽位的当前记录必须在本事务内建立完整替代链。', 'REVISION_CONFLICT');
        }
      }
      for (const related of payload.relatedFacts ?? []) {
        if (related.chatKey !== chatKey) fail('关联事实不能跨聊天写入。', 'CROSS_CHAT');
        assertExistingChat('facts', 'id', related.id, chatKey, '关联事实');
      }
      for (const item of evidence) {
        if (item.chatKey !== chatKey || item.factId !== payload.fact.id) fail('证据与主事实归属不一致。', 'CROSS_CHAT');
      }
      if (Array.isArray(payload.evidence)) {
        const replacementEvidenceIds = new Set(evidence.map(item => item.id));
        for (const evidenceId of payload.fact.evidenceIds ?? []) {
          if (!replacementEvidenceIds.has(evidenceId)) fail(`事实 ${payload.fact.id} 的替换证据缺少 ${evidenceId}。`, 'INVALID_EVIDENCE');
        }
      }
      validateFactGraph(chatKey, [...relatedFacts, payload.fact], evidence);
      for (const related of relatedFacts) upsertFact(related);
      upsertFact(payload.fact);
      if (Array.isArray(payload.evidence)) {
        db.prepare('DELETE FROM evidence WHERE fact_id = ? AND chat_key = ?').run(payload.fact.id, chatKey);
        for (const item of evidence) upsertEvidence(item);
      }
      return payload.fact;
    }
    case 'fact.remove': {
      const id = text(payload.id, 'id');
      const chatKey = text(payload.chatKey, 'chatKey');
      const target = parsePayload(db.prepare('SELECT payload_json FROM facts WHERE id = ? AND chat_key = ?').get(id, chatKey));
      if (!target) fail(`事实 ${id} 已不存在或归属变化。`, 'REVISION_CONFLICT');
      if (!Number.isInteger(payload.expectedRevision) || target.revision !== payload.expectedRevision) {
        fail(`事实 ${id} 已被其他事务修改。`, 'REVISION_CONFLICT');
      }
      const expectedRelated = payload.expectedRelatedRevisions ?? {};
      if (!expectedRelated || typeof expectedRelated !== 'object' || Array.isArray(expectedRelated)) {
        fail('expectedRelatedRevisions 必须是对象。');
      }
      const relatedFacts = [];
      const previous = target.supersedesId
        ? parsePayload(db.prepare('SELECT payload_json FROM facts WHERE id = ? AND chat_key = ?').get(target.supersedesId, chatKey))
        : null;
      const next = target.supersededById
        ? parsePayload(db.prepare('SELECT payload_json FROM facts WHERE id = ? AND chat_key = ?').get(target.supersededById, chatKey))
        : null;
      const now = Date.now();
      for (const related of [previous, next].filter(Boolean)) {
        if (!Number.isInteger(expectedRelated[related.id]) || related.revision !== expectedRelated[related.id]) {
          fail(`关联事实 ${related.id} 已被其他事务修改。`, 'REVISION_CONFLICT');
        }
      }
      if (previous) {
        relatedFacts.push({
          ...previous,
          supersededById: next?.id,
          status: next ? 'superseded' : 'active',
          revision: previous.revision + 1,
          updatedAt: now,
        });
      }
      if (next) {
        relatedFacts.push({
          ...next,
          supersedesId: previous?.id,
          revision: next.revision + 1,
          updatedAt: now,
        });
      }
      validateFactGraph(chatKey, relatedFacts, [], [id]);
      for (const fact of relatedFacts) upsertFact(fact);
      const result = db.prepare('DELETE FROM facts WHERE id = ? AND chat_key = ?').run(id, chatKey);
      return { removed: Number(result.changes) > 0 };
    }
    case 'ingest.commit': {
      const noFacts = payload.facts === undefined || (Array.isArray(payload.facts) && payload.facts.length === 0);
      const noEvidence = payload.evidence === undefined || (Array.isArray(payload.evidence) && payload.evidence.length === 0);
      if (payload.audit && !payload.job && noFacts && noEvidence) {
        putAudit(payload.audit);
        return { facts: [], accepted: 0, duplicated: 0, pending: 0, superseded: 0, rejected: [] };
      }
      const job = object(payload.job, 'job');
      const chatKey = text(job.chatKey, 'job.chatKey');
      assertIngestBase(payload, chatKey);
      for (const fact of payload.facts ?? []) if (fact.chatKey !== chatKey) fail('整理事实与任务不属于同一聊天。', 'CROSS_CHAT');
      const incomingFactIds = new Set((payload.facts ?? []).map(fact => fact.id));
      for (const item of payload.evidence ?? []) {
        if (item.chatKey !== chatKey) fail('整理证据与任务不属于同一聊天。', 'CROSS_CHAT');
        const existingOwner = db.prepare('SELECT chat_key FROM facts WHERE id = ?').get(item.factId);
        if (!incomingFactIds.has(item.factId) && existingOwner?.chat_key !== chatKey) fail('整理证据引用了其他聊天或不存在的事实。', 'CROSS_CHAT');
      }
      if (payload.audit && (payload.audit.chatKey !== chatKey || payload.audit.jobId !== job.id)) {
        fail('整理审计与任务归属不一致。', 'CROSS_CHAT');
      }
      validateFactGraph(chatKey, payload.facts ?? [], payload.evidence ?? [], payload.deletedFactIds ?? []);
      putJob(job);
      captureBatchSnapshot(job, payload);
      for (const fact of payload.facts ?? []) upsertFact(fact);
      for (const evidence of payload.evidence ?? []) upsertEvidence(evidence);
      for (const factId of payload.deletedFactIds ?? []) {
        db.prepare('DELETE FROM facts WHERE id = ? AND chat_key = ?').run(text(factId, 'deletedFactIds[]'), chatKey);
      }
      if (payload.audit) putAudit(payload.audit);
      return {
        facts: payload.facts ?? [],
        accepted: payload.accepted ?? (payload.facts?.length ?? 0),
        duplicated: payload.duplicated ?? 0,
        pending: payload.pending ?? 0,
        superseded: payload.superseded ?? 0,
        rejected: payload.rejected ?? [],
      };
    }
    case 'job.put': putJob(payload.job); return payload.job;
    case 'batch.rollback': return rollbackBatch(payload);
    case 'setting.set': return putSetting(payload.setting ?? payload);
    case 'settings.setMany': {
      const settings = Array.isArray(payload.settings) ? payload.settings : fail('settings 必须是数组。');
      if (settings.length > 1_000) fail('单次最多写入 1000 项设置。');
      return settings.map(setting => putSetting(setting));
    }
    case 'recall_log.add': putRecallLog(payload.log); return payload.log;
    case 'main_chat_usage.add': putUsage(payload.usage); return payload.usage;
    case 'chat.clear': {
      const chatKey = text(payload.chatKey, 'chatKey');
      for (const table of ['evidence', 'fact_vectors', 'job_batch_audits', 'batch_snapshots', 'main_chat_usage', 'recall_logs', 'facts', 'jobs']) {
        db.prepare(`DELETE FROM ${table} WHERE chat_key = ?`).run(chatKey);
      }
      return { cleared: true, chatKey };
    }
    case 'vector.upsert': return upsertVector(
      payload.vector && !Array.isArray(payload.vector) && !(payload.vector instanceof Float32Array)
        ? payload.vector
        : payload,
    );
    case 'vector.delete': return {
      removed: Number(db.prepare('DELETE FROM fact_vectors WHERE fact_id = ? AND chat_key = ?')
        .run(text(payload.factId, 'factId'), text(payload.chatKey, 'chatKey')).changes) > 0,
    };
    case 'vector.clear': {
      const result = db.prepare('DELETE FROM fact_vectors WHERE chat_key = ?').run(text(payload.chatKey, 'chatKey'));
      return { removed: Number(result.changes) };
    }
    default: fail(`不允许执行命令：${action}`, 'NOT_ALLOWED');
  }
}

function command(input) {
  object(input, 'command');
  const requestId = text(input.requestId, 'requestId');
  const action = text(input.action, 'action');
  const requestHash = hashText(canonicalJson(input.payload ?? {}));
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare('SELECT action, request_hash, response_json FROM request_dedup WHERE request_id = ?').get(requestId);
    if (prior) {
      if (prior.action !== action || prior.request_hash !== requestHash) {
        fail('requestId 已被不同命令或参数使用。', 'IDEMPOTENCY_CONFLICT');
      }
      db.exec('COMMIT');
      return { replayed: true, result: JSON.parse(prior.response_json) };
    }
    const result = executeAction(action, input.payload ?? {});
    db.prepare('INSERT INTO request_dedup(request_id, action, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(requestId, action, requestHash, json(result), Date.now());
    db.prepare('DELETE FROM request_dedup WHERE created_at < ?').run(Date.now() - DEDUP_RETENTION_MS);
    db.prepare(`DELETE FROM request_dedup WHERE request_id IN (
      SELECT request_id FROM request_dedup ORDER BY created_at DESC, request_id DESC LIMIT -1 OFFSET ?
    )`).run(MAX_DEDUP_ROWS);
    db.exec('COMMIT');
    statusCache.clear();
    return { replayed: false, result };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cosine(left, rightBlob) {
  if (rightBlob.byteLength !== left.length * 4) return null;
  const right = new Float32Array(rightBlob.buffer, rightBlob.byteOffset, left.length);
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function vectorSearch(input) {
  object(input, 'vector search');
  const queryVector = Float32Array.from(input.vector ?? []);
  if (queryVector.length === 0 || queryVector.some(value => !Number.isFinite(value))) fail('查询向量为空或包含非法数值。');
  const clauses = ['chat_key = ?', 'dimensions = ?'];
  const params = [text(input.chatKey, 'chatKey'), queryVector.length];
  if (input.resourceId) { clauses.push('resource_id = ?'); params.push(input.resourceId); }
  if (input.model) { clauses.push('model = ?'); params.push(input.model); }
  const rows = db.prepare(`SELECT fact_id, content_hash, resource_id, model, dimensions, vector FROM fact_vectors WHERE ${clauses.join(' AND ')}`).all(...params);
  return rows.map(row => ({
    factId: row.fact_id,
    contentHash: row.content_hash,
    resourceId: row.resource_id,
    model: row.model,
    dimensions: row.dimensions,
    score: cosine(queryVector, row.vector),
  })).filter(row => row.score !== null).sort((a, b) => b.score - a.score).slice(0, boundedLimit(input.limit, 60));
}

async function exportBackup() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const target = `${dbPath}.export-${process.pid}-${Date.now()}`;
  try {
    await backup(db, target);
    const data = await readFile(target);
    return { data, sha256: createHash('sha256').update(data).digest('hex') };
  } finally {
    await rm(target, { force: true });
  }
}

async function importBackup(input) {
  const bytes = Buffer.from(input.data);
  if (bytes.byteLength < 100 || bytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') fail('上传内容不是 SQLite 3 数据库。');
  if (input.sha256 && createHash('sha256').update(bytes).digest('hex') !== input.sha256) fail('SQLite 备份 SHA-256 不匹配。');
  const temp = `${dbPath}.import-${process.pid}-${Date.now()}`;
  const previous = previousBackupPath;
  await writeFile(temp, bytes, { flag: 'wx' });
  let candidate;
  try {
    candidate = new DatabaseSync(temp, { readOnly: true });
    validateCandidate(candidate);
    candidate.close(); candidate = null;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close(); db = null;
    try {
      await rm(previous, { force: true });
      await rm(`${dbPath}-wal`, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
      await writeFile(importMarkerPath, json({ stage: 'prepared', temp, createdAt: Date.now() }), 'utf8');
      await rename(dbPath, previous).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await writeFile(importMarkerPath, json({ stage: 'previous_saved', temp, createdAt: Date.now() }), 'utf8');
      await rename(temp, dbPath);
      await writeFile(importMarkerPath, json({ stage: 'installed', temp, createdAt: Date.now() }), 'utf8');
      openDatabase();
      statusCache.clear();
      validateCandidate(db);
      await rm(previous, { force: true });
      await rm(importMarkerPath, { force: true });
    } catch (error) {
      db?.close(); db = null;
      if (await exists(previous)) {
        await rm(dbPath, { force: true });
        await rename(previous, dbPath);
      }
      if (await exists(dbPath)) openDatabase();
      await rm(importMarkerPath, { force: true });
      throw error;
    }
    return await status();
  } finally {
    candidate?.close();
    await rm(temp, { force: true });
  }
}

async function dispatch(method, payload) {
  switch (method) {
    case 'health': return status(payload?.chatKey);
    case 'bootstrap': {
      const chatKey = text(payload?.chatKey, 'chatKey');
      const currentStatus = await status(chatKey);
      return {
        ...currentStatus,
        facts: query({ resource: 'facts', chatKey, limit: MAX_QUERY_LIMIT }),
        evidence: query({ resource: 'evidence', chatKey, limit: MAX_QUERY_LIMIT }),
        jobs: query({ resource: 'jobs', chatKey, limit: MAX_QUERY_LIMIT }),
        settings: query({ resource: 'settings', filters: {}, limit: MAX_QUERY_LIMIT }),
        lastRecall: query({ resource: 'recall_logs', chatKey, limit: 1 })[0] ?? null,
      };
    }
    case 'query': return query(payload);
    case 'command': return command(payload);
    case 'vectorSearch': return vectorSearch(payload);
    case 'integrity': return integrity();
    case 'backupExport': return exportBackup();
    case 'backupImport': return importBackup(payload);
    case 'close': db?.close(); db = null; return { closed: true };
    default: fail(`未知 Worker 方法：${method}`, 'NOT_ALLOWED');
  }
}

await initialize();
parentPort.postMessage({ type: 'ready' });
let messageQueue = Promise.resolve();
async function handleMessage({ id, method, payload }) {
  try {
    const result = await dispatch(method, payload);
    const transferList = method === 'backupExport' && ArrayBuffer.isView(result?.data)
      ? [result.data.buffer]
      : [];
    parentPort.postMessage({ id, ok: true, result }, transferList);
  } catch (error) {
    statusCache.clear();
    const sqliteBusy = error?.code === 'SQLITE_BUSY'
      || error?.errcode === 5
      || (error?.code === 'ERR_SQLITE_ERROR' && /\b(?:busy|locked)\b/i.test(error?.message ?? ''));
    const code = sqliteBusy ? 'SQLITE_BUSY'
      : error?.code === 'ERR_SQLITE_ERROR' ? 'SQLITE_ERROR'
        : error?.code ?? 'SQLITE_ERROR';
    lastError = { code, message: error.message, at: Date.now() };
    parentPort.postMessage({ id, ok: false, error: lastError });
  }
}
parentPort.on('message', message => {
  messageQueue = messageQueue.then(() => handleMessage(message));
});
