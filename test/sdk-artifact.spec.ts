import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const EXPECTED_SDK_SHA256 = 'b8feb5dd0eee34b39c39c1cddf3ff3f4a44dd537af8bb0f9f0991e49c9aff5c4';

describe('G012 G5C SDK managed artifact', () => {
  it('pins the exact approved tarball without workspace/link/absolute path dependencies', async () => {
    const [archive, packageJson, lockfile] = await Promise.all([
      readFile(new URL('../vendor/ss-helper-sdk-1.0.0.tgz', import.meta.url)),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
    ]);
    expect(createHash('sha256').update(archive).digest('hex')).toBe(EXPECTED_SDK_SHA256);
    const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.['@ss-helper/sdk']).toBe('file:vendor/ss-helper-sdk-1.0.0.tgz');
    expect(lockfile).not.toMatch(/(?:workspace:|link:|I:\\|\.\.\/\.\.\/SDK|SillyTavern-SS-Helper)/u);
  });
});
