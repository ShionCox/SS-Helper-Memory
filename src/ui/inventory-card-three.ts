import * as THREE from 'three';

export interface InventoryCardViewModel {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly aliases: readonly string[];
  readonly confidence: number;
  readonly amountLabel: string;
  readonly precisionLabel: string;
  readonly stateNote?: string;
  readonly sourceFloor?: number;
}

export interface InventoryCardRendererOptions {
  readonly reduceMotion?: boolean;
  readonly entering?: boolean;
  readonly onFlipChange?: (flipped: boolean) => void;
}

export interface InventoryCardRenderer {
  flip(): boolean;
  update(model: InventoryCardViewModel): Promise<void>;
  enter(): void;
  leave(): void;
  dispose(): void;
}

export const MAX_INVENTORY_CARD_PIXEL_RATIO = 1.5;

const inventoryAssetUrl = (relativePath: string): string => new URL(relativePath, import.meta.url).href;
const FRONT_CARD_URL = import.meta.env.DEV
  ? new URL('./assets/inventory-card-front.webp', import.meta.url).href
  : inventoryAssetUrl('./assets/inventory-card-front.webp');
const BACK_CARD_URL = import.meta.env.DEV
  ? new URL('./assets/inventory-card-back.webp', import.meta.url).href
  : inventoryAssetUrl('./assets/inventory-card-back.webp');
const CARD_WIDTH = 2.18;
const CARD_HEIGHT = 3.1;
const CARD_DEPTH = .12;
const HOLO_IDLE_INTENSITY = .52;
const HOLO_ACTIVE_INTENSITY = .92;

interface InventoryCardPalette {
  readonly accent: string;
  readonly highlight: string;
  readonly metal: string;
  readonly glow: string;
}

const PALETTES: Readonly<Record<string, InventoryCardPalette>> = Object.freeze({
  weapon: { accent: '#d17867', highlight: '#f0b36e', metal: '#d1a55a', glow: '#ff8069' },
  medicine: { accent: '#6fbd93', highlight: '#a4e0bd', metal: '#d2bd77', glow: '#72ffc0' },
  food: { accent: '#d1a75e', highlight: '#f1cf88', metal: '#d1a55a', glow: '#ffd274' },
  armor: { accent: '#779bb8', highlight: '#aad0e3', metal: '#c5cad2', glow: '#79c9ff' },
  special: { accent: '#b184ca', highlight: '#d8b1ec', metal: '#d1a55a', glow: '#d78cff' },
  core: { accent: '#69b8c5', highlight: '#9ae9ee', metal: '#d1a55a', glow: '#62f0ff' },
  material: { accent: '#a58d72', highlight: '#d1b894', metal: '#d1a55a', glow: '#e2ba77' },
  other: { accent: '#9ca3ad', highlight: '#d2d6dc', metal: '#c3c8cf', glow: '#b9d7ff' },
});

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('inventory card asset unavailable'));
    image.src = url;
  });
  imageCache.set(url, pending);
  void pending.catch(() => {
    if (imageCache.get(url) === pending) imageCache.delete(url);
  });
  return pending;
}

function fitText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (context.measureText(value).width <= maxWidth) return value;
  let result = value;
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

function rgba(color: string, alpha: number): string {
  const normalized = color.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

async function makeCardCanvas(model: InventoryCardViewModel, back: boolean): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 1080;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('inventory card canvas unavailable');
  const { accent, highlight } = PALETTES[model.category] ?? PALETTES.other!;
  const image = await loadImage(back ? BACK_CARD_URL : FRONT_CARD_URL);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  if (back) {
    const tint = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    tint.addColorStop(0, rgba(accent, .045));
    tint.addColorStop(.5, 'rgba(0,0,0,0)');
    tint.addColorStop(1, rgba(highlight, .04));
    context.globalCompositeOperation = 'screen';
    context.fillStyle = tint;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  const floor = model.sourceFloor === undefined ? '—' : String(model.sourceFloor);
  const aliases = model.aliases.length ? model.aliases.slice(0, 2).join('、') : '暂无别名';
  const note = model.stateNote?.trim() || '当前聊天未记录补充说明';
  const confidence = `${Math.round(Math.max(0, Math.min(1, model.confidence)) * 100)}%`;

  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#f4ead7';
  context.shadowColor = 'rgba(0,0,0,.86)';
  context.shadowBlur = 8;
  context.font = '800 34px "Segoe UI","Microsoft YaHei",sans-serif';
  context.fillText(floor, 110, 113);
  context.font = '700 31px "Segoe UI","Microsoft YaHei",sans-serif';
  context.fillText(fitText(context, model.name, 420), 384, 675);
  context.restore();

  context.save();
  context.fillStyle = '#30291e';
  context.textAlign = 'left';
  context.textBaseline = 'top';
  context.font = '700 19px "Segoe UI","Microsoft YaHei",sans-serif';
  context.fillText(fitText(context, `${model.categoryLabel} · ${model.precisionLabel}`, 500), 132, 755);
  context.font = '500 17px "Segoe UI","Microsoft YaHei",sans-serif';
  const lines = [
    `当前状态：${model.amountLabel}`,
    `别名：${aliases}`,
    `说明：${note}`,
    `来源：${model.sourceFloor === undefined ? '暂无可跳转楼层' : `第 ${model.sourceFloor} 层`} · 可信度 ${confidence}`,
  ];
  lines.forEach((line, index) => context.fillText(fitText(context, line, 500), 132, 792 + index * 31));
  context.restore();

  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#f0e6d2';
  context.shadowColor = 'rgba(0,0,0,.8)';
  context.shadowBlur = 5;
  context.font = '800 25px "Segoe UI","Microsoft YaHei",sans-serif';
  context.fillText(fitText(context, model.amountLabel, 150), 223, 1011);
  context.fillText(confidence, 548, 1011);
  context.font = '700 17px "Segoe UI","Microsoft YaHei",sans-serif';
  context.fillStyle = highlight;
  context.fillText(fitText(context, model.categoryLabel, 130), 384, 1017);
  context.restore();

  const glow = context.createRadialGradient(384, 74, 4, 384, 74, 72);
  glow.addColorStop(0, rgba(highlight, .55));
  glow.addColorStop(.45, rgba(accent, .17));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  context.globalCompositeOperation = 'screen';
  context.fillStyle = glow;
  context.fillRect(304, 0, 160, 150);
  return canvas;
}

function appendFallback(host: HTMLElement, reason: string): void {
  host.replaceChildren();
  host.classList.add('is-webgl-unavailable');
  const image = document.createElement('img');
  image.className = 'stx-memory-inventory-card-fallback-image';
  image.src = FRONT_CARD_URL;
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  const status = document.createElement('div');
  status.className = 'stx-memory-inventory-card-fallback-status';
  status.setAttribute('role', 'status');
  const icon = document.createElement('ss-helper-icon');
  icon.setAttribute('name', 'cube');
  icon.setAttribute('decorative', '');
  const strong = document.createElement('strong');
  strong.textContent = '三维预览暂不可用';
  const copy = document.createElement('span');
  copy.textContent = reason;
  status.append(icon, strong, copy);
  host.append(image, status);
}

function noOpRenderer(host: HTMLElement, options: InventoryCardRendererOptions): InventoryCardRenderer {
  options.onFlipChange?.(false);
  return {
    flip: () => false,
    update: async (model) => {
      host.setAttribute('aria-label', `${model.name}三维卡牌预览`);
    },
    enter: () => undefined,
    leave: () => undefined,
    dispose: () => undefined,
  };
}

function roundedCardShape(): THREE.Shape {
  const shape = new THREE.Shape();
  const width = CARD_WIDTH;
  const height = CARD_HEIGHT;
  const radius = .14;
  const left = -width / 2;
  const bottom = -height / 2;
  shape.moveTo(left + radius, bottom);
  shape.lineTo(left + width - radius, bottom);
  shape.quadraticCurveTo(left + width, bottom, left + width, bottom + radius);
  shape.lineTo(left + width, bottom + height - radius);
  shape.quadraticCurveTo(left + width, bottom + height, left + width - radius, bottom + height);
  shape.lineTo(left + radius, bottom + height);
  shape.quadraticCurveTo(left, bottom + height, left, bottom + height - radius);
  shape.lineTo(left, bottom + radius);
  shape.quadraticCurveTo(left, bottom, left + radius, bottom);
  return shape;
}

interface SeededStarfield {
  readonly positions: Float32Array;
  readonly sizes: Float32Array;
  readonly phases: Float32Array;
  readonly blinking: Float32Array;
}

function seededStarfield(seed: string, count: number): SeededStarfield {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const next = (): number => {
    hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0;
    return hash / 4294967296;
  };
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const blinking = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (next() - .5) * 6.2;
    positions[index * 3 + 1] = (next() - .5) * 5.4;
    positions[index * 3 + 2] = -1.1 - next() * 2.2;
    sizes[index] = 1.7 + next() * 3.8;
    phases[index] = next() * Math.PI * 2;
    blinking[index] = next() > .78 ? 1 : 0;
  }
  return { positions, sizes, phases, blinking };
}

function disposeScene(scene: THREE.Scene): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((object) => {
    const renderable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    if (renderable.geometry) geometries.add(renderable.geometry);
    for (const material of Array.isArray(renderable.material) ? renderable.material : renderable.material ? [renderable.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach(texture => texture.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
}

export async function mountInventoryCardThree(
  host: HTMLElement,
  model: InventoryCardViewModel,
  options: InventoryCardRendererOptions = {},
): Promise<InventoryCardRenderer> {
  if (!host.hasAttribute('role')) host.setAttribute('role', 'img');
  if (!host.hasAttribute('aria-label')) host.setAttribute('aria-label', `${model.name}三维卡牌预览`);
  host.classList.remove('is-webgl-unavailable');
  if (typeof window.WebGLRenderingContext !== 'function' && typeof window.WebGL2RenderingContext !== 'function') {
    appendFallback(host, '当前浏览器没有可用的 WebGL；物品详情和账本仍可正常使用。');
    return noOpRenderer(host, options);
  }

  let canvases: readonly [HTMLCanvasElement, HTMLCanvasElement];
  try {
    canvases = await Promise.all([makeCardCanvas(model, false), makeCardCanvas(model, true)]);
  } catch {
    appendFallback(host, '本地卡面资源暂时无法读取；物品详情和账本仍可正常使用。');
    return noOpRenderer(host, options);
  }

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    appendFallback(host, '当前浏览器无法创建 WebGL 画布；物品详情和账本仍可正常使用。');
    return noOpRenderer(host, options);
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_INVENTORY_CARD_PIXEL_RATIO));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.14;
  renderer.setClearColor(0x05080c, 1);
  renderer.domElement.className = 'stx-memory-inventory-card-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(31, 1, .1, 100);
  camera.position.set(0, 0, 6.45);
  let palette = PALETTES[model.category] ?? PALETTES.other!;
  const accentColor = new THREE.Color(palette.accent);
  const metalColor = new THREE.Color(palette.metal);

  const frontTexture = new THREE.CanvasTexture(canvases[0]);
  const backTexture = new THREE.CanvasTexture(canvases[1]);
  frontTexture.colorSpace = THREE.SRGBColorSpace;
  backTexture.colorSpace = THREE.SRGBColorSpace;
  frontTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  backTexture.anisotropy = frontTexture.anisotropy;

  const card = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(roundedCardShape(), {
      depth: CARD_DEPTH,
      steps: 1,
      curveSegments: 16,
      bevelEnabled: true,
      bevelThickness: .035,
      bevelSize: .035,
      bevelSegments: 3,
    }),
    new THREE.MeshStandardMaterial({ color: 0x12151a, metalness: .72, roughness: .3 }),
  );
  body.geometry.center();
  card.add(body);

  const faceGeometry = new THREE.PlaneGeometry(CARD_WIDTH - .06, CARD_HEIGHT - .06);
  frontTexture.needsUpdate = true;
  backTexture.needsUpdate = true;
  const front = new THREE.Mesh(faceGeometry, new THREE.MeshBasicMaterial({
    map: frontTexture,
    transparent: false,
    toneMapped: false,
    depthWrite: true,
    side: THREE.FrontSide,
  }));
  front.position.z = CARD_DEPTH / 2 + .044;
  front.renderOrder = 2;
  const back = new THREE.Mesh(faceGeometry, new THREE.MeshBasicMaterial({
    map: backTexture,
    transparent: false,
    toneMapped: false,
    depthWrite: true,
    side: THREE.FrontSide,
  }));
  back.position.z = -CARD_DEPTH / 2 - .044;
  back.rotation.y = Math.PI;
  back.renderOrder = 2;
  card.add(front, back);

  const frameMaterial = new THREE.MeshStandardMaterial({
    color: metalColor,
    metalness: .88,
    roughness: .24,
    transparent: true,
    opacity: .14,
    depthWrite: false,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: accentColor,
    metalness: .58,
    roughness: .25,
    emissive: accentColor,
    emissiveIntensity: .03,
    transparent: true,
    opacity: .22,
    depthWrite: false,
  });
  const addBar = (
    width: number,
    height: number,
    x: number,
    y: number,
    material: THREE.Material = frameMaterial,
    z = CARD_DEPTH / 2 + .072,
  ): void => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(width, height, .045), material);
    bar.position.set(x, y, z);
    bar.renderOrder = 6;
    card.add(bar);
  };
  addBar(CARD_WIDTH - .22, .055, 0, CARD_HEIGHT / 2 - .075);
  addBar(CARD_WIDTH - .22, .055, 0, -CARD_HEIGHT / 2 + .075);
  addBar(.055, CARD_HEIGHT - .22, -CARD_WIDTH / 2 + .075, 0);
  addBar(.055, CARD_HEIGHT - .22, CARD_WIDTH / 2 - .075, 0);
  addBar(CARD_WIDTH - .4, .018, 0, CARD_HEIGHT / 2 - .155, accentMaterial, CARD_DEPTH / 2 + .083);
  addBar(CARD_WIDTH - .4, .018, 0, -CARD_HEIGHT / 2 + .155, accentMaterial, CARD_DEPTH / 2 + .083);
  for (const [x, y] of [
    [-CARD_WIDTH / 2 + .1, CARD_HEIGHT / 2 - .1],
    [CARD_WIDTH / 2 - .1, CARD_HEIGHT / 2 - .1],
    [-CARD_WIDTH / 2 + .1, -CARD_HEIGHT / 2 + .1],
    [CARD_WIDTH / 2 - .1, -CARD_HEIGHT / 2 + .1],
  ] as const) {
    const corner = new THREE.Mesh(new THREE.OctahedronGeometry(.092, 0), frameMaterial);
    corner.scale.z = .38;
    corner.position.set(x, y, CARD_DEPTH / 2 + .1);
    corner.renderOrder = 6;
    card.add(corner);
  }
  const crest = new THREE.Mesh(new THREE.OctahedronGeometry(.11, 0), accentMaterial);
  crest.scale.z = .42;
  crest.position.set(0, CARD_HEIGHT / 2 - .045, CARD_DEPTH / 2 + .115);
  crest.renderOrder = 6;
  card.add(crest);

  const holoMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    blending: THREE.NormalBlending,
    side: THREE.FrontSide,
    uniforms: {
      uTime: { value: 0 },
      uPointer: { value: new THREE.Vector2(.35, .65) },
      uTilt: { value: new THREE.Vector2() },
      uIntensity: { value: HOLO_IDLE_INTENSITY },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vViewPosition;
      varying vec3 vViewNormal;
      void main(){
        vUv=uv;
        vec4 viewPosition=modelViewMatrix*vec4(position,1.0);
        vViewPosition=-viewPosition.xyz;
        vViewNormal=normalize(normalMatrix*normal);
        gl_Position=projectionMatrix*viewPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec2 uPointer;
      uniform vec2 uTilt;
      uniform float uIntensity;
      varying vec2 vUv;
      varying vec3 vViewPosition;
      varying vec3 vViewNormal;
      float roundedMask(vec2 uv){
        vec2 q=abs(uv-.5)-vec2(.482)+.038;
        float d=length(max(q,0.0))+min(max(q.x,q.y),0.0)-.038;
        return 1.0-smoothstep(-.010,.008,d);
      }
      float grain(vec2 cell){
        return fract(sin(dot(cell,vec2(127.1,311.7)))*43758.5453);
      }
      vec2 hash22(vec2 cell){
        vec2 value=vec2(dot(cell,vec2(127.1,311.7)),dot(cell,vec2(269.5,183.3)));
        return fract(sin(value)*43758.5453);
      }
      vec4 cellularData(vec2 point){
        vec2 cell=floor(point);
        vec2 local=fract(point);
        float nearest=8.0;
        float nearestSeed=0.0;
        vec2 nearestDelta=vec2(0.0);
        for(int y=-1;y<=1;y++){
          for(int x=-1;x<=1;x++){
            vec2 neighbor=vec2(float(x),float(y));
            vec2 feature=hash22(cell+neighbor);
            vec2 delta=neighbor+feature-local;
            float distanceSquared=dot(delta,delta);
            if(distanceSquared<nearest){
              nearest=distanceSquared;
              nearestSeed=grain(cell+neighbor);
              nearestDelta=delta;
            }
          }
        }
        return vec4(sqrt(nearest),nearestSeed,nearestDelta);
      }
      float cellular(vec2 point){
        return cellularData(point).x;
      }
      void main(){
        vec2 uv=vUv;
        vec3 normal=normalize(vViewNormal);
        vec3 viewDirection=normalize(vViewPosition);
        float viewDot=clamp(abs(dot(normal,viewDirection)),0.0,1.0);
        float incidence=1.0-viewDot;
        float fresnel=pow(incidence,.58);
        vec2 pointerOffset=(uPointer-.5)*vec2(.82,1.12);
        float anglePhase=uTilt.x*.65-uTilt.y*.52+incidence*.55;
        float warpX=cellular(uv*3.15+vec2(1.7,-.8));
        float warpY=cellular(uv*3.65+vec2(-2.4,2.1));
        vec2 organicUv=uv*vec2(8.2,11.0)+(vec2(warpX,warpY)-.36)*1.15;
        vec4 largeCell=cellularData(organicUv);
        vec4 fineCell=cellularData(organicUv*2.05+vec2(4.1,-3.7));
        float cellLarge=largeCell.x;
        float cellFine=fineCell.x;
        float cellFill=1.0-smoothstep(.10,.62,cellLarge);
        float membrane=1.0-smoothstep(.025,.105,abs(cellLarge-.34));
        float lace=1.0-smoothstep(.035,.15,abs(cellFine-.28));
        float cellField=clamp(cellFill*.72+membrane*.48+lace*.20,0.0,1.0);
        float holoHeight=clamp(cellFill*.70+membrane*.18
          +(1.0-smoothstep(.06,.62,cellFine))*.12,0.0,1.0);
        vec2 heightGradient=-(largeCell.zw+fineCell.zw*.24);
        heightGradient/=max(length(heightGradient),.001);
        vec3 microNormal=normalize(vec3(heightGradient*.78,1.0));
        vec2 lightTravel=vec2(-uTilt.x,-uTilt.y)*3.2+pointerOffset*.16;
        vec3 foilLight=normalize(vec3(lightTravel,.65));
        float heightLight=clamp(dot(microNormal,foilLight)*.5+.5,0.0,1.0);
        float heightResponse=smoothstep(.26,.92,heightLight);
        vec2 lightAxis=normalize(lightTravel+vec2(.001));
        float slopePhase=dot(microNormal.xy,lightAxis);
        vec2 broadCenter=vec2(.5)+vec2(-uTilt.x,-uTilt.y)*1.2+pointerOffset*.06;
        vec2 broadDelta=(uv-broadCenter)*vec2(.72,.90);
        float broadSheen=exp(-dot(broadDelta,broadDelta)*2.3);
        float angleSheen=broadSheen*(.72+.28*heightResponse);
        float colorPhase=anglePhase*.80+broadSheen*.24+holoHeight*.55+heightLight*.36+slopePhase*.12
          +largeCell.y*.10+fineCell.y*.04+uTime*.0015;
        vec3 spectrum=.5+.5*cos(6.28318*(vec3(0.0,.34,.67)+colorPhase));
        vec3 violet=vec3(.26,.025,.80);
        vec3 aqua=vec3(.025,.50,.88);
        vec3 pink=vec3(.82,.035,.48);
        float coolMix=.5+.5*sin(6.28318*(anglePhase*1.25+.18));
        float pinkMix=.5+.5*cos(6.28318*(anglePhase*.90+holoHeight*.05));
        vec3 filmTint=mix(violet,aqua,coolMix);
        filmTint=mix(filmTint,pink,.22+.18*pinkMix);
        vec2 spotVector=(uv-uPointer)*vec2(.70,1.08);
        float hotspot=exp(-dot(spotVector,spotVector)*4.2);
        float sparkle=smoothstep(.986,1.0,grain(floor(uv*210.0+uTime*.34)))*(.35+.65*cellField);
        float vignette=smoothstep(0.0,.025,uv.x)*smoothstep(0.0,.025,uv.y)
          *smoothstep(0.0,.025,1.0-uv.x)*smoothstep(0.0,.025,1.0-uv.y);
        float glint=clamp(cellField*.38+membrane*.26+sparkle*.54+fresnel*.20+angleSheen*.48,0.0,1.0);
        vec3 color=mix(filmTint,spectrum,.10+heightResponse*.08+holoHeight*.04);
        color=mix(color,vec3(.03,.46,.92),membrane*.05+sparkle*.14);
        float luminance=dot(color,vec3(.2126,.7152,.0722));
        color=clamp(mix(vec3(luminance),color,1.38)*.86,0.0,1.0);
        float baseFilm=.18+.22*broadSheen+.06*fresnel;
        float reliefFilm=.015*cellField+.012*membrane+.01*lace+.04*sparkle
          +.02*heightResponse*holoHeight;
        float alpha=(baseFilm+reliefFilm)
          *(.70+.30*hotspot)*uIntensity*vignette*roundedMask(uv);
        gl_FragColor=vec4(color,clamp(alpha*(.86+.14*glint),0.0,.46));
      }
    `,
  });
  const holo = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_WIDTH - .02, CARD_HEIGHT - .02),
    holoMaterial,
  );
  holo.position.z = CARD_DEPTH / 2 + .052;
  holo.renderOrder = 5;
  card.add(holo);
  scene.add(card);

  const starfield = seededStarfield(`${model.id}-stars`, 118);
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(starfield.positions, 3));
  particleGeometry.setAttribute('aSize', new THREE.BufferAttribute(starfield.sizes, 1));
  particleGeometry.setAttribute('aPhase', new THREE.BufferAttribute(starfield.phases, 1));
  particleGeometry.setAttribute('aBlink', new THREE.BufferAttribute(starfield.blinking, 1));
  const particleMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(palette.highlight) },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute float aBlink;
      uniform float uTime;
      varying float vBrightness;
      void main(){
        float wave=.5+.5*sin(uTime*(1.35+aPhase*.16)+aPhase);
        float blink=pow(wave,7.0);
        vBrightness=mix(.68,.48+blink*.92,aBlink);
        vec4 viewPosition=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=aSize*(6.5/max(4.0,-viewPosition.z));
        gl_Position=projectionMatrix*viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vBrightness;
      void main(){
        vec2 point=gl_PointCoord-.5;
        float distanceToCenter=length(point);
        float core=1.0-smoothstep(.10,.48,distanceToCenter);
        float rays=(1.0-smoothstep(.025,.095,abs(point.x)))*(1.0-smoothstep(.12,.49,abs(point.y)))
          +(1.0-smoothstep(.025,.095,abs(point.y)))*(1.0-smoothstep(.12,.49,abs(point.x)));
        float alpha=clamp(core+rays*.32,0.0,1.0)*vBrightness;
        gl_FragColor=vec4(mix(uColor,vec3(1.0),.72),alpha);
      }
    `,
  });
  const particles = new THREE.Points(
    particleGeometry,
    particleMaterial,
  );
  scene.add(particles);

  scene.add(new THREE.HemisphereLight(0xf4ead7, 0x0a0d12, 1.18));
  const keyLight = new THREE.DirectionalLight(metalColor, 3);
  keyLight.position.set(2.6, 3.8, 5);
  const rimLight = new THREE.PointLight(new THREE.Color(palette.glow), 2.2, 10);
  rimLight.position.set(-3, -.6, 3.5);
  const coolLight = new THREE.PointLight(0x78b8ff, 1, 9);
  coolLight.position.set(2.8, -2.2, 2.2);
  scene.add(keyLight, rimLight, coolLight);

  let disposed = false;
  let frameId = 0;
  let visible = true;
  let hovered = false;
  let flipped = false;
  const pointer = { x: 0, y: 0 };
  const target = { rx: 0, ry: 0, scale: 1, intensity: HOLO_IDLE_INTENSITY, flip: 0 };
  const current = { rx: 0, ry: 0, scale: 1, intensity: HOLO_IDLE_INTENSITY, flip: 0 };
  const clock = new THREE.Clock();
  const reduceMotion = Boolean(options.reduceMotion);
  const flight = options.entering
    ? { x: 2.7, y: -.12, ry: .45, rz: .055, scale: .86 }
    : { x: 0, y: 0, ry: 0, rz: 0, scale: 1 };
  const flightTarget = { x: 0, y: 0, ry: 0, rz: 0, scale: 1 };
  let previousTime = 0;
  let updateGeneration = 0;
  let resizeObserver: ResizeObserver | undefined;
  let intersectionObserver: IntersectionObserver | undefined;

  const syncSize = (): void => {
    if (disposed) return;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };
  const resize = (): void => {
    syncSize();
    requestFrame();
  };
  const renderFrame = (): void => {
    frameId = 0;
    if (disposed || !visible) return;
    const time = reduceMotion ? 0 : clock.getElapsedTime();
    const flightBlend = reduceMotion ? 1 : 1 - Math.exp(-Math.max(0, time - previousTime) * 16);
    previousTime = time;
    if (reduceMotion) {
      current.rx = 0;
      current.ry = 0;
      current.scale = 1;
      current.intensity = HOLO_IDLE_INTENSITY;
      current.flip = target.flip;
    } else {
      current.rx += (target.rx - current.rx) * .095;
      current.ry += (target.ry - current.ry) * .095;
      current.scale += (target.scale - current.scale) * .095;
      current.intensity += (target.intensity - current.intensity) * .075;
      current.flip += (target.flip - current.flip) * .085;
    }
    flight.x += (flightTarget.x - flight.x) * flightBlend;
    flight.y += (flightTarget.y - flight.y) * flightBlend;
    flight.ry += (flightTarget.ry - flight.ry) * flightBlend;
    flight.rz += (flightTarget.rz - flight.rz) * flightBlend;
    flight.scale += (flightTarget.scale - flight.scale) * flightBlend;
    card.rotation.x = current.rx;
    card.rotation.y = current.flip + current.ry + flight.ry;
    card.rotation.z = (reduceMotion ? 0 : pointer.x * .018) + flight.rz;
    card.scale.setScalar(current.scale * flight.scale);
    card.position.x = flight.x;
    card.position.y = flight.y + (reduceMotion ? 0 : Math.sin(time * .72) * .028);
    holoMaterial.uniforms.uTime.value = time;
    holoMaterial.uniforms.uTilt.value.set(current.ry + flight.ry, current.rx);
    holoMaterial.uniforms.uIntensity.value = current.intensity;
    if (!reduceMotion && !hovered && !flipped) {
      holoMaterial.uniforms.uPointer.value.set(
        .5 + Math.sin(time * .28) * .26,
        .54 + Math.cos(time * .23) * .2,
      );
    }
    particleMaterial.uniforms.uTime.value = time;
    particles.rotation.z = reduceMotion ? 0 : time * .009;
    particles.rotation.y = reduceMotion ? 0 : Math.sin(time * .18) * .025;
    keyLight.position.x = 2.6 + current.ry * 5.4;
    rimLight.position.x = -3 - current.ry * 3;
    renderer.render(scene, camera);
    if (!reduceMotion) requestFrame();
  };
  function requestFrame(): void {
    if (!disposed && visible && frameId === 0) frameId = window.requestAnimationFrame(renderFrame);
  }
  const enter = (): void => {
    if (disposed) return;
    Object.assign(flightTarget, { x: 0, y: 0, ry: 0, rz: 0, scale: 1 });
    requestFrame();
  };
  const leave = (): void => {
    if (disposed) return;
    Object.assign(flightTarget, { x: -2.7, y: .12, ry: -.45, rz: -.055, scale: .86 });
    requestFrame();
  };
  const update = async (nextModel: InventoryCardViewModel): Promise<void> => {
    const generation = ++updateGeneration;
    const nextCanvases = await Promise.all([makeCardCanvas(nextModel, false), makeCardCanvas(nextModel, true)]);
    if (disposed || generation !== updateGeneration) return;

    frontTexture.image = nextCanvases[0];
    backTexture.image = nextCanvases[1];
    frontTexture.needsUpdate = true;
    backTexture.needsUpdate = true;
    palette = PALETTES[nextModel.category] ?? PALETTES.other!;
    accentColor.set(palette.accent);
    metalColor.set(palette.metal);
    frameMaterial.color.copy(metalColor);
    accentMaterial.color.copy(accentColor);
    accentMaterial.emissive.copy(accentColor);
    particleMaterial.uniforms.uColor.value.set(palette.highlight);
    keyLight.color.copy(metalColor);
    rimLight.color.set(palette.glow);

    const nextStarfield = seededStarfield(`${nextModel.id}-stars`, 118);
    const updateAttribute = (name: string, values: Float32Array): void => {
      const attribute = particleGeometry.getAttribute(name) as THREE.BufferAttribute;
      (attribute.array as Float32Array).set(values);
      attribute.needsUpdate = true;
    };
    updateAttribute('position', nextStarfield.positions);
    updateAttribute('aSize', nextStarfield.sizes);
    updateAttribute('aPhase', nextStarfield.phases);
    updateAttribute('aBlink', nextStarfield.blinking);
    particleGeometry.computeBoundingSphere();

    flipped = false;
    target.flip = 0;
    current.flip = 0;
    const incoming = reduceMotion
      ? { x: 0, y: 0, ry: 0, rz: 0, scale: 1 }
      : { x: 2.7, y: -.12, ry: .45, rz: .055, scale: .86 };
    Object.assign(flight, incoming);
    Object.assign(flightTarget, incoming);
    host.setAttribute('aria-label', `${nextModel.name}三维卡牌预览`);
    options.onFlipChange?.(false);
    requestFrame();
  };
  const setFlipped = (value: boolean): boolean => {
    if (disposed) return flipped;
    flipped = value;
    target.flip = flipped ? Math.PI : 0;
    if (reduceMotion) current.flip = target.flip;
    options.onFlipChange?.(flipped);
    requestFrame();
    return flipped;
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (reduceMotion) return;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    target.ry = pointer.x * .24;
    target.rx = -pointer.y * .17;
    target.scale = 1.02;
    target.intensity = HOLO_ACTIVE_INTENSITY;
    holoMaterial.uniforms.uPointer.value.set((pointer.x + 1) / 2, 1 - (pointer.y + 1) / 2);
  };
  const onPointerEnter = (): void => {
    hovered = true;
    target.scale = 1.02;
    target.intensity = HOLO_ACTIVE_INTENSITY;
    requestFrame();
  };
  const onPointerLeave = (): void => {
    hovered = false;
    target.rx = 0;
    target.ry = 0;
    target.scale = 1;
    target.intensity = HOLO_IDLE_INTENSITY;
    requestFrame();
  };
  const onClick = (): void => { setFlipped(!flipped); };
  const teardown = (forceContextLoss: boolean): void => {
    if (frameId) window.cancelAnimationFrame(frameId);
    frameId = 0;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerenter', onPointerEnter);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    renderer.domElement.removeEventListener('click', onClick);
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
    disposeScene(scene);
    renderer.dispose();
    if (forceContextLoss) renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    if (disposed) return;
    disposed = true;
    visible = false;
    flipped = false;
    teardown(false);
    appendFallback(host, 'WebGL 上下文已中断；物品详情和账本仍可正常使用。');
    options.onFlipChange?.(false);
  };

  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerenter', onPointerEnter);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  renderer.domElement.addEventListener('click', onClick);
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);
  syncSize();
  renderFrame();
  host.replaceChildren(renderer.domElement);
  resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : undefined;
  resizeObserver?.observe(host);
  intersectionObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        visible = entries.some(entry => entry.isIntersecting);
        if (visible) requestFrame();
        else if (frameId) { window.cancelAnimationFrame(frameId); frameId = 0; }
      })
    : undefined;
  intersectionObserver?.observe(host);
  options.onFlipChange?.(false);

  return {
    flip: () => setFlipped(!flipped),
    update,
    enter,
    leave,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      teardown(true);
    },
  };
}
