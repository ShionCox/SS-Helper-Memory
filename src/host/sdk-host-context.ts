import type {
  HostCharacterSnapshot,
  HostPersonaSnapshot,
  PluginSession,
  WorldbookSnapshot,
} from '@ss-helper/sdk';
import type { SourceBlock } from '../application/ingest/types';
import type { MemoryHostCapability } from '../ss-helper/plugin';
import { collectCurrentChatSources, type MemorySourceReader } from './source-adapter';

function stableId(value: unknown): string {
  if (value === null || value === undefined) return '';
  const id = String(value).trim();
  return id && !/^(?:null|undefined)$/i.test(id) ? id : '';
}

export interface MemoryHostContext {
  getChatKey(): string;
  getWorkspaceId(): string;
  collectSources(chatKey: string): Promise<SourceBlock[]>;
  getRecallContext?(): Promise<{ characterKeys: string[]; worldKeys: string[] }>;
}

export class SdkMemoryHostContext implements MemoryHostContext, MemorySourceReader {
  private sourceChatKey = '';
  private workspaceKey = '';

  constructor(private readonly session: PluginSession<MemoryHostCapability>) {}

  getChatKey(): string { return this.sourceChatKey; }
  getWorkspaceId(): string { return this.workspaceKey; }

  setChatKey(chatKey: string): void { this.sourceChatKey = chatKey.trim(); }

  async refresh(): Promise<string> {
    const context = await this.session.host.context.read();
    this.sourceChatKey = String(context.chatKey ?? context.chatId ?? '').trim();
    const groupId = stableId(context.groupId);
    if (groupId) this.workspaceKey = `group:${groupId}`;
    else {
      const character = await this.session.host.character?.read?.() ?? null;
      const characterId = stableId(character?.id);
      this.workspaceKey = characterId ? `character:${characterId}` : '';
    }
    return this.workspaceKey;
  }

  readMessages() { return this.session.host.chat.readMessages(); }
  readCharacter(): Promise<HostCharacterSnapshot | null> { return this.session.host.character.read(); }
  readPersona(): Promise<HostPersonaSnapshot | null> { return this.session.host.persona.read(); }
  readActiveWorldbooks(): Promise<readonly WorldbookSnapshot[]> { return this.session.host.worldbooks.active(); }

  collectSources(chatKey: string): Promise<SourceBlock[]> {
    return collectCurrentChatSources(chatKey, this);
  }

  async getRecallContext(): Promise<{ characterKeys: string[]; worldKeys: string[] }> {
    const [character, books] = await Promise.all([this.readCharacter(), this.readActiveWorldbooks()]);
    return {
      characterKeys: character ? [character.id, character.name].filter(Boolean) : [],
      worldKeys: books.flatMap((book) => [book.id, book.name]).filter(Boolean),
    };
  }
}
