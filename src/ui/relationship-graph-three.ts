import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { MemoryGraphPreview } from '../domain';
import { buildGraphLayout, type GraphCluster, type GraphLayout, type GraphLayoutEdge, type GraphLayoutNode } from './relationship-graph-layout';

export type RelationshipGraphCommand = 'zoom-in' | 'zoom-out' | 'fit' | 'reset-layout' | 'toggle-orbit';

export interface RelationshipGraphViewState {
  graph: MemoryGraphPreview;
  visibleEdgeIds: ReadonlySet<string>;
  selectedNodeId: string;
  selectedEdgeId: string;
  reduceMotion?: boolean;
}

export interface RelationshipGraphRendererOptions extends RelationshipGraphViewState {
  onSelectNode(nodeId: string): void;
  onSelectEdge(edgeId: string): void;
  onRendererStateChange?(state: { autoOrbit: boolean; webglAvailable: boolean }): void;
}

export interface RelationshipGraphRenderer {
  update(state: RelationshipGraphViewState): void;
  command(command: RelationshipGraphCommand): void;
  dispose(): void;
}

const CAMERA_FOV = 60;
const BLOOM_SETTINGS = Object.freeze({ strength: .66, radius: 1.35, threshold: .2, vignette: .18 });

const VIGNETTE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: BLOOM_SETTINGS.vignette },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      float vignette = smoothstep(0.60, 0.98, d);
      color.rgb *= 1.0 - vignette * strength;
      gl_FragColor = color;
    }
  `,
};

function noOpRenderer(): RelationshipGraphRenderer {
  return { update: () => undefined, command: () => undefined, dispose: () => undefined };
}

function disposeMaterial(material: THREE.Material | THREE.Material[], disposed: Set<THREE.Material>): void {
  for (const item of Array.isArray(material) ? material : [material]) {
    if (disposed.has(item)) continue;
    disposed.add(item);
    item.dispose();
  }
}

function disposeObject(root: THREE.Object3D, preserveGeometry?: THREE.BufferGeometry): void {
  const disposed = new Set<THREE.Material>();
  root.traverse((object) => {
    const renderable = object as THREE.Mesh;
    if (renderable.geometry && renderable.geometry !== preserveGeometry) renderable.geometry.dispose();
    if (renderable.material) disposeMaterial(renderable.material, disposed);
  });
}

function deterministicGalaxy(count: number): { positions: Float32Array; colors: Float32Array } {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let value = 0x38a4f19;
  const random = (): number => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
  const cyan = new THREE.Color('#68d7ee');
  const teal = new THREE.Color('#53e0be');
  const color = new THREE.Color();
  for (let index = 0; index < count; index += 1) {
    const radius = 1200 + random() * 600;
    const angle = random() * Math.PI * 2;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = (random() - .5) * 150;
    positions[index * 3 + 2] = Math.sin(angle) * radius - 600;
    color.copy(cyan).lerp(teal, random());
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  return { positions, colors };
}

function makeLabel(text: string, className: string): CSS2DObject {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  element.title = text;
  return new CSS2DObject(element);
}

function edgeCurvePositions(edge: GraphLayoutEdge): number[] {
  const source = new THREE.Vector3(edge.source.x, edge.source.y, edge.source.z);
  const target = new THREE.Vector3(edge.target.x, edge.target.y, edge.target.z);
  const direction = target.clone().sub(source);
  const length = direction.length();
  if (length < .001) return [source.x, source.y, source.z, target.x, target.y, target.z];
  direction.multiplyScalar(1 / length);
  const referenceAxis = Math.abs(direction.y) < .78 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const normal = new THREE.Vector3().crossVectors(direction, referenceAxis).normalize();
  const binormal = new THREE.Vector3().crossVectors(direction, normal).normalize();
  let hash = 2166136261;
  for (let index = 0; index < edge.id.length; index += 1) {
    hash ^= edge.id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const phase = (hash >>> 0) / 0x100000000 * Math.PI * 2;
  const bend = (1.7 + Math.min(7, length * .075)) * (.62 + ((hash >>> 8) & 0xff) / 0xff * .48);
  const midpoint = source.clone().lerp(target, .5)
    .addScaledVector(normal, Math.cos(phase) * bend)
    .addScaledVector(binormal, Math.sin(phase) * bend);
  return [source.x, source.y, source.z, midpoint.x, midpoint.y, midpoint.z, target.x, target.y, target.z];
}

function makeEdgeGeometry(edge: GraphLayoutEdge): LineGeometry {
  const geometry = new LineGeometry();
  geometry.setPositions(edgeCurvePositions(edge));
  return geometry;
}

function edgeLineWidth(edge: GraphLayoutEdge): number {
  return Math.min(2.6, .95 + edge.weight * .08);
}

function createNodeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      colorCore: { value: new THREE.Color('#7de1ff') },
      colorRim: { value: new THREE.Color('#ff9bd5') },
      time: { value: 0 },
      opacity: { value: .85 },
    },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 colorCore;
      uniform vec3 colorRim;
      uniform float time;
      uniform float opacity;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float fresnel = pow(1.0 - max(dot(vN, vV), 0.0), 2.0);
        float core = smoothstep(0.0, 0.6, fresnel);
        vec3 color = mix(colorCore, colorRim, fresnel);
        float pulse = 0.6 + 0.4 * sin(time * 1.5);
        gl_FragColor = vec4(color * (core * 1.2 + pulse * 0.15), opacity);
      }
    `,
  });
}

function createEnergyMesh(edge: GraphLayoutEdge): THREE.Mesh {
  const source = new THREE.Vector3(edge.source.x, edge.source.y, edge.source.z);
  const target = new THREE.Vector3(edge.target.x, edge.target.y, edge.target.z);
  const curve = new THREE.CatmullRomCurve3([source, target]);
  const geometry = new THREE.TubeGeometry(curve, 32, Math.max(.06, (.2 + edge.weight * .1) * .2), 6, false);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      time: { value: 0 },
      c1: { value: new THREE.Color('#6be6ff') },
      c2: { value: new THREE.Color('#ff8bcb') },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec3 c1;
      uniform vec3 c2;
      varying vec2 vUv;
      void main() {
        float t = fract(vUv.x - time * 0.8);
        float band = smoothstep(0.0, 0.05, t) * smoothstep(0.2, 0.15, t);
        vec3 color = mix(c1, c2, t);
        gl_FragColor = vec4(color * (0.5 + band * 2.0), 0.7);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.edgeId = edge.id;
  return mesh;
}

function makeUnsupportedState(host: HTMLElement, reason: string): RelationshipGraphRenderer {
  host.replaceChildren();
  host.classList.add('is-webgl-unavailable');
  const message = document.createElement('div');
  message.className = 'stx-memory-graph-webgl-unavailable';
  message.setAttribute('role', 'status');
  message.innerHTML = `<i class="fa-solid fa-cubes-stacked" aria-hidden="true"></i><strong>三维画布暂不可用</strong><span>${reason}</span>`;
  host.append(message);
  return noOpRenderer();
}

export function mountRelationshipGraphThree(host: HTMLElement, initial: RelationshipGraphRendererOptions): RelationshipGraphRenderer {
  host.replaceChildren();
  host.classList.remove('is-webgl-unavailable');
  if (typeof window.WebGLRenderingContext !== 'function' && typeof window.WebGL2RenderingContext !== 'function') {
    return makeUnsupportedState(host, '当前浏览器没有可用的 WebGL 支持；请使用关系列表查看已验证事实。');
  }
  let webgl: THREE.WebGLRenderer;
  try {
    webgl = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    return makeUnsupportedState(host, '当前浏览器没有可用的 WebGL 支持；请使用关系列表查看已验证事实。');
  }
  webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  webgl.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
  webgl.outputColorSpace = THREE.SRGBColorSpace;
  webgl.toneMapping = THREE.ACESFilmicToneMapping;
  webgl.toneMappingExposure = 1.2;
  webgl.domElement.className = 'stx-memory-graph-webgl';
  webgl.domElement.tabIndex = 0;
  webgl.domElement.setAttribute('role', 'application');
  webgl.domElement.setAttribute('aria-label', '三维知识图谱画布。左键旋转，右键平移，滚轮缩放；可拖动节点调整本次浏览视图。');
  const onContextMenu = (event: MouseEvent): void => event.preventDefault();
  webgl.domElement.addEventListener('contextmenu', onContextMenu);
  host.append(webgl.domElement);

  const labels = new CSS2DRenderer();
  labels.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  labels.domElement.className = 'stx-memory-graph-label-layer';
  labels.domElement.setAttribute('aria-hidden', 'true');
  host.append(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#06070a');
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, .1, 5000);
  camera.position.set(140, 140, 140);
  const controls = new OrbitControls(camera, webgl.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .05;
  controls.screenSpacePanning = true;
  controls.minDistance = 10;
  controls.maxDistance = 2000;
  controls.maxPolarAngle = Math.PI;
  controls.minPolarAngle = 0;
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
  controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;

  scene.add(
    new THREE.AmbientLight('#ffffff', .6),
    new THREE.DirectionalLight('#a0b9ff', 1),
    new THREE.DirectionalLight('#7f8cff', .6),
  );
  const directionalLights = scene.children.filter((child): child is THREE.DirectionalLight => child instanceof THREE.DirectionalLight);
  directionalLights[0]?.position.set(100, 100, 120);
  directionalLights[1]?.position.set(-120, -80, -100);

  const nebulaGeometry = new THREE.PlaneGeometry(4000, 2500);
  const nebulaMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { cTop: { value: new THREE.Color('#101221') }, cBot: { value: new THREE.Color('#05060b') } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 cTop; uniform vec3 cBot; varying vec2 vUv; void main() { gl_FragColor = vec4(mix(cBot, cTop, vUv.y), 1.0); }`,
  });
  const nebula = new THREE.Mesh(nebulaGeometry, nebulaMaterial);
  nebula.position.set(0, 0, -800);
  scene.add(nebula);

  const galaxy = deterministicGalaxy(3500);
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(galaxy.positions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(galaxy.colors, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ vertexColors: true, size: .8, transparent: true, opacity: .35, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  scene.add(stars);

  const composer = new EffectComposer(webgl);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  composer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight)), BLOOM_SETTINGS.strength, BLOOM_SETTINGS.radius, BLOOM_SETTINGS.threshold);
  bloomPass.threshold = BLOOM_SETTINGS.threshold;
  bloomPass.strength = BLOOM_SETTINGS.strength;
  bloomPass.radius = BLOOM_SETTINGS.radius;
  const vignettePass = new ShaderPass(VIGNETTE_SHADER);
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(vignettePass);

  const graphRoot = new THREE.Group();
  scene.add(graphRoot);
  const nodeGeometry = new THREE.SphereGeometry(1, 24, 16);
  const nodeMeshes = new Map<string, THREE.Mesh>();
  const nodeLabels = new Map<string, CSS2DObject>();
  const edgeLines = new Map<string, Line2>();
  const edgeEnergy = new Map<string, THREE.Mesh>();
  const edgeMeta = new Map<string, GraphLayoutEdge>();
  const clusterMeshes = new Map<string, THREE.Mesh>();
  const clusterLabels = new Map<string, CSS2DObject>();
  const raycaster = new THREE.Raycaster();
  raycaster.params.Line.threshold = 3.4;
  const pointer = new THREE.Vector2();
  const pointerDown = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const dragPoint = new THREE.Vector3();
  const cameraDirection = new THREE.Vector3();
  let dragNode: GraphLayoutNode | undefined;
  let dragMesh: THREE.Mesh | undefined;
  let pointerId = -1;
  let dragged = false;
  let disposed = false;
  let frame = 0;
  let layoutRevision = 0;
  let lastFrame = performance.now();
  let autoOrbit = !initial.reduceMotion;
  let reduceMotion = Boolean(initial.reduceMotion);
  let current: RelationshipGraphViewState = { ...initial };
  let layout: GraphLayout = { nodes: [], edges: [], clusters: [] };
  let graphCenter = new THREE.Vector3();
  let graphSize = 200;
  let graphOrbitDistance = 200;
  let currentLayoutKey = '';

  const stateChange = (): void => initial.onRendererStateChange?.({ autoOrbit, webglAvailable: true });
  const stopAutoOrbit = (): void => {
    if (!autoOrbit) return;
    autoOrbit = false;
    stateChange();
  };
  controls.addEventListener('start', stopAutoOrbit);

  const layoutKey = (state: RelationshipGraphViewState): string => `${state.graph.edges.map((edge) => edge.id).join(',')}|${[...state.visibleEdgeIds].sort().join(',')}`;
  const edgeConnectedToNode = (edge: GraphLayoutEdge, nodeId: string): boolean => edge.source.id === nodeId || edge.target.id === nodeId;
  const selectedClusterId = (): string => layout.nodes.find((node) => node.id === current.selectedNodeId)?.clusterId ?? '';

  const clearGraphRoot = (): void => {
    for (const label of [...nodeLabels.values(), ...clusterLabels.values()]) {
      label.parent?.remove(label);
      label.element.remove();
    }
    nodeLabels.clear();
    clusterLabels.clear();
    nodeMeshes.clear();
    edgeLines.clear();
    edgeEnergy.clear();
    edgeMeta.clear();
    clusterMeshes.clear();
    while (graphRoot.children.length) {
      const child = graphRoot.children.pop();
      if (child) disposeObject(child, nodeGeometry);
    }
  };

  const calculateGraphBounds = (): { center: THREE.Vector3; size: number; radius: number } => {
    if (!layout.nodes.length) return { center: new THREE.Vector3(), size: 200, radius: 100 };
    const bounds = new THREE.Box3();
    for (const node of layout.nodes) bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
    const size = bounds.getSize(new THREE.Vector3());
    return {
      center: bounds.getCenter(new THREE.Vector3()),
      size: Math.max(size.x, size.y, size.z, 1),
      radius: Math.max(.5 * size.length(), 1),
    };
  };

  const fitCamera = (): void => {
    const bounds = calculateGraphBounds();
    graphCenter = bounds.center;
    graphSize = bounds.size;
    // The reference visualizer assumes hundreds of entities. Memory graphs
    // are smaller but can have deep z-extents, so fit the complete 3D bounds
    // rather than just their largest axis. This keeps the auto-orbit view
    // centred instead of clipping a community at particular angles.
    const verticalFov = THREE.MathUtils.degToRad(CAMERA_FOV);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const fitFov = Math.min(verticalFov, horizontalFov);
    const distance = Math.max(bounds.radius / Math.sin(fitFov / 2) * 1.1, 170);
    graphOrbitDistance = distance;
    controls.target.copy(graphCenter);
    camera.position.set(graphCenter.x + distance / Math.sqrt(3), graphCenter.y + distance / Math.sqrt(3), graphCenter.z + distance / Math.sqrt(3));
    camera.lookAt(graphCenter);
    controls.update();
  };

  const createBoundary = (cluster: GraphCluster): THREE.Mesh => {
    const [width, height, depth] = cluster.bounds.size;
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const material = new THREE.MeshBasicMaterial({ color: cluster.color, transparent: true, opacity: .15, wireframe: true, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    const [x, y, z] = cluster.bounds.center;
    mesh.position.set(x, y, z);
    mesh.renderOrder = 999;
    mesh.userData.clusterId = cluster.id;
    return mesh;
  };

  const makeEnergy = (edge: GraphLayoutEdge): void => {
    if (edgeEnergy.has(edge.id)) return;
    const mesh = createEnergyMesh(edge);
    graphRoot.add(mesh);
    edgeEnergy.set(edge.id, mesh);
  };
  const removeEnergy = (edgeId: string): void => {
    const mesh = edgeEnergy.get(edgeId);
    if (!mesh) return;
    graphRoot.remove(mesh);
    disposeObject(mesh);
    edgeEnergy.delete(edgeId);
  };
  const syncEnergyEdges = (): void => {
    const weights = layout.edges.map((edge) => edge.weight).sort((left, right) => left - right);
    const threshold = weights[Math.min(weights.length - 1, Math.max(0, Math.floor(weights.length * .9)))];
    const needed = new Set(layout.edges
      .filter((edge) => (threshold !== undefined && edge.weight >= threshold) || edge.id === current.selectedEdgeId || Boolean(current.selectedNodeId && edgeConnectedToNode(edge, current.selectedNodeId)))
      .map((edge) => edge.id));
    for (const edgeId of [...edgeEnergy.keys()]) if (!needed.has(edgeId)) removeEnergy(edgeId);
    for (const edge of layout.edges) if (needed.has(edge.id)) makeEnergy(edge);
  };
  const replaceEnergyGeometry = (edge: GraphLayoutEdge): void => {
    if (!edgeEnergy.has(edge.id)) return;
    removeEnergy(edge.id);
    makeEnergy(edge);
  };

  const updateEdgeGeometry = (edge: GraphLayoutEdge): void => {
    const line = edgeLines.get(edge.id);
    if (line) {
      line.geometry.setPositions(edgeCurvePositions(edge));
      line.computeLineDistances();
    }
    replaceEnergyGeometry(edge);
  };

  const rebuildScene = (state: RelationshipGraphViewState): void => {
    clearGraphRoot();
    layout = buildGraphLayout(state.graph, state.visibleEdgeIds, layoutRevision);
    currentLayoutKey = layoutKey(state);
    for (const cluster of layout.clusters) {
      const boundary = createBoundary(cluster);
      graphRoot.add(boundary);
      clusterMeshes.set(cluster.id, boundary);
      const label = makeLabel(cluster.label, 'stx-memory-graph-cluster-label');
      const [x, y, z] = cluster.bounds.center;
      label.position.set(x, y + cluster.bounds.size[1] / 2 + 6, z);
      scene.add(label);
      clusterLabels.set(cluster.id, label);
    }
    for (const edge of layout.edges) {
      const material = new LineMaterial({ color: '#8fa4bb', transparent: true, opacity: .72, depthWrite: false });
      material.resolution.set(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
      material.uniforms.linewidth.value = edgeLineWidth(edge);
      const line = new Line2(makeEdgeGeometry(edge), material);
      line.computeLineDistances();
      line.userData.edgeId = edge.id;
      line.userData.baseWidth = edgeLineWidth(edge);
      graphRoot.add(line);
      edgeLines.set(edge.id, line);
      edgeMeta.set(edge.id, edge);
    }
    for (const node of layout.nodes) {
      const mesh = new THREE.Mesh(nodeGeometry, createNodeMaterial());
      mesh.position.set(node.x, node.y, node.z);
      const sparseNodeScale = layout.nodes.length < 48 ? 1.45 : 1;
      const displaySize = node.size * sparseNodeScale;
      mesh.scale.setScalar(displaySize);
      mesh.userData.nodeId = node.id;
      mesh.userData.baseSize = displaySize;
      graphRoot.add(mesh);
      nodeMeshes.set(node.id, mesh);
      const label = makeLabel(node.label, 'stx-memory-graph-node-label');
      label.position.set(0, displaySize + 3, 0);
      mesh.add(label);
      nodeLabels.set(node.id, label);
    }
    syncEnergyEdges();
    fitCamera();
  };

  const updateHighlights = (time: number): void => {
    const selectedNode = current.selectedNodeId;
    const selectedEdge = current.selectedEdgeId;
    const selectedCluster = selectedClusterId();
    // drei's Text labels in graphrag-workbench are world-space text. CSS2D
    // labels are intentionally kept to the strongest factual anchors when
    // nothing is selected, otherwise a small graph turns into a flat label
    // cloud.  Selecting a node expands its local factual neighborhood.
    const overviewLabelIds = new Set([...layout.nodes]
      .sort((left, right) => right.degree - left.degree || right.frequency - left.frequency || left.id.localeCompare(right.id))
      .slice(0, Math.max(4, Math.min(9, Math.ceil(layout.nodes.length * .35))))
      .map((node) => node.id));
    const labelCandidates = [...layout.nodes]
      .filter((node) => selectedNode ? (node.id === selectedNode || edgeMeta.size > 0 && layout.edges.some((edge) => edgeConnectedToNode(edge, selectedNode) && edgeConnectedToNode(edge, node.id)) || node.clusterId === selectedCluster) : overviewLabelIds.has(node.id))
      .sort((left, right) => Number(right.id === selectedNode) - Number(left.id === selectedNode) || right.degree - left.degree || right.frequency - left.frequency || left.id.localeCompare(right.id));
    const visibleLabelIds = new Set<string>();
    const occupiedLabels: Array<{ x: number; y: number }> = [];
    const projection = new THREE.Vector3();
    const labelWidth = Math.max(1, host.clientWidth);
    const labelHeight = Math.max(1, host.clientHeight);
    const toolbar = host.closest('.stx-memory-graph-stage-panel')?.querySelector<HTMLElement>('.stx-memory-graph-toolbar');
    const toolbarRect = toolbar?.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    for (const node of labelCandidates) {
      const mesh = nodeMeshes.get(node.id);
      if (!mesh) continue;
      mesh.getWorldPosition(projection);
      projection.y += (mesh.userData.baseSize as number) + 3;
      projection.project(camera);
      const x = (projection.x * .5 + .5) * labelWidth;
      const y = (-projection.y * .5 + .5) * labelHeight;
      const behindCamera = projection.z < -1 || projection.z > 1;
      const underToolbar = Boolean(toolbarRect && x + hostRect.left > toolbarRect.left - 18 && x + hostRect.left < toolbarRect.right + 18 && y + hostRect.top > toolbarRect.top - 18 && y + hostRect.top < toolbarRect.bottom + 18);
      const collides = occupiedLabels.some((occupied) => Math.hypot(occupied.x - x, occupied.y - y) < (selectedNode ? 27 : 31));
      if (behindCamera || underToolbar || collides) continue;
      occupiedLabels.push({ x, y });
      visibleLabelIds.add(node.id);
    }
    for (const node of layout.nodes) {
      const mesh = nodeMeshes.get(node.id);
      if (!mesh) continue;
      const active = node.id === selectedNode;
      const connected = Boolean(selectedNode && layout.edges.some((edge) => edgeConnectedToNode(edge, selectedNode) && edgeConnectedToNode(edge, node.id)));
      const inSelectedCluster = !selectedCluster || node.clusterId === selectedCluster;
      const scale = (mesh.userData.baseSize as number) * (active ? 1.5 : connected ? 1.25 : 1);
      mesh.scale.setScalar(scale);
      const material = mesh.material as THREE.ShaderMaterial;
      const opacity = selectedNode && !inSelectedCluster ? .25 : .85;
      material.uniforms.opacity.value = opacity;
      (material.uniforms.colorCore.value as THREE.Color).set(active ? '#b6f3ff' : '#7de1ff');
      material.uniforms.time.value = reduceMotion ? 0 : time * .001;
      const label = nodeLabels.get(node.id);
      if (label) {
        const visible = visibleLabelIds.has(node.id);
        label.visible = visible;
        label.element.classList.toggle('is-selected', active);
        label.element.classList.toggle('is-muted', Boolean(selectedNode && !inSelectedCluster));
      }
    }
    for (const edge of layout.edges) {
      const line = edgeLines.get(edge.id);
      if (!line) continue;
      const active = edge.id === selectedEdge;
      const connected = Boolean(selectedNode && edgeConnectedToNode(edge, selectedNode));
      const insideSelectedCluster = !selectedCluster || (edge.source.clusterId === selectedCluster && edge.target.clusterId === selectedCluster);
      const material = line.material;
      material.color.set(active || connected ? '#ffffff' : '#8893a2');
      material.opacity = active || connected ? .95 : selectedNode && !insideSelectedCluster ? .25 : .7;
      material.uniforms.linewidth.value = (line.userData.baseWidth as number) * (active || connected ? 1.65 : 1);
    }
    for (const cluster of layout.clusters) {
      const mesh = clusterMeshes.get(cluster.id);
      if (!mesh) continue;
      const active = Boolean(selectedCluster && cluster.id === selectedCluster);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.color.set(active ? '#ffaa00' : cluster.color);
      material.opacity = selectedCluster && !active ? .06 : active ? .25 : .15;
      clusterLabels.get(cluster.id)?.element.classList.toggle('is-selected', active);
    }
    for (const mesh of edgeEnergy.values()) {
      const material = mesh.material as THREE.ShaderMaterial;
      material.uniforms.time.value = reduceMotion ? 0 : time * .001;
      const edgeId = String(mesh.userData.edgeId);
      mesh.visible = !selectedNode || edgeConnectedToNode(edgeMeta.get(edgeId)!, selectedNode) || edgeId === selectedEdge;
    }
  };

  const setPointer = (event: PointerEvent): void => {
    const rect = webgl.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
  };
  const pick = (event: PointerEvent): { nodeId?: string; edgeId?: string } => {
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    const nodeHit = raycaster.intersectObjects([...nodeMeshes.values()], false)[0];
    if (nodeHit?.object.userData.nodeId) return { nodeId: String(nodeHit.object.userData.nodeId) };
    const edgeHit = raycaster.intersectObjects([...edgeLines.values()], false)[0];
    if (edgeHit?.object.userData.edgeId) return { edgeId: String(edgeHit.object.userData.edgeId) };
    return {};
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    stopAutoOrbit();
    pointerDown.set(event.clientX, event.clientY);
    const hit = pick(event);
    if (!hit.nodeId) return;
    const node = layout.nodes.find((item) => item.id === hit.nodeId);
    const mesh = nodeMeshes.get(hit.nodeId);
    if (!node || !mesh) return;
    dragNode = node;
    dragMesh = mesh;
    pointerId = event.pointerId;
    dragged = false;
    camera.getWorldDirection(cameraDirection);
    dragPlane.setFromNormalAndCoplanarPoint(cameraDirection, mesh.position);
    controls.enabled = false;
    webgl.domElement.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragNode || event.pointerId !== pointerId || !dragMesh) return;
    if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4) dragged = true;
    setPointer(event);
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return;
    dragNode.x = dragPoint.x;
    dragNode.y = dragPoint.y;
    dragNode.z = dragPoint.z;
    dragMesh.position.copy(dragPoint);
    for (const edge of layout.edges) if (edgeConnectedToNode(edge, dragNode.id)) updateEdgeGeometry(edge);
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    controls.enabled = true;
    if (webgl.domElement.hasPointerCapture(event.pointerId)) webgl.domElement.releasePointerCapture(event.pointerId);
    const wasDragged = dragged;
    const picked = pick(event);
    dragNode = undefined;
    dragMesh = undefined;
    pointerId = -1;
    if (wasDragged) return;
    if (picked.nodeId) initial.onSelectNode(picked.nodeId);
    else if (picked.edgeId) initial.onSelectEdge(picked.edgeId);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      initial.onSelectNode('');
      initial.onSelectEdge('');
      return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); command('zoom-in'); }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); command('zoom-out'); }
    if (event.key.toLocaleLowerCase() === 'f') { event.preventDefault(); command('fit'); }
  };
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    host.classList.add('is-webgl-unavailable');
    initial.onRendererStateChange?.({ autoOrbit: false, webglAvailable: false });
  };
  const onResize = (): void => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    webgl.setSize(width, height, false);
    composer.setSize(width, height);
    labels.setSize(width, height);
    for (const line of edgeLines.values()) line.material.resolution.set(width, height);
  };

  webgl.domElement.addEventListener('pointerdown', onPointerDown);
  webgl.domElement.addEventListener('pointermove', onPointerMove);
  webgl.domElement.addEventListener('pointerup', onPointerUp);
  webgl.domElement.addEventListener('pointercancel', onPointerUp);
  webgl.domElement.addEventListener('keydown', onKeyDown);
  webgl.domElement.addEventListener('webglcontextlost', onContextLost);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : undefined;
  resizeObserver?.observe(host);
  window.addEventListener('resize', onResize);

  function update(state: RelationshipGraphViewState): void {
    if (disposed) return;
    const selectionChanged = state.selectedNodeId !== current.selectedNodeId || state.selectedEdgeId !== current.selectedEdgeId;
    current = { ...state };
    reduceMotion = Boolean(state.reduceMotion);
    if (autoOrbit && reduceMotion) {
      autoOrbit = false;
      stateChange();
    }
    if (layoutKey(state) !== currentLayoutKey) rebuildScene(state);
    if (selectionChanged) syncEnergyEdges();
    updateHighlights(performance.now());
  }
  function command(value: RelationshipGraphCommand): void {
    if (disposed) return;
    if (value === 'zoom-in' || value === 'zoom-out') {
      stopAutoOrbit();
      const factor = value === 'zoom-in' ? .78 : 1.28;
      camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
      controls.update();
      return;
    }
    if (value === 'fit') {
      stopAutoOrbit();
      fitCamera();
      return;
    }
    if (value === 'reset-layout') {
      layoutRevision += 1;
      rebuildScene(current);
      return;
    }
    autoOrbit = !autoOrbit && !reduceMotion;
    stateChange();
  }
  function animate(now: number): void {
    if (disposed) return;
    const delta = Math.min(80, now - lastFrame);
    lastFrame = now;
    if (!reduceMotion && autoOrbit) {
      const radius = Math.max(graphOrbitDistance, graphSize * .98, 170);
      const angle = now * .00005;
      controls.target.copy(graphCenter);
      camera.position.set(graphCenter.x + Math.cos(angle) * radius * .93, graphCenter.y + radius * .38, graphCenter.z + Math.sin(angle) * radius * .93);
      camera.lookAt(graphCenter);
      stars.rotation.y += delta * .000005;
    }
    controls.update();
    updateHighlights(now);
    composer.render();
    labels.render(scene, camera);
    frame = window.requestAnimationFrame(animate);
  }

  onResize();
  update(initial);
  frame = window.requestAnimationFrame(animate);
  return {
    update,
    command,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
      controls.removeEventListener('start', stopAutoOrbit);
      webgl.domElement.removeEventListener('pointerdown', onPointerDown);
      webgl.domElement.removeEventListener('pointermove', onPointerMove);
      webgl.domElement.removeEventListener('pointerup', onPointerUp);
      webgl.domElement.removeEventListener('pointercancel', onPointerUp);
      webgl.domElement.removeEventListener('keydown', onKeyDown);
      webgl.domElement.removeEventListener('contextmenu', onContextMenu);
      webgl.domElement.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      clearGraphRoot();
      scene.remove(stars, nebula, graphRoot);
      starGeometry.dispose();
      (stars.material as THREE.Material).dispose();
      nebulaGeometry.dispose();
      nebulaMaterial.dispose();
      composer.dispose();
      nodeGeometry.dispose();
      webgl.dispose();
      labels.domElement.remove();
      webgl.domElement.remove();
    },
  };
}
