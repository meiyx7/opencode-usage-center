/**
 * 统计口径统一入口（统计口径统一批次任务 2）：前端业务指标的唯一来源。
 * 页面只做展示与格式化，不自行重复计算业务指标。
 *
 * 口径定义（与《docs/STATS_AUDIT.md》一致，勿在此之外另立公式）：
 * - 有效 Token = input + output（缓存读写不计入；reasoning 是否计入待确认，
 *   见审计表 R1，当前不计）
 * - 缓存命中率 = cacheRead / (cacheRead + input)
 */
import type { ModelRow, TokenTotals } from "../contract"

/** 有效 Token：input + output。模型行与会话/快照级 TokenTotals 共用。 */
export function effectiveTokens(tokens: Pick<TokenTotals, "input" | "output">): number {
  return tokens.input + tokens.output
}

/** 模型行的有效 Token（模型分布排序、占比的统一口径）。 */
export function modelTokens(model: ModelRow): number {
  return effectiveTokens(model)
}

/** 缓存命中率（0-1）：cacheRead / (cacheRead + input)；分母为 0 时返回 0。 */
export function cacheHitRate(tokens: Pick<TokenTotals, "input" | "cacheRead">): number {
  const base = tokens.cacheRead + tokens.input
  return base > 0 ? tokens.cacheRead / base : 0
}
