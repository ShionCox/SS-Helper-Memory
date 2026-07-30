import type { PlainData, WorkspaceQueryPredicate } from '@ss-helper/sdk';

export interface MemoryPageRequest {
  readonly cursor?: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly query?: string;
  readonly filter?: Readonly<Record<string, PlainData>>;
  readonly where?: readonly WorkspaceQueryPredicate[];
  readonly orderBy?: { readonly field: string; readonly direction?: 'asc' | 'desc' };
  readonly includeTotal?: boolean;
}

export interface MemoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly total?: number;
}

export type MemoryPageResource =
  | 'facts'
  | 'evidence'
  | 'actors'
  | 'actor-aliases'
  | 'actor-candidates'
  | 'scene-casts'
  | 'episodes'
  | 'observations'
  | 'memory-traces'
  | 'profiles'
  | 'profile-claims'
  | 'dream-jobs'
  | 'generation-cast-plans'
  | 'cast-plan-audits'
  | 'recall-coverage-logs'
  | 'memory-usage-logs'
  | 'change-audits'
  | 'usage'
  | 'graph-edges';
