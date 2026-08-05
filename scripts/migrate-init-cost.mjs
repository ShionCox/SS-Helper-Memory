import { DatabaseSync } from 'node:sqlite';

// One-time, operator-run cutover for the existing initialization job. It only
// changes derived queue state/settings; facts, evidence, traces, events and
// vectors remain byte-for-byte untouched.
const dbPath = process.argv[2] ?? 'I:/SillyTavern/data/_ss-helper-v0/ss-helper.sqlite3';
const workspaceId = process.argv[3] ?? 'character:小時.png';
const migrationId = 'memory-init-cost-v1';
const ownerPluginId = 'ss-helper.memory';
const jobCollection = 'capture-jobs';
const queueCollection = 'capture-repair-queue';
const auditCollection = 'change-audits';
const settingsWorkspace = 'settings:global';
const deterministicKeywords = new Set(['excerpt_mismatch', 'invalid_shape', 'invalid_reference', 'entity_ref_unsupported']);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys=ON');
let committed = false;
process.on('exit', () => { if (!committed) { try { db.exec('ROLLBACK'); } catch {} } });
const now = Date.now();
const getRows = db.prepare('SELECT owner_plugin_id, workspace_id, collection, record_id, value_json, revision FROM workspace_records WHERE owner_plugin_id = ? AND workspace_id = ? AND collection = ? AND tombstone = 0');
const updateRow = db.prepare('UPDATE workspace_records SET value_json = ?, revision = revision + 1, updated_at = ? WHERE owner_plugin_id = ? AND workspace_id = ? AND collection = ? AND record_id = ?');
const count = (collection) => Number(db.prepare('SELECT COUNT(*) AS c FROM workspace_records WHERE owner_plugin_id = ? AND workspace_id = ? AND collection = ? AND tombstone = 0').get(ownerPluginId, workspaceId, collection)?.c ?? 0);

const baseline = Object.fromEntries(['facts', 'evidence', 'memory-traces', 'inventory-events', 'episodes', 'observations', 'graph-nodes', 'graph-edges', 'workspace_vectors'].map((collection) => [collection, collection === 'workspace_vectors' ? Number(db.prepare('SELECT COUNT(*) AS c FROM workspace_vectors WHERE workspace_id = ?').get(workspaceId)?.c ?? 0) : count(collection)]));
const already = db.prepare('SELECT 1 AS found FROM workspace_records WHERE owner_plugin_id = ? AND workspace_id = ? AND collection = ? AND record_id = ? AND tombstone = 0').get(ownerPluginId, workspaceId, auditCollection, migrationId);
if (already) {
  console.log(JSON.stringify({ skipped: true, migrationId }));
  db.close();
  process.exit(0);
}

const queueRows = getRows.all(ownerPluginId, workspaceId, queueCollection).map((row) => ({ row, value: JSON.parse(row.value_json) }));
db.exec('BEGIN IMMEDIATE');
const ambiguous = queueRows
  .filter(({ value }) => (value.issues ?? []).some((issue) => issue.keyword === 'invalid_reference' || issue.keyword === 'entity_ref_unsupported'))
  .sort((left, right) => String(left.value.id).localeCompare(String(right.value.id)));
const aiIds = new Set(ambiguous.slice(0, 32).map(({ value }) => value.id));
const classifications = new Map();
for (const { row, value } of queueRows) {
  const keywords = new Set((value.issues ?? []).map((issue) => issue.keyword));
  const classification = keywords.has('duplicate_proposal') || keywords.has('duplicate_noop')
    ? 'duplicate_noop'
    : aiIds.has(value.id)
      ? 'ai_required'
      : [...keywords].some((keyword) => deterministicKeywords.has(keyword)) ? 'unsupported_evidence' : 'ai_required';
  classifications.set(value.id, classification);
  const next = { ...value, classification };
  if (classification !== 'ai_required') {
    next.status = 'ignored';
    next.resolutionMode = 'ignored';
    next.waitingForEvidenceChange = false;
    next.resolvedAt = value.resolvedAt ?? now;
  }
  updateRow.run(JSON.stringify(next), now, ownerPluginId, workspaceId, queueCollection, row.record_id);
}

const queueByRejection = new Map();
for (const { value } of queueRows) {
  const classification = classifications.get(value.id);
  for (const rejectionId of value.rejectionIds ?? (value.rejectionId ? [value.rejectionId] : [])) queueByRejection.set(rejectionId, classification);
}
const jobs = getRows.all(ownerPluginId, workspaceId, jobCollection).map((row) => ({ row, value: JSON.parse(row.value_json) }));
for (const { row, value } of jobs) {
  if (!Array.isArray(value.rejections)) continue;
  const rejections = value.rejections.map((rejection) => {
    const classification = queueByRejection.get(rejection.id);
    if (!classification || classification === 'ai_required') return rejection;
    return { ...rejection, status: 'ignored', waitingForEvidenceChange: false, ignoredAt: rejection.ignoredAt ?? now };
  });
  const unresolved = rejections.filter((rejection) => (rejection.status ?? 'unresolved') === 'unresolved').length;
  const ignored = rejections.filter((rejection) => rejection.status === 'ignored').length;
  const next = {
    ...value,
    rejectionCount: unresolved,
    rejections,
    checkpoint: {
      ...(value.checkpoint ?? {}),
      phase: 'repair',
      pendingRepairCount: queueRows.filter(({ value: item }) => classifications.get(item.id) === 'ai_required' && item.status !== 'resolved' && item.status !== 'ignored').length,
      retryableRepairCount: queueRows.filter(({ value: item }) => classifications.get(item.id) === 'ai_required' && item.status !== 'resolved' && item.status !== 'ignored' && item.attemptCount < (item.maxAttempts ?? 1)).length,
      unresolvedRejectionCount: unresolved,
      ignoredCount: ignored,
    },
  };
  updateRow.run(JSON.stringify(next), now, ownerPluginId, workspaceId, jobCollection, row.record_id);
}

const settings = getRows.all(ownerPluginId, settingsWorkspace, 'settings').map((row) => ({ row, value: JSON.parse(row.value_json) }));
const defaults = new Map([
  ['summaryBatchMode', 'chars'],
  ['summaryBatchFloors', 16],
  ['summaryBatchChars', 16000],
  ['summaryOverlapFloors', 1],
  ['structuredRepairMaxItems', 8],
]);
for (const { row, value } of settings) {
  if (!defaults.has(value.key)) continue;
  updateRow.run(JSON.stringify({ ...value, value: defaults.get(value.key), updatedAt: now }), now, ownerPluginId, settingsWorkspace, 'settings', row.record_id);
}

const audit = {
  id: migrationId,
  workspaceId,
  chatKey: '小時 - 2026-04-23@10h30m03s277ms imported - SS-Helper 复测',
  kind: 'memory-init-cost-migration-v0',
  createdAt: now,
  metadata: {
    migrationId,
    queueRecords: queueRows.length,
    aiRequired: [...classifications.values()].filter((value) => value === 'ai_required').length,
    deterministicIgnored: [...classifications.values()].filter((value) => value !== 'ai_required').length,
    preservedCounts: baseline,
  },
};
db.prepare('INSERT INTO workspace_records (owner_plugin_id, workspace_id, collection, record_id, value_json, revision, tombstone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)').run(ownerPluginId, workspaceId, auditCollection, migrationId, JSON.stringify(audit), now, now);
db.prepare('UPDATE workspaces SET version = version + 1, updated_at = ? WHERE workspace_id = ?').run(now, workspaceId);
db.exec('COMMIT');
committed = true;

const after = Object.fromEntries(Object.keys(baseline).map((collection) => [collection, collection === 'workspace_vectors' ? Number(db.prepare('SELECT COUNT(*) AS c FROM workspace_vectors WHERE workspace_id = ?').get(workspaceId)?.c ?? 0) : count(collection)]));
for (const key of Object.keys(baseline)) if (baseline[key] !== after[key]) throw new Error(`preserved count changed: ${key} ${baseline[key]} -> ${after[key]}`);
db.exec('PRAGMA wal_checkpoint(PASSIVE)');
db.exec('PRAGMA integrity_check');
console.log(JSON.stringify({ migrationId, queueRecords: queueRows.length, aiRequired: [...classifications.values()].filter((value) => value === 'ai_required').length, deterministicIgnored: [...classifications.values()].filter((value) => value !== 'ai_required').length, preservedCounts: after }));
db.close();
