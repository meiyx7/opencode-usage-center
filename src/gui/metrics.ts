/**
 * 统计口径统一入口（统计口径统一批次任务 2）：前端业务指标的唯一来源。
 * 页面只做展示与格式化，不自行重复计算业务指标。
 *
 * 口径定义（与《docs/STATS_AUDIT.md》一致，勿在此之外另立公式）：
 * - 有效 Token = input + output（缓存读写不计入；reasoning 是否计入待确认，
 *   见审计表 R1，当前不计）
 * - 缓存命中率 = cacheRead / (cacheRead + input)
 */
import type { AgentRow, ModelRow, ProjectUsageRow, SeriesPoint, SessionRow, TokenTotals } from "../contract"

/** 有效 Token：input + output。模型行与会话/快照级 TokenTotals 共用。 */
export function effectiveTokens(tokens: Pick<TokenTotals, "input" | "output">): number {
  return tokens.input + tokens.output
}

/** 模型行的有效 Token（模型分布排序、占比的统一口径）。 */
export function modelTokens(model: ModelRow): number {
  return effectiveTokens(model)
}

/** 趋势点的有效 Token（TrendChart、KPI delta、Sparkline 的统一口径）。 */
export function pointTokens(point: Pick<SeriesPoint, "input" | "output">): number {
  return effectiveTokens(point)
}

/** 会话行的有效 Token（Sessions 列表、CSV 导出的统一口径）。 */
export function sessionTokens(session: Pick<SessionRow, "input" | "output">): number {
  return effectiveTokens(session)
}

/** Agent 行的有效 Token（成本归因卡排序与占比的统一口径）。 */
export function agentTokens(agent: Pick<AgentRow, "input" | "output">): number {
  return effectiveTokens(agent)
}

/** 项目归因行的有效 Token（成本归因卡排序与占比的统一口径）。 */
export function projectUsageTokens(row: Pick<ProjectUsageRow, "input" | "output">): number {
  return effectiveTokens(row)
}

/** 缓存命中率（0-1）：cacheRead / (cacheRead + input)；分母为 0 时返回 0。 */
export function cacheHitRate(tokens: Pick<TokenTotals, "input" | "cacheRead">): number {
  const base = tokens.cacheRead + tokens.input
  return base > 0 ? tokens.cacheRead / base : 0
}

/**
 * 趋势点的缓存命中率（0-1）：SeriesPoint 无 write 字段，口径与 TokenTotals
 * 版本一致（cacheRead / (cacheRead + input)）。KPI Sparkline 等图表使用。
 */
export function pointCacheHit(point: Pick<SeriesPoint, "input" | "cacheRead">): number {
  const base = point.cacheRead + point.input
  return base > 0 ? point.cacheRead / base : 0
}
