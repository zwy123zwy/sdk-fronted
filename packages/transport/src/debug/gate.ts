/**
 * C08-F4 的调试模式门禁（硬约束：**只能在非生产环境或白名单用户下开启**）。
 *
 * 判定规则：
 * 1. URL 查询参数（缺省 `wr_debug`）必须显式请求（`0` / `false` / `off` 视为关闭）；
 * 2. 且满足「非生产环境」**或**「当前用户在 `allowUsers` 白名单中」；
 * 3. `env` 缺失时**保守处理**：不视为非生产环境，只有白名单用户可开启。
 *
 * 对应验收用例：C08-AC-08（非生产 + 参数 → 开启）、C08-AC-09（生产 + 非白名单 → 不开启）。
 * 本模块只做判定，不读取也不输出任何令牌。
 */

/** 缺省 URL 查询参数名。 */
export const DEBUG_QUERY_PARAM = 'wr_debug';

/** 缺省视为生产的环境名。 */
export const DEFAULT_PRODUCTION_ENVS = ['production', 'prod'] as const;

const DISABLED_VALUES = ['0', 'false', 'off'];

export type DebugDecisionReason =
  | 'not_requested'
  | 'production_user_not_allowlisted'
  | 'allowed_non_production'
  | 'allowed_allowlisted_user';

export interface DebugGateOptions {
  /** 当前环境，如 `production`、`staging`。 */
  readonly env?: string | undefined;
  /** `location.search`（也可传完整 URL 或裸查询串）。 */
  readonly search?: string | undefined;
  /** 白名单用户（`user_id` 或其哈希值）。 */
  readonly allowUsers?: readonly string[] | undefined;
  readonly user?: string | undefined;
  readonly hashedUser?: string | undefined;
  /** 视为生产的环境名；缺省 `DEFAULT_PRODUCTION_ENVS`。 */
  readonly productionEnvs?: readonly string[] | undefined;
  /** URL 参数名；缺省 `DEBUG_QUERY_PARAM`。 */
  readonly paramName?: string | undefined;
}

export interface DebugDecision {
  /** URL 参数是否请求开启。 */
  readonly requested: boolean;
  /** 环境/白名单是否允许。 */
  readonly allowed: boolean;
  /** 最终是否开启（`requested && allowed`）。 */
  readonly enabled: boolean;
  readonly reason: DebugDecisionReason;
}

function readQueryParam(search: string | undefined, name: string): string | null {
  if (search === undefined || search === '') return null;
  const questionMark = search.indexOf('?');
  const query = questionMark >= 0 ? search.slice(questionMark + 1) : search;
  const params = new URLSearchParams(query);
  if (!params.has(name)) return null;
  return params.get(name) ?? '';
}

export function resolveDebugMode(options: DebugGateOptions): DebugDecision {
  const paramName = options.paramName ?? DEBUG_QUERY_PARAM;
  const raw = readQueryParam(options.search, paramName);
  const requested = raw !== null && !DISABLED_VALUES.includes(raw.trim().toLowerCase());
  if (!requested) {
    return { requested: false, allowed: false, enabled: false, reason: 'not_requested' };
  }

  const productionEnvs = options.productionEnvs ?? DEFAULT_PRODUCTION_ENVS;
  const env = options.env;
  const nonProduction = env !== undefined && !productionEnvs.includes(env);

  const allowUsers = options.allowUsers ?? [];
  const candidates = [options.user, options.hashedUser].filter(
    (value): value is string => value !== undefined,
  );
  const allowlistedUser = candidates.some((value) => allowUsers.includes(value));

  if (!nonProduction && !allowlistedUser) {
    return {
      requested: true,
      allowed: false,
      enabled: false,
      reason: 'production_user_not_allowlisted',
    };
  }
  return {
    requested: true,
    allowed: true,
    enabled: true,
    reason: allowlistedUser ? 'allowed_allowlisted_user' : 'allowed_non_production',
  };
}
