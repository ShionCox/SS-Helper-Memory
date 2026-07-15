import type {
  HostCharacterSnapshot,
  HostPersonaSnapshot,
  PluginSession,
  WorldbookSnapshot,
} from '@ss-helper/sdk';
import type { SourceBlock } from '../application/ingest/types';
import type { MemoryHostCapability } from '../ss-helper/plugin';
import type { MemoryPluginBinaryRequestPort, MemoryPluginRequestPort } from '../infrastructure/memory-sqlite-client';
import { collectCurrentChatSources, type MemorySourceReader } from './source-adapter';

export interface MemoryHostContext {
  getChatKey(): string;
  collectSources(chatKey: string): Promise<SourceBlock[]>;
  getRecallContext?(): Promise<{ characterKeys: string[]; worldKeys: string[] }>;
  getRequestPort?(): MemoryPluginRequestPort;
  getBinaryRequestPort?(): MemoryPluginBinaryRequestPort;
}

export class SdkMemoryHostContext implements MemoryHostContext, MemorySourceReader {
  private chatKey = '';

  constructor(private readonly session: PluginSession<MemoryHostCapability>) {}

  getChatKey(): string { return this.chatKey; }

  setChatKey(chatKey: string): void { this.chatKey = chatKey.trim(); }

  async refresh(): Promise<string> {
    const context = await this.session.host.context.read();
    this.chatKey = String(context.chatKey ?? context.chatId ?? '').trim();
    return this.chatKey;
  }

  readMessages() { return this.session.host.chat.readMessages(); }
  readCharacter(): Promise<HostCharacterSnapshot | null> { return this.session.host.character.read(); }
  readPersona(): Promise<HostPersonaSnapshot | null> { return this.session.host.persona.read(); }
  readActiveWorldbooks(): Promise<readonly WorldbookSnapshot[]> { return this.session.host.worldbooks.active(); }

  collectSources(chatKey: string): Promise<SourceBlock[]> {
    return collectCurrentChatSources(chatKey, this);
  }

  getRequestPort(): MemoryPluginRequestPort { return this.session.host.request; }
  getBinaryRequestPort(): MemoryPluginBinaryRequestPort { return this.session.host.binaryRequest; }

  async getRecallContext(): Promise<{ characterKeys: string[]; worldKeys: string[] }> {
    const [character, books] = await Promise.all([this.readCharacter(), this.readActiveWorldbooks()]);
    return {
      characterKeys: character ? [character.id, character.name].filter(Boolean) : [],
      worldKeys: books.flatMap((book) => [book.id, book.name]).filter(Boolean),
    };
  }
}
