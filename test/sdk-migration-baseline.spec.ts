import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const text = (relativePath: string) => readFile(path.join(root, relativePath), 'utf8');
const json = async (relativePath: string) => JSON.parse(await text(relativePath)) as Record<string, unknown>;

describe('SDK workspace architecture baseline', () => {
  it('keeps Memory as one frontend extension with a single version source', async () => {
    const [config, manifest, rootPackage] = await Promise.all([json('plugin.config.json'), json('manifest.json'), json('package.json')]);
    expect(config.kind).toBe('frontend-extension');
    expect((config.manifest as { version?: string }).version).toBe('V0.0.2');
    expect(manifest.version).toBe('V0.0.2');
    expect(rootPackage).not.toHaveProperty('version');
    await expect(access(path.join(root, 'server', 'index.js'))).rejects.toThrow();
  });

  it('owns domain logic while persistence uses only the generic WorkspacePort', async () => {
    const [repository, runtime, host] = await Promise.all([
      text('src/infrastructure/memory-repository.ts'), text('src/host/memory-runtime.ts'), text('src/host/sdk-host-context.ts'),
    ]);
    expect(repository).toContain('WorkspacePort');
    expect(repository).toContain("const SETTINGS_WORKSPACE_ID = 'settings:global'");
    expect(repository).toContain("'fact-slots'");
    expect(repository).toContain('this.workspace.transaction(');
    expect(repository).toContain('this.workspace.exportAll()');
    expect(repository).not.toContain('/api/plugins/ss-helper-sdk/v1/memory');
    expect(runtime).toContain('new MemoryRepository(session.workspace)');
    expect(host).toContain('getWorkspaceId(): string');
    expect(host).not.toContain('getBinaryRequestPort');
  });

  it('keeps chat identity as audit metadata and workspace identity as visibility', async () => {
    const [host, repository] = await Promise.all([text('src/host/sdk-host-context.ts'), text('src/infrastructure/memory-repository.ts')]);
    expect(host).toContain('getChatKey(): string { return this.sourceChatKey; }');
    expect(host).toContain('getWorkspaceId(): string { return this.workspaceKey; }');
    expect(host).toContain('`character:${characterId}`');
    expect(repository).toContain("this.listAllRecordRows('evidence', { chatKey })");
    expect(repository).toContain('preserveWorkspaceIds: [SETTINGS_WORKSPACE_ID]');
  });

  it('retains public capture, recall, workbench and prompt APIs', async () => {
    const [api, application, runtime, ui] = await Promise.all([text('src/index.ts'), text('src/application/memory-application.ts'), text('src/host/memory-runtime.ts'), text('src/ui/memory-ui.ts')]);
    expect(api).toContain('capture: {');
    expect(api).toContain('recall: {');
    expect(api).toContain('clearAllMemoryData(): Promise<void>');
    expect(application).toContain('this.capture = { flush:');
    expect(runtime).toContain("events.subscribe('prompt-ready'");
    expect(ui).toContain('清空全部角色记忆');
  });
});
