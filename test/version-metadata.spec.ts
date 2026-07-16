import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8')) as Record<string, unknown>;
}

describe('版本元数据', () => {
  it('只声明裸 SemVer 前端插件版本，不再拥有 Memory 服务端版本', async () => {
    const manifest = await readJson('manifest.json');
    const clientPackage = await readJson('package.json');
    const config = await readJson('plugin.config.json');

    expect(manifest.version).toBe('0.0.2');
    expect(clientPackage).not.toHaveProperty('version');
    expect(config.kind).toBe('frontend-extension');
  });
});
