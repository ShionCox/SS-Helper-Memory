import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

function readPackedPackageJson(archive: Buffer): Record<string, unknown> {
  const tar = gunzipSync(archive);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const bodyStart = offset + 512;
    if (name === 'package/package.json') {
      return JSON.parse(tar.subarray(bodyStart, bodyStart + size).toString('utf8')) as Record<string, unknown>;
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error('SDK archive does not contain package/package.json');
}

describe('G012 G5C SDK managed artifact', () => {
  it('keeps the dependency, archive name and packed SDK metadata consistent', async () => {
    const [packageJson, sdkPackageJson, lockfile] = await Promise.all([
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../../SS-Helper-SDK/packages/sdk/package.json', import.meta.url), 'utf8'),
      readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
    ]);
    const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string> };
    const sdkManifest = JSON.parse(sdkPackageJson) as { name?: string; version?: string };
    const dependency = manifest.dependencies?.['@ss-helper/sdk'];
    expect(dependency).toBe(`file:vendor/ss-helper-sdk-${sdkManifest.version}.tgz`);
    if (dependency === undefined || !dependency.startsWith('file:')) throw new Error('SDK dependency must use a vendored file archive');
    const archive = await readFile(new URL(`../${dependency.slice('file:'.length)}`, import.meta.url));
    const packedManifest = readPackedPackageJson(archive);
    expect(packedManifest.name).toBe(sdkManifest.name);
    expect(packedManifest.version).toBe(sdkManifest.version);
    expect(lockfile).toContain(dependency);
    expect(lockfile).not.toMatch(/(?:workspace:|link:|I:\\|\.\.\/\.\.\/SDK|SillyTavern-SS-Helper)/u);
  });
});
