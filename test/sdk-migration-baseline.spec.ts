import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 服务端以原生 JS 发布，G0 直接验证其运行时常量。
import { BUSINESS_TABLES, PROTOCOL_VERSION, SCHEMA_VERSION } from '../server/schema.js';

const root = path.resolve(import.meta.dirname, '..');

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function json(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await text(relativePath)) as Record<string, unknown>;
}

describe('SDK 迁移前架构基线', () => {
  it('锁定插件、服务端和协议的单一版本来源', async () => {
    const [manifest, rootPackage, serverPackage, worker, repository] = await Promise.all([
      json('manifest.json'),
      json('package.json'),
      json('server/package.json'),
      text('server/sqlite-worker.js'),
      text('src/infrastructure/memory-repository.ts'),
    ]);

    expect(manifest.version).toBe('V0.0.2');
    expect(rootPackage).not.toHaveProperty('version');
    expect(serverPackage.version).toBe('0.0.1');
    expect(worker).toContain("import packageMetadata from './package.json' with { type: 'json' }");
    expect(worker).toContain('const SERVER_VERSION = packageMetadata.version');
    expect(PROTOCOL_VERSION).toBe(1);
    expect(SCHEMA_VERSION).toBe(2);
    expect(repository).toContain('const EXPECTED_PROTOCOL_VERSION = 1');
    expect(repository).toContain('const EXPECTED_SCHEMA_VERSION = 2');
  });

  it('锁定 SQLite 业务表、固定路径和浏览器无持久化所有权', async () => {
    const [readme, schema, service, client] = await Promise.all([
      text('README.md'),
      text('server/schema.js'),
      text('server/service.js'),
      text('src/infrastructure/memory-sqlite-client.ts'),
    ]);

    expect(BUSINESS_TABLES).toEqual([
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
    expect(schema).toContain('PRAGMA foreign_keys = ON');
    expect(schema).toContain('PRAGMA journal_mode = WAL');
    expect(schema).toContain('PRAGMA synchronous = NORMAL');
    expect(schema).toContain('PRAGMA busy_timeout = 5000');
    expect(service).toContain("path.resolve(root, '_memory', 'memory.sqlite3')");
    expect(client).toContain("const DEFAULT_BASE_URL = '/api/plugins/ss-helper-memory/v1'");
    expect(client).toContain("this.post<T>('/query', { resource, ...options })");
    expect(client).toContain("this.post<T>('/command', { requestId, action, payload })");
    expect(client).toContain('await port.send(request');
    expect(client).not.toContain('getRequestHeaders');
    expect(client).not.toContain('X-CSRF');
    expect(client).not.toContain('X-Content-SHA256');
    expect(client).not.toContain('Authorization');
    expect(client).not.toContain('globalSTX');
    expect(client).not.toContain('window.STX');
    expect(client).not.toContain('SillyTavern.getContext');
    expect(client).not.toMatch(/\bfetch\s*\(/u);
    expect(readme).toContain('SQLite 数据库作为唯一持久化来源');
    expect(readme).toContain('浏览器不使用 IndexedDB、Dexie、localStorage');
  });

  it('锁定 SDK HostPort、Core 设置和 popup workbench 边界', async () => {
    const [runtime, ui, css, extractor] = await Promise.all([
      text('src/host/memory-runtime.ts'),
      text('src/ui/memory-ui.ts'),
      text('src/ui/memory.css'),
      text('src/application/ingest/llm-extractor.ts'),
    ]);

    expect(runtime).toContain("import type { PluginSession } from '@ss-helper/sdk'");
    expect(runtime).toContain('registerMemoryContributions(');
    expect(runtime).toContain("events.subscribe('prompt-ready'");
    expect(runtime).toContain('this.session.host.prompt.set(');
    expect(runtime).not.toContain('window.STX');
    expect(runtime).not.toContain('renderMemorySettings(');
    expect(ui).not.toContain('#extensions_settings');
    expect(ui).toContain("document.createElement('dialog')");
    expect(ui).toContain('dialog.id = WORKBENCH_ID');
    expect(ui).toContain('dialog.showModal()');
    expect(css).not.toMatch(/SDK\/tailwind\.css/u);
    expect(extractor).not.toContain('STX?.llm');
    expect(extractor).toContain('configuredLlmApi');
  });

  it('锁定公共 capture、recall、query 和 write 能力入口', async () => {
    const [api, client, application] = await Promise.all([
      text('src/index.ts'),
      text('src/infrastructure/memory-sqlite-client.ts'),
      text('src/application/memory-application.ts'),
    ]);

    expect(api).toContain('capture: {');
    expect(api).toContain('flush(): Promise<void>');
    expect(api).toContain('recall: {');
    expect(api).toContain("preview(input: Omit<RecallQuery, 'chatKey'>");
    expect(api).toContain('upsert(input: ManualFactInput): Promise<MemoryFact>');
    expect(api).toContain('remove(id: string): Promise<void>');
    expect(client).toContain("return this.post<T>('/query'");
    expect(client).toContain("return this.post<T>('/command'");
    expect(application).toContain('this.capture = { flush:');
    expect(application).toContain('this.recall = { preview:');
  });

  it('不恢复被废弃的版本和 API 标记', async () => {
    const combined = (await Promise.all([
      text('manifest.json'),
      text('package.json'),
      text('README.md'),
      text('src/index.ts'),
    ])).join('\n');
    expect(combined).not.toMatch(/Memory 3\.0|Memory v2|Memory v3|MemoryPluginApiV3|memory-v2|3\.0\.0/u);
  });
});

