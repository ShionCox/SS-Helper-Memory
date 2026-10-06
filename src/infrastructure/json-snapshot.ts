const encoder = new TextEncoder();

export function textBytes(value: string | undefined): number {
  return value ? encoder.encode(value).byteLength : 0;
}

/** Split at Unicode boundaries; escaped counts the bytes inside a JSON string. */
export function splitUtf8(value: string, maximumBytes: number, escaped = false): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of value) {
    const size = textBytes(escaped ? JSON.stringify(character).slice(1, -1) : character);
    if (bytes > 0 && bytes + size > maximumBytes) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += size;
  }
  if (current || value.length === 0) chunks.push(current);
  return chunks;
}
