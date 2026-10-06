import type { MemoryFactKind } from './memory-types';

function normalizeKeyPart(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export function createCanonicalKey(subjectKey: string, predicateKey: string, objectKey?: string): string {
  return [subjectKey, predicateKey, objectKey].map(normalizeKeyPart).join('::');
}

export function createFactSlotKey(
  subjectKey: string,
  predicateKey: string,
  objectKey?: string,
  kind?: MemoryFactKind,
): string {
  // These fact classes describe a relation to one specific object. Keeping the
  // object in their slot prevents an update about B from superseding the same
  // subject's independent relation/preference/capability concerning A.
  const objectScoped = kind === 'relationship' || kind === 'preference' || kind === 'capability';
  return [subjectKey, predicateKey, ...(objectScoped ? [objectKey] : [])]
    .map(normalizeKeyPart)
    .join('::');
}

export function normalizeFactContent(content: string): string {
  return content.trim().replace(/\s+/gu, ' ');
}
