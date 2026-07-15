export interface LegacyScanDependencies {
  listTrackedPaths?: () => Promise<string[]>;
  checkAccess?: (path: string) => Promise<void>;
  readContents?: (path: string, encoding: 'utf8') => Promise<string>;
}

export function shouldScan(path: string): boolean;
export function trackedScanPaths(dependencies?: Pick<LegacyScanDependencies, 'listTrackedPaths' | 'checkAccess'>): Promise<string[]>;
export function scanLegacyReferences(dependencies?: LegacyScanDependencies): Promise<string[]>;
