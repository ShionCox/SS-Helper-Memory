import type { MemoryOwner, SceneCast, SceneCastMember } from '../../domain';
import { type ActorResolution } from './actor-registry';
import { FIXED_OWNER_IDS } from '../../domain';
import type { SourceBlock } from '../ingest/types';
import { ActorRegistry } from './actor-registry';

export interface ActiveCastOptions {
  readonly currentFloor?: number;
  readonly lookbackFloors?: number;
  readonly maxSources?: number;
  readonly sceneEpoch?: string;
}

export interface ActiveCastResolution {
  readonly scene: SceneCast;
  readonly owners: readonly MemoryOwner[];
  readonly resolutions: readonly ActorResolution[];
}

const PRESENCE_CUES = /(?:在场|这里|来到|走进|站在|坐在|躺在|身旁|附近|跟着|陪同|面对|对面|房间里|现场|出现在)/gu;
const ABSENCE_CUES = /(?:不在|并未在|没有在|缺席|离开|不在场|没来|未到)/gu;
const PRIVATE_THOUGHT_CUES = /(?:心想|想到|暗自|内心|心里|没有说出口|秘密|独白|thought)/iu;
const NARRATOR_CUES = /(?:旁白|叙述|镜头|视角|与此同时|此时此刻)/u;

function floorOf(source: SourceBlock): number { return source.floor ?? 0; }
function unique(values: readonly string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function resolveName(registry: ActorRegistry, value: string, source: SourceBlock): ActorResolution | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const direct = registry.getOwner(trimmed);
  if (direct) return { owner: direct, method: 'exact', confidence: 1, ambiguous: false };
  const known = registry.resolveMention(trimmed);
  if (known) return known;
  return registry.discover({
    displayName: trimmed,
    sourceRef: source.id,
    sourceType: source.kind === 'host_card' ? 'host_card' : source.kind === 'worldbook' ? 'worldbook' : 'message',
    excerpt: source.content.slice(0, 240),
    confidence: source.kind === 'host_card' || source.kind === 'worldbook'
      ? 0.9
      : source.author?.kind === 'assistant' && source.author.displayName?.trim()
        ? 0.8
        : 0.55,
  });
}

function explicitSpeakerName(content: string): string | undefined {
  // Keep this deliberately conservative. A host author is provenance only;
  // a name becomes a speaker when the text itself uses a dialogue/narration
  // construction such as “A说：…” or “B: …”.
  const match = content.match(/^\s*[“「『]?([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·_-]{0,31}?)[”」』]?\s*(?:说|道|喊|问|答|低声|轻声|心想|：|:)\s*/u);
  return match?.[1]?.trim() || undefined;
}

function namesInContent(registry: ActorRegistry, source: SourceBlock): ActorResolution[] {
  const candidates = registry.listOwners().filter(owner => owner.kind === 'actor').flatMap(owner => [owner.displayName, ...owner.aliases]);
  const containsName = (name: string): boolean => {
    if (name.length === 1 && /^[A-Za-z0-9]$/u.test(name)) return new RegExp(`(?:^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9])`, 'u').test(source.content);
    return source.content.includes(name);
  };
  return unique(candidates).filter(name => name.length >= 1 && containsName(name)).map(name => resolveName(registry, name, source)).filter((item): item is ActorResolution => Boolean(item));
}

function hasLocalPresenceCue(content: string, name: string): boolean {
  return content.split(/[。！？!?\n]/u).some(sentence => {
    const nameIndex = sentence.indexOf(name);
    if (nameIndex < 0) return false;
    for (const match of sentence.matchAll(ABSENCE_CUES)) {
      const cueIndex = match.index ?? -1;
      if (cueIndex >= 0 && Math.abs(cueIndex - nameIndex) <= Math.max(10, name.length + 5)) return false;
    }
    for (const match of sentence.matchAll(PRESENCE_CUES)) {
      const cueIndex = match.index ?? -1;
      if (cueIndex >= 0 && Math.abs(cueIndex - nameIndex) <= Math.max(8, name.length + 4)) return true;
    }
    return false;
  });
}

/**
 * Resolves the cast of the current scene from recent source blocks. Mentioned
 * names are kept separate from present listeners; only speaker and explicit
 * presence cues enter `presentOwnerIds`.
 */
export class ActiveCastResolver {
  constructor(private readonly registry: ActorRegistry) {}

  resolve(sources: readonly SourceBlock[], options: ActiveCastOptions = {}): ActiveCastResolution {
    const currentFloor = options.currentFloor ?? Math.max(0, ...sources.map(floorOf));
    const lookback = Math.max(1, options.lookbackFloors ?? 8);
    const recent = sources.filter(source => floorOf(source) >= currentFloor - lookback && floorOf(source) <= currentFloor).slice(-Math.max(1, options.maxSources ?? 64));
    const members = new Map<string, SceneCastMember>();
    const mentioned = new Set<string>();
    const present = new Set<string>();
    const speakers = new Set<string>();
    let viewpointOwnerId: string = FIXED_OWNER_IDS.narrator;
    const resolutions: ActorResolution[] = [];

    const addMember = (ownerId: string, role: SceneCastMember['role'], source: SourceBlock, confidence: number): void => {
      const existing = members.get(`${ownerId}:${role}`);
      const sourceRefs = unique([...(existing?.sourceRefs ?? []), source.id]);
      members.set(`${ownerId}:${role}`, { ownerId, role, confidence: Math.max(existing?.confidence ?? 0, confidence), sourceRefs });
    };

    for (const source of recent) {
      const content = source.content;
      const author = source.author;
      let speakerId: string | undefined;
      if (source.kind === 'message') {
        if (author?.kind === 'user' || source.role === 'user') speakerId = FIXED_OWNER_IDS.player;
        else if (author?.kind === 'narrator' || source.messageType === 'narrator' || NARRATOR_CUES.test(content)) speakerId = FIXED_OWNER_IDS.narrator;
        else if (source.perspective?.speakerOwnerRef) speakerId = resolveName(this.registry, source.perspective.speakerOwnerRef, source)?.owner.id;
        else {
          const explicitName = explicitSpeakerName(content);
          const authorName = author?.displayName;
          // Host assistant messages are authored by the current character even
          // when the text is first-person and never repeats the character name.
          // Explicit refs/name mentions remain the fallback for other sources.
          // `SourceAuthor.displayName` is explicit host provenance. It may be
          // the only speaker signal for a first-person assistant message; the
          // registry keeps generic labels pending/unknown rather than creating
          // a fake in-world actor.
          const explicitAuthorName = authorName?.trim() ?? '';
          speakerId = resolveName(this.registry, explicitName ?? explicitAuthorName, source)?.owner.id;
        }
      }
      if (speakerId) {
        speakers.add(speakerId);
        addMember(speakerId, speakerId === FIXED_OWNER_IDS.narrator ? 'narrator' : 'speaker', source, 0.96);
        if (speakerId !== FIXED_OWNER_IDS.narrator) {
          present.add(speakerId);
          addMember(speakerId, 'present', source, 0.96);
          viewpointOwnerId = speakerId;
        }
      }

      const found = namesInContent(this.registry, source);
      for (const resolution of found) {
        resolutions.push(resolution);
        const ownerId = resolution.owner.id;
        mentioned.add(ownerId);
        addMember(ownerId, 'mentioned', source, resolution.confidence);
        if (speakerId === ownerId) addMember(ownerId, 'speaker', source, 0.96);
        if (hasLocalPresenceCue(content, resolution.owner.displayName) || speakerId === ownerId) {
          present.add(ownerId);
          addMember(ownerId, 'present', source, Math.max(0.7, resolution.confidence));
        }
        if (PRIVATE_THOUGHT_CUES.test(content) && speakerId === ownerId) addMember(ownerId, 'viewpoint', source, 0.9);
      }
      const explicitRefs = [
        ...(source.actorRefs ?? []),
        ...(source.perspective?.mentionedOwnerRefs ?? []),
      ];
      for (const ref of explicitRefs) {
        const resolution = resolveName(this.registry, ref, source);
        if (!resolution) continue;
        resolutions.push(resolution);
        mentioned.add(resolution.owner.id);
        addMember(resolution.owner.id, 'mentioned', source, resolution.confidence);
      }
      for (const ref of source.perspective?.presentOwnerRefs ?? []) {
        const resolution = resolveName(this.registry, ref, source);
        if (!resolution) continue;
        resolutions.push(resolution);
        mentioned.add(resolution.owner.id);
        present.add(resolution.owner.id);
        addMember(resolution.owner.id, 'present', source, resolution.confidence);
      }
      for (const ref of source.perspective?.observerOwnerRefs ?? []) {
        const resolution = resolveName(this.registry, ref, source);
        if (!resolution) continue;
        resolutions.push(resolution);
        present.add(resolution.owner.id);
        addMember(resolution.owner.id, 'present', source, resolution.confidence);
      }
      if (source.perspective?.viewpointOwnerRef) {
        const resolution = resolveName(this.registry, source.perspective.viewpointOwnerRef, source);
        if (resolution) {
          viewpointOwnerId = resolution.owner.id;
          addMember(viewpointOwnerId, 'viewpoint', source, source.perspective.confidence ?? resolution.confidence);
        }
      }
      if (source.kind === 'state' || source.kind === 'worldbook' || source.kind === 'host_card') {
        addMember(FIXED_OWNER_IDS.world, 'world', source, 1);
      }
    }

    addMember(FIXED_OWNER_IDS.narrator, 'narrator', recent[recent.length - 1] ?? { id: 'scene', content: '', kind: 'message', role: 'metadata', createdAt: Date.now(), chatKey: '' }, 1);
    const chatKey = recent[0]?.chatKey ?? '';
    const scene: SceneCast = {
      // Scene casts are chat-scoped records. Including the chat key prevents
      // equal floor/epoch values in two chats from overwriting one another in
      // the shared workspace collection.
      id: `scene-cast:${this.registry.workspaceId}:${encodeURIComponent(chatKey)}:${currentFloor}:${encodeURIComponent(options.sceneEpoch ?? 'default')}`,
      workspaceId: this.registry.workspaceId,
      chatKey,
      floor: currentFloor,
      members: [...members.values()],
      viewpointOwnerId,
      speakerOwnerIds: [...speakers],
      presentOwnerIds: [...present],
      mentionedOwnerIds: [...mentioned],
      createdAt: Date.now(),
    };
    const owners = scene.members.map(member => this.registry.getOwner(member.ownerId)).filter((owner): owner is MemoryOwner => Boolean(owner));
    return { scene, owners, resolutions };
  }
}
