import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryGraphPreview } from '../src/domain';
import { buildGraphLayout, selectGraphView } from '../src/ui/relationship-graph-layout';

const graph: MemoryGraphPreview = {
  nodes: [
    { id: 'a', label: '艾琳' },
    { id: 'b', label: '雷暴' },
    { id: 'c', label: '港口城' },
    { id: 'd', label: '北区' },
    { id: 'e', label: '商队' },
    { id: 'f', label: '法师塔' },
    { id: 'g', label: '护送商队' },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', predicate: '害怕', kind: 'event', status: 'active', confidence: .9, backingFactId: 'f1' },
    { id: 'e2', from: 'a', to: 'c', predicate: '居住于', kind: 'location', status: 'active', confidence: .88, backingFactId: 'f2' },
    { id: 'e3', from: 'c', to: 'd', predicate: '位于', kind: 'location', status: 'active', confidence: .86, backingFactId: 'f3' },
    { id: 'e4', from: 'e', to: 'f', predicate: '所属', kind: 'relationship', status: 'active', confidence: .82, backingFactId: 'f4' },
    { id: 'e5', from: 'e', to: 'g', predicate: '护送', kind: 'commitment', status: 'active', confidence: .8, backingFactId: 'f5' },
  ],
};

describe('relationship graph layout', () => {
  it('produces deterministic 3D positions and at most six display clusters', () => {
    const first = buildGraphLayout(graph, new Set(graph.edges.map((edge) => edge.id)));
    const second = buildGraphLayout(graph, new Set(graph.edges.map((edge) => edge.id)));
    expect(first.nodes.map(({ id, x, y, z }) => ({ id, x, y, z }))).toEqual(second.nodes.map(({ id, x, y, z }) => ({ id, x, y, z })));
    expect(first.clusters.length).toBeLessThanOrEqual(6);
    expect(first.clusters.length).toBeGreaterThan(1);
    expect(first.nodes.every((node) => [node.x, node.y, node.z].every(Number.isFinite))).toBe(true);
    expect(new Set(first.nodes.map((node) => node.id))).toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g']));
  });

  it('filters locally by query, kind, status and selected-node neighbors', () => {
    expect(selectGraphView(graph, '港口城').edges.map((edge) => edge.id)).toEqual(['e2', 'e3']);
    expect(selectGraphView(graph, '', 'location').edges.map((edge) => edge.id)).toEqual(['e2', 'e3']);
    expect(selectGraphView(graph, '', '', '', 'a', true).edges.map((edge) => edge.id)).toEqual(['e1', 'e2']);
  });

  it('does not leave the retired canvas renderer or command bus in the graph UI', () => {
    const root = resolve(process.cwd());
    expect(existsSync(resolve(root, 'src/ui/relationship-graph-canvas.ts'))).toBe(false);
    const ui = readFileSync(resolve(root, 'src/ui/memory-ui.ts'), 'utf8');
    const css = readFileSync(resolve(root, 'src/ui/memory.css'), 'utf8');
    for (const token of ['mountRelationshipGraphCanvas', 'dispatchRelationshipGraphCanvasCommand', 'RelationshipGraphViewport', 'stx-memory-relationship-graph-canvas', 'stx-memory-graph-sidebar']) {
      expect(`${ui}\n${css}`).not.toContain(token);
    }
  });
});
