import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RelationshipGraphInvalidation } from '../src/ui/relationship-graph-three';

describe('relationship graph rendering invalidation', () => {
  it('consumes expensive selection, label and rect work only after invalidation', () => {
    const invalidation = new RelationshipGraphInvalidation();
    expect(invalidation.takeSelection()).toBe(true);
    expect(invalidation.takeLabels()).toBe(true);
    expect(invalidation.takeRects()).toBe(true);
    expect(invalidation.takeSelection()).toBe(false);
    expect(invalidation.takeLabels()).toBe(false);
    expect(invalidation.takeRects()).toBe(false);

    invalidation.invalidateLabels();
    expect(invalidation.takeSelection()).toBe(false);
    expect(invalidation.takeLabels()).toBe(true);
    expect(invalidation.takeRects()).toBe(false);

    invalidation.invalidateRects();
    expect(invalidation.takeLabels()).toBe(true);
    expect(invalidation.takeRects()).toBe(true);

    invalidation.invalidateSelection();
    expect(invalidation.takeSelection()).toBe(true);
    expect(invalidation.takeLabels()).toBe(true);
  });

  it('keeps DOM measurement outside the animation loop and caps balanced pixel ratio', async () => {
    const source = await readFile(new URL('../src/ui/relationship-graph-three.ts', import.meta.url), 'utf8');
    const animate = source.slice(source.indexOf('function animate('), source.indexOf('\n\n  onResize();'));
    expect(animate).not.toContain('getBoundingClientRect');
    expect(animate).toContain('if (invalidation.takeLabels()) updateLabelLayout();');
    expect(source).toContain('const MAX_GRAPH_PIXEL_RATIO = 1.5;');
    expect(source).toContain("strength: .58, radius: .9, threshold: .23");
    expect(source).toContain('nodeNeighbors.get(selectedNode)?.has(nodeId)');
    expect(source).toContain('focused ? .96 : .3');
    expect(source).toContain('selectedNode ? .2 : .7');
    expect(source).toContain("material.opacity = active || connected ? .98 : selectedEdge || selectedEvent ? .2");
    expect(source).not.toContain('edge.weight >= threshold');
    expect(source).toContain('eventRelatedEdgeIds.has(edge.id)');
    expect(source).toContain('selectedEvent ? eventRelatedEdgeIds.has(edgeId)');
    expect(source).toContain('if (state.selectedEdgeId) focusSelectedEdge();');
    expect(source).toContain('camera.position.lerpVectors(focusAnimation.cameraFrom, focusAnimation.cameraTo, eased);');
  });
});
