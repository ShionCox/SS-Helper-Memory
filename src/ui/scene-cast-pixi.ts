import { Application, Container, Graphics, Text } from 'pixi.js';
import type { SceneCast, SceneCastMember } from '../domain';
import {
  primarySceneRole,
  sceneGraphOwnerConfidence,
  sceneGraphOwnerIds,
  sceneGraphOwnerSources,
  sceneSourceLabel,
} from './scene-events-view';

export type SceneCastPixiCommand = 'zoom-in' | 'zoom-out' | 'fit' | 'focus-viewpoint' | 'clear-focus';

export interface SceneCastPixiOptions {
  showBoundaries: boolean;
  showSources: boolean;
  showConfidence: boolean;
  reduceMotion: boolean;
}

export interface SceneCastPixiMountInput {
  scene: SceneCast;
  ownerName(ownerId: string): string;
  ownerKind(ownerId: string): string;
  options: SceneCastPixiOptions;
  selectedOwnerId?: string;
  onSelectOwner(ownerId: string): void;
  onSelectSource(sourceRef: string): void;
  onZoomChange?(zoomPercent: number): void;
}

export interface SceneCastPixiRenderer {
  command(command: SceneCastPixiCommand): void;
  focusOwner(ownerId: string): void;
  setOptions(options: Partial<SceneCastPixiOptions>): void;
  dispose(): void;
}

export interface SceneCastLayoutNode {
  id: string;
  role: SceneCastMember['role'];
  x: number;
  y: number;
}

export interface SceneCastLayoutSource {
  id: string;
  x: number;
  y: number;
}

export interface SceneCastLayout {
  width: number;
  height: number;
  center: { x: number; y: number };
  rings: { inner: number; middle: number; outer: number };
  nodes: SceneCastLayoutNode[];
  sources: SceneCastLayoutSource[];
}

const WORLD_WIDTH = 720;
const WORLD_HEIGHT = 520;

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function buildSceneCastLayout(scene: SceneCast): SceneCastLayout {
  const center = { x: WORLD_WIDTH / 2, y: 220 };
  const rings = { inner: 68, middle: 132, outer: 182 };
  const groups: Record<SceneCastMember['role'], string[]> = {
    viewpoint: [],
    speaker: [],
    present: [],
    mentioned: [],
    narrator: [],
    world: [],
  };
  for (const ownerId of sceneGraphOwnerIds(scene)) groups[primarySceneRole(scene, ownerId)].push(ownerId);
  const positions = new Map<string, { x: number; y: number }>();
  for (const ownerId of groups.viewpoint) positions.set(ownerId, center);
  const placeArc = (ids: readonly string[], radius: number, start: number, end: number): void => {
    ids.forEach((ownerId, index) => {
      const t = ids.length === 1 ? 0.5 : index / Math.max(1, ids.length - 1);
      const angle = start + (end - start) * t;
      positions.set(ownerId, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    });
  };
  placeArc(groups.speaker, rings.inner, Math.PI * 1.08, Math.PI * 1.92);
  placeArc(groups.present, rings.middle, Math.PI * 0.12, Math.PI * 0.88);
  placeArc(groups.mentioned, rings.outer, Math.PI * 0.65, Math.PI * 1.35);
  [...groups.narrator, ...groups.world].forEach((ownerId, index) => {
    positions.set(ownerId, { x: index % 2 ? 654 : 66, y: 66 + Math.floor(index / 2) * 70 });
  });
  const sourceIds = unique(scene.members.flatMap((member) => [...member.sourceRefs]));
  const sources = sourceIds.map((id, index) => ({
    id,
    x: 650,
    y: sourceIds.length === 1 ? 96 : 76 + index * Math.min(58, 360 / Math.max(1, sourceIds.length - 1)),
  }));
  return {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    center,
    rings,
    nodes: sceneGraphOwnerIds(scene).map((id) => {
      const point = positions.get(id) ?? center;
      return { id, role: primarySceneRole(scene, id), x: point.x, y: point.y };
    }),
    sources,
  };
}

export async function mountSceneCastPixi(host: HTMLElement, input: SceneCastPixiMountInput): Promise<SceneCastPixiRenderer> {
  const app = new Application();
  const fallback = host.querySelector<HTMLElement>('[data-scene-pixi-fallback]');
  const tooltip = host.querySelector<HTMLElement>('[data-scene-pixi-tooltip]');
  const initialWidth = Math.max(320, Math.round(host.clientWidth || host.getBoundingClientRect().width || 640));
  const initialHeight = Math.max(300, Math.round(host.clientHeight || host.getBoundingClientRect().height || 440));
  try {
    await app.init({
      width: initialWidth,
      height: initialHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: 'webgl',
    });
  } catch (error) {
    app.destroy({ removeView: true }, { children: true, context: true });
    if (fallback) {
      const title = document.createElement('strong');
      title.textContent = '无法启动场景关系图';
      const detail = document.createElement('span');
      detail.textContent = '当前浏览器可能未启用 WebGL，文字角色边界与来源列表仍然可用。';
      fallback.replaceChildren(title, detail);
      fallback.dataset.scenePixiStatus = 'failed';
    }
    throw error;
  }

  const canvas = app.canvas;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.classList.add('stx-memory-scene-pixi-canvas');
  host.appendChild(canvas);
  fallback?.remove();

  const camera = new Container();
  app.stage.addChild(camera);
  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;

  const layout = buildSceneCastLayout(input.scene);
  let options = { ...input.options };
  let selectedOwnerId = input.selectedOwnerId ?? '';
  let disposed = false;
  let cameraScale = 1;
  let cameraX = 0;
  let cameraY = 0;
  let cameraFrame = 0;
  let pulseElapsed = 0;
  let selectedHalo: Graphics | undefined;
  let dragging: { pointerId: number; x: number; y: number; originX: number; originY: number; moved: boolean } | undefined;

  const palette = {
    text: 0xEEE9DF,
    muted: 0x92969C,
    border: 0x4A4F56,
    accent: 0xC5A059,
    speaker: 0xA895D8,
    success: 0x6FB88D,
    warning: 0xD7AA4F,
    surface: 0x20242A,
    source: 0x69717B,
  };

  const roleColor = (role: SceneCastMember['role']): number => role === 'viewpoint'
    ? palette.accent
    : role === 'speaker'
      ? palette.speaker
      : role === 'present'
        ? palette.success
        : role === 'mentioned'
          ? palette.warning
          : palette.muted;

  const applyCamera = (): void => {
    camera.position.set(cameraX, cameraY);
    camera.scale.set(cameraScale);
    input.onZoomChange?.(Math.round(cameraScale * 100));
  };

  const clampScale = (value: number): number => Math.max(0.42, Math.min(2.5, value));

  const moveCamera = (target: { x: number; y: number; scale: number }, animate = true): void => {
    window.cancelAnimationFrame(cameraFrame);
    if (!animate || options.reduceMotion) {
      cameraX = target.x;
      cameraY = target.y;
      cameraScale = target.scale;
      applyCamera();
      return;
    }
    const start = { x: cameraX, y: cameraY, scale: cameraScale };
    const startedAt = performance.now();
    const step = (now: number): void => {
      if (disposed) return;
      const time = Math.min(1, (now - startedAt) / 260);
      const eased = 1 - Math.pow(1 - time, 3);
      cameraX = start.x + (target.x - start.x) * eased;
      cameraY = start.y + (target.y - start.y) * eased;
      cameraScale = start.scale + (target.scale - start.scale) * eased;
      applyCamera();
      if (time < 1) cameraFrame = window.requestAnimationFrame(step);
    };
    cameraFrame = window.requestAnimationFrame(step);
  };

  const fit = (animate = true): void => {
    const width = Math.max(320, app.screen.width);
    const height = Math.max(300, app.screen.height);
    const padding = 28;
    const scale = clampScale(Math.min((width - padding * 2) / layout.width, (height - padding * 2) / layout.height));
    moveCamera({ x: (width - layout.width * scale) / 2, y: (height - layout.height * scale) / 2, scale }, animate);
  };

  const zoomAt = (clientX: number, clientY: number, factor: number): void => {
    const rect = canvas.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    const worldX = (screenX - cameraX) / cameraScale;
    const worldY = (screenY - cameraY) / cameraScale;
    const scale = clampScale(cameraScale * factor);
    moveCamera({ x: screenX - worldX * scale, y: screenY - worldY * scale, scale }, false);
  };

  const focusOwner = (ownerId: string): void => {
    const node = layout.nodes.find((item) => item.id === ownerId);
    if (!node) return;
    selectedOwnerId = ownerId;
    redraw();
    input.onSelectOwner(ownerId);
    const scale = clampScale(Math.max(cameraScale, 1.42));
    moveCamera({
      x: app.screen.width * 0.5 - node.x * scale,
      y: app.screen.height * 0.47 - node.y * scale,
      scale,
    });
  };

  const text = (value: string, size: number, color = palette.text, weight: '400' | '500' | '600' | '700' = '500'): Text => new Text({
    text: value,
    style: {
      fontFamily: 'Segoe UI, Microsoft YaHei UI, sans-serif',
      fontSize: size,
      fill: color,
      fontWeight: weight,
      align: 'center',
    },
  });

  const drawDashedLine = (graphics: Graphics, x1: number, y1: number, x2: number, y2: number, color: number, alpha: number): void => {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    for (let offset = 0; offset < length; offset += 12) {
      const end = Math.min(offset + 7, length);
      graphics.moveTo(x1 + Math.cos(angle) * offset, y1 + Math.sin(angle) * offset);
      graphics.lineTo(x1 + Math.cos(angle) * end, y1 + Math.sin(angle) * end);
    }
    graphics.stroke({ color, width: 1.4, alpha });
  };

  function showTooltip(ownerId: string, event: { global: { x: number; y: number } }): void {
    if (!tooltip) return;
    const role = primarySceneRole(input.scene, ownerId);
    const title = document.createElement('strong');
    title.textContent = input.ownerName(ownerId);
    const detail = document.createElement('span');
    detail.textContent = `${input.ownerKind(ownerId)} · ${Math.round(sceneGraphOwnerConfidence(input.scene, ownerId) * 100)}% · ${role}`;
    tooltip.replaceChildren(title, detail);
    tooltip.style.left = `${Math.max(8, Math.min(app.screen.width - 220, event.global.x + 12))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(app.screen.height - 70, event.global.y + 12))}px`;
    tooltip.classList.add('is-visible');
  }

  function redraw(): void {
    if (disposed) return;
    const children = camera.removeChildren();
    for (const child of children) child.destroy({ children: true });
    selectedHalo = undefined;

    if (options.showBoundaries) {
      const rings = new Graphics();
      rings.circle(layout.center.x, layout.center.y, layout.rings.inner).stroke({ color: palette.accent, width: 1, alpha: 0.34 });
      rings.circle(layout.center.x, layout.center.y, layout.rings.middle).stroke({ color: palette.success, width: 1, alpha: 0.28 });
      rings.circle(layout.center.x, layout.center.y, layout.rings.outer).stroke({ color: palette.warning, width: 1, alpha: 0.22 });
      camera.addChild(rings);
    }

    const viewpoint = layout.nodes.find((node) => node.id === input.scene.viewpointOwnerId) ?? { x: layout.center.x, y: layout.center.y };
    const edges = new Graphics();
    for (const node of layout.nodes) {
      if (node.id === input.scene.viewpointOwnerId) continue;
      const color = roleColor(node.role);
      const highlighted = !selectedOwnerId || selectedOwnerId === node.id || selectedOwnerId === input.scene.viewpointOwnerId;
      if (node.role === 'mentioned') drawDashedLine(edges, viewpoint.x, viewpoint.y, node.x, node.y, color, highlighted ? 0.72 : 0.1);
      else edges.moveTo(viewpoint.x, viewpoint.y).lineTo(node.x, node.y).stroke({ color, width: node.role === 'speaker' ? 2.2 : 1.6, alpha: highlighted ? 0.68 : 0.1 });
    }
    if (options.showSources) {
      for (const member of input.scene.members) {
        const owner = layout.nodes.find((node) => node.id === member.ownerId);
        if (!owner) continue;
        for (const sourceRef of member.sourceRefs) {
          const source = layout.sources.find((item) => item.id === sourceRef);
          if (source) drawDashedLine(edges, owner.x, owner.y, source.x, source.y, palette.source, !selectedOwnerId || selectedOwnerId === member.ownerId ? 0.3 : 0.06);
        }
      }
    }
    camera.addChild(edges);

    if (options.showSources) {
      for (const source of layout.sources) {
        const sourceNode = new Container();
        sourceNode.position.set(source.x, source.y);
        sourceNode.eventMode = 'static';
        sourceNode.cursor = 'pointer';
        const background = new Graphics().roundRect(-56, -16, 112, 32, 6).fill({ color: palette.surface, alpha: 0.96 }).stroke({ color: palette.border, width: 1, alpha: 0.9 });
        const label = text(sceneSourceLabel(source.id).replace('聊天消息 ', '消息 ').slice(0, 18), 10, palette.text, '600');
        label.anchor.set(0.5);
        sourceNode.addChild(background, label);
        sourceNode.on('pointertap', (event) => {
          event.stopPropagation();
          if (!dragging?.moved) input.onSelectSource(source.id);
        });
        camera.addChild(sourceNode);
      }
    }

    for (const nodeData of layout.nodes) {
      const color = roleColor(nodeData.role);
      const selected = selectedOwnerId === nodeData.id;
      const node = new Container();
      node.position.set(nodeData.x, nodeData.y);
      node.alpha = selectedOwnerId && !selected ? 0.25 : 1;
      node.eventMode = 'static';
      node.cursor = 'pointer';
      if (selected) {
        selectedHalo = new Graphics().circle(0, 0, 36).stroke({ color, width: 3, alpha: 0.88 });
        node.addChild(selectedHalo);
      }
      const circle = new Graphics().circle(0, 0, nodeData.role === 'viewpoint' ? 27 : 23)
        .fill({ color: palette.surface, alpha: 0.98 })
        .stroke({ color, width: nodeData.role === 'mentioned' ? 1.5 : 2.2, alpha: 0.96 });
      const initial = text(input.ownerName(nodeData.id).slice(0, 1), nodeData.role === 'viewpoint' ? 20 : 18, color, '700');
      initial.anchor.set(0.5);
      const name = text(input.ownerName(nodeData.id), 13, palette.text, '700');
      name.anchor.set(0.5);
      name.position.y = nodeData.role === 'viewpoint' ? 42 : 38;
      const role = text(nodeData.role === 'viewpoint' ? '当前视角' : nodeData.role === 'speaker' ? '明确发言' : nodeData.role === 'present' ? '明确在场' : nodeData.role === 'mentioned' ? '仅被提及' : nodeData.role === 'world' ? '世界来源' : '旁白', 10, color, '600');
      role.anchor.set(0.5);
      role.position.y = nodeData.role === 'viewpoint' ? 57 : 53;
      node.addChild(circle, initial, name, role);
      if (options.showConfidence) {
        const confidence = text(`${Math.round(sceneGraphOwnerConfidence(input.scene, nodeData.id) * 100)}%`, 10, palette.text, '600');
        confidence.anchor.set(0.5);
        confidence.position.y = -(nodeData.role === 'viewpoint' ? 38 : 34);
        node.addChild(confidence);
      }
      node.on('pointerover', (event) => {
        if (!selectedOwnerId) node.scale.set(1.08);
        showTooltip(nodeData.id, event);
      });
      node.on('pointermove', (event) => showTooltip(nodeData.id, event));
      node.on('pointerout', () => {
        node.scale.set(1);
        tooltip?.classList.remove('is-visible');
      });
      node.on('pointertap', (event) => {
        event.stopPropagation();
        if (!dragging?.moved) focusOwner(nodeData.id);
      });
      camera.addChild(node);
    }
  }

  const clearFocus = (): void => {
    selectedOwnerId = '';
    redraw();
    input.onSelectOwner('');
    fit();
  };

  app.stage.on('pointertap', () => {
    if (!dragging?.moved && selectedOwnerId) clearFocus();
  });

  const onPointerDown = (event: PointerEvent): void => {
    dragging = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: cameraX, originY: cameraY, moved: false };
    canvas.setPointerCapture(event.pointerId);
    host.classList.add('is-dragging');
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
    cameraX = dragging.originX + dx;
    cameraY = dragging.originY + dy;
    applyCamera();
  };
  const endPointer = (event: PointerEvent): void => {
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    host.classList.remove('is-dragging');
    window.setTimeout(() => { dragging = undefined; }, 0);
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 1 / 1.12);
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect || rect.width < 10 || rect.height < 10 || disposed) return;
    app.renderer.resize(Math.round(rect.width), Math.round(rect.height));
    app.stage.hitArea = app.screen;
    fit(false);
  });
  resizeObserver?.observe(host);

  const pulse = (ticker: { deltaMS: number }): void => {
    if (!selectedHalo || options.reduceMotion) {
      if (selectedHalo) selectedHalo.alpha = 0.88;
      return;
    }
    pulseElapsed += ticker.deltaMS;
    selectedHalo.alpha = 0.62 + Math.sin(pulseElapsed / 260) * 0.25;
  };
  app.ticker.add(pulse);

  redraw();
  fit(false);
  if (selectedOwnerId) focusOwner(selectedOwnerId);

  return {
    command(command) {
      if (disposed) return;
      if (command === 'fit') fit();
      else if (command === 'focus-viewpoint') focusOwner(input.scene.viewpointOwnerId);
      else if (command === 'clear-focus') clearFocus();
      else {
        const rect = canvas.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, command === 'zoom-in' ? 1.22 : 1 / 1.22);
      }
    },
    focusOwner,
    setOptions(next) {
      options = { ...options, ...next };
      redraw();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      resizeObserver?.disconnect();
      window.cancelAnimationFrame(cameraFrame);
      app.ticker.remove(pulse);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endPointer);
      canvas.removeEventListener('pointercancel', endPointer);
      canvas.removeEventListener('wheel', onWheel);
      tooltip?.classList.remove('is-visible');
      app.destroy({ removeView: true }, { children: true, context: true });
    },
  };
}
