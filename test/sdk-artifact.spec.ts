import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const EXPECTED_SDK_SHA256 = '53d02683cd1b8b7182428bb50b33a81a7e7ff06cc78dc9d57cc0794546197f12';

describe('G012 G5C SDK managed artifact', () => {
  it('pins the exact approved tarball without workspace/link/absolute path dependencies', async () => {
    const [archive, packageJson, lockfile] = await Promise.all([
      readFile(new URL('../vendor/ss-helper-sdk-2.0.0.tgz', import.meta.url)),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
    ]);
    expect(createHash('sha256').update(archive).digest('hex')).toBe(EXPECTED_SDK_SHA256);
    const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.['@ss-helper/sdk']).toBe('file:vendor/ss-helper-sdk-2.0.0.tgz');
    expect(lockfile).not.toMatch(/(?:workspace:|link:|I:\\|\.\.\/\.\.\/SDK|SillyTavern-SS-Helper)/u);
  });
});
