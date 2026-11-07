import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type {
  CredentialRow,
  Latency,
  LatencyModelRow,
  ModelRow,
  ProjectRow,
  Quota,
  SeriesPoint,
  SessionDetail,
  SessionDetailInput,
  SessionRequest,
  SessionRow,
  SessionToolCall,
  SessionTurn,
  Snapshot,
  SnapshotInput,
  TokenTotals,
} from "../contract"

type Row = Record<string, string | number | null>

const DAY = 86_400_000
const CACHE_MS = 60_000
const QUOTA_CACHE_MS = 60_000
const DETAIL_CACHE_MS = 60_000
const DETAIL_CACHE_LIMIT = 6
const DETAIL_PAGE = 60
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

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
  if (chunks.length === 0) {
    const metadata = asRecord(state.metadata)
    for (const key of ["output", "preview", "diff", "filediff"]) {
      const value = metadata?.[key]
      if (typeof value === "string" && value.trim()) {
        chunks.push(value)
        break
      }
    }
  }
  return clip(chunks.join("\n").trim(), PREVIEW.output)
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

export class UsageStore {
  private db?: Database
  private dbError = ""
  private cache?: { key: string; at: number; value: Snapshot }
  private quotaCache?: { at: number; value: Quota }
  private sessionCache = new Map<string, { at: number; value: SessionDetail }>()

  constructor(
    readonly path: string,
    private readonly log: (message: string, detail?: unknown) => void = () => {},
  ) {}

  close(): void {
    this.db?.close()
    this.db = undefined
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

  snapshot(input: SnapshotInput): Snapshot {
    const key = `${Math.floor(input.from / 60_000)}|${Math.floor(input.to / 60_000)}|${input.projectID ?? ""}`
    if (!input.force && this.cache && this.cache.key === key && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.value
    }

    const db = this.database()
    if (!db) {
      const value = this.emptySnapshot(input)
      this.cache = { key, at: Date.now(), value }
      return value
    }

    const params: unknown[] = [input.from, input.to]
    const project = input.projectID?.trim()
    let scope = ""
    if (project) {
      scope = " AND s.project_id = ?"
      params.push(project)
    }
    const where = `m.type = 'assistant' AND m.time_created >= ? AND m.time_created < ?${scope}`
    const joined = `FROM session_message m JOIN session_v2 s ON s.id = m.session_id`
    const prompts = project
      ? `SELECT count(*) AS n ${joined} WHERE m.type = 'user' AND m.time_created >= ? AND m.time_created < ? AND s.project_id = ?`
      : `SELECT count(*) AS n ${joined} WHERE m.type = 'user' AND m.time_created >= ? AND m.time_created < ?`

    const promptRow = db
      .query<Row>(prompts)
      .get(...(project ? [input.from, input.to, project] : [input.from, input.to]))

    const totalParams = project ? [input.from, input.to, project] : [input.from, input.to]
    // One scan, one JSON extraction set. The previous version scanned the same
    // messages four times (totals, series, models, latency), which dominated the
    // cold-load cost on a multi-hundred-megabyte database.
    const messageRows = db
      .query<Row>(
        `SELECT
           m.session_id AS sessionID,
           m.time_created AS timeCreated,
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
         ${joined} WHERE ${where}`,
      )
      .all(...totalParams)

    type SeriesAgg = {
      date: string
      requests: number
      cost: number
      input: number
      output: number
      cacheRead: number
    }
    type ModelAgg = {
      providerID: string
      modelID: string
      requests: number
      cost: number
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }

    const sessionSet = new Set<string>()
    const seriesMap = new Map<string, SeriesAgg>()
    const modelMap = new Map<string, ModelAgg>()
    const latencySamples: LatencySample[] = []
    const latencyGroups = new Map<string, { providerID: string; modelID: string; rows: LatencySample[] }>()
    const tokenTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    let totalCost = 0

    for (const row of messageRows) {
      const providerID = text(row.providerID) || "unknown"
      const modelID = text(row.modelID) || "unknown"
      const cost = num(row.cost)
      const input = num(row.input)
      const output = num(row.output)
      const reasoning = num(row.reasoning)
      const cacheRead = num(row.cacheRead)
      const cacheWrite = num(row.cacheWrite)

      sessionSet.add(text(row.sessionID))
      totalCost += cost
      tokenTotals.input += input
      tokenTotals.output += output
      tokenTotals.reasoning += reasoning
      tokenTotals.cacheRead += cacheRead
      tokenTotals.cacheWrite += cacheWrite

      const date = localDate(num(row.timeCreated))
      const point = seriesMap.get(date) ?? { date, requests: 0, cost: 0, input: 0, output: 0, cacheRead: 0 }
      point.requests += 1
      point.cost += cost
      point.input += input
      point.output += output
      point.cacheRead += cacheRead
      seriesMap.set(date, point)

      const modelKey = `${providerID}\u0000${modelID}`
      const model =
        modelMap.get(modelKey) ??
        { providerID, modelID, requests: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      model.requests += 1
      model.cost += cost
      model.input += input
      model.output += output
      model.cacheRead += cacheRead
      model.cacheWrite += cacheWrite
      modelMap.set(modelKey, model)

      const elapsed = num(row.elapsed)
      if (elapsed >= 0.05) {
        const sample: LatencySample = { ttft: num(row.ttft), total: elapsed, output }
        latencySamples.push(sample)
        const group = latencyGroups.get(modelKey) ?? { providerID, modelID, rows: [] }
        group.rows.push(sample)
        latencyGroups.set(modelKey, group)
      }
    }

    const series: SeriesPoint[] = [...seriesMap.values()].sort((a, b) => a.date.localeCompare(b.date))
    const models: ModelRow[] = [...modelMap.values()].sort(
      (a, b) => b.input + b.output - (a.input + a.output),
    )
    const latency = latencyStats(latencySamples)
    const latencyModels: LatencyModelRow[] = [...latencyGroups.values()]
      .map((group) => {
        const { maxTotal: _maxTotal, ...stats } = latencyStats(group.rows)
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
         WHERE time_updated >= ? AND time_updated <= ?${project ? " AND project_id = ?" : ""}
         ORDER BY time_updated DESC LIMIT 50`,
      )
      .all(...(project ? [input.from, input.to, project] : [input.from, input.to]))

    const sessions: SessionRow[] = sessionRows.map((row) => {
      const model = row.model ? parseJSON(String(row.model)) : undefined
      return {
        id: text(row.id),
        title: text(row.title) || "未命名会话",
        projectID: text(row.project_id),
        modelID: text(model?.id) || "unknown",
        providerID: text(model?.providerID) || "unknown",
        cost: num(row.cost),
        input: num(row.tokens_input),
        output: num(row.tokens_output),
        cacheRead: num(row.tokens_cache_read),
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
        requests: messageRows.length,
        sessions: sessionSet.size,
        prompts: num(promptRow?.n),
        activeDays: days.length,
        streak: activeStreak(days, localDate(Date.now())),
        cost: totalCost,
        tokens: tokenTotals,
      },
      series: filled,
      models,
      latency,
      latencyModels,
      projects,
      sessions,
      credentials,
    }
    this.cache = { key, at: Date.now(), value }
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
    const limit = Math.min(200, Math.max(1, Math.round(input.limit ?? DETAIL_PAGE)))
    const before = input.beforeTurn && input.beforeTurn > 0 ? input.beforeTurn : full.turns.length + 1
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
        outputTruncated: output.truncated,
        error: errorText(state?.error),
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
      error: errorText(data?.error),
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
        source: "none",
        error: this.dbError || "数据库不可用",
      }
    }
    const row = db
      .query<Row>(
        "SELECT value FROM credential WHERE integration_id = 'opencode-go' ORDER BY active DESC, time_updated DESC LIMIT 1",
      )
      .get()
    const value = row?.value ? parseJSON(String(row.value)) : undefined
    const secret =
      value?.type === "oauth"
        ? text(value.access)
        : value?.type === "key"
          ? text(value.key)
          : text(value?.access) || text(value?.key)
    if (!secret) {
      const value: Quota = {
        available: false,
        source: "none",
        error: "未找到 OpenCode Go 凭据",
      }
      this.quotaCache = { at: Date.now(), value }
      return value
    }

    try {
      const response = await fetch(GO_USAGE_URL, {
        headers: {
          authorization: `Bearer ${secret}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) {
        const value: Quota = {
          available: false,
          source: "zen/go",
          error: `OpenCode Go 额度暂不可用（HTTP ${response.status}）`,
        }
        this.quotaCache = { at: Date.now(), value }
        return value
      }
      const body = (await response.json()) as {
        usage?: Record<string, { status?: string; percent?: number; resetsAt?: string }>
      }
      const parse = (key: string) => {
        const entry = body.usage?.[key]
        if (!entry) return undefined
        const resetsAt = entry.resetsAt ? Date.parse(entry.resetsAt) : 0
        return {
          percent: num(entry.percent),
          limited: entry.status !== "ok" || num(entry.percent) >= 100,
          resetsAt: Number.isFinite(resetsAt) ? resetsAt : 0,
        }
      }
      const rolling = parse("rolling")
      const weekly = parse("weekly")
      const monthly = parse("monthly")
      const value: Quota = {
        available: true,
        source: "zen/go",
        error: "",
        ...(rolling ? { rolling } : {}),
        ...(weekly ? { weekly } : {}),
        ...(monthly ? { monthly } : {}),
      }
      this.quotaCache = { at: Date.now(), value }
      return value
    } catch (error) {
      this.log("OpenCode Go quota request failed", error instanceof Error ? error.message : String(error))
      const value: Quota = {
        available: false,
        source: "zen/go",
        error: "无法连接 OpenCode Go 额度接口",
      }
      this.quotaCache = { at: Date.now(), value }
      return value
    }
  }
}

export function defaultDatabasePath(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "opencode.db")
}
