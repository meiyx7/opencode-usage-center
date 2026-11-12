const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** CSV cell with quote escaping and spreadsheet formula-injection protection. */
export function csvCell(value: unknown): string {
  const raw = String(value ?? "")
  const safe = typeof value === "string" && /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw
  return `"${safe.replace(/"/g, '""')}"`
}

export function readableError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  if (/SchemaError|Missing key at/i.test(value)) {
    return "插件窗口与后台服务版本不一致。请完全退出 OpenCode 后重新打开，或重载插件。"
  }
  if (/unknown method|not implemented|no such method|method.*not.*found/i.test(value)) {
    return "后台服务还没有加载「用量中心」的新版本。请重载插件后再试。"
  }
  return value
}

export function compact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return `${Math.round(value)}`
}

/** 请求次数用千分位完整展示：10,800 次比 10.8K 次更直观。 */
export function count(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  return Math.round(value).toLocaleString("en-US")
}

export function money(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00"
  return `$${MONEY.format(value)}`
}

export function percent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "0%"
  return `${value.toFixed(digits)}%`
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
}

export function resetLabel(at: number): string {
  if (!at) return "重置时间未知"
  const delta = at - Date.now()
  if (delta <= 0) return "即将重置"
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))} 分钟后重置`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时后重置`
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")} 重置`
}

export function expiryLabel(expires: number | undefined): { text: string; tone: "ok" | "warn" | "danger" | "none" } {
  if (!expires) return { text: "长期", tone: "none" }
  const days = (expires - Date.now()) / 86_400_000
  if (days < 0) return { text: "已过期", tone: "danger" }
  if (days < 1) return { text: "今天", tone: "danger" }
  if (days <= 3) return { text: `${Math.ceil(days)} 天`, tone: "danger" }
  if (days <= 14) return { text: `${Math.ceil(days)} 天`, tone: "warn" }
  return { text: `${Math.ceil(days)} 天`, tone: "ok" }
}

export function dateText(ms: number): string {
  if (!ms) return "—"
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`
}

export function relativeTime(ms: number): string {
  const delta = Date.now() - ms
  if (!Number.isFinite(delta) || delta < 0) return "刚刚"
  if (delta < 60_000) return "刚刚"
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  return dateText(ms)
}

export function providerName(id: string): string {
  const names: Record<string, string> = {
    opencode: "OpenCode",
    "opencode-go": "OpenCode Go",
    "trae-cn": "Trae CN",
    "trae-cn-ent": "Trae CN 企业版",
    qoder: "Qoder CN",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    "zai-coding-plan": "Z.ai",
    gmicloud: "GMI",
    agnes: "Agnes",
    unknown: "未知",
  }
  return names[id] ?? id
}

/** `497.73 / 2300 credits` when the provider exposes amounts, otherwise blank. */
export function meterAmount(used: number | undefined, limit: number | undefined, unit: string | undefined): string {
  if (used === undefined && limit === undefined) return ""
  const suffix = unit && unit !== "percent" ? ` ${unit}` : ""
  if (limit === undefined) return `${formatAmount(used ?? 0)}${suffix}`
  return `${formatAmount(used ?? 0)} / ${formatAmount(limit)}${suffix}`
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0"
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 })
  return `${Math.round(value * 100) / 100}`
}

export function modelInitial(id: string): string {
  const base = id.split("/").pop() ?? id
  return (base.replace(/^opencode[-_]?/i, "").slice(0, 1) || "?").toUpperCase()
}

export function shortModel(id: string): string {
  return id.length > 32 ? `${id.slice(0, 31)}…` : id
}

export type RangeKind = "today" | "7d" | "30d" | "all"

export const RANGES: { id: RangeKind; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "all", label: "全部" },
]

export function rangeBounds(kind: RangeKind): { from: number; to: number } {
  const now = Date.now()
  if (kind === "today") {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return { from: start.getTime(), to: now }
  }
  if (kind === "7d") return { from: now - 7 * 86_400_000, to: now }
  if (kind === "30d") return { from: now - 30 * 86_400_000, to: now }
  return { from: 0, to: now }
}
