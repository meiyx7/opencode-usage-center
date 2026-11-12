import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type {
  CredentialRow,
  Latency,
  LatencyModelRow,
  Meter,
  ModelRow,
  ProjectRow,
  Quota,
  QuotaProvider,
  SeriesPoint,
  SessionDetail,
  SessionDetailInput,
  SessionRequest,
  SessionRow,
  SessionToolCall,
  Snapshot,
  SnapshotInput,
  TokenTotals,
} from "../contract"

type Row = Record<string, string | number | null>

const DAY = 86_400_000
const CACHE_MS = 60_000
const SNAPSHOT_CACHE_LIMIT = 8
const QUOTA_CACHE_MS = 60_000
const DETAIL_CACHE_MS = 60_000
const DETAIL_CACHE_LIMIT = 4
const DETAIL_PAGE = 60
/**
 * 逐日聚合缓存（冷启动优化的核心）。历史天的消息不会再变，把每天扫描 +
 * JSON 提取的结果按天落盘；进程重启后 30 天快照 = 读 30 个小 JSON + 扫「今天」，
 * 从 ~1.7s 降到几十毫秒。文件放 ~/.cache/opencode/usage-center/days/<scope>/。
 */
const DAY_CACHE_LIMIT = 600
const DAY_FILE_MAX_BYTES = 32 * 1024 * 1024
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
/**
 * Trae CN serves the account's credit usage on its own API host. The
 * enterprise tenant host answers 405 for this path, so both the personal and
 * enterprise credentials post here with their own Cloud-IDE-JWT.
 */
const TRAE_USAGE_URL = "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage"
const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"
/** Qoder asks its OpenAPI host for the device account's allowance. */
const QODER_OPENAPI: Record<string, string> = {
  cn: "https://openapi.qoder.com.cn",
  global: "https://openapi.qoder.sh",
}

/** Keep RPC payloads small. Full session data stays in the local database. */
const PREVIEW = {
  prompt: 4_000,
  text: 6_000,
  reasoning: 1_500,
  input: 600,
  output: 1_000,
  summary: 120,
} as const

const PROVIDERS: Record<string, string> = {
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  "trae-cn": "Trae CN",
  qoder: "Qoder CN",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  "zai-coding-plan": "Z.ai",
  gmicloud: "GMI",
  agnes: "Agnes",
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function localDate(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

function nextDate(date: string): string {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + 1)
  return localDate(value.getTime())
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))
  return sorted[index] ?? 0
}

type LatencySample = { ttft: number; total: number; output: number }

type MutableTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type MutableTurn = {
  index: number
  seq: number
  time: number
  prompt: string
  promptTruncated: boolean
  files: string[]
  agents: string[]
  requests: SessionRequest[]
  cost: number
  tokens: MutableTokens
  toolCount: number
  errorCount: number
  duration: number
  ttft: number
  cacheHit: number
}

function latencyStats(rows: LatencySample[]): Latency {
  const usable = rows.filter((row) => row.total >= 0.05)
  const ttfts = usable.filter((row) => row.ttft > 0).map((row) => row.ttft)
  const totals = usable.map((row) => row.total)
  const output = usable.reduce((sum, row) => sum + row.output, 0)
  const seconds = totals.reduce((sum, value) => sum + value, 0)
  return {
    samples: usable.length,
    ttftP50: percentile(ttfts, 0.5),
    ttftP95: percentile(ttfts, 0.95),
    totalP50: percentile(totals, 0.5),
    totalP95: percentile(totals, 0.95),
    slowRate: totals.length ? totals.filter((value) => value > 30).length / totals.length : 0,
    tokensPerSecond: seconds > 0 ? output / seconds : 0,
    maxTotal: totals.length ? Math.max(...totals) : 0,
  }
}

function displayProvider(integrationID: string, label: string): string {
  if (PROVIDERS[integrationID]) return PROVIDERS[integrationID]
  const first = label.split(":")[0]?.trim()
  return first || integrationID || "未知"
}

function fillSeries(points: SeriesPoint[], from: number, to: number): SeriesPoint[] {
  if (points.length === 0) return points
  // A full history can span months; do not manufacture thousands of points.
  if (to - from > 120 * DAY) return points
  const map = new Map(points.map((point) => [point.date, point]))
  const first = points[0]!.date
  const last = points[points.length - 1]!.date
  const result: SeriesPoint[] = []
  let cursor = first
  let guard = 0
  while (cursor <= last && guard < 400) {
    result.push(
      map.get(cursor) ?? {
        date: cursor,
        requests: 0,
        cost: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
      },
    )
    cursor = nextDate(cursor)
    guard += 1
  }
  return result
}

function activeStreak(days: string[], today: string): number {
  const set = new Set(days)
  let cursor = today
  if (!set.has(cursor)) {
    const yesterday = new Date(`${today}T12:00:00`)
    yesterday.setDate(yesterday.getDate() - 1)
    cursor = localDate(yesterday.getTime())
  }
  let streak = 0
  while (set.has(cursor) && streak < 400) {
    streak += 1
    const previous = new Date(`${cursor}T12:00:00`)
    previous.setDate(previous.getDate() - 1)
    cursor = localDate(previous.getTime())
  }
  return streak
}

function parseJSON(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Build a meter without putting explicit `undefined` on the wire (RPC encodes JSON). */
function meterOf(
  id: string,
  label: string,
  percent: number,
  extra: { used?: number; limit?: number; unit?: string; resetsAt?: number; limited?: boolean } = {},
): Meter {
  return {
    id,
    label,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    ...(extra.used !== undefined ? { used: round2(extra.used) } : {}),
    ...(extra.limit !== undefined ? { limit: round2(extra.limit) } : {}),
    ...(extra.unit ? { unit: extra.unit } : {}),
    ...(extra.resetsAt ? { resetsAt: extra.resetsAt } : {}),
    ...(extra.limited ? { limited: true } : {}),
  }
}

/** Trae pack times are seconds since epoch; ISO strings and milliseconds also appear. */
function traeTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/**
 * Sum a Trae account's entitlement packs the way the Trae auth plugin does:
 * every pack's `quota.credits_limit` adds to the allowance (a `-1` means
 * unlimited), every pack's `usage.credits_amount` adds to the spend, and the
 * soonest pack expiry is the reset.
 */
function traeCredits(body: Record<string, unknown>): { limit: number; used: number; unlimited: boolean; until: number } {
  let limit = 0
  let used = 0
  let unlimited = false
  let until = 0
  const packs = Array.isArray(body.user_entitlement_pack_list) ? body.user_entitlement_pack_list : []
  for (const raw of packs) {
    const pack = asRecord(raw)
    if (!pack) continue
    const base = asRecord(pack.entitlement_base_info) ?? {}
    const quota = asRecord(base.quota) ?? {}
    const creditsLimit = Number(quota.credits_limit)
    if (Number.isFinite(creditsLimit)) {
      if (creditsLimit === -1) unlimited = true
      else if (creditsLimit >= 0) limit += creditsLimit
    }
    const usage = asRecord(pack.usage) ?? {}
    const amount = Number(usage.credits_amount)
    if (Number.isFinite(amount) && amount > 0) used += amount
    const end = traeTime(base.end_time ?? base.expire_time ?? pack.end_time)
    if (end && (!until || end < until)) until = end
  }
  if (limit <= 0 && !unlimited) {
    // Some tenants only fill `usage_summary`; fall back to it.
    const summary = asRecord(body.usage_summary) ?? {}
    const total = Number(summary.total_amount)
    const consumed = Number(summary.consumed_amount)
    if (Number.isFinite(total) && total > 0) {
      limit = total
      used = Number.isFinite(consumed) ? consumed : 0
    }
  }
  return { limit, used, unlimited, until }
}

async function goQuota(value: Record<string, unknown>): Promise<QuotaProvider> {
  const base = { id: "opencode-go", name: "OpenCode Go", source: "zen/go" }
  const secret =
    value.type === "oauth"
      ? text(value.access)
      : value.type === "key"
        ? text(value.key)
        : text(value.access) || text(value.key)
  if (!secret) return { ...base, available: false, error: "未找到 OpenCode Go 凭据", meters: [] }
  try {
    const response = await fetch(GO_USAGE_URL, {
      headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) {
      return { ...base, available: false, error: `OpenCode Go 额度暂不可用（HTTP ${response.status}）`, meters: [] }
    }
    const body = (await response.json()) as {
      usage?: Record<string, { status?: string; percent?: number; resetsAt?: string }>
    }
    const labels: Record<string, string> = { rolling: "滚动 5 小时", weekly: "本周", monthly: "本月" }
    const meters: Meter[] = []
    for (const key of ["rolling", "weekly", "monthly"]) {
      const entry = body.usage?.[key]
      if (!entry) continue
      const resetsAt = entry.resetsAt ? Date.parse(entry.resetsAt) : 0
      meters.push(
        meterOf(key, labels[key]!, num(entry.percent), {
          ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
          limited: entry.status !== "ok" || num(entry.percent) >= 100,
        }),
      )
    }
    return { ...base, available: true, error: "", meters }
  } catch {
    return { ...base, available: false, error: "无法连接 OpenCode Go 额度接口", meters: [] }
  }
}

async function traeQuota(id: string, name: string, value: Record<string, unknown>): Promise<QuotaProvider> {
  const base = { id, name, source: "trae" }
  const metadata = asRecord(value.metadata)
  const v1 = metadata ? asRecord(metadata.v1) : undefined
  const token = v1 ? text(v1.access) : ""
  if (!token) return { ...base, available: false, error: "凭据里没有 Trae 访问令牌，请重新登录", meters: [] }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "x-ide-token": token,
    "x-uid": v1 ? text(v1.uid) : "",
    "x-app-id": TRAE_APP_ID,
    "x-device-id": v1 ? text(v1.deviceId) : "",
    "x-machine-id": v1 ? text(v1.machineId) : "",
    "x-app-version": "0.1.69",
    "x-app-version-code": "20260917",
    "x-ide-version": "0.1.69",
    "x-ide-version-code": "20260917",
    "x-ide-version-type": "stable",
    "x-device-type": "windows",
    "x-system-type": "Windows",
  }
  try {
    const response = await fetch(TRAE_USAGE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ require_usage: true, req_source: 0 }),
      signal: AbortSignal.timeout(8_000),
    })
    if (response.status === 401) {
      return { ...base, available: false, error: "Trae 登录已过期，请在插件里重新登录一次", meters: [] }
    }
    if (!response.ok) {
      return { ...base, available: false, error: `Trae 额度暂不可用（HTTP ${response.status}）`, meters: [] }
    }
    const body = asRecord(await response.json())
    if (!body) return { ...base, available: false, error: "Trae 额度返回无法解析", meters: [] }
    const code = Number(body.code)
    if (Number.isFinite(code) && code !== 0) {
      return {
        ...base,
        available: false,
        error: code === 1001 ? "Trae 登录需要刷新，请在插件里重新登录一次" : text(body.message) || "Trae 额度暂不可用",
        meters: [],
      }
    }
    const credits = traeCredits(body)
    const plan = body.is_credits_billing ? "Credits" : "Free"
    if (credits.unlimited) {
      return {
        ...base,
        available: true,
        error: "",
        plan,
        note: "额度不限量",
        meters: [meterOf("credits", "Credits", 0, { unit: "credits", ...(credits.until ? { resetsAt: credits.until } : {}) })],
      }
    }
    if (credits.limit <= 0) {
      const note = id === "trae-cn-ent" ? "企业租户未暴露额度" : "该账号未暴露额度明细"
      return { ...base, available: true, error: "", plan, note, meters: [] }
    }
    const percent = (credits.used / credits.limit) * 100
    return {
      ...base,
      available: true,
      error: "",
      plan,
      meters: [
        meterOf("credits", "Credits", percent, {
          used: credits.used,
          limit: credits.limit,
          unit: "credits",
          ...(credits.until ? { resetsAt: credits.until } : {}),
          limited: percent >= 100,
        }),
      ],
    }
  } catch {
    return { ...base, available: false, error: "无法连接 Trae 额度接口", meters: [] }
  }
}

async function qoderQuota(value: Record<string, unknown>): Promise<QuotaProvider> {
  const base = { id: "qoder", name: "Qoder CN", source: "qoder" }
  const token = text(value.access)
  if (!token) return { ...base, available: false, error: "凭据里没有 Qoder 设备令牌，请重新登录", meters: [] }
  const metadata = asRecord(value.metadata) ?? {}
  const region = text(metadata.region) === "global" ? "global" : "cn"
  const host = QODER_OPENAPI[region] ?? QODER_OPENAPI.cn!
  try {
    const response = await fetch(`${host}/sash/api/v2/me/usage`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Cosy-ClientType": "10",
        "User-Agent": "Qoder",
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (response.status === 401) {
      return { ...base, available: false, error: "Qoder 令牌已过期，请在插件里刷新登录", meters: [] }
    }
    if (!response.ok) {
      return { ...base, available: false, error: `Qoder 额度暂不可用（HTTP ${response.status}）`, meters: [] }
    }
    const body = asRecord(await response.json())
    const usage = body ? asRecord(body.qoderUsage) : undefined
    if (!usage) return { ...base, available: false, error: text(body?.message) || "Qoder 额度返回无法解析", meters: [] }
    const exceeded = usage.isQuotaExceeded === true
    const meters: Meter[] = []
    const push = (id: string, label: string, raw: unknown) => {
      const quota = asRecord(raw)
      if (!quota) return
      const total = num(quota.total)
      const used = num(quota.used)
      if (total <= 0 && used <= 0) return
      const percent = total > 0 ? (used / total) * 100 : num(quota.percentage) * 100
      meters.push(
        meterOf(id, label, percent, {
          used,
          ...(total > 0 ? { limit: total } : {}),
          unit: text(quota.unit) || "credits",
          limited: exceeded,
        }),
      )
    }
    push("planQuota", "套餐额度", usage.userQuota)
    push("addOnQuota", "加油包", usage.addOnQuota)
    const plan = text(usage.userType)
    return {
      ...base,
      available: true,
      error: "",
      ...(plan ? { plan } : {}),
      ...(meters.length === 0 ? { note: "该账号未暴露额度明细" } : {}),
      meters,
    }
  } catch {
    return { ...base, available: false, error: "无法连接 Qoder 额度接口", meters: [] }
  }
}

function clip(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? ""
  return line.trim()
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errorText(value: unknown): string {
  if (!value) return ""
  if (typeof value === "string") return value
  const record = asRecord(value)
  if (!record) return String(value)
  return text(record.message) || text(record.error) || text(record.reason) || stringify(record)
}

function toolSummary(input: unknown): string {
  const record = asRecord(input)
  if (!record) return clip(stringify(input), PREVIEW.summary).text
  for (const key of [
    "command",
    "code",
    "filePath",
    "filepath",
    "path",
    "url",
    "query",
    "pattern",
    "description",
    "prompt",
    "name",
  ]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return clip(firstLine(value), PREVIEW.summary).text
    }
  }
  return clip(stringify(input), PREVIEW.summary).text
}

function toolOutput(state: Record<string, unknown> | undefined): { text: string; truncated: boolean } {
  if (!state) return { text: "", truncated: false }
  const chunks: string[] = []
  const content = Array.isArray(state.content) ? state.content : []
  for (const raw of content) {
    const part = asRecord(raw)
    if (!part) continue
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text)
      continue
    }
    if (part.type === "file") {
      const label = text(part.name) || text(part.filename) || text(part.mime) || "附件"
      chunks.push(`[文件] ${label}`)
      continue
    }
    chunks.push(`[${text(part.type) || "内容"}]`)
  }
  let value = chunks.join("\n").trim()
  if (!value) {
    const metadata = asRecord(state.metadata)
    for (const key of ["output", "preview", "diff", "filediff"]) {
      const candidate = metadata?.[key]
      if (typeof candidate === "string" && candidate.trim()) {
        value = candidate
        break
      }
    }
  }
  return clip(value, PREVIEW.output)
}

function sumTokens(requests: readonly SessionRequest[]): MutableTokens {
  const total: MutableTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const request of requests) {
    total.input += request.tokens.input
    total.output += request.tokens.output
    total.reasoning += request.tokens.reasoning
    total.cacheRead += request.tokens.cacheRead
    total.cacheWrite += request.tokens.cacheWrite
  }
  return total
}

function cacheHitRate(tokens: TokenTotals): number {
  const base = tokens.cacheRead + tokens.input
  return base > 0 ? tokens.cacheRead / base : 0
}

function blankTurn(
  index: number,
  seq: number,
  time: number,
  prompt: string,
  promptTruncated: boolean,
  files: string[],
  agents: string[],
): MutableTurn {
  return {
    index,
    seq,
    time,
    prompt,
    promptTruncated,
    files,
    agents,
    requests: [],
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    toolCount: 0,
    errorCount: 0,
    duration: 0,
    ttft: 0,
    cacheHit: 0,
  }
}

/**
 * 一天的完整聚合结果。快照需要的所有维度都按天预算好：
 * series 一点、models 各自累计、每会话用量、时延样本。
 * 时延样本要保留原始值才能跨天合并算 P50/P95，这是文件体积的主体。
 */
type DayAgg = {
  date: string
  requests: number
  cost: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  /** providerID\0modelID → 聚合 */
  models: Record<string, { providerID: string; modelID: string; requests: number; cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }>
  /** sessionID → 聚合 */
  sessions: Record<string, { requests: number; cost: number; input: number; output: number; cacheRead: number; providerID: string; modelID: string }>
  /** 每个样本 [ttft, total, output]，保留原值供跨天分位数计算 */
  latency: [number, number, number][]
  /** 每个模型的时延样本：modelKey → [providerID, modelID, samples[]] */
  latencyByModel: Record<string, { providerID: string; modelID: string; samples: [number, number, number][] }>
  prompts: number
  /** 聚合当天的全类型消息总数，用于回退检测 */
  baseCount?: number
}

/** 纯函数：把一天的消息行聚合成 DayAgg。输入输出与数据库解耦，便于缓存。 */
function aggregateDay(date: string, rows: Row[]): DayAgg {
  const models: DayAgg["models"] = {}
  const sessions: DayAgg["sessions"] = {}
  const latency: [number, number, number][] = []
  const latencyByModel: DayAgg["latencyByModel"] = {}
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let cost = 0
  let requests = 0
  let prompts = 0
  for (const row of rows) {
    const providerID = text(row.providerID) || "unknown"
    const modelID = text(row.modelID) || "unknown"
    if (row.type === "user") {
      // user 行只贡献 prompts 计数；requests/token/模型/会话/时延都只看 assistant。
      prompts += 1
      continue
    }
    const rowCost = num(row.cost)
    const input = num(row.input)
    const output = num(row.output)
    const reasoning = num(row.reasoning)
    const cacheRead = num(row.cacheRead)
    const cacheWrite = num(row.cacheWrite)
    // 到这里的全是 assistant 行：requests = 模型调用次数（与旧版 KPI 语义一致）。
    requests += 1
    cost += rowCost
    tokens.input += input
    tokens.output += output
    tokens.reasoning += reasoning
    tokens.cacheRead += cacheRead
    tokens.cacheWrite += cacheWrite

    const sessionID = text(row.sessionID)
    const usage = sessions[sessionID] ?? {
      requests: 0,
      cost: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      providerID: "unknown",
      modelID: "unknown",
    }
    usage.requests += 1
    usage.cost += rowCost
    usage.input += input
    usage.output += output
    usage.cacheRead += cacheRead
    if (modelID !== "unknown") {
      usage.providerID = providerID
      usage.modelID = modelID
    }
    sessions[sessionID] = usage

    const modelKey = `${providerID}\u0000${modelID}`
    const model = models[modelKey] ?? {
      providerID,
      modelID,
      requests: 0,
      cost: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }
    model.requests += 1
    model.cost += rowCost
    model.input += input
    model.output += output
    model.cacheRead += cacheRead
    model.cacheWrite += cacheWrite
    models[modelKey] = model

    const elapsed = num(row.elapsed)
    if (row.type === "assistant" && elapsed >= 0.05) {
      latency.push([num(row.ttft), elapsed, output])
      const group = latencyByModel[modelKey] ?? { providerID, modelID, samples: [] as [number, number, number][] }
      group.samples.push([num(row.ttft), elapsed, output])
      latencyByModel[modelKey] = group
    }
  }
  return { date, requests, cost, tokens, models, sessions, latency, latencyByModel, prompts }
}

/** 合并多天聚合。modelMap/sessionMap 可为传入的累计对象（增量合并）。 */
function mergeDays(target: DayAgg, days: readonly DayAgg[]): DayAgg {
  for (const day of days) {
    target.requests += day.requests
    target.cost += day.cost
    target.prompts += day.prompts
    target.tokens.input += day.tokens.input
    target.tokens.output += day.tokens.output
    target.tokens.reasoning += day.tokens.reasoning
    target.tokens.cacheRead += day.tokens.cacheRead
    target.tokens.cacheWrite += day.tokens.cacheWrite
    for (const [key, model] of Object.entries(day.models)) {
      const existing = target.models[key]
      if (existing) {
        existing.requests += model.requests
        existing.cost += model.cost
        existing.input += model.input
        existing.output += model.output
        existing.cacheRead += model.cacheRead
        existing.cacheWrite += model.cacheWrite
      } else {
        target.models[key] = { ...model }
      }
    }
    for (const [key, session] of Object.entries(day.sessions)) {
      const existing = target.sessions[key]
      if (existing) {
        existing.requests += session.requests
        existing.cost += session.cost
        existing.input += session.input
        existing.output += session.output
        existing.cacheRead += session.cacheRead
        if (session.modelID !== "unknown") {
          existing.providerID = session.providerID
          existing.modelID = session.modelID
        }
      } else {
        target.sessions[key] = { ...session }
      }
    }
    target.latency.push(...day.latency)
    for (const [key, group] of Object.entries(day.latencyByModel)) {
      const existing = target.latencyByModel[key]
      if (existing) existing.samples.push(...group.samples)
      else target.latencyByModel[key] = { providerID: group.providerID, modelID: group.modelID, samples: [...group.samples] }
    }
  }
  return target
}

export class UsageStore {
  private db?: Database
  private dbError = ""
  private cache = new Map<string, { at: number; value: Snapshot }>()
  private quotaCache?: { at: number; value: Quota }
  private sessionCache = new Map<string, { at: number; value: SessionDetail }>()
  /** 逐日聚合的内存缓存：scope → (date → DayAgg)。 */
  private dayMemory = new Map<string, Map<string, DayAgg>>()

  constructor(
    readonly path: string,
    private readonly log: (message: string, detail?: unknown) => void = () => {},
  ) {}

  private dayCacheDir(scope: string): string {
    return join(
      process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
      "opencode",
      "usage-center",
      "days",
      scope.replace(/[^a-zA-Z0-9_-]/g, "_") || "all",
    )
  }

  private dayFilePath(scope: string, date: string): string {
    return join(this.dayCacheDir(scope), `${date}.json`)
  }

  /** 读一天的落盘聚合。文件损坏即删除并返回 undefined。 */
  private readDay(scope: string, date: string): DayAgg | undefined {
    try {
      const file = this.dayFilePath(scope, date)
      if (!existsSync(file)) return undefined
      const parsed = JSON.parse(readFileSync(file, "utf8")) as DayAgg
      if (parsed.date !== date || !Array.isArray(parsed.latency)) {
        unlinkSync(file)
        return undefined
      }
      return parsed
    } catch {
      try {
        unlinkSync(this.dayFilePath(scope, date))
      } catch {
        // 读不出来也删不掉就随它去
      }
      return undefined
    }
  }

  private writeDay(scope: string, day: DayAgg): void {
    try {
      const body = JSON.stringify(day)
      if (body.length > DAY_FILE_MAX_BYTES) return
      const dir = this.dayCacheDir(scope)
      mkdirSync(dir, { recursive: true })
      const file = this.dayFilePath(scope, day.date)
      // 先写临时文件再同步改名，避免半截 JSON 被下一次冷启动读到。
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, body)
      renameSync(tmp, file)
    } catch {
      // 磁盘缓存失败不影响主流程
    }
  }

  /** 内存里记一天，超限淘汰最早的日期。 */
  private rememberDay(scope: string, day: DayAgg): void {
    let map = this.dayMemory.get(scope)
    if (!map) {
      map = new Map()
      this.dayMemory.set(scope, map)
    }
    map.set(day.date, day)
    while (map.size > DAY_CACHE_LIMIT) {
      const oldest = map.keys().next().value
      if (!oldest) break
      map.delete(oldest)
    }
  }

  close(): void {
    this.db?.close()
    this.db = undefined
    this.cache.clear()
    this.quotaCache = undefined
    this.sessionCache.clear()
    this.dayMemory.clear()
  }

  private rememberSnapshot(key: string, value: Snapshot): void {
    this.cache.delete(key)
    this.cache.set(key, { at: Date.now(), value })
    while (this.cache.size > SNAPSHOT_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
  }

  private database(): Database | undefined {
    if (this.db) return this.db
    try {
      this.db = new Database(this.path, { readonly: true, create: false })
      this.db.query("PRAGMA busy_timeout = 4000").run()
      this.dbError = ""
      return this.db
    } catch (error) {
      this.dbError = `无法只读打开 OpenCode 数据库：${error instanceof Error ? error.message : String(error)}`
      return undefined
    }
  }

  private fileInfo(): Snapshot["database"] {
    try {
      const stat = statSync(this.path)
      return { path: this.path, size: stat.size, ok: !this.dbError, error: this.dbError }
    } catch (error) {
      return {
        path: this.path,
        size: 0,
        ok: false,
        error: `找不到 OpenCode 数据库：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * 逐日聚合的查询范围。key 决定缓存命名空间：
   * 项目的消息挂在 project 维度上，所以 scope = 项目 id 或 "all"。
   */
  private scopeOf(projectID?: string): string {
    const project = projectID?.trim()
    return project || "all"
  }

  /** 一天的本地毫秒区间。 */
  private dayBounds(date: string): { from: number; to: number } {
    const start = new Date(`${date}T00:00:00`)
    const from = start.getTime()
    return { from, to: from + DAY }
  }

  /** 取一天的聚合：内存 → 磁盘 → 现算。今天总是现算（消息还在增长）。 */
  private dayAgg(db: Database, scope: string, date: string, today: string): DayAgg {
    const memory = this.dayMemory.get(scope)?.get(date)
    if (memory && date !== today) return memory
    if (date !== today) {
      const disk = this.readDay(scope, date)
      if (disk) {
        // 回退/删会话会减少历史消息；数量对不上就丢弃缓存重算。
        const count = this.dayCount(db, scope, date)
        if (disk.baseCount === undefined) disk.baseCount = count
        if (count === disk.baseCount) {
          this.rememberDay(scope, disk)
          return disk
        }
        this.log("day cache invalidated (count drift)", `${scope}/${date}: ${disk.baseCount} -> ${count}`)
      }
    }

    const { from, to } = this.dayBounds(date)
    const rows = db
      .query<Row>(
        `SELECT
           m.session_id AS sessionID,
           m.type AS type,
           coalesce(json_extract(m.data, '$.model.providerID'), 'unknown') AS providerID,
           coalesce(json_extract(m.data, '$.model.id'), 'unknown') AS modelID,
           coalesce(json_extract(m.data, '$.cost'), 0) AS cost,
           coalesce(json_extract(m.data, '$.tokens.input'), 0) AS input,
           coalesce(json_extract(m.data, '$.tokens.output'), 0) AS output,
           coalesce(json_extract(m.data, '$.tokens.reasoning'), 0) AS reasoning,
           coalesce(json_extract(m.data, '$.tokens.cache.read'), 0) AS cacheRead,
           coalesce(json_extract(m.data, '$.tokens.cache.write'), 0) AS cacheWrite,
           (json_extract(m.data, '$.time.streamed') - json_extract(m.data, '$.time.created')) / 1000.0 AS ttft,
           (json_extract(m.data, '$.time.completed') - json_extract(m.data, '$.time.created')) / 1000.0 AS elapsed
         FROM session_message m JOIN session_v2 s ON s.id = m.session_id
         WHERE m.time_created >= ? AND m.time_created < ?${scope !== "all" ? " AND s.project_id = ?" : ""}
           AND m.type IN ('assistant', 'user')`,
      )
      .all(...(scope !== "all" ? [from, to, scope] : [from, to]))
    const day = aggregateDay(date, rows)
    day.baseCount = this.dayCount(db, scope, date)
    this.rememberDay(scope, day)
    // 今天的数据还会变，落盘要等它结束；历史天直接落盘。
    if (date !== today) this.writeDay(scope, day)
    return day
  }

  /**
   * 历史天的缓存可信度校验：回退（revert）会删掉旧消息，让缓存聚合偏大。
   * 每天只做一次 count(*)（有索引，毫秒级）；数量对不上就作废重算。
   * count 含全部消息类型，与聚合行的差值在同一天内是稳定的，所以把
   * 首次聚合时的基准也存进文件里对比。
   */
  private dayCount(db: Database, scope: string, date: string): number {
    const { from, to } = this.dayBounds(date)
    return num(
      db
        .query<Row>(
          `SELECT count(*) AS n FROM session_message m JOIN session_v2 s ON s.id = m.session_id
           WHERE m.time_created >= ? AND m.time_created < ?${scope !== "all" ? " AND s.project_id = ?" : ""}`,
        )
        .get(...(scope !== "all" ? [from, to, scope] : [from, to]))?.n,
    )
  }

  snapshot(input: SnapshotInput): Snapshot {
    const key = `${Math.floor(input.from / 60_000)}|${Math.floor(input.to / 60_000)}|${input.projectID ?? ""}`
    const cached = this.cache.get(key)
    if (!input.force && cached && Date.now() - cached.at < CACHE_MS) {
      return cached.value
    }

    const db = this.database()
    if (!db) {
      const value = this.emptySnapshot(input)
      this.rememberSnapshot(key, value)
      return value
    }

    const scope = this.scopeOf(input.projectID)
    const today = localDate(Date.now())

    // 找出范围覆盖的每一天，逐日取聚合（历史天走缓存，只有今天现算）。
    const firstDay = input.from === 0 ? undefined : localDate(input.from)
    const lastDay = localDate(Math.min(input.to, Date.now()))
    const dates: string[] = []
    if (firstDay) {
      let cursor = firstDay
      let guard = 0
      while (cursor <= lastDay && guard < 400) {
        dates.push(cursor)
        cursor = nextDate(cursor)
        guard += 1
      }
    } else {
      // 「全部」范围没有明确的起点：先查数据库里最早的消息日期。
      const scopeFilter = scope !== "all" ? " AND s.project_id = ?" : ""
      const earliest = db
        .query<Row>(
          `SELECT min(m.time_created) AS t FROM session_message m JOIN session_v2 s ON s.id = m.session_id
           WHERE m.type = 'assistant'${scopeFilter}`,
        )
        .get(...(scope !== "all" ? [scope] : []))
      const earliestTime = num(earliest?.t)
      if (earliestTime > 0) {
        let cursor = localDate(earliestTime)
        let guard = 0
        while (cursor <= lastDay && guard < 400) {
          dates.push(cursor)
          cursor = nextDate(cursor)
          guard += 1
        }
      }
    }

    const total = mergeDays(
      {
        date: `${firstDay ?? "all"}~${lastDay}`,
        requests: 0,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        models: {},
        sessions: {},
        latency: [],
        latencyByModel: {},
        prompts: 0,
      },
      dates.map((date) => this.dayAgg(db, scope, date, today)),
    )

    const series: SeriesPoint[] = dates.map((date) => {
      const day = this.dayMemory.get(scope)?.get(date)
      return {
        date,
        requests: day?.requests ?? 0,
        cost: day?.cost ?? 0,
        input: day?.tokens.input ?? 0,
        output: day?.tokens.output ?? 0,
        cacheRead: day?.tokens.cacheRead ?? 0,
      }
    })
    const models: ModelRow[] = Object.values(total.models).sort(
      (a, b) => b.input + b.output - (a.input + a.output),
    )
    const latency = latencyStats(total.latency.map(([ttft, t, output]) => ({ ttft, total: t, output })))
    const latencyModels: LatencyModelRow[] = Object.values(total.latencyByModel)
      .map((group) => {
        const { maxTotal: _maxTotal, ...stats } = latencyStats(
          group.samples.map(([ttft, t, output]) => ({ ttft, total: t, output })),
        )
        return {
          providerID: group.providerID,
          modelID: group.modelID,
          ...stats,
        }
      })
      .sort((a, b) => b.samples - a.samples)

    const sessionRows = db
      .query<Row>(
        `SELECT id, title, project_id, model, cost, tokens_input, tokens_output, tokens_cache_read,
                time_created, time_updated
         FROM session_v2
         WHERE time_updated >= ? AND time_updated <= ?${scope !== "all" ? " AND project_id = ?" : ""}
         ORDER BY time_updated DESC LIMIT 500`,
      )
      .all(...(scope !== "all" ? [input.from, input.to, scope] : [input.from, input.to]))

    const sessions: SessionRow[] = sessionRows.map((row) => {
      const model = row.model ? parseJSON(String(row.model)) : undefined
      // session_v2 stores lifetime totals. The list is filtered to the selected
      // time range, so use the aggregate of messages that actually fall inside it.
      const usage = total.sessions[text(row.id)]
      return {
        id: text(row.id),
        title: text(row.title) || "未命名会话",
        projectID: text(row.project_id),
        modelID: text(model?.id) || usage?.modelID || "unknown",
        providerID: text(model?.providerID) || usage?.providerID || "unknown",
        cost: usage?.cost ?? 0,
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        timeCreated: num(row.time_created),
        timeUpdated: num(row.time_updated),
      }
    })

    const projects = this.projects(db)
    const credentials = this.credentials(db)
    const days = series.filter((point) => point.requests > 0).map((point) => point.date)
    const filled = fillSeries(series, input.from, input.to)
    const value: Snapshot = {
      generatedAt: Date.now(),
      range: { from: input.from, to: input.to },
      database: this.fileInfo(),
      totals: {
        requests: total.requests,
        sessions: Object.keys(total.sessions).length,
        prompts: total.prompts,
        activeDays: days.length,
        streak: activeStreak(days, today),
        cost: total.cost,
        tokens: total.tokens,
      },
      series: filled,
      models,
      latency,
      latencyModels,
      projects,
      sessions,
      credentials,
    }
    this.rememberSnapshot(key, value)
    return value
  }

  private projects(db: Database): ProjectRow[] {
    const rows = db
      .query<Row>("SELECT id, worktree, name, time_active FROM project ORDER BY time_active DESC LIMIT 40")
      .all()
    return rows.map((row) => {
      const directory = text(row.worktree)
      return {
        id: text(row.id),
        name: text(row.name) || basename(directory) || "未命名项目",
        directory,
        lastActive: num(row.time_active),
      }
    })
  }

  private credentials(db: Database): CredentialRow[] {
    const rows = db
      .query<Row>("SELECT id, integration_id, label, value, active, time_updated FROM credential")
      .all()
    const result: CredentialRow[] = []
    for (const row of rows) {
      const value = parseJSON(text(row.value))
      if (!value) continue
      const type = text(value.type) || "key"
      const expires = type === "oauth" && typeof value.expires === "number" ? value.expires : undefined
      const provider = displayProvider(text(row.integration_id), text(row.label))
      // Do not put `expires: undefined` on the wire: RPC responses are JSON
      // values, and an explicit undefined fails encoding at ["output"].
      result.push({
        id: text(row.id),
        provider,
        label: provider,
        type,
        active: num(row.active) === 1,
        ...(expires !== undefined ? { expires } : {}),
      })
    }
    return result.sort((a, b) => {
      if (a.expires && b.expires) return a.expires - b.expires
      if (a.expires) return -1
      if (b.expires) return 1
      return Number(b.active) - Number(a.active)
    })
  }

  sessionDetail(input: SessionDetailInput): SessionDetail {
    const cached = this.sessionCache.get(input.sessionID)
    if (!input.force && cached && Date.now() - cached.at < DETAIL_CACHE_MS) {
      return this.sliceSessionDetail(cached.value, input)
    }
    const db = this.database()
    const full = db ? this.buildSessionDetail(db, input.sessionID) : this.emptySessionDetail(input.sessionID)
    if (db) {
      // Refresh insertion order so the map behaves as a small LRU.
      this.sessionCache.delete(input.sessionID)
      this.sessionCache.set(input.sessionID, { at: Date.now(), value: full })
      while (this.sessionCache.size > DETAIL_CACHE_LIMIT) {
        const oldest = this.sessionCache.keys().next().value
        if (oldest) this.sessionCache.delete(oldest)
      }
    }
    return this.sliceSessionDetail(full, input)
  }

  private sliceSessionDetail(full: SessionDetail, input: SessionDetailInput): SessionDetail {
    const wanted = input.limit
    const limit = Math.min(200, Math.max(1, Math.round(Number.isFinite(wanted) ? wanted! : DETAIL_PAGE)))
    const before =
      Number.isFinite(input.beforeTurn) && input.beforeTurn! > 0 ? input.beforeTurn! : full.turns.length + 1
    const eligible = full.turns.filter((turn) => turn.index < before)
    const start = Math.max(0, eligible.length - limit)
    const turns = eligible.slice(start)
    const hasMore = turns.length > 0 && turns[0]!.index > 1
    return { ...full, turns, hasMore, nextBefore: hasMore ? turns[0]!.index : 0 }
  }

  private buildSessionDetail(db: Database, sessionID: string): SessionDetail {
    const row = db
      .query<Row>(
        `SELECT s.id, s.project_id, s.title, s.directory, s.model, s.agent, s.time_created, s.time_updated,
                p.name AS projectName, p.worktree AS projectWorktree
         FROM session_v2 s LEFT JOIN project p ON p.id = s.project_id
         WHERE s.id = ?`,
      )
      .get(sessionID)
    const messageRows = db
      .query<Row>("SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq")
      .all(sessionID)

    const turns: MutableTurn[] = []
    const requests: SessionRequest[] = []
    let userCount = 0
    let turn: MutableTurn | undefined

    const finalize = () => {
      if (!turn) return
      const local = turn
      const tokenTotal = sumTokens(local.requests)
      const end = local.requests.reduce(
        (max, request) => Math.max(max, request.time + request.total * 1000),
        local.time,
      )
      const ttfts = local.requests.filter((request) => request.ttft > 0).map((request) => request.ttft)
      local.cost = local.requests.reduce((sum, request) => sum + request.cost, 0)
      local.tokens = tokenTotal
      local.toolCount = local.requests.reduce((sum, request) => sum + request.tools.length, 0)
      local.errorCount = local.requests.reduce(
        (sum, request) =>
          sum +
          (request.error ? 1 : 0) +
          request.tools.filter((tool) => tool.status === "error" || Boolean(tool.error)).length,
        0,
      )
      local.duration = Math.max(0, (end - local.time) / 1000)
      local.ttft = ttfts.length ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : 0
      local.cacheHit = cacheHitRate(tokenTotal)
      turns.push(local)
      turn = undefined
    }

    for (const message of messageRows) {
      const type = text(message.type)
      const created = num(message.time_created)
      const data = parseJSON(String(message.data))
      if (type === "user") {
        finalize()
        userCount += 1
        const prompt = clip(text(data?.text), PREVIEW.prompt)
        const rawFiles = Array.isArray(data?.files) ? data.files : []
        const files = rawFiles.slice(0, 12).map((raw) => {
          const file = asRecord(raw)
          return text(file?.name) || text(file?.mime) || "附件"
        })
        if (rawFiles.length > 12) files.push(`+${rawFiles.length - 12} 个附件`)
        const rawAgents = Array.isArray(data?.agents) ? data.agents : []
        const agents = rawAgents.slice(0, 12).map((agent) => {
          const record = asRecord(agent)
          return text(agent) || text(record?.name) || text(record?.type) || "agent"
        })
        turn = blankTurn(
          turns.length + 1,
          num(message.seq),
          created,
          prompt.text,
          prompt.truncated,
          files,
          agents,
        )
        continue
      }
      if (type === "assistant") {
        const request = this.sessionRequest(message, data)
        requests.push(request)
        if (!turn) {
          turn = blankTurn(turns.length + 1, num(message.seq), request.time, "（会话开始）", false, [], [])
        }
        turn.requests.push(request)
      }
    }
    finalize()

    const tokens = sumTokens(requests)
    const latency = latencyStats(
      requests.map((request) => ({ ttft: request.ttft, total: request.total, output: request.tokens.output })),
    )
    const sessionModel = row?.model ? parseJSON(String(row.model)) : undefined
    const firstModel = requests.find((request) => request.modelID !== "unknown")
    const projectID = text(row?.project_id)
    const directory = text(row?.directory)
    const projectWorktree = text(row?.projectWorktree)
    const projectName =
      text(row?.projectName) || (projectWorktree ? basename(projectWorktree) : "") || projectID || "未命名项目"
    const errorCount = requests.reduce(
      (sum, request) =>
        sum +
        (request.error ? 1 : 0) +
        request.tools.filter((tool) => tool.status === "error" || Boolean(tool.error)).length,
      0,
    )

    return {
      found: Boolean(row) || messageRows.length > 0,
      id: sessionID,
      title: text(row?.title) || "未命名会话",
      projectID,
      projectName,
      directory,
      providerID: text(sessionModel?.providerID) || firstModel?.providerID || "unknown",
      modelID: text(sessionModel?.id) || firstModel?.modelID || "unknown",
      agent: text(row?.agent) || firstModel?.agent || "",
      timeCreated:
        num(row?.time_created) || (messageRows.length ? num(messageRows[0]?.time_created) : 0),
      timeUpdated:
        num(row?.time_updated) ||
        (messageRows.length ? num(messageRows[messageRows.length - 1]?.time_created) : 0),
      cost: requests.reduce((sum, request) => sum + request.cost, 0),
      tokens,
      turns,
      totalTurns: turns.length,
      hasMore: false,
      nextBefore: 0,
      promptCount: userCount,
      requestCount: requests.length,
      toolCount: requests.reduce((sum, request) => sum + request.tools.length, 0),
      errorCount,
      ttftP50: latency.ttftP50,
      ttftP95: latency.ttftP95,
      totalP50: latency.totalP50,
      totalP95: latency.totalP95,
      slowRate: latency.slowRate,
      cacheHit: cacheHitRate(tokens),
      generatedAt: Date.now(),
    }
  }

  private sessionRequest(message: Row, data: Record<string, unknown> | undefined): SessionRequest {
    const model = asRecord(data?.model)
    const time = asRecord(data?.time)
    const created = num(time?.created) || num(message.time_created)
    const streamed = num(time?.streamed) || created
    const completed = num(time?.completed) || streamed || created
    const tokens = asRecord(data?.tokens)
    const cache = asRecord(tokens?.cache)
    const content = Array.isArray(data?.content) ? data.content : []
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const tools: SessionToolCall[] = []

    for (const raw of content) {
      const part = asRecord(raw)
      if (!part) continue
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text)
        continue
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        reasoningParts.push(part.text)
        continue
      }
      if (part.type !== "tool") continue
      const state = asRecord(part.state)
      const toolTime = asRecord(part.time)
      const started = num(toolTime?.created)
      const ran = num(toolTime?.ran) || num(toolTime?.completed) || started
      const output = toolOutput(state)
      const metadata = asRecord(state?.metadata)
      const exit = metadata?.exit
      tools.push({
        id: text(part.id),
        name: text(part.name) || "tool",
        status: text(state?.status) || "unknown",
        duration: Math.max(0, (ran - started) / 1000),
        summary: toolSummary(state?.input),
        input: clip(stringify(state?.input), PREVIEW.input).text,
        output: output.text,
        outputTruncated: output.truncated || metadata?.truncated === true,
        error: clip(errorText(state?.error), 800).text,
        ...(typeof exit === "number" && Number.isFinite(exit) ? { exitCode: exit } : {}),
      })
    }

    const textValue = clip(textParts.join("\n\n"), PREVIEW.text)
    const reasoningValue = clip(reasoningParts.join("\n\n"), PREVIEW.reasoning)
    const tokenValue: TokenTotals = {
      input: num(tokens?.input),
      output: num(tokens?.output),
      reasoning: num(tokens?.reasoning),
      cacheRead: num(cache?.read),
      cacheWrite: num(cache?.write),
    }

    return {
      id: text(message.id),
      seq: num(message.seq),
      time: created,
      agent: text(data?.agent) || "unknown",
      providerID: text(model?.providerID) || "unknown",
      modelID: text(model?.id) || "unknown",
      variant: text(model?.variant),
      finish: text(data?.finish),
      cost: num(data?.cost),
      tokens: tokenValue,
      ttft: Math.max(0, (streamed - created) / 1000),
      total: Math.max(0, (completed - created) / 1000),
      error: clip(errorText(data?.error), 800).text,
      text: textValue.text,
      textTruncated: textValue.truncated,
      reasoning: reasoningValue.text,
      reasoningTruncated: reasoningValue.truncated,
      tools,
    }
  }

  private emptySessionDetail(id: string): SessionDetail {
    return {
      found: false,
      id,
      title: "未找到会话",
      projectID: "",
      projectName: "",
      directory: "",
      providerID: "unknown",
      modelID: "unknown",
      agent: "",
      timeCreated: 0,
      timeUpdated: 0,
      cost: 0,
      tokens: emptyTokens(),
      turns: [],
      totalTurns: 0,
      hasMore: false,
      nextBefore: 0,
      promptCount: 0,
      requestCount: 0,
      toolCount: 0,
      errorCount: 0,
      ttftP50: 0,
      ttftP95: 0,
      totalP50: 0,
      totalP95: 0,
      slowRate: 0,
      cacheHit: 0,
      generatedAt: Date.now(),
    }
  }

  private emptySnapshot(input: SnapshotInput): Snapshot {
    return {
      generatedAt: Date.now(),
      range: { from: input.from, to: input.to },
      database: this.fileInfo(),
      totals: {
        requests: 0,
        sessions: 0,
        prompts: 0,
        activeDays: 0,
        streak: 0,
        cost: 0,
        tokens: emptyTokens(),
      },
      series: [],
      models: [],
      latency: {
        samples: 0,
        ttftP50: 0,
        ttftP95: 0,
        totalP50: 0,
        totalP95: 0,
        slowRate: 0,
        tokensPerSecond: 0,
        maxTotal: 0,
      },
      latencyModels: [],
      projects: [],
      sessions: [],
      credentials: [],
    }
  }

  async quota(force = false): Promise<Quota> {
    if (!force && this.quotaCache && Date.now() - this.quotaCache.at < QUOTA_CACHE_MS) {
      return this.quotaCache.value
    }
    const db = this.database()
    if (!db) {
      return {
        available: false,
        error: this.dbError || "数据库不可用",
        providers: [],
      }
    }
    const rows = db
      .query<Row>(
        "SELECT integration_id, value FROM credential WHERE integration_id IN ('opencode-go', 'trae-cn', 'trae-cn-ent', 'qoder') ORDER BY active DESC, time_updated DESC",
      )
      .all()
    // Keep only the newest active credential per provider (the query is
    // already ordered), so a stale duplicate never shadows the live one.
    const latest = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const id = text(row.integration_id)
      if (latest.has(id)) continue
      const value = parseJSON(text(row.value))
      if (value) latest.set(id, value)
    }

    const jobs: Promise<QuotaProvider>[] = []
    const go = latest.get("opencode-go")
    if (go) jobs.push(goQuota(go))
    const personal = latest.get("trae-cn")
    if (personal) jobs.push(traeQuota("trae-cn", "Trae CN 个人版", personal))
    const enterprise = latest.get("trae-cn-ent")
    if (enterprise) jobs.push(traeQuota("trae-cn-ent", "Trae CN 企业版", enterprise))
    const qoder = latest.get("qoder")
    if (qoder) jobs.push(qoderQuota(qoder))

    const providers = await Promise.all(jobs)
    for (const provider of providers) {
      if (!provider.available && provider.error) this.log(`${provider.name} quota unavailable`, provider.error)
    }
    const available = providers.some((provider) => provider.available)
    const error =
      available || providers.length === 0
        ? ""
        : providers.map((provider) => provider.error).find((message) => message) || "额度接口暂不可用"
    const value: Quota = { available, error, providers }
    this.quotaCache = { at: Date.now(), value }
    return value
  }
}

export function defaultDatabasePath(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "opencode.db")
}
