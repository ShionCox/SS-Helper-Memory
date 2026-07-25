import {
  canonicalActorDisplayName,
  normalizeActorName,
  normalizeLocationName,
} from './multi-actor-memory';

export type EntityBoundaryTrust = 'trusted' | 'candidate' | 'manual';

export interface EntityBoundaryOptions {
  readonly trust?: EntityBoundaryTrust;
  readonly evidence?: string;
  readonly aliases?: readonly string[];
}

function locationHasEvidence(name: string, evidence: string): boolean {
  const canonicalName = name.normalize('NFKC').trim();
  const text = evidence.normalize('NFKC');
  if (!canonicalName || !text.toLocaleLowerCase().includes(canonicalName.toLocaleLowerCase())) return false;
  const escaped = escapeRegExp(canonicalName);
  const explicitRelation = new RegExp(
    `(?:在|于|位于|身处|前往|抵达|返回|来到|移动到|留在|进入|离开|撤回到|驻扎在|藏在|住在)\\s*[^，。！？\\n]{0,20}${escaped}`
      + `|${escaped}\\s*(?:内|中|里|外|附近)(?:[，。！？\\s]|$)`
      + `|(?:所在位置|位置)\\s*[：:]\\s*[^，。！？\\n]{0,12}${escaped}`
      + `|(?:in|at|to|from|inside|outside|entered|left|arrived\\s+at|returned\\s+to|located\\s+in)\\s+[^.!?\\n]{0,30}${escaped}`,
    'iu',
  ).test(text);
  if (explicitRelation) return true;
  // Place morphology is a weak, language-level signal rather than a project
  // dictionary. It is accepted only when the proposed name occurs verbatim in
  // the evidence, which keeps arbitrary objects from becoming locations.
  return CHINESE_LOCATION_MORPHOLOGY.test(canonicalName)
    || LATIN_LOCATION_MORPHOLOGY.test(canonicalName);
}

export interface EntityBoundaryDecision {
  readonly accepted: boolean;
  readonly reason:
    | 'accepted'
    | 'empty'
    | 'too_long'
    | 'reserved_protocol_name'
    | 'structural_phrase'
    | 'quantified_value'
    | 'generic_reference'
    | 'not_name_like'
    | 'non_agent_without_evidence'
    | 'generic_location';
  readonly canonicalName: string;
}

const RESERVED_PROTOCOL_NAMES = new Set([
  'assistant', 'user', 'system', 'narrator', 'player', 'world', 'character', 'character card',
  '旁白', '玩家', '世界', '系统消息', '角色卡',
].map(normalizeActorName));

const GENERIC_ACTOR_REFERENCES = new Set([
  '某人', '有人', '这个人', '那个人', '一名男子', '一名女子', '男子', '女子',
  '他', '她', '他们', '她们', '它', '它们', '角色', '人物', '路人', '陌生人',
  '无', '暂无', '没有', '不适用', '未出现',
  'someone', 'somebody', 'person', 'man', 'woman', 'boy', 'girl', 'he', 'she', 'they', 'npc',
].map(normalizeActorName));

const GENERIC_LOCATION_REFERENCES = new Set([
  '这里', '那里', '附近', '外面', '里面', '当前位置', '地点', '场景', '某处', '一处',
  '房间', '区域', '地方', '周围', '前方', '后方', '左侧', '右侧', '原地',
  '无', '暂无', '没有', '不适用', '未知地点',
  'here', 'there', 'nearby', 'outside', 'inside', 'somewhere', 'place', 'area', 'unknown location',
].map(normalizeLocationName));

const QUANTIFIED_VALUE = new RegExp([
  '(?:^\\s*[-+]?\\d+(?:\\.\\d+)?\\s*(?:%|个|枚|包|瓶|盒|组|份|把|支|颗|台|公斤|千克|克|毫升|升|米|厘米|公里)\\s*$|',
  '[xX×]\\s*\\d+\\s*$|',
  '\\d+\\s*(?:个|枚|包|瓶|盒|组|份|把|支|颗|台|公斤|千克|克|毫升|升|%|米|厘米|公里)\\s*$)',
].join(''), 'u');

const STRUCTURAL_PHRASE = /(?:的话|的表情|的状态|的内容|的选项|当前不适用)$/u;
const STRUCTURED_FIELD = /^[^：:\r\n]{1,32}[：:]\s*\S+/u;
const IDENTITY_EVIDENCE = /(?:名为|名叫|叫作|叫做|称为|角色\s*[：:]|人物\s*[：:]|NPC\s*[：:])/iu;
const CHINESE_LOCATION_MORPHOLOGY = /(?:国|州|省|市|县|区|镇|乡|村|城|堡|宫|塔|岛|山|谷|河|湖|海|港|路|街|巷|桥|站|店|馆|院|所|厅|室|房|楼|层|宅|屋|营地|基地|仓库|车库|实验室|办公室|学校|医院|工厂|农场|市场|广场|公园|森林|草原|沙漠|洞穴|遗迹|矿井|车站|机场|码头|船舱|车厢)$/u;
const LATIN_LOCATION_MORPHOLOGY = /(?:^|[\s_-])(?:room|hall|station|base|lab|laboratory|street|road|city|village|port|harbou?r|warehouse|garage|school|hospital|market|park|forest|cave|island|deck|cabin)$/iu;
/**
 * Strong actions are difficult to attribute to an ordinary object by accident:
 * speaking, thinking, deciding, negotiating, commanding, intentional social
 * interaction, and clearly embodied reactions. One such predicate is enough
 * to ground a new actor candidate.
 */
const STRONG_AGENTIVE_ACTION = new RegExp([
  '(?:说|问|答|回应|解释|报告|开口|呼喊|自称|介绍|想|思考|认为|决定|计划|命令|拒绝|同意|',
  '承诺|请求|警告|建议|安慰|感谢|道歉|撒谎|怀疑|相信|记得|忘记|',
  '点头|摇头|笑|哭|保护|帮助|攻击|防御|治疗|带领|召集|递给|接过|敲门|跟随|警戒|',
  'speaks?|says?|asks?|answers?|replies?|reports?|thinks?|decides?|plans?|refuses?|agrees?|',
  'promises?|requests?|warns?|suggests?|believes?|remembers?|forgets?|',
  'attacks?|defends?|protects?|helps?|follows?|nods?|cries?|laughs?)',
].join(''), 'iu');

/**
 * Movement, appearance and operational verbs are weak evidence: vehicles,
 * doors, batteries, programs and weather systems can also “enter”, “start” or
 * “stop”. They only count when a second independent animate/intentional signal
 * is present in the same local sentence.
 */
const WEAK_AGENTIVE_ACTION = new RegExp([
  '(?:出现|现身|加入|抵达|到达|走|跑|进入|离开|返回|站|坐|醒来|睡去|',
  '使用|操作|启动|关闭|修理|驾驶|拿起|放下|触碰|转身|靠近|等待|',
  'appears?|joins?|arrives?|walks?|runs?|enters?|leaves?|returns?|waits?|',
  'uses?|operates?|starts?|stops?|repairs?|drives?|moves?|turns?)',
].join(''), 'iu');

const INTENTIONAL_CONTEXT = new RegExp([
  '(?:主动|故意|试图|尝试|准备|为了|于是|随后|再次|悄悄|谨慎地|迅速地|',
  '他|她|他们|她们|本人|自己|队长|成员|同伴|角色|人物|NPC|',
  'intentionally|deliberately|tries?\\s+to|attempts?\\s+to|decides?\\s+to|',
  'he|she|they|himself|herself|themselves|captain|member|companion|character|npc)',
].join(''), 'iu');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function actorHasAgencyEvidence(names: readonly string[], evidence: string): boolean {
  const text = evidence.normalize('NFKC');
  const foldedText = text.toLocaleLowerCase();
  if (!text.trim()) return false;
  for (const rawName of names) {
    const name = canonicalActorDisplayName(rawName);
    if (!name || !foldedText.includes(name.toLocaleLowerCase())) continue;
    const escaped = escapeRegExp(name);
    if (new RegExp(`(?:^|[\\s“”‘’，。！？；：、])${escaped}\\s*[：:]`, 'u').test(text)) return true;
    if (new RegExp(`${escaped}[^。！？.!?\\n]{0,24}${STRONG_AGENTIVE_ACTION.source}`, 'iu').test(text)) return true;
    if (IDENTITY_EVIDENCE.test(text) && new RegExp(`${IDENTITY_EVIDENCE.source}[^。！？\\n]{0,20}${escaped}`, 'iu').test(text)) return true;
    const localSentence = text.match(new RegExp(`[^。！？.!?\\n]{0,36}${escaped}[^。！？.!?\\n]{0,48}`, 'iu'))?.[0] ?? '';
    if (localSentence
      && WEAK_AGENTIVE_ACTION.test(localSentence)
      && INTENTIONAL_CONTEXT.test(localSentence)) return true;
  }
  return false;
}

export function classifyActorName(value: string, options: EntityBoundaryOptions = {}): EntityBoundaryDecision {
  const trust = options.trust ?? 'candidate';
  const canonicalName = canonicalActorDisplayName(value);
  const normalized = normalizeActorName(canonicalName);
  if (!canonicalName || !normalized) return { accepted: false, reason: 'empty', canonicalName };
  if (Array.from(canonicalName).length > 80) return { accepted: false, reason: 'too_long', canonicalName };
  if (RESERVED_PROTOCOL_NAMES.has(normalized) || /^(?:owner|location):/iu.test(canonicalName)) {
    return { accepted: false, reason: 'reserved_protocol_name', canonicalName };
  }
  if (trust !== 'manual' && STRUCTURED_FIELD.test(canonicalName)) return { accepted: false, reason: 'structural_phrase', canonicalName };
  if (STRUCTURAL_PHRASE.test(canonicalName)) return { accepted: false, reason: 'structural_phrase', canonicalName };
  if (QUANTIFIED_VALUE.test(canonicalName)) return { accepted: false, reason: 'quantified_value', canonicalName };
  if (GENERIC_ACTOR_REFERENCES.has(normalized)) return { accepted: false, reason: 'generic_reference', canonicalName };
  if (!/[\p{L}\p{N}]/u.test(canonicalName) || /[\r\n\t]/u.test(canonicalName)) {
    return { accepted: false, reason: 'not_name_like', canonicalName };
  }
  // An explicit host cast/state declaration or a manual correction is the
  // identity authority. Ordinary nouns are valid character names in arbitrary
  // stories; only protocol/generic/structured values above remain forbidden.
  if (trust === 'manual' || trust === 'trusted') return { accepted: true, reason: 'accepted', canonicalName };
  // New model-discovered identities must be grounded as agents. This is more
  // general than maintaining an ever-growing blacklist of food, equipment,
  // species and location nouns, and still permits any ordinary noun to be a
  // character when the text actually shows it speaking, acting or being named.
  if (!actorHasAgencyEvidence([canonicalName, ...(options.aliases ?? [])], options.evidence ?? '')) {
    return { accepted: false, reason: 'non_agent_without_evidence', canonicalName };
  }
  return { accepted: true, reason: 'accepted', canonicalName };
}

export function classifyLocationName(value: string, options: EntityBoundaryOptions = {}): EntityBoundaryDecision {
  const trust = options.trust ?? 'candidate';
  const canonicalName = value.normalize('NFKC').trim();
  const normalized = normalizeLocationName(canonicalName);
  if (!canonicalName || !normalized) return { accepted: false, reason: 'empty', canonicalName };
  if (Array.from(canonicalName).length > 100) return { accepted: false, reason: 'too_long', canonicalName };
  if (RESERVED_PROTOCOL_NAMES.has(normalizeActorName(canonicalName)) || /^(?:owner|actor):/iu.test(canonicalName)) {
    return { accepted: false, reason: 'reserved_protocol_name', canonicalName };
  }
  if (trust !== 'manual' && STRUCTURED_FIELD.test(canonicalName)) return { accepted: false, reason: 'structural_phrase', canonicalName };
  if (STRUCTURAL_PHRASE.test(canonicalName)) return { accepted: false, reason: 'structural_phrase', canonicalName };
  if (QUANTIFIED_VALUE.test(canonicalName)) return { accepted: false, reason: 'quantified_value', canonicalName };
  if (GENERIC_LOCATION_REFERENCES.has(normalized)) return { accepted: false, reason: 'generic_location', canonicalName };
  if (!/[\p{L}\p{N}]/u.test(canonicalName) || /[\r\n\t]/u.test(canonicalName)) {
    return { accepted: false, reason: 'not_name_like', canonicalName };
  }
  // Trusted state/location fields and manual corrections are authoritative;
  // untrusted model candidates still need the locative grounding below.
  if (trust === 'manual' || trust === 'trusted') return { accepted: true, reason: 'accepted', canonicalName };
  // Likewise, a new location candidate needs local locative evidence rather
  // than a language- and story-specific list of place suffixes.
  if (!locationHasEvidence(canonicalName, options.evidence ?? '')) {
    return { accepted: false, reason: 'generic_location', canonicalName };
  }
  return { accepted: true, reason: 'accepted', canonicalName };
}
