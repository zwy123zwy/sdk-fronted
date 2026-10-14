/**
 * 内置脱敏规则与内置敏感请求头（C04-F4）。
 *
 * 契约依据：`docs/contracts/remote-config.md` 5.4（0.2 冻结）。**内置项不可删除、不可禁用、
 * 不可被配置覆盖**：远程配置只能通过 `extra_mask_rules` / `sensitive_headers` 追加
 * （C04-AC-09 的机制基础）。
 *
 * 正则的写法约束（T14 安全要求）：全部使用**结构上安全**的线性写法 —— 锚定边界、
 * 不使用嵌套量词、不让相邻量词共享字符类。每条规则都有对抗性输入的有界耗时测试，
 * 见 `docs/tasks/T14-plan.md` 第 11(b) 点。
 *
 * 规则的**顺序是语义的一部分**（重叠命中时先到者生效），固定为契约 5.4 表格的书写顺序。
 *
 * `compileMaskRules` 在配置到达时执行一次（预编译）；事件处理期间不再构造正则。
 */
import { BUILTIN_MASK_RULE_COUNT, MAX_EXTRA_MASK_RULES, MAX_MASK_RULES_TOTAL } from './constants';
import type { MaskRule } from './types';

/**
 * 文本特征位（一次全串扫描即可得到；用于规则的**廉价前置门**）。
 *
 * 前置门只做「这条规则有没有可能命中」的**必要条件**判断：判否即跳过昂贵正则，
 * 判是仍交给正则决定是否命中——因此它只会少跑正则，不会改变命中集合。
 */
export const MASK_FEATURE_DIGIT = 1;
export const MASK_FEATURE_AT = 2;
export const MASK_FEATURE_DOT = 4;
export const MASK_FEATURE_LETTER = 8;
/** 字面量 `eyJ`（jwt 规则的固定前缀）。 */
export const MASK_FEATURE_JWT_PREFIX = 16;
/** 字面量 `earer`（覆盖 `Bearer` 与 `bearer`；bearer 规则的大小写敏感写法见规则注释）。 */
export const MASK_FEATURE_BEARER_SUFFIX = 32;
/** 字符类别位（不含子串位），用于扫描的提前退出。 */
const MASK_FEATURE_CHAR_MASK = MASK_FEATURE_DIGIT | MASK_FEATURE_AT | MASK_FEATURE_DOT | MASK_FEATURE_LETTER;

/**
 * 扫描一条文本的特征位（**单趟 O(n)**；比 7 条规则各做一次全串正则便宜得多）。
 *
 * 说明：`eyJ` / `earer` 用 `String.prototype.includes` 探测，只在文本含字母时才做——
 * 两个子串都必须含字母，这是必要条件的必要条件。
 */
export function scanMaskFeatures(text: string): number {
  let features = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 48 && code <= 57) features |= MASK_FEATURE_DIGIT;
    else if (code >= 65 && code <= 90) features |= MASK_FEATURE_LETTER;
    else if (code >= 97 && code <= 122) features |= MASK_FEATURE_LETTER;
    else if (code === 64) features |= MASK_FEATURE_AT;
    else if (code === 46) features |= MASK_FEATURE_DOT;
    if ((features & MASK_FEATURE_CHAR_MASK) === MASK_FEATURE_CHAR_MASK) break;
  }
  if ((features & MASK_FEATURE_LETTER) !== 0) {
    if (text.includes('eyJ')) features |= MASK_FEATURE_JWT_PREFIX;
    if (text.includes('earer')) features |= MASK_FEATURE_BEARER_SUFFIX;
  }
  return features;
}

/** 单条内置规则的定义（pattern 与替换串逐字取自 `remote-config.md` 5.4 表格）。 */
export interface BuiltinMaskRule {
  readonly name: string;
  readonly pattern: string;
  readonly replacement: string;
  /** 廉价前置门：正则可能命中所需的文本特征位（`scanMaskFeatures` 的子集）。 */
  readonly gate: number;
  /**
   * 替换串**引入**的文本特征位。规则命中后并入已见特征，保证后续规则的门不会误跳过：
   * 命中片段被**非空**替换串取代，因此替换只会新增特征、不会把两段原文拼到一起。
   */
  readonly added: number;
  /** 便于文档化的示例（伪造数据，用于规则清单文档与自检，不参与运行）。 */
  readonly sample: string;
  readonly sampleMasked: string;
}

/**
 * 内置脱敏规则（共 7 条，顺序即契约表格顺序）。
 *
 * 写作要点：
 * - `email`：本地段与域标签各自单量词，域标签用固定长度重复，无嵌套量词；
 * - `cn_mobile`：`1[3-9]\d{9}` 加前后「非数字」边界（定长 lookaround，非量词）；
 * - `cn_id_card`：`\d{17}[\dXx]` 加数字边界；
 * - `bank_card`：`\d{13,19}` 加数字边界；
 * - `jwt`：三段 base64url 各自单量词（`*` / `*` / `*`），字符类不重叠；
 * - `bearer_token`：`Bearer` + 单量词 + 尾部 `=*`（与前面的字符类不重叠）；
 * - `ipv4`：四段 `\d{1,3}` + 字面点 + 整数位边界。
 *
 * 每条规则另带 `gate`（廉价前置门）与 `added`（替换串引入的特征位），口径见
 * `scanMaskFeatures` 的注释：`gate` 必须是该正则命中的**必要条件**。
 */
export const BUILTIN_MASK_RULES: readonly BuiltinMaskRule[] = [
  {
    name: 'email',
    pattern: '[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){0,4}\\.[A-Za-z]{2,24}',
    replacement: '***@***',
    // 正则含字面 `@`，没有 `@` 必不命中；替换串 `***@***` 只引入 `@`。
    gate: MASK_FEATURE_AT,
    added: MASK_FEATURE_AT,
    sample: 'contact alice.smith+tag@example.co.uk now',
    sampleMasked: 'contact ***@*** now',
  },
  {
    name: 'cn_mobile',
    pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)',
    replacement: '1**********',
    // 11 位手机号必含数字；替换串 `1**********` 引入数字。
    gate: MASK_FEATURE_DIGIT,
    added: MASK_FEATURE_DIGIT,
    sample: 'phone 13800138000 end',
    sampleMasked: 'phone 1********** end',
  },
  {
    name: 'cn_id_card',
    pattern: '(?<!\\d)\\d{17}[\\dXx](?!\\d)',
    replacement: '******************',
    // 18 位身份证必含数字；替换串全是 `*`，不引入任何特征。
    gate: MASK_FEATURE_DIGIT,
    added: 0,
    sample: 'id 11010119900307123X end',
    sampleMasked: 'id ****************** end',
  },
  {
    name: 'bank_card',
    pattern: '(?<!\\d)\\d{13,19}(?!\\d)',
    replacement: '****',
    // 13–19 位连续数字必含数字；替换串全是 `*`。
    gate: MASK_FEATURE_DIGIT,
    added: 0,
    sample: 'card 6222021234567890123 end',
    sampleMasked: 'card **** end',
  },
  {
    name: 'jwt',
    pattern: 'eyJ[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]*',
    replacement: '***',
    // 正则以字面 `eyJ` 开头；替换串全是 `*`。
    gate: MASK_FEATURE_JWT_PREFIX,
    added: 0,
    sample: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl end',
    sampleMasked: 'token *** end',
  },
  {
    name: 'bearer_token',
    // 大小写不敏感用显式字符类 `[Bb]` 表达：JS 的 `RegExp` 没有内联 `(?i)` 标志，
    // 而远程 schema 的 flags 白名单是 `^[imsu]{0,4}$`（内置规则不依赖外部 flags）。
    pattern: '[Bb]earer\\s+[A-Za-z0-9._~+/-]+=*',
    replacement: 'Bearer ***',
    // 正则以字面 `earer`（小写）为固定后缀；替换串 `Bearer ***` 引入字母与 `earer`。
    gate: MASK_FEATURE_BEARER_SUFFIX,
    added: MASK_FEATURE_LETTER | MASK_FEATURE_BEARER_SUFFIX,
    sample: 'Authorization: Bearer abcDEF123.-_ end',
    sampleMasked: 'Authorization: Bearer *** end',
  },
  {
    name: 'ipv4',
    pattern: '(?<!\\d)\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}(?!\\d)',
    replacement: '0.0.0.0',
    // 点分四段必含数字与字面点；替换串 `0.0.0.0` 两者都引入。
    gate: MASK_FEATURE_DIGIT | MASK_FEATURE_DOT,
    added: MASK_FEATURE_DIGIT | MASK_FEATURE_DOT,
    sample: 'from 192.168.10.24 port',
    sampleMasked: 'from 0.0.0.0 port',
  },
];

/** 内置敏感请求头的规范名（小写；**不区分大小写**匹配，值一律不采集）。 */
export const BUILTIN_SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-write-token',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
];

/** 预编译后的规则（正则实例在配置到达时创建一次，事件处理期间不再 `new RegExp`）。 */
export interface CompiledMaskRule {
  readonly name: string;
  readonly regex: RegExp;
  readonly replacement: string;
  readonly builtin: boolean;
  /**
   * 廉价前置门：所需文本特征位（`0` / 缺省 = 无条件运行）。
   * 追加规则语义未知，恒不带门（缺省），保证远程追加的命中行为与优化前一致。
   */
  readonly gate?: number | undefined;
  /** 该规则替换串引入的特征位（缺省 = 不引入）；命中后并入已见特征。 */
  readonly added?: number | undefined;
}

/**
 * 把「内置 + 远程追加」编译为规则表。
 *
 * 口径（见 `docs/tasks/T14-plan.md` 第 4 点与裁定记录）：
 * - 内置 7 条永远在最前，`extra` 按配置顺序追加；
 * - 总数超过 `MAX_MASK_RULES_TOTAL` 时按顺序保留前 50 条（正常远程配置不会触及，见常量注释）；
 * - 单条 `pattern`/`flags` 无法编译时**丢弃该条**（不抛错），由调用方按 `config_schema_invalid` 计数；
 * - 内置规则的 `name` 不可被 `extra` 覆盖（同名追加规则仍然生效为**追加**，不替换内置项）；
 * - **只有内置 7 条带前置门**：追加规则的 pattern 由远程给，语义未知，必须无条件运行
 *   （否则可能漏判远程规则，等于削弱脱敏）。
 *
 * @param extra 远程追加规则（`privacy.extra_mask_rules` 的已解析形态）。
 * @param createRegExp 正则工厂（默认 `(pattern, flags) => new RegExp(pattern, flags)`；测试可注入）。
 */
export function compileMaskRules(
  extra: readonly MaskRule[],
  createRegExp?: (pattern: string, flags: string) => RegExp,
): readonly CompiledMaskRule[] {
  const make = createRegExp ?? ((pattern: string, flags: string): RegExp => new RegExp(pattern, flags));
  const compiled: CompiledMaskRule[] = [];
  for (const rule of BUILTIN_MASK_RULES) {
    compiled.push({
      name: rule.name,
      regex: make(rule.pattern, 'g'),
      replacement: rule.replacement,
      builtin: true,
      gate: rule.gate,
      added: rule.added,
    });
  }
  for (const rule of extra) {
    if (compiled.length >= MAX_MASK_RULES_TOTAL) break;
    const declared = rule.flags ?? '';
    // 远程 schema 的 flags 是 `^[imsu]{0,4}$`（不含 g）；追加 g 时避免重复标志。
    const flags = declared.includes('g') ? declared : `${declared}g`;
    try {
      compiled.push({
        name: rule.name,
        regex: make(rule.pattern, flags),
        replacement: rule.replacement ?? '***',
        builtin: false,
      });
    } catch {
      // 非法正则：丢弃该条，由调用方计数 config_schema_invalid（T13 的原因码）
    }
  }
  return compiled;
}

/**
 * 合并内置敏感请求头与远程追加项：只做并集，**不提供删除通道**。
 * 输出统一小写并去重（HTTP 头名不区分大小写）。
 */
export function mergeSensitiveHeaders(extra: readonly string[]): readonly string[] {
  const merged = new Set<string>();
  for (const name of BUILTIN_SENSITIVE_HEADERS) merged.add(name);
  for (const name of extra) merged.add(name.toLowerCase());
  return [...merged];
}

/** 供测试与文档核对的算术前提：内置 + 追加上限不超过总数上限。 */
export const MASK_RULE_BUDGET = {
  builtin: BUILTIN_MASK_RULE_COUNT,
  extra: MAX_EXTRA_MASK_RULES,
  total: MAX_MASK_RULES_TOTAL,
} as const;
