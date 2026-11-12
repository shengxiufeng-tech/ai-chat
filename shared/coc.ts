// 《克苏鲁的呼唤》第七版（COC 7th）规则引擎：骰子、检定、车卡、角色卡
// 这里实现的是规则机制本身（d100 检定、成功等级等），职业和技能列表是为新手简化过的版本。

import type { ScriptAsset } from './types.ts';

// ---------------- 类型 ----------------

export type CharKey = 'STR' | 'CON' | 'SIZ' | 'DEX' | 'APP' | 'INT' | 'POW' | 'EDU';
export type Characteristics = Record<CharKey, number>;
export type Era = '1920s' | 'modern';

export interface Pool {
  current: number;
  max: number;
}

export interface InvestigatorSheet {
  name: string;
  occupation: string;
  age: number;
  gender: string;
  /** 形象描述 */
  appearance: string;
  /** 背景故事 */
  backstory: string;
  characteristics: Characteristics;
  luck: number;
  hp: Pool;
  mp: Pool;
  san: Pool & { start: number };
  mov: number;
  damageBonus: string;
  build: number;
  skills: Record<string, number>;
  items: string[];
  notes: string;
}

export interface AssistantEntry {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

export interface TrpgState {
  scenarioId: string;
  scenarioTitle: string;
  /** 玩家能看到的剧本简介 */
  scenarioIntro: string;
  /** 只有守秘人能看到的剧本内容 */
  scenarioSecret: string;
  /** 用哪套技能：1920 年代 / 现代 */
  era: Era;
  /** 时代背景（自由描述，比如「1927 年，江南水乡」） */
  eraLabel?: string;
  /** 开团须知（推荐人数、时长、推荐技能、车卡限制等），玩家可以看 */
  playerInfo?: string;
  /** 新手教学模式：守秘人会附上规则小贴士 */
  teachingMode: boolean;
  /** 自动替玩家掷骰 */
  autoRoll: boolean;
  /** 守秘人说完后 AI 队友是否自动行动 */
  teammatesAct: boolean;
  /** 角色卡：'player' 是人类玩家，其余 key 是 AI 队友的参与者 id */
  sheets: Record<string, InvestigatorSheet>;
  /** 守秘人是否已经开场 */
  started: boolean;
  /** 规则助手的对话记录 */
  assistantLog: AssistantEntry[];
  /** 守秘人笔记：开启后守秘人会记录 NPC 和线索（玩家可见） */
  notebook: boolean;
  notes: NoteEntry[];
  /** 秘密备忘：守秘人自己定下的秘密设定，只有守秘人能看到 */
  memo: boolean;
  memos: MemoEntry[];
  /** PDF 剧本里的手出物和地图（图片在数据目录的 assets/<房间 id>/ 下） */
  assets?: ScriptAsset[];
  /** 剧本自带的预设调查员 */
  pregens?: InvestigatorSheet[];
  /** 把地图图片附给守秘人（守秘人的模型要能看图），默认开启 */
  mapsToKp?: boolean;
}

/** 秘密备忘的一条（主题 + 内容），玩家、AI 队友和规则助手都看不到 */
export interface MemoEntry {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export type NoteKind = 'npc' | 'clue';

/** 守秘人笔记里的一条：NPC 或线索。玩家可以看到 */
export interface NoteEntry {
  id: string;
  kind: NoteKind;
  /** NPC 名字或线索标题 */
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** 主对话里「记下了一条笔记」的提示 */
export interface NoteEvent {
  noteId: string;
  kind: NoteKind;
  title: string;
  text: string;
  /** 是更新已有的条目 */
  updated: boolean;
}

export const NOTE_KIND_LABELS: Record<NoteKind, string> = { npc: 'NPC', clue: '线索' };

export type Difficulty = 'regular' | 'hard' | 'extreme';
export type SuccessLevel = 'critical' | 'extreme' | 'hard' | 'regular' | 'fail' | 'fumble';
export type RollType = 'check' | 'san' | 'dice' | 'stat' | 'growth';
export type StatKey = 'HP' | 'MP' | 'SAN' | '幸运' | '物品';

export interface RollRecord {
  type: RollType;
  /** 角色卡 key（'player' 或 AI 队友 id），掷骰类可为空 */
  actor: string;
  actorName: string;
  /** 等待玩家掷骰 */
  pending: boolean;
  /** 技能名 / 理智 / 骰子表达式 / 数值名 */
  label: string;
  // 检定和理智检定
  /** 成功线（有修正时是修正后的值） */
  target?: number;
  /** 守秘人修正之前的技能值（只有修正过时才有） */
  baseTarget?: number;
  /** 成功线的修正，例如「-1d20(20)」「+10」「=35」 */
  modifier?: string;
  difficulty?: Difficulty;
  /** 正数是奖励骰个数，负数是惩罚骰个数 */
  bonus?: number;
  tens?: number[];
  units?: number;
  total?: number;
  level?: SuccessLevel;
  success?: boolean;
  /** 这一次是孤注一掷 */
  pushed?: boolean;
  /** 失败后可以孤注一掷 */
  pushable?: boolean;
  /** 已经孤注一掷过了 */
  pushedAlready?: boolean;
  /**
   * 失败后的选择：pending = 等玩家决定接受失败还是孤注一掷（守秘人这时还不会描述后果），
   * accepted = 接受失败，pushed = 已经孤注一掷
   */
  decision?: 'pending' | 'accepted' | 'pushed';
  // 技能成长
  growth?: GrowthEntry[];
  // 理智检定
  sanSuccess?: string;
  sanFail?: string;
  loss?: number;
  lossDetail?: string;
  before?: number;
  after?: number;
  // 掷骰
  expression?: string;
  detail?: string;
  // 数值变化
  stat?: StatKey;
  delta?: number;
  item?: string;
  itemAdded?: boolean;
  /** 说明 */
  note?: string;
}

export interface GrowthEntry {
  skill: string;
  before: number;
  roll?: number;
  /** 成长的点数（没成长为 0） */
  gain?: number;
  after?: number;
}

export type Rng = () => number;

// ---------------- 属性与技能 ----------------

export const CHAR_NAMES: Record<CharKey, string> = {
  STR: '力量',
  CON: '体质',
  SIZ: '体型',
  DEX: '敏捷',
  APP: '外貌',
  INT: '智力',
  POW: '意志',
  EDU: '教育',
};

export const CHAR_DESC: Record<CharKey, string> = {
  STR: '肌肉力量，影响伤害加值',
  CON: '健康和耐力，影响生命值',
  SIZ: '身高体重，影响生命值和伤害加值',
  DEX: '灵巧和反应，决定闪避基础值',
  APP: '外表魅力，影响第一印象',
  INT: '理解和推理能力（灵感检定）',
  POW: '意志力和精神力量，决定初始理智和魔法值',
  EDU: '受教育程度（知识检定），决定职业技能点',
};

export const CHAR_KEYS: CharKey[] = ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU'];

export type SkillCategory = '调查' | '社交' | '行动' | '战斗' | '学识' | '技艺';

export interface SkillDef {
  name: string;
  base: number | ((c: Characteristics) => number);
  category: SkillCategory;
  desc: string;
  era?: Era;
}

export const SKILLS: SkillDef[] = [
  { name: '侦查', base: 25, category: '调查', desc: '发现隐藏的东西、细节和异常' },
  { name: '聆听', base: 20, category: '调查', desc: '听见细微的声音、偷听谈话' },
  { name: '图书馆使用', base: 20, category: '调查', desc: '在书籍、档案、报纸中查找资料' },
  { name: '心理学', base: 10, category: '调查', desc: '看穿别人的动机，判断是否在说谎' },
  { name: '追踪', base: 10, category: '调查', desc: '根据足迹等痕迹追踪人或动物' },
  { name: '估价', base: 5, category: '调查', desc: '判断物品的价值和年代' },
  { name: '神秘学', base: 5, category: '调查', desc: '了解巫术、传说、秘密结社等知识' },
  { name: '魅惑', base: 15, category: '社交', desc: '用魅力和好感打动别人' },
  { name: '话术', base: 5, category: '社交', desc: '靠口才哄骗、误导别人' },
  { name: '恐吓', base: 15, category: '社交', desc: '用威胁让别人就范' },
  { name: '说服', base: 10, category: '社交', desc: '用道理说服别人' },
  { name: '信用评级', base: 0, category: '社交', desc: '社会地位和财力' },
  { name: '闪避', base: (c) => Math.floor(c.DEX / 2), category: '行动', desc: '躲开攻击（基础值为敏捷的一半）' },
  { name: '潜行', base: 20, category: '行动', desc: '悄无声息地移动、躲藏' },
  { name: '攀爬', base: 20, category: '行动', desc: '爬墙、爬树、爬绳' },
  { name: '跳跃', base: 20, category: '行动', desc: '跳过障碍、从高处跳下' },
  { name: '游泳', base: 20, category: '行动', desc: '在水中行动' },
  { name: '投掷', base: 20, category: '行动', desc: '准确地扔出物体' },
  { name: '汽车驾驶', base: 20, category: '行动', desc: '驾驶汽车，包括追逐' },
  { name: '骑术', base: 5, category: '行动', desc: '骑马等' },
  { name: '导航', base: 10, category: '行动', desc: '辨认方向、看地图' },
  { name: '生存', base: 10, category: '行动', desc: '在野外找食物、搭营地' },
  { name: '斗殴', base: 25, category: '战斗', desc: '徒手或用简单武器近身打斗' },
  { name: '射击(手枪)', base: 20, category: '战斗', desc: '使用手枪' },
  { name: '射击(步枪/霰弹枪)', base: 25, category: '战斗', desc: '使用步枪、霰弹枪' },
  { name: '急救', base: 30, category: '技艺', desc: '紧急处理伤口，恢复 1 点生命值' },
  { name: '医学', base: 1, category: '学识', desc: '诊断和治疗疾病、重伤' },
  { name: '精神分析', base: 1, category: '技艺', desc: '安抚陷入疯狂的人' },
  { name: '锁匠', base: 1, category: '技艺', desc: '开锁、修锁' },
  { name: '机械维修', base: 10, category: '技艺', desc: '修理机械装置' },
  { name: '电气维修', base: 10, category: '技艺', desc: '修理电器、电路' },
  { name: '操作重型机械', base: 1, category: '技艺', desc: '驾驶推土机、起重机等' },
  { name: '乔装', base: 5, category: '技艺', desc: '伪装成别人' },
  { name: '妙手', base: 10, category: '技艺', desc: '扒窃、藏东西、变戏法' },
  { name: '艺术与手艺', base: 5, category: '技艺', desc: '绘画、摄影、表演、写作等' },
  { name: '计算机使用', base: 5, category: '技艺', desc: '使用电脑、上网查资料', era: 'modern' },
  { name: '电子学', base: 1, category: '技艺', desc: '修理和改装电子设备', era: 'modern' },
  { name: '历史', base: 5, category: '学识', desc: '了解历史事件、人物和地方掌故' },
  { name: '考古学', base: 1, category: '学识', desc: '鉴定古物、发掘遗迹' },
  { name: '人类学', base: 1, category: '学识', desc: '了解不同民族的习俗和文化' },
  { name: '法律', base: 5, category: '学识', desc: '了解法律和司法程序' },
  { name: '会计', base: 5, category: '学识', desc: '查账、发现财务上的猫腻' },
  { name: '博物学', base: 10, category: '学识', desc: '辨认动植物、天气和自然现象' },
  { name: '科学', base: 1, category: '学识', desc: '化学、生物、物理等专业知识' },
  { name: '外语', base: 1, category: '学识', desc: '读写和说一门外语' },
  { name: '母语', base: (c) => c.EDU, category: '学识', desc: '母语读写（基础值等于教育）' },
  { name: '克苏鲁神话', base: 0, category: '学识', desc: '关于宇宙恐怖的禁忌知识，车卡时不能分配' },
];

export const SKILL_CATEGORIES: SkillCategory[] = ['调查', '社交', '行动', '战斗', '学识', '技艺'];

export function skillsForEra(era: Era) {
  return SKILLS.filter((s) => !s.era || s.era === era);
}

export function skillBase(name: string, c: Characteristics): number {
  const def = SKILLS.find((s) => s.name === name);
  if (!def) return 1;
  return typeof def.base === 'function' ? def.base(c) : def.base;
}

// ---------------- 职业 ----------------

export interface Occupation {
  id: string;
  name: string;
  desc: string;
  /** 技能点公式：教育 × eduMul，再加上 extra 中最高属性 × 2 */
  eduMul: 2 | 4;
  extra?: CharKey[];
  skills: string[];
  credit: [number, number];
  items: string[];
}

export const OCCUPATIONS: Occupation[] = [
  {
    id: 'journalist',
    name: '记者',
    desc: '为报社四处采访，消息灵通，擅长打听和查资料。新手推荐。',
    eduMul: 4,
    skills: ['侦查', '聆听', '图书馆使用', '心理学', '话术', '历史', '母语', '艺术与手艺'],
    credit: [9, 30],
    items: ['笔记本和钢笔', '相机', '记者证'],
  },
  {
    id: 'detective',
    name: '私家侦探',
    desc: '受雇调查各种案件，擅长跟踪、观察和搜集证据。新手推荐。',
    eduMul: 2,
    extra: ['DEX', 'STR'],
    skills: ['侦查', '心理学', '图书馆使用', '法律', '话术', '乔装', '射击(手枪)', '潜行'],
    credit: [9, 30],
    items: ['左轮手枪（6 发子弹）', '放大镜', '笔记本'],
  },
  {
    id: 'professor',
    name: '大学教授',
    desc: '学识渊博的学者，擅长查阅文献、解读古籍。',
    eduMul: 4,
    skills: ['图书馆使用', '历史', '外语', '母语', '心理学', '考古学', '人类学', '说服'],
    credit: [20, 70],
    items: ['眼镜', '笔记本', '几本参考书'],
  },
  {
    id: 'doctor',
    name: '医生',
    desc: '受过医学训练，能处理伤病，在危险中非常可靠。',
    eduMul: 4,
    skills: ['急救', '医学', '心理学', '科学', '外语', '说服', '精神分析', '侦查'],
    credit: [30, 80],
    items: ['医药箱', '听诊器', '镇静剂'],
  },
  {
    id: 'police',
    name: '警探',
    desc: '经验丰富的警察，懂法律，能打能查。',
    eduMul: 2,
    extra: ['DEX', 'STR'],
    skills: ['侦查', '聆听', '心理学', '法律', '恐吓', '斗殴', '射击(手枪)', '追踪'],
    credit: [20, 50],
    items: ['配枪（6 发子弹）', '警徽', '手电筒'],
  },
  {
    id: 'antiquarian',
    name: '古董商',
    desc: '和古物打交道的人，眼光毒辣，常常接触到奇怪的东西。',
    eduMul: 4,
    skills: ['估价', '历史', '图书馆使用', '外语', '神秘学', '说服', '侦查', '艺术与手艺'],
    credit: [30, 70],
    items: ['放大镜', '小账本', '一件来历不明的古董'],
  },
  {
    id: 'writer',
    name: '作家',
    desc: '靠写作为生，好奇心强，对民间传说和怪谈很感兴趣。',
    eduMul: 4,
    skills: ['艺术与手艺', '历史', '图书馆使用', '博物学', '神秘学', '外语', '母语', '心理学'],
    credit: [9, 30],
    items: ['笔记本和钢笔', '旅行包', '一本自己写的小说'],
  },
  {
    id: 'student',
    name: '学生',
    desc: '在读的大学生，年轻、精力充沛，学东西很快。',
    eduMul: 4,
    skills: ['图书馆使用', '外语', '母语', '聆听', '科学', '历史', '说服', '侦查'],
    credit: [5, 10],
    items: ['课本', '自行车', '一点零花钱'],
  },
  {
    id: 'veteran',
    name: '退伍军人',
    desc: '上过战场的人，身手好，能在危险中生存。',
    eduMul: 2,
    extra: ['DEX', 'STR'],
    skills: ['射击(步枪/霰弹枪)', '斗殴', '闪避', '急救', '潜行', '攀爬', '生存', '恐吓'],
    credit: [9, 30],
    items: ['军用小刀', '旧军装', '急救包'],
  },
  {
    id: 'occultist',
    name: '神秘学家',
    desc: '研究巫术和超自然现象的人，懂得很多禁忌知识。',
    eduMul: 4,
    skills: ['神秘学', '人类学', '历史', '图书馆使用', '外语', '科学', '心理学', '话术'],
    credit: [9, 65],
    items: ['护身符', '一本手抄的古书', '蜡烛和火柴'],
  },
  {
    id: 'artist',
    name: '艺术家',
    desc: '画家、摄影师或音乐家，感觉敏锐，善于观察。',
    eduMul: 2,
    extra: ['DEX', 'POW'],
    skills: ['艺术与手艺', '侦查', '心理学', '历史', '博物学', '外语', '魅惑', '话术'],
    credit: [9, 50],
    items: ['画具或相机', '素描本', '一瓶酒'],
  },
  {
    id: 'athlete',
    name: '运动员',
    desc: '身体素质出众，跑跳攀爬样样在行。',
    eduMul: 2,
    extra: ['DEX', 'STR'],
    skills: ['攀爬', '跳跃', '游泳', '斗殴', '投掷', '闪避', '骑术', '魅惑'],
    credit: [9, 70],
    items: ['运动服', '护身用的短棍', '水壶'],
  },
];

export function occupationById(id: string) {
  return OCCUPATIONS.find((o) => o.id === id || o.name === id);
}

export function occupationFormula(o: Occupation) {
  return o.extra
    ? `教育×2 + ${o.extra.map((k) => CHAR_NAMES[k]).join('或')}×2`
    : '教育×4';
}

export function occupationPoints(o: Occupation, c: Characteristics) {
  const extra = o.extra ? Math.max(...o.extra.map((k) => c[k])) * 2 : 0;
  return c.EDU * o.eduMul + extra;
}

export const interestPoints = (c: Characteristics) => c.INT * 2;

/** 职业技能（含信用评级） */
export const occupationSkills = (o: Occupation) => [...o.skills, '信用评级'];

/** 车卡时单项技能的上限 */
export const SKILL_CAP = 75;

// ---------------- 骰子 ----------------

export const rollDie = (sides: number, rng: Rng = Math.random) => 1 + Math.floor(rng() * sides);

/** 掷骰表达式，如 1d6、2d6+3、1d4+1d4、3（纯数字） */
export function rollExpression(expr: string, rng: Rng = Math.random): { total: number; detail: string } {
  const clean = expr.replace(/\s+/g, '').toLowerCase().replace(/[dｄ]/g, 'd');
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(clean)) {
    throw new Error(`看不懂的骰子表达式：${expr}`);
  }
  let total = 0;
  const parts: string[] = [];
  for (const m of clean.matchAll(/([+-]?)(\d*d\d+|\d+)/g)) {
    const sign = m[1] === '-' ? -1 : 1;
    const term = m[2];
    if (term.includes('d')) {
      const [n, s] = term.split('d');
      const count = Math.min(Number(n || 1), 100);
      const sides = Math.max(1, Math.min(Number(s), 1000));
      const rolls = Array.from({ length: count }, () => rollDie(sides, rng));
      const sum = rolls.reduce((a, b) => a + b, 0);
      total += sign * sum;
      parts.push(`${sign < 0 ? '-' : parts.length ? '+' : ''}${count}d${sides}(${rolls.join(',')})`);
    } else {
      total += sign * Number(term);
      parts.push(`${sign < 0 ? '-' : parts.length ? '+' : ''}${term}`);
    }
  }
  return { total, detail: `${parts.join('')} = ${total}` };
}

/** 掷 d100。bonus > 0 为奖励骰（十位取最低），< 0 为惩罚骰（十位取最高） */
export function rollD100(bonus = 0, rng: Rng = Math.random) {
  const units = Math.floor(rng() * 10);
  const extra = Math.min(2, Math.abs(bonus));
  const tens = Array.from({ length: 1 + extra }, () => Math.floor(rng() * 10) * 10);
  const values = tens.map((t) => (t === 0 && units === 0 ? 100 : t + units));
  const total = bonus > 0 ? Math.min(...values) : bonus < 0 ? Math.max(...values) : values[0];
  return { total, tens, units };
}

export function successLevel(roll: number, target: number): SuccessLevel {
  if (roll === 1) return 'critical';
  if (roll === 100 || (target < 50 && roll >= 96)) return 'fumble';
  if (roll <= Math.floor(target / 5)) return 'extreme';
  if (roll <= Math.floor(target / 2)) return 'hard';
  if (roll <= target) return 'regular';
  return 'fail';
}

const LEVEL_RANK: Record<SuccessLevel, number> = {
  critical: 4,
  extreme: 3,
  hard: 2,
  regular: 1,
  fail: 0,
  fumble: -1,
};
const DIFFICULTY_RANK: Record<Difficulty, number> = { regular: 1, hard: 2, extreme: 3 };

export const meetsDifficulty = (level: SuccessLevel, difficulty: Difficulty = 'regular') =>
  LEVEL_RANK[level] >= DIFFICULTY_RANK[difficulty];

export const LEVEL_LABELS: Record<SuccessLevel, string> = {
  critical: '大成功',
  extreme: '极难成功',
  hard: '困难成功',
  regular: '成功',
  fail: '失败',
  fumble: '大失败',
};

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  regular: '普通',
  hard: '困难',
  extreme: '极难',
};

/** 不同难度下需要掷出的数字 */
export function thresholds(target: number) {
  return { regular: target, hard: Math.floor(target / 2), extreme: Math.floor(target / 5) };
}

// ---------------- 车卡 ----------------

export function rollCharacteristics(rng: Rng = Math.random): { characteristics: Characteristics; luck: number } {
  const three = () => rollExpression('3d6', rng).total * 5;
  const twoPlusSix = () => (rollExpression('2d6', rng).total + 6) * 5;
  return {
    characteristics: {
      STR: three(),
      CON: three(),
      SIZ: twoPlusSix(),
      DEX: three(),
      APP: three(),
      INT: twoPlusSix(),
      POW: three(),
      EDU: twoPlusSix(),
    },
    luck: three(),
  };
}

export function derivedStats(c: Characteristics) {
  const hp = Math.floor((c.CON + c.SIZ) / 10);
  const mp = Math.floor(c.POW / 5);
  let mov = 8;
  if (c.DEX < c.SIZ && c.STR < c.SIZ) mov = 7;
  else if (c.DEX > c.SIZ && c.STR > c.SIZ) mov = 9;
  const sum = c.STR + c.SIZ;
  let damageBonus = '0';
  let build = 0;
  if (sum <= 64) [damageBonus, build] = ['-2', -2];
  else if (sum <= 84) [damageBonus, build] = ['-1', -1];
  else if (sum <= 124) [damageBonus, build] = ['0', 0];
  else if (sum <= 164) [damageBonus, build] = ['+1d4', 1];
  else if (sum <= 204) [damageBonus, build] = ['+1d6', 2];
  else [damageBonus, build] = ['+2d6', 3];
  return { hp, mp, san: c.POW, mov, damageBonus, build };
}

export interface SheetInput {
  name: string;
  occupation: string;
  age: number;
  gender: string;
  appearance?: string;
  backstory?: string;
  characteristics: Characteristics;
  luck: number;
  /** 在基础值之上额外分配的技能点 */
  allocation: Record<string, number>;
  items?: string[];
  era?: Era;
}

export function buildSheet(input: SheetInput): InvestigatorSheet {
  const c = input.characteristics;
  const d = derivedStats(c);
  const skills: Record<string, number> = {};
  for (const s of skillsForEra(input.era ?? '1920s')) {
    skills[s.name] = Math.min(99, skillBase(s.name, c) + (input.allocation[s.name] ?? 0));
  }
  const mythos = skills['克苏鲁神话'] ?? 0;
  return {
    name: input.name.trim() || '无名调查员',
    occupation: input.occupation,
    age: input.age,
    gender: input.gender,
    appearance: input.appearance ?? '',
    backstory: input.backstory ?? '',
    characteristics: { ...c },
    luck: input.luck,
    hp: { current: d.hp, max: d.hp },
    mp: { current: d.mp, max: d.mp },
    san: { current: d.san, max: 99 - mythos, start: d.san },
    mov: d.mov,
    damageBonus: d.damageBonus,
    build: d.build,
    skills,
    items: input.items ?? [],
    notes: '',
  };
}

/** 计算一份技能分配消耗的点数：职业技能先用职业点，不够再用兴趣点 */
export function pointUsage(o: Occupation, allocation: Record<string, number>) {
  const occSkills = new Set(occupationSkills(o));
  let occ = 0;
  let other = 0;
  for (const [name, v] of Object.entries(allocation)) {
    if (v <= 0) continue;
    if (occSkills.has(name)) occ += v;
    else other += v;
  }
  return { occ, other };
}

export function remainingPoints(o: Occupation, c: Characteristics, allocation: Record<string, number>) {
  const { occ, other } = pointUsage(o, allocation);
  const occTotal = occupationPoints(o, c);
  const intTotal = interestPoints(c);
  const occOverflow = Math.max(0, occ - occTotal);
  return {
    occ: Math.max(0, occTotal - occ),
    interest: intTotal - other - occOverflow,
    occTotal,
    intTotal,
  };
}

const INTEREST_PICKS = ['侦查', '聆听', '闪避', '图书馆使用', '心理学', '急救', '潜行', '斗殴'];

/** 自动分配技能点：职业技能优先，然后把兴趣点分给新手常用的技能 */
export function autoAllocate(o: Occupation, c: Characteristics): Record<string, number> {
  const alloc: Record<string, number> = {};
  const value = (s: string) => skillBase(s, c) + (alloc[s] ?? 0);
  const add = (s: string, n: number) => (alloc[s] = (alloc[s] ?? 0) + n);

  let occPool = occupationPoints(o, c);
  // 信用评级取职业范围的中间偏下
  const credit = Math.min(occPool, Math.round((o.credit[0] + o.credit[1]) / 2 / 5) * 5 || o.credit[0]);
  add('信用评级', credit);
  occPool -= credit;

  // 职业技能：一轮轮加 5 点，排在前面的技能目标更高
  const targets: number[] = o.skills.map((_, i) => (i < 3 ? 70 : i < 6 ? 60 : 50));
  for (let guard = 0; occPool >= 5 && guard < 100; guard++) {
    let progressed = false;
    o.skills.forEach((s, i) => {
      if (occPool >= 5 && value(s) + 5 <= Math.min(SKILL_CAP, targets[i])) {
        add(s, 5);
        occPool -= 5;
        progressed = true;
      }
    });
    if (!progressed) targets.forEach((_, i) => (targets[i] = Math.min(SKILL_CAP, targets[i] + 5)));
    if (!progressed && targets.every((t) => t >= SKILL_CAP)) break;
  }

  // 兴趣点：先把新手常用技能提到 55，再提到 65；还有剩余就继续加职业技能，直到上限
  let intPool = interestPoints(c) + Math.max(0, occPool);
  const phases: [string[], number][] = [
    [INTEREST_PICKS, 55],
    [INTEREST_PICKS, 65],
    [o.skills, SKILL_CAP],
    [INTEREST_PICKS, SKILL_CAP],
  ];
  for (const [list, target] of phases) {
    for (let guard = 0; intPool >= 5 && guard < 100; guard++) {
      let progressed = false;
      for (const s of list) {
        if (intPool >= 5 && value(s) + 5 <= target) {
          add(s, 5);
          intPool -= 5;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
  }
  return alloc;
}

const NAMES = ['林薇', '周铭', '顾远', '苏晴', '陈墨', '叶舟', '沈默', '许知'];

/** 快速生成一个调查员（AI 队友或"快速车卡"用） */
export function quickInvestigator(
  opts: { name?: string; occupationId?: string; era?: Era; gender?: string } = {},
  rng: Rng = Math.random,
): InvestigatorSheet {
  const o = (opts.occupationId && occupationById(opts.occupationId)) || OCCUPATIONS[Math.floor(rng() * OCCUPATIONS.length)];
  const { characteristics, luck } = rollCharacteristics(rng);
  return buildSheet({
    name: opts.name || NAMES[Math.floor(rng() * NAMES.length)],
    occupation: o.name,
    age: 22 + Math.floor(rng() * 16),
    gender: opts.gender ?? '',
    characteristics,
    luck,
    allocation: autoAllocate(o, characteristics),
    items: [...o.items],
    era: opts.era,
  });
}

// ---------------- 检定目标 ----------------

const CHAR_ALIASES: Record<string, CharKey> = {
  力量: 'STR',
  体质: 'CON',
  体型: 'SIZ',
  敏捷: 'DEX',
  外貌: 'APP',
  智力: 'INT',
  灵感: 'INT',
  意志: 'POW',
  教育: 'EDU',
  知识: 'EDU',
};

const SKILL_ALIASES: Record<string, string> = {
  驾驶: '汽车驾驶',
  开车: '汽车驾驶',
  手枪: '射击(手枪)',
  射击: '射击(手枪)',
  步枪: '射击(步枪/霰弹枪)',
  霰弹枪: '射击(步枪/霰弹枪)',
  格斗: '斗殴',
  搏斗: '斗殴',
  观察: '侦查',
  侦察: '侦查',
  倾听: '聆听',
  图书馆: '图书馆使用',
  查资料: '图书馆使用',
  躲藏: '潜行',
  隐匿: '潜行',
  自然学: '博物学',
  手艺: '艺术与手艺',
  艺术: '艺术与手艺',
  电脑: '计算机使用',
  神话: '克苏鲁神话',
};

/** 根据技能 / 属性名找到检定的目标值 */
export type CheckModifier = { kind: 'delta'; sign: 1 | -1; expr: string } | { kind: 'set'; value: number };

const MINUS = /[-－−—–]/;

/**
 * 检定指令里的成功线修正：+10、-20、-1d20、+2d6（加减），=35、目标35、35（直接指定）。
 * 不是修正的参数返回 null。
 */
export function parseCheckModifier(arg: string): CheckModifier | null {
  const a = arg.trim().replace(/[ｄＤ]/g, 'd');
  const delta = a.match(/^(?:修正|调整|加值)?\s*([+＋\-－−—–])\s*(\d*d\d+(?:\s*[+\-]\s*\d+)?|\d{1,3})\s*%?$/i);
  if (delta) return { kind: 'delta', sign: MINUS.test(delta[1]) ? -1 : 1, expr: delta[2].replace(/\s+/g, '').toLowerCase() };
  const set = a.match(/^(?:=|＝|目标|目标值|成功线|成功率)?\s*(\d{1,3})\s*%?$/);
  if (set) return { kind: 'set', value: Number(set[1]) };
  return null;
}

/** 「幸运-1d20」「侦查 +10」这种把修正直接写在技能名后面的写法 */
export function splitInlineModifier(skill: string): { skill: string; modifier?: CheckModifier } {
  const m = skill.trim().match(/^(.+?)\s*([+＋\-－−—–]\s*(?:\d*[dｄ]\d+|\d{1,3}))$/i);
  if (!m) return { skill };
  const modifier = parseCheckModifier(m[2]);
  return modifier ? { skill: m[1].trim(), modifier } : { skill };
}

/** 按修正算出新的成功线（掷修正骰），至少为 1 */
export function applyCheckModifiers(base: number, mods: CheckModifier[], rng: Rng = Math.random): { target: number; text: string } {
  let target = base;
  const parts: string[] = [];
  for (const m of mods) {
    if (m.kind === 'set') {
      target = m.value;
      parts.push(`=${m.value}`);
      continue;
    }
    const r = rollExpression(m.expr, rng);
    target += m.sign * r.total;
    const sign = m.sign < 0 ? '-' : '+';
    parts.push(/d/.test(m.expr) ? `${sign}${m.expr}(${r.total})` : `${sign}${r.total}`);
  }
  return { target: Math.max(1, Math.min(199, target)), text: parts.join(' ') };
}

export function resolveTarget(sheet: InvestigatorSheet, rawName: string): { name: string; target: number; found: boolean } {
  const name = rawName.trim().replace(/（/g, '(').replace(/）/g, ')');
  if (name === '幸运') return { name, target: sheet.luck, found: true };
  if (name === '理智' || name.toUpperCase() === 'SAN') return { name: '理智', target: sheet.san.current, found: true };
  const charKey = CHAR_ALIASES[name] ?? (CHAR_KEYS.includes(name.toUpperCase() as CharKey) ? (name.toUpperCase() as CharKey) : undefined);
  if (charKey) return { name: CHAR_ALIASES[name] ? name : CHAR_NAMES[charKey], target: sheet.characteristics[charKey], found: true };
  const skills = sheet.skills;
  if (name in skills) return { name, target: skills[name], found: true };
  const alias = SKILL_ALIASES[name];
  if (alias && alias in skills) return { name: alias, target: skills[alias], found: true };
  // 模糊匹配：如「射击（步枪）」「艺术(摄影)」，括号里的内容优先
  const keys = Object.keys(skills);
  const inner = name.match(/\((.+)\)/)?.[1];
  const baseName = name.replace(/\(.*\)$/, '');
  const fuzzy =
    (inner && keys.find((k) => k.startsWith(baseName) && k.includes(inner))) ||
    keys.find((k) => k.startsWith(name)) ||
    keys.find((k) => name.startsWith(k.replace(/\(.*\)$/, '')));
  if (fuzzy) return { name: fuzzy, target: skills[fuzzy], found: true };
  return { name, target: 5, found: false };
}

// ---------------- 文本 ----------------

/** 守秘人指令的正则：[检定:侦查]、【理智：1/1d6】等 */
export const COMMAND_RE =
  /[[【]\s*(检定|理智|掷骰|HP|MP|SAN|幸运|物品|NPC|线索|备忘|成长|展示)\s*(?:[:：]\s*([^\]】\n]{1,240}))?[\]】]/gi;

/** 把指令换成看得懂的文字，例如 [理智:0/1] → 「理智 0/1」（规则小贴士里引用指令时用） */
export function readableCommands(text: string) {
  return text.replace(COMMAND_RE, (_m, kind: string, args?: string) => `「${kind}${args ? ` ${args.trim().replace(/[:：]/g, ' ')}` : ''}」`);
}

/** 守秘人消息的显示文字：去掉指令，但「规则小贴士」里引用的指令换成文字（否则会留下空白） */
export function kpDisplayText(text: string) {
  return stripCommands(
    text
      .split('\n')
      .map((line) => (/^\s*[【[]规则小贴士[】\]]/.test(line) ? readableCommands(line) : line))
      .join('\n'),
  );
}

/** 去掉消息里的守秘人指令（显示用） */
export function stripCommands(text: string) {
  return text
    .replace(COMMAND_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function rollText(r: RollRecord): string {
  const who = r.actorName;
  switch (r.type) {
    case 'check': {
      const req = r.difficulty && r.difficulty !== 'regular' ? `，要求${DIFFICULTY_LABELS[r.difficulty]}` : '';
      const dice = r.bonus ? `，${r.bonus > 0 ? `奖励骰 ${r.bonus}` : `惩罚骰 ${-r.bonus}`}` : '';
      const value = r.baseTarget !== undefined ? `技能值 ${r.baseTarget}，修正 ${r.modifier}，成功线 ${r.target}` : `技能值 ${r.target}`;
      const head = `${who} 进行「${r.label}」检定（${value}${req}${dice}）${r.pushed ? '【孤注一掷】' : ''}`;
      if (r.pending) return `${head}：等待掷骰`;
      const choice =
        r.success || !r.decision
          ? ''
          : r.decision === 'pending'
            ? '（玩家正在考虑要不要孤注一掷）'
            : r.decision === 'accepted'
              ? '（玩家接受了失败）'
              : '（玩家选择孤注一掷，见下一次掷骰）';
      return `${head}：掷出 ${r.total} → ${LEVEL_LABELS[r.level!]}，${r.success ? '检定成功' : '检定失败'}${choice}`;
    }
    case 'san': {
      const head = `${who} 进行理智检定（当前 SAN ${r.before ?? r.target}，损失 ${r.sanSuccess}/${r.sanFail}）`;
      if (r.pending) return `${head}：等待掷骰`;
      return `${head}：掷出 ${r.total} → ${r.success ? '成功' : '失败'}，失去 ${r.loss} 点理智（${r.lossDetail}），SAN ${r.before} → ${r.after}${r.note ? `。${r.note}` : ''}`;
    }
    case 'dice':
      return `掷骰 ${r.expression}${r.note ? `（${r.note}）` : ''}：${r.detail}`;
    case 'growth': {
      const list = r.growth ?? [];
      if (r.pending) return `${who} 等待进行技能成长检定（${list.map((g) => g.skill).join('、') || '没有可以成长的技能'}）`;
      const parts = list.map((g) =>
        g.gain ? `${g.skill} ${g.before} → ${g.after}（掷出 ${g.roll}，+${g.gain}）` : `${g.skill} 没有成长（掷出 ${g.roll}）`,
      );
      return `${who} 的技能成长检定：${parts.join('；') || '没有可以成长的技能'}`;
    }
    case 'stat':
      if (r.stat === '物品') return `${who} ${r.itemAdded ? '获得' : '失去'}物品：${r.item}`;
      return `${who} 的 ${r.stat} ${r.before} → ${r.after}（${r.delta! >= 0 ? '+' : ''}${r.delta}${r.detail ? `，${r.detail}` : ''}）${r.note ? `。${r.note}` : ''}`;
  }
}

/** 不能通过使用成长的技能（COC 7 规则：信用评级、克苏鲁神话不做成长检定） */
export const NO_GROWTH = ['信用评级', '克苏鲁神话'];

/**
 * 技能成长检定：每项掷 1d100，结果大于当前技能值（或者 96 以上）就成长 1d10 点，最高 99。
 * 会直接修改角色卡。
 */
export function resolveGrowth(r: RollRecord, sheet: InvestigatorSheet, rng: Rng = Math.random) {
  for (const g of r.growth ?? []) {
    const before = sheet.skills[g.skill] ?? g.before;
    const roll = rollD100(0, rng).total;
    g.before = before;
    g.roll = roll;
    if (roll > before || roll >= 96) {
      g.gain = rollDie(10, rng);
      g.after = Math.min(99, before + g.gain);
      g.gain = g.after - before;
      sheet.skills[g.skill] = g.after;
    } else {
      g.gain = 0;
      g.after = before;
    }
  }
  r.pending = false;
}

/** 给守秘人 / 队友看的角色卡摘要 */
export function sheetSummary(s: InvestigatorSheet, era: Era = '1920s'): string {
  const c = s.characteristics;
  const chars = CHAR_KEYS.map((k) => `${CHAR_NAMES[k]}${c[k]}`).join(' ');
  const notable = Object.entries(s.skills)
    .filter(([name, v]) => v > skillBase(name, c) || v >= 40)
    .filter(([name]) => skillsForEra(era).some((d) => d.name === name) || !SKILLS.some((d) => d.name === name))
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => `${name}${v}`)
    .join('、');
  return [
    `「${s.name}」${s.gender ? `，${s.gender}` : ''}，${s.age} 岁，${s.occupation}`,
    `HP ${s.hp.current}/${s.hp.max}，MP ${s.mp.current}/${s.mp.max}，SAN ${s.san.current}/${s.san.max}，幸运 ${s.luck}`,
    `属性：${chars}，移动力 ${s.mov}，伤害加值 ${s.damageBonus}`,
    `主要技能：${notable || '（无）'}（其他技能为基础值）`,
    `物品：${s.items.length ? s.items.join('、') : '（无）'}`,
    s.appearance ? `形象：${s.appearance}` : '',
    s.backstory ? `背景：${s.backstory}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
