const INSTRUCTION_LIKE = /(忽略.{0,12}(规则|指令)|继续调用|导出全部|system\s+prompt|developer\s+message|ignore.{0,12}(rule|instruction))/iu;

export interface SanitizedToolValue {
  readonly value: unknown;
  readonly instructionLikeTextDetected: boolean;
}

function cleanText(value: string): { value: string; detected: boolean } {
  const detected = INSTRUCTION_LIKE.test(value);
  return {
    value: value
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
      .replace(/<[^>]{1,500}>/gu, '')
      .replace(/```[\s\S]{0,4000}?```/gu, '[代码块已省略]')
      .slice(0, 1_200),
    detected,
  };
}

export function sanitizeToolValue(value: unknown, depth = 0): SanitizedToolValue {
  if (depth > 8) return { value: '[嵌套内容已截断]', instructionLikeTextDetected: false };
  if (typeof value === 'string') {
    const cleaned = cleanText(value);
    return { value: cleaned.value, instructionLikeTextDetected: cleaned.detected };
  }
  if (Array.isArray(value)) {
    let detected = false;
    const sanitized = value.slice(0, 50).map(item => {
      const result = sanitizeToolValue(item, depth + 1);
      detected ||= result.instructionLikeTextDetected;
      return result.value;
    });
    return { value: sanitized, instructionLikeTextDetected: detected };
  }
  if (value && typeof value === 'object') {
    let detected = false;
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 80).map(([key, item]) => {
      const result = sanitizeToolValue(item, depth + 1);
      detected ||= result.instructionLikeTextDetected;
      return [key.slice(0, 80), result.value];
    });
    return { value: Object.fromEntries(entries), instructionLikeTextDetected: detected };
  }
  return { value, instructionLikeTextDetected: false };
}
