const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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

/** 将持久化数据复制成 Float32Array，拒绝空数据和非 4 字节对齐的数据。 */
export function arrayBufferToFloat32Array(buffer: ArrayBuffer): Float32Array {
  if (buffer.byteLength === 0 || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('持久化向量的字节长度无效。');
  }
  const copy = buffer.slice(0);
  const vector = new Float32Array(copy);
  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) throw new Error(`持久化向量第 ${index} 维不是有限数值。`);
  }
  return vector;
}

/** 对事实正文计算小写 SHA-256，供内容变更失效检测使用。 */
export async function sha256Content(content: string): Promise<string> {
  if (typeof content !== 'string') throw new Error('向量正文必须是字符串。');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前运行环境不支持 SHA-256。');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export function isSha256ContentHash(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

/** 计算两个同维有限向量的余弦相似度；任一向量为零向量时返回 0。 */
export function cosineSimilarity(
  leftInput: readonly number[] | Float32Array,
  rightInput: readonly number[] | Float32Array,
): number {
  if (leftInput.length === 0 || leftInput.length !== rightInput.length) {
    throw new Error('余弦相似度要求两个非空且同维的向量。');
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < leftInput.length; index += 1) {
    const left = leftInput[index];
    const right = rightInput[index];
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error('余弦相似度不能处理非有限数值。');
    dot += left * right;
    leftNorm += left * left;
    rightNorm += right * right;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
