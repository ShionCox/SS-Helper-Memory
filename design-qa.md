# Relationship graph visual QA

## Comparison target

- Source visual truth: `G:/vue/SS-Helpers/.tmp/graphrag-workbench/docs/screenshots/graphrag-workbench-2.0-community-macbook.webp`
- Rendered implementation: `C:/Users/liao/AppData/Local/Temp/ss-helper-graph-final.png`
- Shared comparison input: `C:/Users/liao/AppData/Local/Temp/graphrag-vs-memory-final-comparison.png`
- Viewport: deployed SillyTavern desktop capture (1534 × 1272). The GraphRAG reference was cropped to its application viewport and both implementations were normalized to the same 1200 × 768 comparison height.
- State: Memory graph with 20 visible nodes and 41 verified relationships. The established Memory workbench shell, navigation, and facts inspector intentionally remain product chrome.

## Evidence

- The shared side-by-side image compares the actual GraphRAG Workbench rendering with the deployed Memory graph. It verifies the left-inspector/right-canvas composition, black-space treatment, top control strip, 3D force layout, glowing nodes, bright relationship paths, translucent community boxes, and star-field depth.
- The deployed browser contains exactly one WebGL canvas, a selected fact relationship, and no WebGL-unavailable state after using the fit-view command.
- Browser console error inspection returned no errors.

## Comparison history

1. The pre-existing 2D-like layout was visually too sparse, too flat, and too far from the reference rendering.
   - Fix: adopted the reference project's 3D force parameters, Fibonacci/spherical distribution, Fresnel node shader, bloom/vignette, galaxy background, wireframe community bounds, energy edges, and orbit controls.
2. The first 3D implementation collapsed because `d3-force-3d` had been initialized as 2D and only later switched to three dimensions.
   - Fix: construct `forceSimulation(nodes, 3)` so `vz` is initialized, then assert every generated coordinate is finite.
3. Initial camera fitting could clip a community at some orbit angles, while CSS2D labels formed a flat cloud.
   - Fix: fit the complete 3D bounding sphere, use screen-space label decluttering, reserve toolbar space, and compact sparse factual communities only for display.
4. Final visual pass found that narrow WebGL lines hid overlapping factual relationships.
   - Fix: switched to Three.js `Line2` paths with weight-sensitive width and deterministic bends for parallel relations. This makes the real 41 fact edges visible without fabricating nodes or facts.

## Findings

- No actionable P0/P1/P2 findings remain for the Memory-specific adaptation.
- [P3] The reference screenshot contains a much larger entity corpus, so it naturally has denser micro-nodes than the current 20-node Memory graph. The implementation preserves that density when the factual graph grows, rather than inventing semantic nodes for visual fill.

## Verification checklist

- [x] Compare the local GraphRAG Workbench screenshot and the deployed Memory result in one shared visual input.
- [x] Verify 3D WebGL availability and a single renderer instance.
- [x] Verify selected relationship state and the fit-view command without recreating the canvas.
- [x] Verify the deployed local HTTP endpoint returns 200.
- [x] Verify Memory lint, complete Vitest suite, Vite build, root artifact build, and workspace verification.

final result: passed
