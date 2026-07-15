export const SCHEMA_VERSION = 2;
export const PROTOCOL_VERSION = 1;

export const BUSINESS_TABLES = Object.freeze([
  'facts',
  'evidence',
  'jobs',
  'settings',
  'recall_logs',
  'job_batch_audits',
  'main_chat_usage',
  'batch_snapshots',
  'fact_vectors',
]);

/** 初始化 Memory 的唯一 SQLite schema。 */
export function migrateDatabase(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS request_dedup (
      request_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      predicate_key TEXT NOT NULL,
      object_key TEXT,
      canonical_key TEXT NOT NULL,
      slot_key TEXT,
      content TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      status TEXT NOT NULL CHECK(status IN ('active','pending','superseded','invalid')),
      freshest_evidence_at INTEGER NOT NULL,
      valid_from INTEGER,
      valid_until INTEGER,
      origin TEXT NOT NULL CHECK(origin IN ('automatic','manual','import')),
      revision INTEGER NOT NULL CHECK(revision >= 1),
      supersedes_id TEXT,
      superseded_by_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS facts_chat_canonical ON facts(chat_key, canonical_key);
    CREATE INDEX IF NOT EXISTS facts_chat_status ON facts(chat_key, status);
    CREATE INDEX IF NOT EXISTS facts_chat_kind ON facts(chat_key, kind);
    CREATE INDEX IF NOT EXISTS facts_chat_slot ON facts(chat_key, slot_key);
    CREATE INDEX IF NOT EXISTS facts_chat_time ON facts(chat_key, freshest_evidence_at DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      chat_key TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS evidence_chat_fact ON evidence(chat_key, fact_id);
    CREATE INDEX IF NOT EXISTS evidence_chat_source ON evidence(chat_key, source_ref);
    CREATE INDEX IF NOT EXISTS evidence_time ON evidence(chat_key, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('initialize','history','incremental')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','paused','completed','failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jobs_chat_type ON jobs(chat_key, type);
    CREATE INDEX IF NOT EXISTS jobs_chat_status ON jobs(chat_key, status);
    CREATE INDEX IF NOT EXISTS jobs_chat_updated ON jobs(chat_key, updated_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(namespace, key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS settings_namespace ON settings(namespace, updated_at DESC);

    CREATE TABLE IF NOT EXISTS recall_logs (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS recall_chat_created ON recall_logs(chat_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS job_batch_audits (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK(batch_index >= 0),
      completed_at INTEGER NOT NULL,
      request_id TEXT,
      payload_json TEXT NOT NULL,
      UNIQUE(job_id, batch_index)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audits_chat_job ON job_batch_audits(chat_key, job_id, completed_at DESC);

    CREATE TABLE IF NOT EXISTS main_chat_usage (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      recall_log_id TEXT,
      captured_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS usage_chat_message ON main_chat_usage(chat_key, message_id);
    CREATE INDEX IF NOT EXISTS usage_chat_time ON main_chat_usage(chat_key, captured_at DESC);

    CREATE TABLE IF NOT EXISTS batch_snapshots (
      id TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      batch_index INTEGER NOT NULL CHECK(batch_index >= 0),
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(job_id, batch_index)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS snapshots_chat_job ON batch_snapshots(chat_key, job_id, batch_index);

    CREATE TABLE IF NOT EXISTS fact_vectors (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      chat_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK(dimensions > 0),
      vector BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS vectors_chat_updated ON fact_vectors(chat_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS vectors_route ON fact_vectors(chat_key, resource_id, model, dimensions);
  `);

  const factColumns = new Set(db.prepare('PRAGMA table_info(facts)').all().map(row => row.name));
  if (!factColumns.has('supersedes_id')) db.exec('ALTER TABLE facts ADD COLUMN supersedes_id TEXT');
  if (!factColumns.has('superseded_by_id')) db.exec('ALTER TABLE facts ADD COLUMN superseded_by_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS facts_supersedes ON facts(supersedes_id, superseded_by_id)');

  const dedupColumns = new Set(db.prepare('PRAGMA table_info(request_dedup)').all().map(row => row.name));
  if (!dedupColumns.has('request_hash')) db.exec('ALTER TABLE request_dedup ADD COLUMN request_hash TEXT');

  // v1 误把 canonicalKey 声明为唯一索引，会阻止同一 canonical 的历史
  // superseded 事实与当前事实并存。SQLite 是唯一后端，启动时直接修正索引。
  db.exec(`
    DROP INDEX IF EXISTS facts_chat_canonical;
    CREATE INDEX facts_chat_canonical ON facts(chat_key, canonical_key);
  `);

  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, now);
  db.prepare(`
    INSERT INTO metadata(key, value, updated_at) VALUES ('schema_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(SCHEMA_VERSION), now);
}
