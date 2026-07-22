import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const forbidden = [
  /(?:\.\.\/){2,}SDK\//u,
  /window\.STX/u,
  /globalSTX/u,
  /\bfetch\s*\(/u,
  /getRequestHeaders/u,
  /SillyTavern\.getContext/u,
  /MemoryOS/iu,
  /stx_memory_os/iu,
  /#extensions_settings/u,
  /renderMemorySettings/u,
  /registerConsumer\s*\(/u,
  /stx:memory-state/u,
  /--memory-/u,
  /\bstx-ui-/u,
  /\bstx-memory-(?:button|input|chip|select-wrap)\b/u,
];

const executableExtensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.css']);

const historicalDocExceptions = new Map();

export function shouldScan(path) {
  if (path.startsWith('src/')) return executableExtensions.has(extname(path));
  if (path.startsWith('test/fixtures/')) {
    // This fixture intentionally supplies a neutral host API contract, not a legacy use.
    return path !== 'test/fixtures/sdk/tavern.ts' && executableExtensions.has(extname(path));
  }
  return path === 'README.md'
    || (path.startsWith('docs/') && path.endsWith('.md'))
    || path === 'manifest.json'
    || path === 'package.json'
    || path === 'server/package.json';
}

async function listGitTrackedPaths() {
  const [{ stdout }, { stdout: deleted }] = await Promise.all([
    execFileAsync('git', ['ls-files', '-z']),
    execFileAsync('git', ['ls-files', '--deleted', '-z']),
  ]);
  const deletedPaths = new Set(deleted.split('\0').filter(Boolean));
  return stdout.split('\0').filter((path) => !deletedPaths.has(path) && shouldScan(path));
}

export async function trackedScanPaths({
  listTrackedPaths = listGitTrackedPaths,
  checkAccess = access,
} = {}) {
  const paths = await listTrackedPaths();
  for (const path of paths) {
    try {
      await checkAccess(path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`legacy scan cannot access tracked candidate ${path}: ${detail}`);
    }
  }
  return paths;
}

function isHistoricalException(path, pattern) {
  return historicalDocExceptions.get(path)?.has(pattern.source) ?? false;
}

export async function scanLegacyReferences({
  listTrackedPaths,
  checkAccess,
  readContents = readFile,
} = {}) {
  const violations = [];
  let paths;
  try {
    paths = await trackedScanPaths({ listTrackedPaths, checkAccess });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [`legacy scan failure: ${detail}`];
  }
  for (const path of paths) {
    let contents;
    try {
      contents = await readContents(path, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      violations.push(`${path}: unable to read tracked candidate: ${detail}`);
      continue;
    }
    for (const pattern of forbidden) {
      if (pattern.test(contents) && !isHistoricalException(path, pattern)) {
        violations.push(`${path}: ${pattern}`);
      }
    }
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await scanLegacyReferences();

  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('legacy scan PASS');
  }
}
