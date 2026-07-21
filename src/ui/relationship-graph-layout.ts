import * as d3 from 'd3-force-3d';
import type { MemoryGraphPreview } from '../domain';

export interface GraphLayoutNode {
  id: string;
  label: string;
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  degree: number;
  frequency: number;
  abstraction: number;
  size: number;
  clusterId: string;
  clusterLabel: string;
  color: string;
}

export interface GraphLayoutEdge {
  id: string;
  source: GraphLayoutNode;
  target: GraphLayoutNode;
  predicate: string;
  kind: string;
  confidence: number;
  weight: number;
}

export interface GraphCluster {
  id: string;
  label: string;
  nodeIds: string[];
  color: string;
  center: { x: number; y: number; z: number };
  radius: number;
  bounds: { center: [number, number, number]; size: [number, number, number]; padding: number };
}

export interface GraphLayout {
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  clusters: GraphCluster[];
}

export interface GraphViewSelection {
  edges: MemoryGraphPreview['edges'][number][];
  nodes: MemoryGraphPreview['nodes'][number][];
}

/**
 * These values deliberately mirror graphrag-workbench's 3D "knowledge
 * universe" defaults.  The Memory graph only adapts its confidence range to
 * the reference project's relationship weight range; it does not persist any
 * of this display-only geometry.
 */
export const MEMORY_KNOWLEDGE_UNIVERSE_FORCE_CONFIG = Object.freeze({
  chargeStrength: -100,
  linkDistance: 30,
  linkStrength: .2,
  collisionRadius: 6,
  communityStrength: .2,
  centerStrength: .02,
  spread3D: 150,
  levelSpacing: 40,
  sphericalConstraint: .05,
});

const CLUSTER_COLORS = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#a77bff'];
const KIND_COLORS: Readonly<Record<string, string>> = Object.freeze({
  relationship: '#39a8ff',
  location: '#62d990',
  world_rule: '#a47aff',
  goal: '#e5be52',
  commitment: '#ef944a',
  event: '#35c7bb',
});

export function graphKindColor(kind: string): string { return KIND_COLORS[kind] ?? '#8da6b8'; }

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function fibonacciPosition(index: number, total: number, radius: number, seed: number): { x: number; y: number; z: number } {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const fraction = total > 1 ? index / total : .5;
  const phi = Math.acos(1 - 2 * fraction);
  const theta = goldenAngle * index + ((seed % 360) * Math.PI / 180);
  const random = seededRandom(seed);
  const adjustedRadius = radius * (.9 + random() * .2);
  return {
    x: adjustedRadius * Math.sin(phi) * Math.cos(theta),
    y: adjustedRadius * Math.sin(phi) * Math.sin(theta),
    z: adjustedRadius * Math.cos(phi),
  };
}

function calculateNodeSize(degree: number, frequency: number): number {
  return Math.min(.8 + (degree + frequency * .1) * .15, 4);
}

function relationWeight(confidence: number): number {
  // The reference project accepts a roughly 1–20 relationship weight. Memory
  // confidence is 0–1, so this makes the two force equations comparable.
  return 1 + Math.max(0, Math.min(1, confidence)) * 19;
}

function chooseCommunityLabels(
  nodeIds: readonly string[],
  edges: readonly MemoryGraphPreview['edges'][number][],
): Map<string, string> {
  const ordered = [...nodeIds].sort((left, right) => left.localeCompare(right));
  if (ordered.length <= 4) return new Map(ordered.map((id) => [id, ordered[0]!] as const));
  const neighbors = new Map<string, Array<{ id: string; cost: number }>>();
  const degree = new Map<string, number>();
  for (const edge of edges) {
    const cost = 1 / Math.max(.05, edge.confidence);
    const from = neighbors.get(edge.from) ?? [];
    const to = neighbors.get(edge.to) ?? [];
    from.push({ id: edge.to, cost });
    to.push({ id: edge.from, cost });
    neighbors.set(edge.from, from);
    neighbors.set(edge.to, to);
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const distanceFrom = (source: string): Map<string, number> => {
    const distances = new Map(ordered.map((id) => [id, Number.POSITIVE_INFINITY] as const));
    const visited = new Set<string>();
    distances.set(source, 0);
    for (let step = 0; step < ordered.length; step += 1) {
      const current = ordered.filter((id) => !visited.has(id)).sort((left, right) => (distances.get(left) ?? Infinity) - (distances.get(right) ?? Infinity) || left.localeCompare(right))[0];
      if (!current || !Number.isFinite(distances.get(current))) break;
      visited.add(current);
      for (const neighbor of neighbors.get(current) ?? []) {
        const next = (distances.get(current) ?? Infinity) + neighbor.cost;
        if (next < (distances.get(neighbor.id) ?? Infinity)) distances.set(neighbor.id, next);
      }
    }
    return distances;
  };

  const desiredCount = Math.min(6, Math.max(2, Math.round(Math.sqrt(ordered.length / 2))));
  const seeds = [
    [...ordered].sort((left, right) => (degree.get(right) ?? 0) - (degree.get(left) ?? 0) || left.localeCompare(right))[0]!,
  ];
  const distanceBySeed = new Map<string, Map<string, number>>([[seeds[0]!, distanceFrom(seeds[0]!)] ]);
  while (seeds.length < desiredCount) {
    const candidate = ordered
      .filter((id) => !seeds.includes(id))
      .map((id) => ({ id, distance: Math.min(...seeds.map((seed) => distanceBySeed.get(seed)?.get(id) ?? Infinity)) }))
      .sort((left, right) => right.distance - left.distance || (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id))[0]?.id;
    if (!candidate) break;
    seeds.push(candidate);
    distanceBySeed.set(candidate, distanceFrom(candidate));
  }

  const membership = new Map<string, string>();
  const memberCount = new Map<string, number>(seeds.map((seed) => [seed, 0]));
  for (const seed of seeds) {
    membership.set(seed, seed);
    memberCount.set(seed, 1);
  }
  const assignOrder = ordered.filter((id) => !membership.has(id)).sort((left, right) => (degree.get(right) ?? 0) - (degree.get(left) ?? 0) || left.localeCompare(right));
  for (const nodeId of assignOrder) {
    const group = [...seeds]
      .map((seed) => ({ seed, score: (distanceBySeed.get(seed)?.get(nodeId) ?? Infinity) + (memberCount.get(seed) ?? 0) * .6 }))
      .sort((left, right) => left.score - right.score || (memberCount.get(left.seed) ?? 0) - (memberCount.get(right.seed) ?? 0) || left.seed.localeCompare(right.seed))[0]!.seed;
    membership.set(nodeId, group);
    memberCount.set(group, (memberCount.get(group) ?? 0) + 1);
  }
  return membership;
}

function calculateClusterCenters(nodes: readonly GraphLayoutNode[], clusters: readonly GraphCluster[]): Map<string, { x: number; y: number; z: number }> {
  const config = MEMORY_KNOWLEDGE_UNIVERSE_FORCE_CONFIG;
  const centers = new Map<string, { x: number; y: number; z: number }>();
  // The reference universe commonly displays hundreds of entities. Sparse
  // Memory graphs use the same spherical distribution, compacted only enough
  // to preserve visual relationships between their few verified facts.
  const sparseGraphScale = Math.min(1, Math.max(.46, Math.sqrt(nodes.length / 90)));
  for (const [index, cluster] of clusters.entries()) {
    const members = nodes.filter((node) => node.clusterId === cluster.id);
    if (!members.length) continue;
    const averageAbstraction = members.reduce((total, node) => total + node.abstraction, 0) / members.length;
    const radius = (config.spread3D * .1 + (1 - averageAbstraction) * (config.spread3D - config.spread3D * .1)) * sparseGraphScale;
    const center = fibonacciPosition(index, clusters.length, radius, hashString(cluster.id));
    centers.set(cluster.id, center);
  }
  return centers;
}

function updateClusterBounds(clusters: GraphCluster[], nodeMap: ReadonlyMap<string, GraphLayoutNode>): void {
  for (const cluster of clusters) {
    const members = cluster.nodeIds.map((id) => nodeMap.get(id)).filter((node): node is GraphLayoutNode => Boolean(node));
    if (!members.length) continue;
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const node of members) {
      minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
      minZ = Math.min(minZ, node.z); maxZ = Math.max(maxZ, node.z);
    }
    const padding = members.length <= 2 ? 18 : members.length <= 4 ? 26 : 35;
    const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    const size: [number, number, number] = [Math.max(padding, maxX - minX + padding), Math.max(padding, maxY - minY + padding), Math.max(padding, maxZ - minZ + padding)];
    cluster.bounds = { center, size, padding };
    cluster.center = { x: center[0], y: center[1], z: center[2] };
    cluster.radius = Math.max(18, Math.hypot(...size) / 2);
  }
}

export function selectGraphView(
  graph: MemoryGraphPreview,
  query = '',
  kind = '',
  status = '',
  focusNodeId = '',
  focusNeighbors = false,
): GraphViewSelection {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase();
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node] as const));
  let edges = graph.edges.filter((edge) => {
    if (kind && edge.kind !== kind) return false;
    if (status && edge.status !== status) return false;
    if (!needle) return true;
    const from = nodeMap.get(edge.from)?.label ?? '';
    const to = nodeMap.get(edge.to)?.label ?? '';
    return [from, to, edge.predicate, edge.kind].some((value) => value.normalize('NFKC').toLocaleLowerCase().includes(needle));
  });
  if (focusNeighbors && focusNodeId) edges = edges.filter((edge) => edge.from === focusNodeId || edge.to === focusNodeId);
  const nodeIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return {
    edges: [...edges].sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id)),
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
  };
}

export function buildGraphLayout(graph: MemoryGraphPreview, visibleEdgeIds?: ReadonlySet<string>, layoutSeed = 0): GraphLayout {
  const config = MEMORY_KNOWLEDGE_UNIVERSE_FORCE_CONFIG;
  const edges = graph.edges.filter((edge) => !visibleEdgeIds || visibleEdgeIds.has(edge.id)).sort((left, right) => left.id.localeCompare(right.id));
  const nodeIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const sourceNodes = graph.nodes.filter((node) => nodeIds.has(node.id)).sort((left, right) => left.id.localeCompare(right.id));
  if (!sourceNodes.length) return { nodes: [], edges: [], clusters: [] };

  const communityLabels = chooseCommunityLabels(sourceNodes.map((node) => node.id), edges);
  const grouped = new Map<string, string[]>();
  for (const node of sourceNodes) {
    const groupId = communityLabels.get(node.id) ?? node.id;
    const members = grouped.get(groupId) ?? [];
    members.push(node.id);
    grouped.set(groupId, members);
  }
  const clusters: GraphCluster[] = [...grouped.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([id, ids], index) => ({
      id,
      label: sourceNodes.find((node) => ids.includes(node.id))?.label ?? id,
      nodeIds: ids.sort(),
      color: CLUSTER_COLORS[index % CLUSTER_COLORS.length]!,
      center: { x: 0, y: 0, z: 0 },
      radius: 18,
      bounds: { center: [0, 0, 0], size: [35, 35, 35], padding: 35 },
    }));
  const clusterMap = new Map(clusters.map((cluster) => [cluster.id, cluster] as const));
  const degree = new Map<string, number>();
  const frequency = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    frequency.set(edge.from, (frequency.get(edge.from) ?? 0) + edge.confidence);
    frequency.set(edge.to, (frequency.get(edge.to) ?? 0) + edge.confidence);
  }
  const abstractionScores = sourceNodes.map((node) => (degree.get(node.id) ?? 0) + (frequency.get(node.id) ?? 0) * .5);
  const minAbstraction = Math.min(...abstractionScores);
  const maxAbstraction = Math.max(...abstractionScores);
  const layoutNodes: GraphLayoutNode[] = sourceNodes.map((node, index) => {
    const nodeDegree = degree.get(node.id) ?? 0;
    const nodeFrequency = frequency.get(node.id) ?? 0;
    const score = nodeDegree + nodeFrequency * .5;
    const abstraction = maxAbstraction > minAbstraction ? (score - minAbstraction) / (maxAbstraction - minAbstraction) : .5;
    const radius = config.spread3D * .1 + (1 - abstraction) * (config.spread3D - config.spread3D * .1);
    const position = fibonacciPosition(index, sourceNodes.length, radius, hashString(node.id) ^ layoutSeed);
    const clusterId = communityLabels.get(node.id) ?? node.id;
    const cluster = clusterMap.get(clusterId)!;
    return {
      ...position,
      id: node.id,
      label: node.label,
      degree: nodeDegree,
      frequency: nodeFrequency,
      abstraction,
      size: calculateNodeSize(nodeDegree, nodeFrequency),
      clusterId,
      clusterLabel: cluster.label,
      color: graphKindColor(edges.find((edge) => edge.from === node.id || edge.to === node.id)?.kind ?? ''),
    };
  });
  const layoutNodeMap = new Map(layoutNodes.map((node) => [node.id, node] as const));
  const layoutEdges: GraphLayoutEdge[] = edges.flatMap((edge) => {
    const source = layoutNodeMap.get(edge.from);
    const target = layoutNodeMap.get(edge.to);
    return source && target ? [{ id: edge.id, source, target, predicate: edge.predicate, kind: edge.kind, confidence: edge.confidence, weight: relationWeight(edge.confidence) }] : [];
  });
  const communityCenters = calculateClusterCenters(layoutNodes, clusters);
  const random = seededRandom(hashString(layoutNodes.map((node) => node.id).join('|')) ^ layoutSeed);
  // d3-force-3d initializes velocity components only when the dimensionality
  // is supplied at construction time. Calling numDimensions(3) afterwards
  // leaves `vz` undefined and collapses the next tick into NaN/zero.
  const simulation = d3.forceSimulation(layoutNodes, 3)
    .randomSource(random)
    .alphaDecay(.03)
    .alphaMin(.001)
    .force('link', d3.forceLink(layoutEdges).id((node: GraphLayoutNode) => node.id)
      .distance((edge: GraphLayoutEdge) => config.linkDistance / (edge.weight * .05 + 1))
      .strength((edge: GraphLayoutEdge) => Math.min(edge.weight * .05, config.linkStrength)))
    .force('charge', d3.forceManyBody().strength((node: GraphLayoutNode) => config.chargeStrength - node.degree * 5))
    .force('center', d3.forceCenter(0, 0, 0).strength(config.centerStrength))
    .force('collision', d3.forceCollide((node: GraphLayoutNode) => config.collisionRadius + node.size))
    .force('community', () => {
      for (const node of layoutNodes) {
        const center = communityCenters.get(node.clusterId);
        if (!center) continue;
        node.vx = (node.vx ?? 0) + (center.x - node.x) * config.communityStrength;
        node.vy = (node.vy ?? 0) + (center.y - node.y) * config.communityStrength;
        node.vz = (node.vz ?? 0) + (center.z - node.z) * config.communityStrength;
      }
    })
    .force('spherical', () => {
      for (const node of layoutNodes) {
        const targetRadius = config.spread3D * .1 + (1 - node.abstraction) * (config.spread3D - config.spread3D * .1);
        const currentDistance = Math.hypot(node.x, node.y, node.z);
        if (currentDistance < .0001) continue;
        const force = (targetRadius - currentDistance) * config.sphericalConstraint;
        node.vx = (node.vx ?? 0) + (node.x / currentDistance) * force;
        node.vy = (node.vy ?? 0) + (node.y / currentDistance) * force;
        node.vz = (node.vz ?? 0) + (node.z / currentDistance) * force;
      }
    });
  simulation.stop();
  for (let iteration = 0; iteration < 500 && simulation.alpha() >= .001; iteration += 1) simulation.tick();
  for (const node of layoutNodes) {
    node.x = Number.isFinite(node.x) ? node.x : 0;
    node.y = Number.isFinite(node.y) ? node.y : 0;
    node.z = Number.isFinite(node.z) ? node.z : 0;
  }
  updateClusterBounds(clusters, layoutNodeMap);
  return { nodes: layoutNodes, edges: layoutEdges, clusters };
}
