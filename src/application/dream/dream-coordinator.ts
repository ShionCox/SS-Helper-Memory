import type { ActorMemoryTrace, DreamJob, DreamNarrative, ProfileClaim } from '../../domain';

export interface DreamApplyResult {
  readonly ownerId: string;
  readonly traceIds: readonly string[];
  readonly profileClaims: readonly ProfileClaim[];
  readonly links: readonly Record<string, unknown>[];
  /** Repository transaction identifiers, when apply was committed as a ChangeSet. */
  readonly changeSetId?: string;
  readonly undoToken?: string;
}

export interface DreamAudit {
  readonly id: string;
  readonly jobId: string;
  readonly ownerId: string;
  readonly phases: readonly DreamJob['phase'][];
  readonly applied: boolean;
  readonly traceIds: readonly string[];
  readonly createdAt: number;
  readonly changeSetId?: string;
  readonly undoToken?: string;
  readonly rolledBackAt?: number;
}

export interface DreamCoordinatorOptions {
  readonly enabled?: boolean;
  readonly automaticApply?: boolean;
  readonly traceThreshold?: number;
  readonly floorThreshold?: number;
  readonly idleMs?: number;
}

function createId(prefix: string): string { return `${prefix}:${crypto.randomUUID()}`; }

/** Per-owner SWS/REM/consolidation/compaction/apply scheduler. */
export class DreamCoordinator {
  readonly options: Required<DreamCoordinatorOptions> = { enabled: true, automaticApply: true, traceThreshold: 20, floorThreshold: 50, idleMs: 30_000 };
  private static readonly workspaceApplyLocks = new Set<string>();
  private readonly jobs = new Map<string, DreamJob>();
  private readonly audits = new Map<string, DreamAudit>();
  private applyLock = false;
  constructor(options: DreamCoordinatorOptions = {}) { Object.assign(this.options, options); }

  listJobs(): DreamJob[] { return [...this.jobs.values()].map(job => structuredClone(job)); }
  listAudits(): DreamAudit[] { return [...this.audits.values()].map(audit => structuredClone(audit)); }
  reset(): void { this.jobs.clear(); this.audits.clear(); this.applyLock = false; }
  /** Remove queued derived work that was invalidated by a parent Capture undo. */
  forgetJob(jobId: string): void { this.jobs.delete(jobId); }
  hydrateJobs(records: readonly DreamJob[]): void {
    for (const record of records) {
      if (!record.id || !record.ownerId || !Array.isArray(record.traceIds)) continue;
      this.jobs.set(record.id, structuredClone(record));
    }
  }
  hydrateAudits(records: readonly DreamAudit[]): void {
    for (const record of records) if (record.id && record.jobId && record.ownerId) this.audits.set(record.id, structuredClone(record));
  }
  /** Return queued/running work so a host can resume it after restart. */
  recoverPending(): DreamJob[] { return this.listJobs().filter(job => job.status === 'queued' || job.status === 'running'); }

  shouldTrigger(input: { readonly ownerId: string; readonly addedTraceCount: number; readonly visibleFloorCount: number; readonly salient?: number }): boolean {
    return this.options.enabled && (input.addedTraceCount >= this.options.traceThreshold || input.visibleFloorCount >= this.options.floorThreshold || (input.salient ?? 0) >= 0.85);
  }

  enqueue(input: { readonly workspaceId: string; readonly chatKey: string; readonly ownerId: string; readonly traceIds: readonly string[]; readonly trigger?: DreamJob['trigger'] }): DreamJob {
    const timestamp = Date.now();
    const job: DreamJob = { id: createId('dream-job'), workspaceId: input.workspaceId, chatKey: input.chatKey, ownerId: input.ownerId, status: 'queued', phase: 'gather', trigger: input.trigger ?? 'manual', traceIds: [...new Set(input.traceIds)], createdAt: timestamp, updatedAt: timestamp };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  async run(jobId: string, traces: readonly ActorMemoryTrace[], apply: (result: DreamApplyResult) => Promise<void | Partial<DreamApplyResult>> | void | Partial<DreamApplyResult>, options: { readonly dryRun?: boolean; readonly narrative?: boolean } = {}): Promise<{ job: DreamJob; audit: DreamAudit; narrative?: DreamNarrative }> {
    const original = this.jobs.get(jobId);
    if (!original) throw new Error('Dream job 不存在。');
    const workspaceLockKey = original.workspaceId || '__unbound__';
    if (!options.dryRun && (this.applyLock || DreamCoordinator.workspaceApplyLocks.has(workspaceLockKey))) throw new Error('当前工作区已有 Dream Apply 事务运行。');
    if (!options.dryRun) {
      this.applyLock = true;
      DreamCoordinator.workspaceApplyLocks.add(workspaceLockKey);
    }
    const selected = traces.filter(trace => trace.ownerId === original.ownerId && original.traceIds.includes(trace.id));
    const phases: DreamJob['phase'][] = ['gather', 'sws', 'rem', 'consolidation', 'compaction'];
    let job: DreamJob = { ...original, status: options.dryRun ? 'dry-run' : 'running', phase: 'gather', updatedAt: Date.now() };
    this.jobs.set(job.id, job);
    try {
      for (const phase of phases) { job = { ...job, phase, updatedAt: Date.now() }; this.jobs.set(job.id, job); }
      // SWS/REM/consolidation/compaction are deterministic derived operations.
      // Source facts and traces remain untouched; links are rebuilt from the
      // selected owner's permitted traces and can be restored by the ChangeSet.
      const deduped = [...new Map(selected.map(trace => [trace.factId, trace])).values()];
      const sws = selected.map(trace => ({
        id: `dream-sws:${job.id}:${trace.id}`,
        ownerId: original.ownerId,
        traceId: trace.id,
        phase: 'sws',
        retained: trace.strength >= 25,
        decayedStrength: Math.max(0, trace.strength * 0.97),
        createdAt: Date.now(),
      }));
      const rem = deduped.slice(1).map((trace, index) => ({
        id: `dream-rem:${job.id}:${index}`,
        ownerId: original.ownerId,
        traceId: trace.id,
        associatedTraceId: deduped[index]?.id,
        phase: 'rem',
        createdAt: Date.now(),
      }));
      const consolidation = deduped.slice(1).map((trace, index) => ({
        id: `dream-link:${job.id}:${index}`,
        ownerId: original.ownerId,
        traceId: trace.id,
        previousTraceId: deduped[index]?.id,
        phase: 'consolidation',
        strength: trace.strength,
        createdAt: Date.now(),
      }));
      const links = [...sws, ...rem, ...consolidation, { id: `dream-compaction:${job.id}`, ownerId: original.ownerId, phase: 'compaction', sourceTraceCount: selected.length, retainedTraceCount: sws.filter(item => item.retained).length, createdAt: Date.now() }];
      let result: DreamApplyResult = { ownerId: original.ownerId, traceIds: selected.map(trace => trace.id), profileClaims: [], links };
      if (!options.dryRun && this.options.automaticApply) {
        const applied = await apply(result);
        if (applied) result = { ...result, ...applied, traceIds: applied.traceIds ?? result.traceIds, profileClaims: applied.profileClaims ?? result.profileClaims, links: applied.links ?? result.links };
        job = { ...job, phase: 'apply', status: 'applied', appliedAt: Date.now(), updatedAt: Date.now() };
      }
      else job = { ...job, phase: 'apply', status: options.dryRun ? 'dry-run' : 'applied', updatedAt: Date.now() };
      this.jobs.set(job.id, job);
      const audit: DreamAudit = { id: createId('dream-audit'), jobId: job.id, ownerId: job.ownerId, phases: [...phases, 'apply'], applied: !options.dryRun && this.options.automaticApply, traceIds: result.traceIds, createdAt: Date.now(), ...(result.changeSetId ? { changeSetId: result.changeSetId } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) };
      this.audits.set(audit.id, audit);
      const narrative = options.narrative ? { id: createId('dream-narrative'), workspaceId: job.workspaceId, dreamJobId: job.id, ownerId: job.ownerId, fictional: true as const, content: `（文学梦境，仅供叙事，不属于事实证据）\n梦境阶段：${phases.join(' → ')}；涉及 ${result.traceIds.length} 条证据。`, createdAt: Date.now() } : undefined;
      return { job: structuredClone(job), audit: structuredClone(audit), ...(narrative ? { narrative } : {}) };
    } catch (error) {
      job = { ...job, status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
      this.jobs.set(job.id, job);
      throw error;
    } finally {
      if (!options.dryRun) {
        this.applyLock = false;
        DreamCoordinator.workspaceApplyLocks.delete(workspaceLockKey);
      }
    }
  }

  async rollback(auditId: string, rollback: (audit: DreamAudit) => Promise<void> | void): Promise<void> {
    const audit = this.audits.get(auditId);
    if (!audit) throw new Error('Dream audit 不存在。');
    await rollback(audit);
    this.audits.set(auditId, { ...audit, rolledBackAt: Date.now() });
    const job = this.jobs.get(audit.jobId);
    if (job) this.jobs.set(job.id, { ...job, status: 'rolled-back', updatedAt: Date.now() });
  }
}
