// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_INVENTORY_CARD_PIXEL_RATIO,
  mountInventoryCardThree,
  type InventoryCardViewModel,
} from '../src/ui/inventory-card-three';

const model: InventoryCardViewModel = {
  id: 'item:water',
  name: '瓶装水',
  category: 'food',
  categoryLabel: '食物',
  aliases: ['饮用水'],
  confidence: .93,
  amountLabel: '20瓶',
  precisionLabel: '精确记录',
  sourceFloor: 8,
};

describe('物品三维卡牌', () => {
  it('无 WebGL 时使用本地卡图并保留可访问说明和普通详情能力', async () => {
    const host = document.createElement('div');
    const renderer = await mountInventoryCardThree(host, model);

    expect(host.getAttribute('role')).toBe('img');
    expect(host.getAttribute('aria-label')).toContain('瓶装水');
    expect(host.classList.contains('is-webgl-unavailable')).toBe(true);
    expect(host.querySelector<HTMLImageElement>('img')?.src).toMatch(/inventory-card-front\.webp/u);
    expect(host.textContent).toContain('三维预览暂不可用');
    expect(host.textContent).toContain('物品详情和账本仍可正常使用');
    expect(renderer.flip()).toBe(false);
    await expect(renderer.update({ ...model, id: 'item:bandage', name: '绷带' })).resolves.toBeUndefined();
    expect(host.getAttribute('aria-label')).toContain('绷带');
    expect(() => renderer.enter()).not.toThrow();
    expect(() => renderer.leave()).not.toThrow();
    expect(() => renderer.dispose()).not.toThrow();
  });

  it('锁定原型旋转参数、细胞噪波镭射和独立闪烁星空', async () => {
    const source = await readFile(resolve(process.cwd(), 'src/ui/inventory-card-three.ts'), 'utf8');
    const styles = await readFile(resolve(process.cwd(), 'src/ui/memory.css'), 'utf8');
    expect(MAX_INVENTORY_CARD_PIXEL_RATIO).toBe(1.5);
    expect(source).toContain("new URL('./assets/inventory-card-front.webp', import.meta.url)");
    expect(source).toContain("new URL('./assets/inventory-card-back.webp', import.meta.url)");
    expect(source).toContain('new THREE.ExtrudeGeometry');
    expect(source).toContain('new THREE.CanvasTexture');
    expect(source).toContain('new THREE.ShaderMaterial');
    expect(source).not.toContain('new THREE.TorusGeometry');
    expect(source).toContain('new THREE.Points');
    expect(source).toContain('target.flip = flipped ? Math.PI : 0');
    expect(source).toContain("Object.assign(flightTarget, { x: -2.7");
    expect(source).toContain('const flight = options.entering');
    expect(source).toContain('target.ry = pointer.x * .24');
    expect(source).toContain('target.rx = -pointer.y * .17');
    expect(source).toContain('current.rx += (target.rx - current.rx) * .095');
    expect(source).toContain('current.intensity += (target.intensity - current.intensity) * .075');
    expect(source).toContain('current.flip += (target.flip - current.flip) * .085');
    expect(source).toContain('const clock = new THREE.Clock()');
    expect(source).toContain('clock.getElapsedTime()');
    expect(source).toContain('card.rotation.z = (reduceMotion ? 0 : pointer.x * .018) + flight.rz');
    expect(source).toContain('Math.sin(time * .72) * .028');
    expect(source).toContain('const HOLO_IDLE_INTENSITY = .52');
    expect(source).toContain('const HOLO_ACTIVE_INTENSITY = .92');
    expect(source).toContain('target.intensity = HOLO_ACTIVE_INTENSITY');
    expect(source).toContain('target.intensity = HOLO_IDLE_INTENSITY');
    expect(source).toContain('uPointer: { value: new THREE.Vector2(.35, .65) }');
    expect(source).toContain('uTilt: { value: new THREE.Vector2() }');
    expect(source).toContain('depthTest: true');
    expect(source).toContain('varying vec3 vViewNormal');
    expect(source).toContain('float fresnel=pow(incidence,.58)');
    expect(source).toContain('float anglePhase=uTilt.x*.65-uTilt.y*.52+incidence*.55');
    expect(source).toContain('float holoHeight=clamp');
    expect(source).toContain('vec3 microNormal=normalize');
    expect(source).toContain('float heightLight=clamp(dot(microNormal,foilLight)');
    expect(source).toContain('float heightResponse=smoothstep(.26,.92,heightLight)');
    expect(source).toContain('float slopePhase=dot(microNormal.xy,lightAxis)');
    expect(source).toContain('float broadSheen=exp');
    expect(source).toContain('float angleSheen=broadSheen*(.72+.28*heightResponse)');
    expect(source).toContain('vec3 filmTint=mix(violet,aqua,coolMix)');
    expect(source).toContain('float luminance=dot(color,vec3(.2126,.7152,.0722))');
    expect(source).toContain('mix(vec3(luminance),color,1.38)*.86');
    expect(source).toContain('float baseFilm=.18+.22*broadSheen+.06*fresnel');
    expect(source).toContain('new THREE.PlaneGeometry(CARD_WIDTH - .02, CARD_HEIGHT - .02)');
    expect(source).toContain('vec4 cellularData(vec2 point)');
    expect(source).toContain('return vec4(sqrt(nearest),nearestSeed,nearestDelta)');
    expect(source).toContain('float cellular(vec2 point)');
    expect(source).toContain('vec2 organicUv=uv*vec2(8.2,11.0)');
    expect(source).not.toContain('organicUv=uv*vec2(8.2,11.0)+(vec2(warpX,warpY)-.36)*1.15+pointerOffset');
    expect(source).toContain('float cellField=clamp');
    expect(source).toContain('float membrane=');
    expect(source).not.toContain('float sweepCenter=');
    expect(source).not.toContain('float grooves=pow');
    expect(source).toContain('float hotspot=exp');
    expect(source).toContain('vec3 spectrum=.5+.5*cos');
    expect(source).toContain('float sparkle=smoothstep');
    expect(source).toContain('bar.renderOrder = 6');
    expect(source).toContain('.5 + Math.sin(time * .28) * .26');
    expect(source).toContain("seededStarfield(`${model.id}-stars`, 118)");
    expect(source).toContain("particleGeometry.setAttribute('aBlink'");
    expect(source).toContain('float blink=pow(wave,7.0)');
    expect(source).toContain('blending: THREE.AdditiveBlending');
    expect(source).toContain("alpha: false, powerPreference: 'high-performance'");
    expect(source).toContain('renderer.setClearColor(0x05080c, 1)');
    expect(source).toContain('frontTexture.image = nextCanvases[0]');
    expect(source).toContain('Object.assign(flight, incoming)');
    expect(source).toContain('particleMaterial.uniforms.uTime.value = time');
    expect(source).toContain('uTilt.value.set(current.ry + flight.ry, current.rx)');
    expect(source).toContain('particles.rotation.z = reduceMotion ? 0 : time * .009');
    expect(source).toContain('keyLight.position.x = 2.6 + current.ry * 5.4');
    expect(source).toContain('rimLight.position.x = -3 - current.ry * 3');
    expect(source.indexOf('renderFrame();')).toBeLessThan(source.indexOf('host.replaceChildren(renderer.domElement)'));
    expect(styles).toMatch(/\.stx-memory-inventory-card-canvas\s*\{[^}]*background:\s*#05080c[^}]*touch-action:\s*none/u);
    expect(styles).not.toMatch(/\.stx-memory-inventory-item\s*\{[^}]*border-top:\s*3px/u);
    expect(styles).toMatch(/\.stx-memory-inventory-command\s*>\s*\[data-ss-helper-control="button"\]\s*\{[^}]*min-height:\s*36px[^}]*margin-top:\s*8px/u);
    expect(source).toContain('const reduceMotion = Boolean(options.reduceMotion)');
    expect(source).toContain('new ResizeObserver(resize)');
    expect(source).toContain('new IntersectionObserver');
    expect(source).toContain("addEventListener('webglcontextlost', onContextLost)");
    expect(source).toContain('teardown(false)');
    expect(source).toContain('teardown(true)');
    expect(source).toContain('disposeScene(scene)');
    expect(source).toContain('renderer.forceContextLoss()');
    expect(source).toContain('window.cancelAnimationFrame(frameId)');
    expect(source).not.toMatch(/https?:\/\/(?:cdn|unpkg|jsdelivr)/u);
    expect(source).not.toContain('data:image');
    expect(source).not.toContain('OrbitControls');
  });
});
