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
  SessionRow,
  Snapshot,
  SnapshotInput,
  TokenTotals,
} from "../contract"

type Row = Record<string, string | number | null>

const DAY = 86_400_000
const CACHE_MS = 15_000
const QUOTA_CACHE_MS = 60_000
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

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

export class UsageStore {
  private db?: Database
  private dbError = ""
  private cache?: { key: string; at: number; value: Snapshot }
  private quotaCache?: { at: number; value: Quota }

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

    const totalsRow = db
      .query<Row>(
        `SELECT
           count(*) AS requests,
           count(DISTINCT m.session_id) AS sessions,
           coalesce(sum(json_extract(m.data, '$.cost')), 0) AS cost,
           coalesce(sum(json_extract(m.data, '$.tokens.input')), 0) AS input,
           coalesce(sum(json_extract(m.data, '$.tokens.output')), 0) AS output,
           coalesce(sum(json_extract(m.data, '$.tokens.reasoning')), 0) AS reasoning,
           coalesce(sum(json_extract(m.data, '$.tokens.cache.read')), 0) AS cacheRead,
           coalesce(sum(json_extract(m.data, '$.tokens.cache.write')), 0) AS cacheWrite
         ${joined} WHERE ${where}`,
      )
      .get(...params)

    const promptRow = db
      .query<Row>(prompts)
      .get(...(project ? [input.from, input.to, project] : [input.from, input.to]))

    const totalParams = project ? [input.from, input.to, project] : [input.from, input.to]
    const seriesRows = db
      .query<Row>(
        `SELECT
           date(m.time_created / 1000, 'unixepoch', 'localtime') AS date,
           count(*) AS requests,
           coalesce(sum(json_extract(m.data, '$.cost')), 0) AS cost,
           coalesce(sum(json_extract(m.data, '$.tokens.input')), 0) AS input,
           coalesce(sum(json_extract(m.data, '$.tokens.output')), 0) AS output,
           coalesce(sum(json_extract(m.data, '$.tokens.cache.read')), 0) AS cacheRead
         ${joined} WHERE ${where}
         GROUP BY date ORDER BY date`,
      )
      .all(...totalParams)

    const series: SeriesPoint[] = seriesRows.map((row) => ({
      date: text(row.date),
      requests: num(row.requests),
      cost: num(row.cost),
      input: num(row.input),
      output: num(row.output),
      cacheRead: num(row.cacheRead),
    }))

    const modelRows = db
      .query<Row>(
        `SELECT
           coalesce(json_extract(m.data, '$.model.providerID'), 'unknown') AS providerID,
           coalesce(json_extract(m.data, '$.model.id'), 'unknown') AS modelID,
           count(*) AS requests,
           coalesce(sum(json_extract(m.data, '$.cost')), 0) AS cost,
           coalesce(sum(json_extract(m.data, '$.tokens.input')), 0) AS input,
           coalesce(sum(json_extract(m.data, '$.tokens.output')), 0) AS output,
           coalesce(sum(json_extract(m.data, '$.tokens.cache.read')), 0) AS cacheRead,
           coalesce(sum(json_extract(m.data, '$.tokens.cache.write')), 0) AS cacheWrite
         ${joined} WHERE ${where}
         GROUP BY providerID, modelID
         ORDER BY (sum(json_extract(m.data, '$.tokens.input')) + sum(json_extract(m.data, '$.tokens.output'))) DESC`,
      )
      .all(...totalParams)

    const models: ModelRow[] = modelRows.map((row) => ({
      providerID: text(row.providerID) || "unknown",
      modelID: text(row.modelID) || "unknown",
      requests: num(row.requests),
      cost: num(row.cost),
      input: num(row.input),
      output: num(row.output),
      cacheRead: num(row.cacheRead),
      cacheWrite: num(row.cacheWrite),
    }))

    const latencyRows = db
      .query<Row>(
        `SELECT
           coalesce(json_extract(m.data, '$.model.providerID'), 'unknown') AS providerID,
           coalesce(json_extract(m.data, '$.model.id'), 'unknown') AS modelID,
           (json_extract(m.data, '$.time.streamed') - json_extract(m.data, '$.time.created')) / 1000.0 AS ttft,
           (json_extract(m.data, '$.time.completed') - json_extract(m.data, '$.time.created')) / 1000.0 AS total,
           coalesce(json_extract(m.data, '$.tokens.output'), 0) AS output
         ${joined} WHERE ${where}
           AND json_extract(m.data, '$.time.completed') IS NOT NULL`,
      )
      .all(...totalParams)

    const latencySamples: LatencySample[] = latencyRows.map((row) => ({
      ttft: num(row.ttft),
      total: num(row.total),
      output: num(row.output),
    }))
    const latency = latencyStats(latencySamples)
    const latencyGroups = new Map<string, { providerID: string; modelID: string; rows: LatencySample[] }>()
    for (const [index, row] of latencyRows.entries()) {
      const providerID = text(row.providerID) || "unknown"
      const modelID = text(row.modelID) || "unknown"
      const key = `${providerID}\u0000${modelID}`
      const group = latencyGroups.get(key) ?? { providerID, modelID, rows: [] }
      group.rows.push(latencySamples[index]!)
      latencyGroups.set(key, group)
    }
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
        requests: num(totalsRow?.requests),
        sessions: num(totalsRow?.sessions),
        prompts: num(promptRow?.n),
        activeDays: days.length,
        streak: activeStreak(days, localDate(Date.now())),
        cost: num(totalsRow?.cost),
        tokens: {
          input: num(totalsRow?.input),
          output: num(totalsRow?.output),
          reasoning: num(totalsRow?.reasoning),
          cacheRead: num(totalsRow?.cacheRead),
          cacheWrite: num(totalsRow?.cacheWrite),
        },
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
