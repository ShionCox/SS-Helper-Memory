import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8')) as Record<string, unknown>;
}

describe('版本元数据', () => {
  it('分别声明插件 V0.0.2 与服务端 0.0.1', async () => {
    const manifest = await readJson('manifest.json');
    const clientPackage = await readJson('package.json');
    const serverPackage = await readJson('server/package.json');

    expect(manifest.version).toBe('V0.0.2');
    expect(clientPackage).not.toHaveProperty('version');
    expect(serverPackage.version).toBe('0.0.1');
  });
});
