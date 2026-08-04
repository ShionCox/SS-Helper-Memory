import type { InventoryState } from '../../domain';
import type { StructuredInventoryOperation } from '../ingest/types';
import type { TemporalState } from '../extraction/extraction-types';

export type InventoryUpdateDecision = 'create_item' | 'duplicate_noop' | 'apply_delta' | 'set_snapshot' | 'append_history' | 'pending_review' | 'reject';

export class InventoryUpdatePlanner {
  plan(operation: StructuredInventoryOperation, current: InventoryState | undefined, temporal: TemporalState, readSetValid = true): { readonly decision: InventoryUpdateDecision; readonly reasonCode: string } {
    if (!readSetValid) return { decision: 'pending_review', reasonCode: 'MEMORY_AGENT_TOOL_STALE_REVISION' };
    if (!operation.sourceRef || !operation.evidenceExcerpt.trim()) return { decision: 'reject', reasonCode: 'MEMORY_CAPTURE_EVIDENCE_MISMATCH' };
    if (!current) return { decision: operation.operation === 'set' ? 'create_item' : 'apply_delta', reasonCode: 'MEMORY_INVENTORY_CREATE' };
    if (current.unitKey && operation.unit && current.unitKey !== operation.unit.trim().toLocaleLowerCase('zh-CN')) {
      return { decision: 'pending_review', reasonCode: 'MEMORY_INVENTORY_UNIT_CONFLICT' };
    }
    if (temporal.validFrom !== undefined && current.updatedAt !== undefined && temporal.validFrom < current.updatedAt) {
      return { decision: 'append_history', reasonCode: 'MEMORY_UPDATE_APPEND_HISTORY' };
    }
    if (operation.operation === 'set' && operation.amount !== undefined && operation.amount === current.amount && operation.precision === current.precision) {
      return { decision: 'duplicate_noop', reasonCode: 'MEMORY_UPDATE_DUPLICATE' };
    }
    if (operation.operation === 'set') return { decision: 'set_snapshot', reasonCode: 'MEMORY_INVENTORY_SET' };
    return { decision: 'apply_delta', reasonCode: 'MEMORY_INVENTORY_DELTA' };
  }
}
