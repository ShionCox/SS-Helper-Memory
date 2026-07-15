import { describe, expect, it } from 'vitest';
import { scanLegacyReferences, shouldScan, trackedScanPaths } from '../scripts/legacy-scan.mjs';

describe('legacy scan coverage', () => {
  it('covers tracked source, executable fixtures, manifests, and shipped documentation', () => {
    expect(shouldScan('src/entry.ts')).toBe(true);
    expect(shouldScan('test/fixtures/example/index.js')).toBe(true);
    expect(shouldScan('manifest.json')).toBe(true);
    expect(shouldScan('server/package.json')).toBe(true);
    expect(shouldScan('README.md')).toBe(true);
    expect(shouldScan('docs/sdk-migration-baseline.md')).toBe(true);
    expect(shouldScan('test/fixtures/sdk/tavern.ts')).toBe(false);
  });

  it('fails closed when a tracked candidate cannot be accessed', async () => {
    await expect(trackedScanPaths({
      listTrackedPaths: async () => ['src/entry.ts'],
      checkAccess: async () => { throw new Error('EACCES'); },
    })).rejects.toThrow('legacy scan cannot access tracked candidate src/entry.ts: EACCES');
  });

  it('reports a violation when a tracked candidate cannot be accessed', async () => {
    await expect(scanLegacyReferences({
      listTrackedPaths: async () => ['src/entry.ts'],
      checkAccess: async () => { throw new Error('EACCES'); },
    })).resolves.toEqual(['legacy scan failure: legacy scan cannot access tracked candidate src/entry.ts: EACCES']);
  });

  it('reports a violation when a tracked candidate cannot be read', async () => {
    await expect(scanLegacyReferences({
      listTrackedPaths: async () => ['src/entry.ts'],
      checkAccess: async () => undefined,
      readContents: async () => { throw new Error('EIO'); },
    })).resolves.toEqual(['src/entry.ts: unable to read tracked candidate: EIO']);
  });
});
