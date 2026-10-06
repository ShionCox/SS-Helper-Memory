/** 将向量校验并复制成可安全持久化的独立 ArrayBuffer。 */
export function float32ArrayToArrayBuffer(vector: readonly number[] | Float32Array): ArrayBuffer {
  if (vector.length === 0) throw new Error('向量维度必须是正整数。');
  const normalized = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  for (let index = 0; index < normalized.length; index += 1) {
    if (!Number.isFinite(normalized[index])) throw new Error(`向量第 ${index} 维不是有限数值。`);
  }
  const bytes = new Uint8Array(normalized.byteLength);
  bytes.set(new Uint8Array(normalized.buffer, normalized.byteOffset, normalized.byteLength));
  return bytes.buffer;
}

/** 对事实正文计算小写 SHA-256，供内容变更失效检测使用。 */
export async function sha256Content(content: string): Promise<string> {
  if (typeof content !== 'string') throw new Error('向量正文必须是字符串。');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前运行环境不支持 SHA-256。');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
