import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { BUSINESS_TABLES, exit, init, MemorySqliteService, MemorySqliteWorkerClient } from '../server/index.js';

const cleanup: string[] = [];

async function worker(): Promise<{ client: MemorySqliteWorkerClient; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'memory-sqlite-test-'));
  cleanup.push(directory);
  return {
    client: new MemorySqliteWorkerClient(path.join(directory, '_memory', 'memory.sqlite3')),
    directory,
  };
}

function fact(id = 'fact:one', chatKey = 'chat:test') {
  return {
    id,
    chatKey,
    kind: 'state',
    subjectKey: 'hour2',
    predicateKey: 'weapon_count',
    objectKey: '2',
    canonicalKey: 'hour2::weapon_count::2',
    slotKey: 'hour2::weapon_count',
    content: '小时2当前拥有两把紫电枪。',
    entityKeys: ['hour2', '紫电枪'],
    confidence: 0.95,
    status: 'active',
    sourceRefs: ['message:1'],
    evidenceIds: [`evidence:${id}`],
    freshestEvidenceAt: 1_000,
    origin: 'automatic',
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function factAtSlot(id: string, predicateKey: string, chatKey = 'chat:test') {
  return {
    ...fact(id, chatKey),
    predicateKey,
    canonicalKey: `hour2::${predicateKey}::2`,
    slotKey: `hour2::${predicateKey}`,
  };
}

function evidence(factId = 'fact:one', chatKey = 'chat:test') {
  return {
    id: `evidence:${factId}`,
    factId,
    chatKey,
    sourceRef: 'message:1',
    sourceType: 'message',
    excerpt: '两把紫电枪',
    occurredAt: 1_000,
    createdAt: 1_000,
  };
}

function contentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function embeddingText(row: ReturnType<typeof fact>): string {
  return [
    `类型：${row.kind}`,
    `主体：${row.subjectKey}`,
    `谓词：${row.predicateKey}`,
    row.objectKey ? `对象：${row.objectKey}` : '',
    row.entityKeys.length > 0 ? `实体：${row.entityKeys.join('、')}` : '',
    `事实：${row.content}`,
  ].filter(Boolean).join('\n');
}

function job(batchIndex: number, chatKey = 'chat:test') {
  return {
    id: 'job:sequence', chatKey, type: 'incremental', status: 'running',
    checkpoint: { batchIndex, processedCount: batchIndex * 10 }, createdAt: 1_000, updatedAt: 1_000 + batchIndex,
  };
}

function audit(batchIndex: number, chatKey = 'chat:test') {
  return {
    id: `audit:${batchIndex}`, chatKey, jobId: 'job:sequence', batchIndex,
    sourceRefs: [`message:${batchIndex}`], accepted: 1, rejected: 0, duplicated: 0,
    pending: 0, superseded: 0, rejections: [], startedAt: 1_000, completedAt: 2_000 + batchIndex, usage: null,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Memory SQLite server worker', () => {
  it('creates the complete schema with WAL, FK-safe business writes and per-chat status', async () => {
    const { client } = await worker();
    try {
      const health = await client.call('health', { chatKey: 'chat:test' });
      expect(health).toMatchObject({
        connected: true,
        serverVersion: '0.0.1',
        schemaVersion: 2,
        databasePath: '_memory/memory.sqlite3',
        walMode: 'wal',
      });
      expect(Object.keys(health.tableCounts)).toEqual(BUSINESS_TABLES);
      expect(Object.keys(health.tableBytes)).toEqual(BUSINESS_TABLES);
      expect(Object.values(health.tableBytes).every(value => value === null || (typeof value === 'number' && value >= 0))).toBe(true);

      const inserted = await client.call('command', {
        requestId: 'request:fact:one',
        action: 'fact.upsert',
        payload: { expectedSlotFactId: null, fact: fact(), evidence: [evidence()] },
      });
      expect(inserted.replayed).toBe(false);
      const replay = await client.call('command', {
        requestId: 'request:fact:one',
        action: 'fact.upsert',
        payload: { expectedSlotFactId: null, fact: fact(), evidence: [evidence()] },
      });
      expect(replay.replayed).toBe(true);
      await expect(client.call('command', {
        requestId: 'request:fact:one',
        action: 'fact.upsert',
        payload: { expectedSlotFactId: null, fact: factAtSlot('fact:different', 'different'), evidence: [evidence('fact:different')] },
      })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      const bootstrap = await client.call('bootstrap', { chatKey: 'chat:test' });
      expect(bootstrap.facts).toEqual([fact()]);
      expect(bootstrap.evidence).toEqual([evidence()]);
      expect(bootstrap.tableCounts).toMatchObject({ facts: 1, evidence: 1 });
      expect(await client.call('integrity')).toEqual({ ok: true, messages: ['ok'] });
    } finally {
      await client.close();
    }
  });

  it('preserves supersede history when two facts share one canonical key', async () => {
    const { client } = await worker();
    try {
      const oldFact = fact('fact:old');
      const supersededOldFact = { ...oldFact, status: 'superseded', supersededById: 'fact:new', revision: 2 };
      const currentFact = { ...fact('fact:new'), supersedesId: 'fact:old' };

      await client.call('command', {
        requestId: 'request:fact:old',
        action: 'fact.upsert',
        payload: { expectedSlotFactId: null, fact: oldFact, evidence: [evidence(oldFact.id)] },
      });
      await client.call('command', {
        requestId: 'request:fact:new',
        action: 'fact.upsert',
        payload: {
          expectedSlotFactId: oldFact.id,
          expectedRelatedRevisions: { [oldFact.id]: 1 },
          fact: currentFact,
          relatedFacts: [supersededOldFact],
          evidence: [evidence(currentFact.id)],
        },
      });

      const facts = await client.call('query', { resource: 'facts', chatKey: 'chat:test' });
      expect(facts).toHaveLength(2);
      expect(facts.map((item: { id: string }) => item.id)).toEqual(['fact:old', 'fact:new']);
    } finally {
      await client.close();
    }
  });

  it('preserves both sides of a supersede chain while editing the active successor and a middle history fact', async () => {
    const { client } = await worker();
    try {
      const oldest = { ...fact('fact:edit-oldest'), status: 'superseded', supersededById: 'fact:edit-middle' };
      const middle = {
        ...fact('fact:edit-middle'), status: 'superseded',
        supersedesId: oldest.id, supersededById: 'fact:edit-latest',
      };
      const latest = { ...fact('fact:edit-latest'), supersedesId: middle.id };
      await client.call('command', {
        requestId: 'edit-chain-seed', action: 'ingest.commit',
        payload: {
          job: job(1), facts: [oldest, middle, latest],
          evidence: [evidence(oldest.id), evidence(middle.id), evidence(latest.id)],
        },
      });

      await client.call('command', {
        requestId: 'edit-chain-latest', action: 'fact.upsert',
        payload: {
          expectedRevision: 1,
          expectedSlotFactId: latest.id,
          fact: { ...latest, content: '已编辑的当前事实。', revision: 2, updatedAt: 2_000 },
          evidence: [evidence(latest.id)],
        },
      });
      await client.call('command', {
        requestId: 'edit-chain-middle', action: 'fact.upsert',
        payload: {
          expectedRevision: 1,
          expectedSlotFactId: latest.id,
          fact: { ...middle, content: '已编辑的中间历史事实。', revision: 2, updatedAt: 2_000 },
          evidence: [evidence(middle.id)],
        },
      });

      await expect(client.call('query', {
        resource: 'fact', chatKey: latest.chatKey, filters: { id: latest.id },
      })).resolves.toMatchObject({ supersedesId: middle.id, revision: 2 });
      await expect(client.call('query', {
        resource: 'fact', chatKey: middle.chatKey, filters: { id: middle.id },
      })).resolves.toMatchObject({ supersedesId: oldest.id, supersededById: latest.id, revision: 2 });
    } finally {
      await client.close();
    }
  });

  it('rejects stale manual revisions and two concurrent creates against the same empty slot', async () => {
    const { client } = await worker();
    try {
      const first = fact('fact:manual-first');
      await client.call('command', {
        requestId: 'manual-first', action: 'fact.upsert',
        payload: { expectedRevision: null, expectedSlotFactId: null, fact: first, evidence: [evidence(first.id)] },
      });
      await expect(client.call('command', {
        requestId: 'manual-stale-update', action: 'fact.upsert',
        payload: {
          expectedRevision: 0,
          expectedSlotFactId: first.id,
          fact: { ...first, revision: 2 },
          evidence: [evidence(first.id)],
        },
      })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

      const concurrent = fact('fact:manual-concurrent');
      await expect(client.call('command', {
        requestId: 'manual-concurrent', action: 'fact.upsert',
        payload: { expectedRevision: null, expectedSlotFactId: null, fact: concurrent, evidence: [evidence(concurrent.id)] },
      })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      const edited = { ...first, content: '并发标签已更新事实。', revision: 2, updatedAt: 2_000 };
      await client.call('command', {
        requestId: 'manual-edit-before-delete', action: 'fact.upsert',
        payload: { expectedRevision: 1, expectedSlotFactId: first.id, fact: edited, evidence: [evidence(first.id)] },
      });
      await expect(client.call('command', {
        requestId: 'manual-stale-delete', action: 'fact.remove',
        payload: { id: first.id, chatKey: first.chatKey, expectedRevision: 1, expectedRelatedRevisions: {} },
      })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(client.call('query', { resource: 'facts', chatKey: first.chatKey })).resolves.toEqual([edited]);
    } finally {
      await client.close();
    }
  });

  it('repairs supersede links when deleting a middle or latest fact', async () => {
    const { client } = await worker();
    try {
      const oldest = { ...fact('fact:chain-oldest'), status: 'superseded', supersededById: 'fact:chain-middle' };
      const middle = {
        ...fact('fact:chain-middle'), status: 'superseded',
        supersedesId: oldest.id, supersededById: 'fact:chain-latest',
      };
      const latest = { ...fact('fact:chain-latest'), supersedesId: middle.id };
      await client.call('command', {
        requestId: 'chain-seed', action: 'ingest.commit',
        payload: {
          job: job(1), facts: [oldest, middle, latest],
          evidence: [evidence(oldest.id), evidence(middle.id), evidence(latest.id)],
        },
      });

      await client.call('command', {
        requestId: 'chain-remove-middle', action: 'fact.remove',
        payload: {
          id: middle.id, chatKey: middle.chatKey, expectedRevision: 1,
          expectedRelatedRevisions: { [oldest.id]: 1, [latest.id]: 1 },
        },
      });
      await expect(client.call('query', {
        resource: 'fact', chatKey: middle.chatKey, filters: { id: middle.id },
      })).resolves.toBeNull();
      await expect(client.call('query', {
        resource: 'fact', chatKey: oldest.chatKey, filters: { id: oldest.id },
      })).resolves.toMatchObject({ status: 'superseded', supersededById: latest.id });
      await expect(client.call('query', {
        resource: 'fact', chatKey: latest.chatKey, filters: { id: latest.id },
      })).resolves.toMatchObject({ status: 'active', supersedesId: oldest.id });

      await client.call('command', {
        requestId: 'chain-remove-latest', action: 'fact.remove',
        payload: {
          id: latest.id, chatKey: latest.chatKey, expectedRevision: 2,
          expectedRelatedRevisions: { [oldest.id]: 2 },
        },
      });
      const restoredOldest = await client.call('query', {
        resource: 'fact', chatKey: oldest.chatKey, filters: { id: oldest.id },
      });
      expect(restoredOldest).toMatchObject({ status: 'active' });
      expect(restoredOldest).not.toHaveProperty('supersededById');
    } finally {
      await client.close();
    }
  });

  it('rejects malformed fact keys, invalid automatic state, ghost evidence and broken supersede graphs', async () => {
    const { client } = await worker();
    try {
      const invalidKey = { ...fact('fact:invalid-key'), canonicalKey: 'client-controlled' };
      await expect(client.call('command', {
        requestId: 'invalid-key', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: invalidKey, evidence: [evidence(invalidKey.id)] },
      })).rejects.toMatchObject({ code: 'INVALID_FACT' });

      const lowConfidence = { ...fact('fact:low-confidence'), confidence: 0.5 };
      await expect(client.call('command', {
        requestId: 'low-confidence', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: lowConfidence, evidence: [evidence(lowConfidence.id)] },
      })).rejects.toMatchObject({ code: 'INVALID_FACT' });

      await expect(client.call('command', {
        requestId: 'ghost-evidence', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: fact('fact:ghost-evidence') },
      })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });

      const seeded = fact('fact:replacement-evidence');
      await client.call('command', {
        requestId: 'replacement-evidence-seed', action: 'fact.upsert',
        payload: { expectedSlotFactId: null, fact: seeded, evidence: [evidence(seeded.id)] },
      });
      await expect(client.call('command', {
        requestId: 'replacement-evidence-missing', action: 'fact.upsert',
        payload: { expectedRevision: 1, expectedSlotFactId: seeded.id, fact: { ...seeded, revision: 2 }, evidence: [] },
      })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });

      const oneWayNew = { ...fact('fact:one-way-new'), supersedesId: 'fact:one-way-old' };
      const oneWayOld = fact('fact:one-way-old');
      await expect(client.call('command', {
        requestId: 'one-way-chain', action: 'ingest.commit',
        payload: {
          job: job(1), facts: [oneWayOld, oneWayNew],
          evidence: [evidence(oneWayOld.id), evidence(oneWayNew.id)],
        },
      })).rejects.toMatchObject({ code: 'INVALID_FACT_GRAPH' });

      const cycleA = {
        ...fact('fact:cycle-a'), status: 'superseded',
        supersedesId: 'fact:cycle-b', supersededById: 'fact:cycle-b',
      };
      const cycleB = {
        ...fact('fact:cycle-b'), status: 'superseded',
        supersedesId: 'fact:cycle-a', supersededById: 'fact:cycle-a',
      };
      await expect(client.call('command', {
        requestId: 'cyclic-chain', action: 'ingest.commit',
        payload: {
          job: job(1), facts: [cycleA, cycleB],
          evidence: [evidence(cycleA.id), evidence(cycleB.id)],
        },
      })).rejects.toMatchObject({ code: 'INVALID_FACT_GRAPH' });
      expect(await client.call('query', { resource: 'facts', chatKey: 'chat:test' })).toEqual([seeded]);
    } finally {
      await client.close();
    }
  });

  it('rejects multiple current facts in one slot within a single ingest transaction and rolls every write back', async () => {
    const { client } = await worker();
    try {
      const first = fact('fact:same-slot:first');
      const second = {
        ...fact('fact:same-slot:second'),
        objectKey: '3',
        canonicalKey: 'hour2::weapon_count::3',
        content: '小时2当前拥有三把紫电枪。',
      };
      await expect(client.call('command', {
        requestId: 'same-slot-single-transaction',
        action: 'ingest.commit',
        payload: {
          job: job(1),
          facts: [first, second],
          evidence: [evidence(first.id), evidence(second.id)],
          audit: audit(1),
        },
      })).rejects.toMatchObject({ code: 'INVALID_FACT_GRAPH' });

      await expect(client.call('query', { resource: 'facts', chatKey: first.chatKey })).resolves.toEqual([]);
      await expect(client.call('query', { resource: 'jobs', chatKey: first.chatKey })).resolves.toEqual([]);
      await expect(client.call('query', { resource: 'job_batch_audits', chatKey: first.chatKey })).resolves.toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('fails closed when an existing database already contains two current facts in one slot', async () => {
    const { client, directory } = await worker();
    const databasePath = path.join(directory, '_memory', 'memory.sqlite3');
    const first = fact('fact:existing-slot:first');
    const second = {
      ...fact('fact:existing-slot:second'),
      objectKey: '3',
      canonicalKey: 'hour2::weapon_count::3',
      content: '小时2当前拥有三把紫电枪。',
    };
    let replacement: MemorySqliteWorkerClient | null = null;
    try {
      await client.call('command', {
        requestId: 'existing-slot-seed',
        action: 'fact.upsert',
        payload: { expectedSlotFactId: null, fact: first, evidence: [evidence(first.id)] },
      });
      await client.close();

      const database = new DatabaseSync(databasePath);
      database.prepare(`INSERT INTO facts (
        id, chat_key, kind, subject_key, predicate_key, object_key, canonical_key, slot_key,
        content, confidence, status, freshest_evidence_at, valid_from, valid_until, origin,
        revision, supersedes_id, superseded_by_id, created_at, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        second.id, second.chatKey, second.kind, second.subjectKey, second.predicateKey, second.objectKey,
        second.canonicalKey, second.slotKey, second.content, second.confidence, second.status,
        second.freshestEvidenceAt, null, null, second.origin, second.revision, null, null,
        second.createdAt, second.updatedAt, JSON.stringify(second),
      );
      database.close();

      replacement = new MemorySqliteWorkerClient(databasePath);
      const unrelated = factAtSlot('fact:unrelated-after-conflict', 'unrelated_slot');
      await expect(replacement.call('command', {
        requestId: 'existing-slot-must-fail-closed',
        action: 'ingest.commit',
        payload: {
          job: job(1),
          facts: [unrelated],
          evidence: [evidence(unrelated.id)],
          audit: audit(1),
        },
      })).rejects.toMatchObject({ code: 'INVALID_FACT_GRAPH' });

      await expect(replacement.call('query', {
        resource: 'fact', chatKey: unrelated.chatKey, filters: { id: unrelated.id },
      })).resolves.toBeNull();
      await expect(replacement.call('query', { resource: 'jobs', chatKey: unrelated.chatKey })).resolves.toEqual([]);
      await expect(replacement.call('query', {
        resource: 'job_batch_audits', chatKey: unrelated.chatKey,
      })).resolves.toEqual([]);
    } finally {
      await replacement?.close();
      await client.close();
    }
  });

  it('stores Float32 BLOBs, rejects invalid vectors and returns ordered cosine results', async () => {
    const { client } = await worker();
    try {
      for (const [index, vector] of [[0, [1, 0]], [1, [0.8, 0.2]], [2, [-1, 0]]] as const) {
        const row = factAtSlot(`fact:${index}`, `weapon_count_${index}`);
        await client.call('command', { requestId: `fact:${index}`, action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: row, evidence: [evidence(row.id)] } });
        await client.call('command', {
          requestId: `vector:${index}`,
          action: 'vector.upsert',
          payload: { factId: row.id, chatKey: row.chatKey, contentHash: contentHash(embeddingText(row)), resourceId: 'embed', model: 'test', vector },
        });
      }
      const matches = await client.call('vectorSearch', { chatKey: 'chat:test', vector: [1, 0], limit: 2 });
      expect(matches.map((item: { factId: string }) => item.factId)).toEqual(['fact:0', 'fact:1']);
      expect(matches[0].score).toBeCloseTo(1, 6);
      await expect(client.call('command', {
        requestId: 'vector:invalid',
        action: 'vector.upsert',
        payload: { factId: 'fact:0', chatKey: 'chat:test', contentHash: 'bad', resourceId: 'embed', model: 'test', vector: [Number.NaN] },
      })).rejects.toThrow(/NaN|Infinity/);
      expect(await client.call('query', { resource: 'vector_coverage', chatKey: 'chat:test' }))
        .toMatchObject({ totalFacts: 3, ready: 3, missing: 0, coverage: 1 });
      const original = factAtSlot('fact:0', 'weapon_count_0');
      const renamed = {
        ...original,
        subjectKey: 'hour2-renamed',
        canonicalKey: 'hour2-renamed::weapon_count_0::2',
        slotKey: 'hour2-renamed::weapon_count_0',
        revision: 2,
      };
      await client.call('command', {
        requestId: 'fact:0:rename', action: 'fact.upsert', payload: { expectedRevision: 1, expectedSlotFactId: null, fact: renamed, evidence: [evidence(renamed.id)] },
      });
      expect(await client.call('query', { resource: 'vector_coverage', chatKey: 'chat:test' }))
        .toMatchObject({ totalFacts: 3, ready: 2, missing: 1, stale: 0 });
      expect(await client.call('vectorSearch', { chatKey: 'chat:test', vector: [1, 0], limit: 3 }))
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ factId: renamed.id })]));
    } finally {
      await client.close();
    }
  });

  it('健康状态只用 active 事实计算覆盖率，但不会把历史事实向量误报为孤儿', async () => {
    const { client, directory } = await worker();
    try {
      for (const [id, predicate] of [['fact:active', 'active_slot'], ['fact:history', 'history_slot']] as const) {
        const row = factAtSlot(id, predicate);
        await client.call('command', {
          requestId: `coverage:${id}`, action: 'fact.upsert',
          payload: { expectedSlotFactId: null, fact: row, evidence: [evidence(row.id)] },
        });
        await client.call('command', {
          requestId: `coverage-vector:${id}`, action: 'vector.upsert',
          payload: {
            factId: row.id, chatKey: row.chatKey, contentHash: contentHash(embeddingText(row)),
            resourceId: 'embed', model: 'test', vector: [1, 0],
          },
        });
      }
      const database = new DatabaseSync(path.join(directory, '_memory', 'memory.sqlite3'));
      const history = factAtSlot('fact:history', 'history_slot');
      database.prepare('UPDATE facts SET status = ?, payload_json = ? WHERE id = ?')
        .run('superseded', JSON.stringify({ ...history, status: 'superseded' }), history.id);
      database.close();

      expect(await client.call('health', { chatKey: 'chat:test' })).toMatchObject({
        vectorCoverage: { eligibleFacts: 1, indexedFacts: 1, orphaned: 0 },
      });
    } finally {
      await client.close();
    }
  });

  it('requires chatKey for fact and vector reads/deletes and never performs a global vector clear', async () => {
    const { client } = await worker();
    try {
      const row = fact();
      await client.call('command', {
        requestId: 'chat-key-fact', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: row, evidence: [evidence()] },
      });
      await client.call('command', {
        requestId: 'chat-key-vector', action: 'vector.upsert',
        payload: { factId: row.id, chatKey: row.chatKey, contentHash: contentHash(embeddingText(row)), resourceId: 'embed', model: 'test', vector: [1, 0] },
      });

      await expect(client.call('query', { resource: 'fact', filters: { id: row.id } })).rejects.toThrow(/chatKey/);
      await expect(client.call('query', { resource: 'fact_vectors', filters: { factId: row.id } })).rejects.toThrow(/chatKey/);
      await expect(client.call('command', {
        requestId: 'delete-vector-no-chat', action: 'vector.delete', payload: { factId: row.id },
      })).rejects.toThrow(/chatKey/);
      await expect(client.call('command', {
        requestId: 'clear-vector-no-chat', action: 'vector.clear', payload: {},
      })).rejects.toThrow(/chatKey/);
      await expect(client.call('query', {
        resource: 'fact_vectors', chatKey: 'chat:other', filters: { factId: row.id },
      })).resolves.toBeNull();
      await expect(client.call('command', {
        requestId: 'delete-vector-other-chat', action: 'vector.delete', payload: { factId: row.id, chatKey: 'chat:other' },
      })).resolves.toMatchObject({ result: { removed: false } });
      await expect(client.call('query', {
        resource: 'fact_vectors', chatKey: row.chatKey, filters: { factId: row.id },
      })).resolves.toMatchObject({ factId: row.id });
    } finally {
      await client.close();
    }
  });

  it('rolls failed transactions back and exports/imports a verified SQLite snapshot', async () => {
    const source = await worker();
    const target = await worker();
    try {
      await expect(source.client.call('command', {
        requestId: 'broken-ingest',
        action: 'ingest.commit',
        payload: { facts: [fact()], evidence: [evidence('fact:missing')] },
      })).rejects.toThrow();
      expect(await source.client.call('query', { resource: 'facts', chatKey: 'chat:test' })).toEqual([]);

      await source.client.call('command', {
        requestId: 'valid-ingest', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: fact(), evidence: [evidence()] },
      });
      const exported = await source.client.call('backupExport');
      expect(Buffer.from(exported.data).subarray(0, 16).toString('ascii')).toBe('SQLite format 3\0');
      const imported = await target.client.call('backupImport', exported);
      expect(imported.tableCounts).toMatchObject({ facts: 1, evidence: 1 });
      expect(await target.client.call('query', { resource: 'facts', chatKey: 'chat:test' })).toEqual([fact()]);
    } finally {
      await Promise.all([source.client.close(), target.client.close()]);
    }
  });

  it('restores a complete pre-batch snapshot and pauses the owning job atomically', async () => {
    const { client } = await worker();
    try {
      const before = fact();
      const after = { ...before, content: '小时2当前拥有三把紫电枪。', revision: 2, updatedAt: 2_000 };
      const job = {
        id: 'job:one', chatKey: before.chatKey, type: 'incremental', status: 'running',
        checkpoint: { batchIndex: 2, processedCount: 10 }, createdAt: 1_000, updatedAt: 2_000,
      };
      await client.call('command', { requestId: 'before', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: before, evidence: [evidence()] } });
      await client.call('command', {
        requestId: 'batch',
        action: 'ingest.commit',
        payload: {
          job,
          snapshot: {
            id: 'snapshot:one', chatKey: before.chatKey, jobId: job.id, batchIndex: 2,
            facts: [before], evidence: [evidence()], createdAt: 1_500,
          },
          facts: [after],
          audit: {
            id: 'audit:one', chatKey: before.chatKey, jobId: job.id, batchIndex: 2,
            sourceRefs: ['message:1'], accepted: 1, rejected: 0, duplicated: 0, pending: 0,
            superseded: 0, rejections: [], startedAt: 1_500, completedAt: 2_000, usage: null,
          },
        },
      });
      await client.call('command', {
        requestId: 'rollback', action: 'batch.rollback', payload: { jobId: job.id, batchIndex: 2, chatKey: before.chatKey },
      });
      expect(await client.call('query', { resource: 'fact', chatKey: before.chatKey, filters: { id: before.id } })).toEqual(before);
      expect(await client.call('query', { resource: 'jobs', chatKey: before.chatKey }))
        .toMatchObject([{ status: 'paused', checkpoint: { batchIndex: 1 } }]);
    } finally {
      await client.close();
    }
  });

  it('rejects cross-chat moves and foreign-key ownership pollution for every write family', async () => {
    const { client } = await worker();
    try {
      await client.call('command', { requestId: 'owner-fact', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: fact(), evidence: [evidence()] } });
      await expect(client.call('command', {
        requestId: 'move-fact', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: fact('fact:one', 'chat:other') },
      })).rejects.toMatchObject({ code: 'CROSS_CHAT' });
      await expect(client.call('command', {
        requestId: 'foreign-evidence', action: 'fact.upsert',
        payload: { expectedSlotFactId: null, fact: fact('fact:two', 'chat:other'), evidence: [evidence('fact:two', 'chat:test')] },
      })).rejects.toMatchObject({ code: 'CROSS_CHAT' });
      await client.call('command', { requestId: 'owner-job', action: 'job.put', payload: { job: job(1) } });
      await expect(client.call('command', {
        requestId: 'foreign-audit', action: 'ingest.commit', payload: { audit: audit(1, 'chat:other') },
      })).rejects.toMatchObject({ code: 'CROSS_CHAT' });
      await expect(client.call('command', {
        requestId: 'foreign-vector', action: 'vector.upsert',
        payload: { factId: 'fact:one', chatKey: 'chat:other', resourceId: 'r', model: 'm', vector: [1] },
      })).rejects.toMatchObject({ code: 'CROSS_CHAT' });
    } finally {
      await client.close();
    }
  });

  it('stores incremental inverse snapshots and rolls back the selected batch plus every later batch', async () => {
    const { client, directory } = await worker();
    try {
      const original = fact();
      await client.call('command', { requestId: 'seed', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: original, evidence: [evidence()] } });
      const untouched = factAtSlot('fact:untouched', 'untouched');
      await client.call('command', {
        requestId: 'seed-untouched', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: untouched, evidence: [evidence(untouched.id)] },
      });
      const batchOne = { ...original, content: '第一批修改后的事实内容。', revision: 2, updatedAt: 2_000 };
      const batchTwo = { ...original, content: '第二批修改后的事实内容。', revision: 3, updatedAt: 3_000 };
      const addedLater = factAtSlot('fact:added-later', 'added_later_slot');
      await client.call('command', {
        requestId: 'batch-one', action: 'ingest.commit',
        payload: { job: job(1), facts: [batchOne], evidence: [], audit: audit(1), accepted: 1 },
      });
      const snapshotDb = new DatabaseSync(path.join(directory, '_memory', 'memory.sqlite3'), { readOnly: true });
      const snapshotRow = snapshotDb.prepare("SELECT payload_json FROM batch_snapshots WHERE id = 'batch-snapshot:job:sequence:1'").get() as { payload_json: string };
      const snapshot = JSON.parse(snapshotRow.payload_json);
      snapshotDb.close();
      expect(snapshot).toMatchObject({ mode: 'inverse-v1', factStates: [{ id: original.id }] });
      expect(snapshot.factStates).toHaveLength(1);
      expect(snapshot.evidenceStates).toHaveLength(1);
      await client.call('command', {
        requestId: 'batch-two', action: 'ingest.commit',
        payload: {
          job: job(2), facts: [batchTwo, addedLater], evidence: [evidence(addedLater.id)], audit: audit(2), accepted: 2,
        },
      });
      await client.call('command', {
        requestId: 'rollback-one', action: 'batch.rollback', payload: { jobId: 'job:sequence', batchIndex: 1, chatKey: 'chat:test' },
      });
      expect(await client.call('query', { resource: 'fact', chatKey: 'chat:test', filters: { id: original.id } })).toEqual(original);
      expect(await client.call('query', { resource: 'fact', chatKey: 'chat:test', filters: { id: addedLater.id } })).toBeNull();
      expect(await client.call('query', { resource: 'fact', chatKey: 'chat:test', filters: { id: untouched.id } })).toEqual(untouched);
      const audits = await client.call('query', { resource: 'job_batch_audits', chatKey: 'chat:test', filters: { jobId: 'job:sequence' } });
      expect(audits).toHaveLength(2);
      expect(audits.every((item: { rolledBackAt?: number }) => typeof item.rolledBackAt === 'number')).toBe(true);

      await client.call('command', {
        requestId: 'batch-one-after-rollback', action: 'ingest.commit',
        payload: { job: job(1), facts: [batchOne], evidence: [], audit: audit(1), accepted: 1 },
      });
      await client.call('command', {
        requestId: 'rollback-one-again', action: 'batch.rollback', payload: { jobId: 'job:sequence', batchIndex: 1, chatKey: 'chat:test' },
      });
      expect(await client.call('query', { resource: 'fact', chatKey: 'chat:test', filters: { id: original.id } })).toEqual(original);
    } finally {
      await client.close();
    }
  });

  it('captures deleted facts and evidence in inverse snapshots and restores them on rollback', async () => {
    const { client } = await worker();
    try {
      const original = fact();
      await client.call('command', {
        requestId: 'delete-snapshot-seed', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: original, evidence: [evidence()] },
      });
      await client.call('command', {
        requestId: 'delete-snapshot-batch', action: 'ingest.commit',
        payload: { job: job(1), facts: [], evidence: [], deletedFactIds: [original.id], audit: audit(1) },
      });
      await expect(client.call('query', {
        resource: 'fact', chatKey: original.chatKey, filters: { id: original.id },
      })).resolves.toBeNull();
      await client.call('command', {
        requestId: 'delete-snapshot-rollback', action: 'batch.rollback',
        payload: { jobId: 'job:sequence', batchIndex: 1, chatKey: original.chatKey },
      });
      await expect(client.call('query', {
        resource: 'fact', chatKey: original.chatKey, filters: { id: original.id },
      })).resolves.toEqual(original);
      await expect(client.call('query', {
        resource: 'evidence', chatKey: original.chatKey, filters: { factId: original.id },
      })).resolves.toEqual([evidence()]);
    } finally {
      await client.close();
    }
  });

  it('accepts the frontend audit-only ingest.commit payload without protocol drift', async () => {
    const { client } = await worker();
    try {
      await client.call('command', { requestId: 'audit-job', action: 'job.put', payload: { job: job(1) } });
      await expect(client.call('command', {
        requestId: 'audit-only', action: 'ingest.commit', payload: { audit: audit(1) },
      })).resolves.toMatchObject({ result: { accepted: 0, facts: [] } });
      await expect(client.call('query', {
        resource: 'job_batch_audits', chatKey: 'chat:test', filters: { jobId: 'job:sequence' },
      })).resolves.toMatchObject([{ id: 'audit:1' }]);
    } finally {
      await client.close();
    }
  });

  it('rejects stale ingest reconciliation with revision and slot optimistic locks', async () => {
    const { client } = await worker();
    try {
      const current = fact();
      await client.call('command', { requestId: 'optimistic-seed', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: current, evidence: [evidence()] } });
      await expect(client.call('command', {
        requestId: 'stale-revision', action: 'ingest.commit',
        payload: { job: job(1), facts: [], evidence: [], baseRevisions: { [current.id]: 0 } },
      })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(client.call('command', {
        requestId: 'stale-slot', action: 'ingest.commit',
        payload: {
          job: job(1), facts: [], evidence: [], baseRevisions: { [current.id]: 1 },
          baseSlotFactIds: { [current.slotKey]: null },
        },
      })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(client.call('query', { resource: 'jobs', chatKey: 'chat:test' })).resolves.toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('serializes backup replacement before following commands and rejects a wrong schema version', async () => {
    const source = await worker();
    const target = await worker();
    try {
      await source.client.call('command', {
        requestId: 'backup-seed', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: fact(), evidence: [evidence()] },
      });
      const exported = await source.client.call('backupExport');
      const afterImport = factAtSlot('fact:after-import', 'after_import');
      await Promise.all([
        target.client.call('backupImport', exported),
        target.client.call('command', { requestId: 'after-import', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: afterImport, evidence: [evidence(afterImport.id)] } }),
      ]);
      const facts = await target.client.call('query', { resource: 'facts', chatKey: 'chat:test' });
      expect(new Set(facts.map((item: { id: string }) => item.id))).toEqual(new Set(['fact:one', 'fact:after-import']));

      const invalidPath = path.join(target.directory, 'invalid-schema.sqlite3');
      await writeFile(invalidPath, Buffer.from(exported.data));
      const invalid = new DatabaseSync(invalidPath);
      invalid.prepare("UPDATE metadata SET value = '1' WHERE key = 'schema_version'").run();
      invalid.close();
      await expect(target.client.call('backupImport', { data: await readFile(invalidPath) }))
        .rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });

      const foreignKeyPath = path.join(target.directory, 'invalid-foreign-key.sqlite3');
      await writeFile(foreignKeyPath, Buffer.from(exported.data));
      const invalidForeignKey = new DatabaseSync(foreignKeyPath);
      invalidForeignKey.exec('PRAGMA foreign_keys = OFF');
      invalidForeignKey.prepare("UPDATE evidence SET fact_id = 'missing:fact'").run();
      invalidForeignKey.close();
      await expect(target.client.call('backupImport', { data: await readFile(foreignKeyPath) }))
        .rejects.toThrow(/外键/);
    } finally {
      await Promise.all([source.client.close(), target.client.close()]);
    }
  });
});

describe('Memory SQLite user isolation', () => {
  it('derives databases only from the authenticated SillyTavern user root', async () => {
    const service = new MemorySqliteService();
    const firstRoot = await mkdtemp(path.join(tmpdir(), 'memory-user-a-'));
    const secondRoot = await mkdtemp(path.join(tmpdir(), 'memory-user-b-'));
    cleanup.push(firstRoot, secondRoot);
    try {
      await service.call(firstRoot, 'command', { requestId: 'same', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: fact(), evidence: [evidence()] } });
      const second = await service.call(secondRoot, 'query', { resource: 'facts', chatKey: 'chat:test' });
      expect(second).toEqual([]);
      expect(service.resolveUserDatabase(firstRoot)).toBe(path.join(path.resolve(firstRoot), '_memory', 'memory.sqlite3'));
    } finally {
      await service.close();
    }
  });

  it('rebuilds a failed user worker without retaining hanging requests', async () => {
    const service = new MemorySqliteService();
    const root = await mkdtemp(path.join(tmpdir(), 'memory-worker-restart-'));
    cleanup.push(root);
    try {
      const failed = service.forUser(root) as MemorySqliteWorkerClient & { worker: { terminate(): Promise<number> } };
      await failed.call('health');
      await failed.worker.terminate();
      await new Promise(resolve => setTimeout(resolve, 20));
      const replacement = service.forUser(root);
      expect(replacement).not.toBe(failed);
      await expect(replacement.call('health')).resolves.toMatchObject({ connected: true });
    } finally {
      await service.close();
    }
  });

  it('recovers the formal database from a durable import marker after an interrupted replacement', async () => {
    const { client, directory } = await worker();
    const databasePath = path.join(directory, '_memory', 'memory.sqlite3');
    try {
      await client.call('command', { requestId: 'recovery-seed', action: 'fact.upsert', payload: { expectedSlotFactId: null, fact: fact(), evidence: [evidence()] } });
      await client.close();
      await writeFile(`${databasePath}.import-marker.json`, JSON.stringify({ stage: 'previous_saved', temp: `${databasePath}.missing-temp` }));
      await import('node:fs/promises').then(fs => fs.rename(databasePath, `${databasePath}.before-import`));
      const recovered = new MemorySqliteWorkerClient(databasePath);
      try {
        await expect(recovered.call('query', { resource: 'facts', chatKey: 'chat:test' })).resolves.toEqual([fact()]);
      } finally {
        await recovered.close();
      }
    } finally {
      await client.close();
    }
  });

  it('fails explicitly when the formal database file is read-only', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'memory-readonly-'));
    cleanup.push(directory);
    const databasePath = path.join(directory, '_memory', 'memory.sqlite3');
    const seed = new MemorySqliteWorkerClient(databasePath);
    await seed.call('health');
    await seed.close();
    await chmod(databasePath, 0o444);
    const readonly = new MemorySqliteWorkerClient(databasePath);
    try {
      await expect(readonly.call('command', {
        requestId: 'readonly-write', action: 'setting.set',
        payload: { setting: { id: 'setting:readonly', namespace: 'memory', key: 'readonly', value: true, updatedAt: Date.now() } },
      })).rejects.toMatchObject({ code: expect.stringMatching(/SQLITE|WORKER/u) });
    } finally {
      await readonly.close();
      await chmod(databasePath, 0o666);
    }
  });

  it('rejects a corrupted formal database without silently replacing it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'memory-corrupt-'));
    cleanup.push(directory);
    const memoryDirectory = path.join(directory, '_memory');
    const databasePath = path.join(memoryDirectory, 'memory.sqlite3');
    await mkdir(memoryDirectory, { recursive: true });
    const corruptBytes = Buffer.from('not a sqlite database; preserve for diagnosis', 'utf8');
    await writeFile(databasePath, corruptBytes);
    const corrupted = new MemorySqliteWorkerClient(databasePath);
    try {
      await expect(corrupted.call('health')).rejects.toMatchObject({ code: expect.stringMatching(/SQLITE|WORKER/u) });
      await expect(readFile(databasePath)).resolves.toEqual(corruptBytes);
    } finally {
      await corrupted.close();
    }
  });
});

describe('Memory SQLite HTTP route error mapping', () => {
  it('maps stale revisions to 409 and a real SQLite lock to 503', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memory-http-route-'));
    cleanup.push(root);
    const posts = new Map<string, (req: any, res: any) => Promise<void>>();
    const router = {
      get: () => undefined,
      post: (routePath: string, handler: (req: any, res: any) => Promise<void>) => posts.set(routePath, handler),
    };
    const invoke = async (body: unknown) => {
      let status = 200;
      let response: any;
      const res = {
        status(value: number) { status = value; return this; },
        json(value: unknown) { response = value; return this; },
      };
      await posts.get('/v1/command')?.({ body, user: { directories: { root } } }, res);
      return { status, response };
    };
    await init(router);
    try {
      const row = fact();
      await expect(invoke({
        requestId: 'http-seed', action: 'fact.upsert',
        payload: { expectedRevision: null, expectedSlotFactId: null, fact: row, evidence: [evidence()] },
      })).resolves.toMatchObject({ status: 200, response: { ok: true } });
      await expect(invoke({
        requestId: 'http-stale', action: 'fact.upsert',
        payload: {
          expectedRevision: 0,
          expectedSlotFactId: row.id,
          fact: { ...row, revision: 2 },
          evidence: [evidence()],
        },
      })).resolves.toMatchObject({ status: 409, response: { error: { code: 'REVISION_CONFLICT' } } });

      const databasePath = path.join(root, '_memory', 'memory.sqlite3');
      const lock = new DatabaseSync(databasePath);
      lock.exec('BEGIN IMMEDIATE');
      try {
        const other = factAtSlot('fact:http-busy', 'busy');
        await expect(invoke({
          requestId: 'http-busy', action: 'fact.upsert',
          payload: { expectedRevision: null, expectedSlotFactId: null, fact: other, evidence: [evidence(other.id)] },
        })).resolves.toMatchObject({ status: 503, response: { error: { code: 'SQLITE_BUSY' } } });
      } finally {
        lock.exec('ROLLBACK');
        lock.close();
      }
    } finally {
      await exit();
    }
  }, 15_000);
});
