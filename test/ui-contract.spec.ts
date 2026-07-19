import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Memory 工作台公共 UI 契约门禁', () => {
  it('只消费 SDK 公共标记和主题变量，不恢复内部类或基础控件副本', async () => {
    const [source, styles] = await Promise.all([
      readFile(new URL('../src/ui/memory-ui.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/ui/memory.css', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain('UI_CONTROL_ATTRIBUTE');
    expect(source).toContain('UI_CONTROL_TONE_ATTRIBUTE');
    expect(source).toContain('popupUi?.refreshControls(root)');
    expect(styles).toContain('--ss-control-input-padding-inline-start: 34px');
    expect(styles).toMatch(/\.stx-memory-statusbar\s+\[data-ss-helper-control="status"\][^}]*justify-self:\s*start/u);
    expect(styles).toMatch(/\.stx-memory-statusbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.35fr\)\s+repeat\(4,/u);
    expect(styles).toMatch(/\.stx-memory-chat-storage\s*\{[^}]*border-radius:\s*7px/u);
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-maintenance-action\[data-ss-helper-control="button"\][^}]*display:\s*grid[^}]*grid-template-columns:\s*34px\s+minmax\(0,\s*1fr\)\s+20px/u);
    expect(styles).toMatch(/\.stx-memory-maintenance-icon\s*\{[^}]*width:\s*34px[^}]*height:\s*34px[^}]*place-items:\s*center/u);
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-danger-actions\s+\.stx-memory-danger-action\[data-ss-helper-control="button"\][^}]*grid-template-columns:\s*30px\s+minmax\(0,\s*1fr\)[^}]*text-align:\s*left/u);
    expect(source).toContain('fa-solid fa-file-export');
    expect(source).toContain('fa-solid fa-file-import');
    expect(source).toContain('fa-solid fa-eraser');
    expect(source).not.toContain('fa-solid fa-comment-slash');
    expect(source).toContain('本聊天记忆占用');
    expect(source).toContain('数据库 / WAL 占用');
    expect(styles).not.toMatch(/\.stx-memory-search-wrap\s+\[data-ss-helper-control="input"\]\s*\{[^}]*padding/u);
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-page-heading\s*\{[^}]*min-height:\s*42px/u);
    expect(styles).toMatch(/\.stx-memory-page-heading\s*>\s*div\s*\{[^}]*display:\s*grid/u);
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-page-heading\s+h2,[^}]*\.stx-memory-page-heading\s+p\s*\{[^}]*margin:\s*0/u);
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-detail-head\s*>\s*div\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/u);
    expect(styles).toMatch(/\.stx-memory-page-counter\s*\{[^}]*border-radius:\s*999px/u);
    expect(styles).toMatch(/\.stx-memory-error-guidance\s*\{[^}]*display:\s*flex/u);
    expect(styles).toMatch(/\.stx-memory-page-content:has\(> section\.stx-memory-panel\)[^}]*grid-template-columns/u);
    expect(styles).toMatch(/\.stx-memory-audit-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit/u);
    expect(styles).toMatch(/\.stx-memory-page-content:has\(> \.stx-memory-card-grid\)[^}]*grid-template-rows/u);
    expect(styles).toMatch(/\.stx-memory-multi-filter-menu\s*\{[^}]*position:\s*absolute[^}]*max-height:/u);
    expect(styles).toMatch(/\.stx-memory-multi-filter-option\s*\{[^}]*display:\s*flex/u);
    expect(styles).toMatch(/\.stx-memory-multi-filter-menu\s*\{[^}]*display:\s*grid[^}]*gap:\s*4px/u);
    expect(styles).toMatch(/\.stx-memory-multi-filter-option\.is-selected,\s*\.stx-memory-multi-filter-option\.is-partial\s*\{[^}]*border-color:\s*transparent[^}]*background:\s*transparent/u);
    expect(styles).not.toMatch(/\.stx-memory-multi-filter-option\.is-selected[^,{]*\{[^}]*border-left-color:/u);
    expect(styles).toMatch(/input\.stx-memory-multi-filter-native\[data-ss-helper-control="checkbox"\]\s*\{[^}]*clip-path:\s*inset\(50%\)[^}]*opacity:\s*0/u);
    expect(source).toContain('fa-solid fa-check');
    expect(source).not.toContain('fa-square-check');
    expect(source).not.toContain('fa-regular fa-square');
    expect(styles).toMatch(/\.stx-memory-card-grid\s*\{[^}]*min-height:\s*100%/u);
    expect(styles).toMatch(/\.stx-memory-reinitialize-drawer\s*\{[^}]*background-color:\s*var\(--ss-theme-surface,\s*#1b1b1a\)[^}]*animation:\s*stx-memory-reinitialize-drawer-in/u);
    expect(styles).toMatch(/\.stx-memory-drawer-backdrop\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*\.62\)[^}]*animation:\s*stx-memory-reinitialize-backdrop-in/u);
    expect(styles).toContain('@keyframes stx-memory-reinitialize-drawer-in');
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-multi-filter-trigger\[data-ss-helper-control="button"\]\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+24px[^}]*justify-content:\s*stretch/u);
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-fact-row\[data-ss-helper-control="button"\]\s*\{[^}]*min-height:\s*116px[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*align-items:\s*stretch[^}]*border-color:\s*transparent/u);
    expect(styles).toMatch(/\.stx-memory-workbench\s+\.stx-memory-fact-row\[data-ss-helper-control="button"\]\[aria-selected="true"\]\s*\{[^}]*border-color:\s*color-mix/u);
    expect(source).not.toMatch(/\bstx-ui-/u);
    expect(styles).not.toMatch(/\bstx-ui-/u);
    expect(styles).not.toMatch(/--memory-/u);
    expect(`${source}\n${styles}`).not.toMatch(/\bstx-memory-(?:button|input|chip|select-wrap)\b/u);
  });
});
