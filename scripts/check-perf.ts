/**
 * TASK-17.1 长会话性能基线：10,000 回合 fixture 的确定性重复测量。
 *
 * 只读工具：不修改任何生产代码。fixture 与 scripts/check-synthetic.ts 的 15g
 * 用例逐字一致（同一 schema / 索引 / 大体积正文 / 10,000 回合），父进程构造
 * 一次，3 个独立子进程复用同一个 DB 文件，保证「同机器、同环境、同 fixture」。
 * 每个子进程全新启动 = 天然冷缓存。
 *
 * 分层测量（不挂载 SolidJS，渲染层不在此脚本范围内）：
 * - 服务端：UsageStore.sessionDetail() 真实调用，SQL 层用 bun:sqlite 的
 *   Database.prototype.query 包裹计时（运行时注入，不改 store.ts），按语句
 *   标签归因；冷/热首屏之差近似 buildSessionSummary 成本。
 * - RPC：src/index.ts 的 wire() 是 `JSON.parse(JSON.stringify(value))`，这里
 *   用完全相同的表达式单独计时，并统计序列化字节数。
 * - 前端合并：生产导出的 applyLoadMoreResult / mergeTurns / filterTurnsByQuery /
 *   buildCsvText / buildJsonPayload，逐页与全量各测一次。
 * - 搜索 / 展开 / 折叠：只能测信号层纯计算（WeakMap 索引与 Set 构造），
 *   不是 DOM 渲染耗时，报告中必须如实标注。
 * - JSON 解析量：复用生产 globalThis 探针 __ucReadProbe / __ucPageReads /
 *   __ucSummaryProbe（生产环境无消费者，零开销）。
 * - 内存：process.memoryUsage().rss + process.resourceUsage().maxRSS 高水位，
 *   macOS 为 bytes，Linux 为 KB，统一换算成 bytes。
 *
 * 用法：
 *   bun scripts/check-perf.ts                 # 构造 fixture，跑 3 次，聚合输出
 *   bun scripts/check-perf.ts 5               # 指定重复次数
 *   bun scripts/check-perf.ts worker <db> <out.json>   # 内部：单次测量
 */
import { UsageStore, SESSION_PAGE_SQLS } from "../src/server/store"
import {
  applyLoadMoreResult,
  filterTurnsByQuery,
  buildCsvText,
  buildJsonPayload,
} from "../src/gui/session-detail"

const TURNS = 10_000
const PAGE_LIMIT = 60
const SESSION_ID = "hg1"

// ---------------------------------------------------------------- 探针基础设施

type SqlStat = { count: number; ms: number; maxMs: number }
type SqlStats = Record<string, SqlStat>

/** 把生产 SQL 归入可读标签，用于「重复扫描 / 无效查询」归因。 */
function sqlLabel(sql: string): string {
  const s = sql.replace(/\s+/g, " ").trim()
  if (s.includes("PRAGMA")) return "pragma"
  if (s.includes("json_each(")) return "summary.toolStats"
  if (s.includes("$.tokens.input")) return "summary.scalars"
  if (s.includes("$.model.providerID")) return "summary.firstModel"
  if (s.includes("LEFT JOIN project")) return "summary.sessionRow"
  if (s.includes("SELECT id, type, seq, time_created, data")) return "page.pageMessages"
  if (s.includes("type = 'user' AND seq < ?") && s.includes("ORDER BY seq DESC")) return "page.userBoundaries"
  if (s.includes("COUNT(*) AS n") && s.includes("seq < ?")) return "page.turnCountBefore"
  if (s.includes("MAX(seq)")) return "page.lastSeq"
  if (s.includes("LIMIT 1 OFFSET ?")) return "page.turnStartOffset"
  if (s.includes("SELECT type, seq FROM session_message")) return "page.headRow"
  if (s.includes("SELECT type FROM session_message")) return "page.firstMessage"
  if (s.includes("COUNT(*) AS n") && s.includes("type = 'assistant'")) return "summary.requestCount"
  if (s.includes("COUNT(*) AS n") && s.includes("type = 'user'")) return "summary.userCount"
  if (s.includes("ORDER BY seq DESC LIMIT 1")) return "meta.lastMessageTime"
  if (s.includes("ORDER BY seq LIMIT 1")) return "meta.firstMessageTime"
  if (s.includes("sqlite_master") || s.includes("PRAGMA table_info")) return "meta.schemaProbe"
  return "other"
}

/** 运行时包裹 bun:sqlite 语句执行，不改生产源码。 */
function installSqlProbe(): { stats: SqlStats; reset: () => void; snapshot: () => SqlStats } {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const proto = (Database as unknown as { prototype: Record<string, unknown> }).prototype
  const originalQuery = proto.query as (this: unknown, sql: string) => Record<string, unknown>
  // Bun 按 SQL 文本复用 Statement：同一对象若被重复包裹，会形成嵌套计时链，
  // 计数/耗时变成三角数（167 页会得到 14028 次而非 167 次）。每个对象只包一次。
  const wrappedStatements = new WeakSet<object>()
  let stats: SqlStats = {}
  proto.query = function (this: unknown, sql: string) {
    const stmt = originalQuery.call(this, sql)
    if (wrappedStatements.has(stmt)) return stmt
    wrappedStatements.add(stmt)
    const label = sqlLabel(sql)
    for (const method of ["all", "get", "run"] as const) {
      const original = stmt[method]
      if (typeof original !== "function") continue
      try {
        stmt[method] = function (this: unknown, ...args: unknown[]) {
          const t0 = performance.now()
          try {
            return (original as (...a: unknown[]) => unknown).apply(this, args)
          } finally {
            const dt = performance.now() - t0
            const slot = stats[label] ?? (stats[label] = { count: 0, ms: 0, maxMs: 0 })
            slot.count += 1
            slot.ms += dt
            if (dt > slot.maxMs) slot.maxMs = dt
          }
        }
      } catch {
        // 某些内置语句的方法不可写时跳过该方法的计时，不影响执行。
      }
    }
    return stmt
  }
  return {
    get stats() {
      return stats
    },
    reset: () => {
      stats = {}
    },
    snapshot: () => JSON.parse(JSON.stringify(stats)) as SqlStats,
  }
}

/** 两批 SQL 统计之差，用于按阶段归因。 */
function sqlDelta(after: SqlStats, before: SqlStats): SqlStats {
  const out: SqlStats = {}
  for (const [label, value] of Object.entries(after)) {
    const prev = before[label] ?? { count: 0, ms: 0, maxMs: 0 }
    const count = value.count - prev.count
    if (count <= 0) continue
    out[label] = { count, ms: value.ms - prev.ms, maxMs: value.maxMs }
  }
  return out
}

function sqlTotal(stats: SqlStats): number {
  return Object.values(stats).reduce((sum, s) => sum + s.ms, 0)
}

type ReadProbe = { parses: number; parseBytes: number }
type PageProbe = { messages: number; assistant: number; bodyBytes: number }
type SummaryProbe = { scannedRows: number; bodyBytes: number }

function setProductionProbes() {
  const g = globalThis as {
    __ucReadProbe?: ReadProbe
    __ucPageReads?: PageProbe
    __ucSummaryProbe?: SummaryProbe
  }
  g.__ucReadProbe = { parses: 0, parseBytes: 0 }
  g.__ucPageReads = { messages: 0, assistant: 0, bodyBytes: 0 }
  g.__ucSummaryProbe = { scannedRows: 0, bodyBytes: 0 }
  return g
}

function resetProductionProbes(g: ReturnType<typeof setProductionProbes>) {
  if (g.__ucReadProbe) {
    g.__ucReadProbe.parses = 0
    g.__ucReadProbe.parseBytes = 0
  }
  if (g.__ucPageReads) {
    g.__ucPageReads.messages = 0
    g.__ucPageReads.assistant = 0
    g.__ucPageReads.bodyBytes = 0
  }
  if (g.__ucSummaryProbe) {
    g.__ucSummaryProbe.scannedRows = 0
    g.__ucSummaryProbe.bodyBytes = 0
  }
}

function probeValues(g: ReturnType<typeof setProductionProbes>) {
  return {
    reads: { ...g.__ucPageReads! },
    parse: { ...g.__ucReadProbe! },
    summary: { ...g.__ucSummaryProbe! },
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0] ?? 0,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: values.reduce((a, b) => a + b, 0) / (values.length || 1),
    total: values.reduce((a, b) => a + b, 0),
  }
}

function rssBytes(): number {
  return process.memoryUsage().rss
}

function maxRssBytes(): number {
  const raw = process.resourceUsage?.().maxRSS ?? 0
  return process.platform === "darwin" ? raw : raw * 1024
}

// ---------------------------------------------------------------- fixture 构造

/** 与 check-synthetic.ts 15g 完全一致（含 3 个索引与 3000 字大正文）。 */
function buildFixture(file: string): { payloadBytes: number; dbBytes: number } {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const { statSync } = require("node:fs") as typeof import("node:fs")
  const db = new Database(file)
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
    CREATE INDEX session_message_time_created_idx ON session_message (time_created);
    CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
    CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
  `)
  db.exec(`INSERT INTO project VALUES ('ph', NULL, '/tmp/huge', 1)`)
  db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('hg1', 'ph', '万回合', 1, 1)").run()
  const insert = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, 'hg1', ?, ?, ?, ?, ?)")
  const bigText = "长".repeat(3_000)
  const hugePayload = JSON.stringify({
    cost: 0.001,
    model: { providerID: "prov-x", id: "model-a" },
    agent: "build",
    tokens: { input: 30, output: 15, cache: { read: 10, write: 2 } },
    time: { created: 1, streamed: 100, completed: 900 },
    content: [
      { type: "text", text: bigText },
      { type: "reasoning", text: bigText },
      { type: "tool", id: "t", name: "bash", state: { status: "completed", input: { command: `echo ${bigText.slice(0, 500)}` }, metadata: { output: bigText.slice(0, 800) } } },
    ],
  })
  db.transaction(() => {
    for (let i = 0; i < TURNS; i++) {
      insert.run(`h${i}u`, "user", i * 2 + 1, i, i, JSON.stringify({ text: `回合 ${i}` }))
      insert.run(`h${i}a`, "assistant", i * 2 + 2, i, i, hugePayload)
    }
  })()
  db.close()
  return { payloadBytes: Buffer.byteLength(hugePayload, "utf8"), dbBytes: statSync(file).size }
}

/** 在真实 10,000 回合库上取查询计划（不是空库），验证游标查询稳定命中索引。 */
function queryPlans(fixturePath: string): Record<string, string> {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const db = new Database(fixturePath, { readonly: true })
  const bind = (sql: string, ...values: string[]) => {
    let i = 0
    return sql.replace(/\?/g, () => values[i++] ?? "0")
  }
  const named: Record<string, string> = {
    "userBoundaries": bind(SESSION_PAGE_SQLS.userBoundaries, "'hg1'", "20000", "61"),
    "firstMessage": bind(SESSION_PAGE_SQLS.firstMessage, "'hg1'"),
    "pageMessages": bind(SESSION_PAGE_SQLS.pageMessages, "'hg1'", "1", "20000"),
    "turnCountBefore": bind(SESSION_PAGE_SQLS.turnCountBefore, "'hg1'", "20000"),
    "summaryScalars": bind(SESSION_PAGE_SQLS.summaryScalars, "'hg1'"),
    "toolStats": bind(SESSION_PAGE_SQLS.toolStats, "'hg1'"),
    "lastSeq": bind(SESSION_PAGE_SQLS.lastSeq, "'hg1'"),
  }
  const out: Record<string, string> = {}
  for (const [name, sql] of Object.entries(named)) {
    try {
      const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
      out[name] = rows.map((r) => r.detail).join(" | ")
    } catch (cause) {
      out[name] = `ERROR ${String(cause)}`
    }
  }
  db.close()
  return out
}

// ---------------------------------------------------------------- 单次测量

type ChainResult = {
  mode: "force-every-page" | "summary-cache"
  pages: number
  loadedTurns: number
  server: ReturnType<typeof distribution>
  rpc: ReturnType<typeof distribution>
  frontendMerge: ReturnType<typeof distribution>
  wallMs: number
  pageServerMs: number[]
  sql: SqlStats
  parse: ReadProbe
  reads: PageProbe
  summaryScans: number
  maxPageReads: number
  sigmaCost: number
  firstTurnIndex: number
  lastTurnIndex: number
  duplicates: number
  missing: number
  wireBytes: number
}

type RunResult = {
  run: number
  fixture: { turns: number; payloadBytes: number; dbBytes: number }
  firstScreen: {
    coldMs: number
    hotMs: number
    summaryApproxMs: number
    coldSqlMs: number
    hotSqlMs: number
    coldJsMs: number
    hotJsMs: number
    coldSql: SqlStats
    hotSql: SqlStats
    reads: PageProbe
    parse: ReadProbe
    summary: SummaryProbe
    rpcMs: number
    rpcBytes: number
    turns: number
  }
  chains: ChainResult[]
  frontend: {
    loadedTurns: number
    searchColdMs: number
    searchHotMs: number
    searchMatches: number
    expandAllMs: number
    collapseAllMs: number
    csvMs: number
    csvBytes: number
    jsonPayloadMs: number
    jsonPayloadBytes: number
  }
  memory: {
    startRss: number
    startHigh: number
    afterForceChainRss: number
    afterCachedChainRss: number
    afterSearchRss: number
    afterCsvRss: number
    afterFrontendRss: number
    peakHigh: number
    growthBytes: number
  }
  queryPlans: Record<string, string>
  checks: Record<string, boolean>
  failures: string[]
}

/** wire() 与 src/index.ts:10-12 完全同形；单独计时以区分 RPC 序列化成本。 */
function rpcWire<T>(value: T): { value: T; ms: number; bytes: number } {
  const t0 = performance.now()
  const text = JSON.stringify(value)
  const parsed = JSON.parse(text) as T
  return { value: parsed, ms: performance.now() - t0, bytes: Buffer.byteLength(text, "utf8") }
}

function runChain(
  mode: ChainResult["mode"],
  fixturePath: string,
  probes: ReturnType<typeof setProductionProbes>,
  sql: ReturnType<typeof installSqlProbe>,
): { chain: ChainResult; detail: ReturnType<typeof applyLoadMoreResult> } {
  const store = new UsageStore(fixturePath, () => {})
  resetProductionProbes(probes)
  sql.reset()
  const beforeSql = sql.snapshot()
  const beforeProbe = probeValues(probes)

  // 与 15g 全链同构：游标从 undefined 起，每页用合并后的 nextBefore 前进；
  // 首屏直接作为 detail，后续页走生产 applyLoadMoreResult（含 mergeTurns 排序去重）。
  let current: ReturnType<typeof applyLoadMoreResult> | undefined
  let cursor: number | undefined
  const serverMs: number[] = []
  const rpcMs: number[] = []
  const mergeMs: number[] = []
  let wireBytes = 0
  let maxPageReads = 0
  let loadedTurns = 0
  let sigmaCost = 0
  let pages = 0
  const tStart = performance.now()
  for (;;) {
    const pageProbeBefore = probeValues(probes)
    const t0 = performance.now()
    const page = store.sessionDetail({
      sessionID: SESSION_ID,
      beforeTurn: cursor,
      limit: PAGE_LIMIT,
      ...(mode === "force-every-page" ? { force: true } : {}),
    })
    serverMs.push(performance.now() - t0)
    const pageProbeAfter = probeValues(probes)
    maxPageReads = Math.max(maxPageReads, pageProbeAfter.reads.messages - pageProbeBefore.reads.messages)
    const wire = rpcWire(page)
    rpcMs.push(wire.ms)
    wireBytes += wire.bytes
    const t1 = performance.now()
    // 首屏不合并；后续页走生产归并路径。
    current = current ? applyLoadMoreResult(current, page) : page
    mergeMs.push(performance.now() - t1)
    for (const turn of page.turns) sigmaCost += turn.cost
    loadedTurns += page.turns.length
    pages += 1
    if (!current.hasMore) break
    cursor = current.nextBefore
  }
  const wallMs = performance.now() - tStart

  const chainSql = sqlDelta(sql.snapshot(), beforeSql)
  const afterProbe = probeValues(probes)
  const allTurns = current.turns
  const indices = new Set(allTurns.map((turn) => turn.index))
  const firstTurnIndex = allTurns[0]?.index ?? -1
  const lastTurnIndex = allTurns[allTurns.length - 1]?.index ?? -1
  store.close()
  return {
    chain: {
      mode,
      pages,
      loadedTurns,
      server: distribution(serverMs),
      rpc: distribution(rpcMs),
      frontendMerge: distribution(mergeMs),
      wallMs,
      pageServerMs: serverMs,
      sql: chainSql,
      // 全链累计：整条链只 reset 一次，用首尾探针快照相减。
      parse: {
        parses: afterProbe.parse.parses - beforeProbe.parse.parses,
        parseBytes: afterProbe.parse.parseBytes - beforeProbe.parse.parseBytes,
      },
      reads: {
        messages: afterProbe.reads.messages - beforeProbe.reads.messages,
        assistant: afterProbe.reads.assistant - beforeProbe.reads.assistant,
        bodyBytes: afterProbe.reads.bodyBytes - beforeProbe.reads.bodyBytes,
      },
      summaryScans: chainSql["summary.scalars"]?.count ?? 0,
      maxPageReads,
      sigmaCost,
      firstTurnIndex,
      lastTurnIndex,
      duplicates: allTurns.length - indices.size,
      missing: TURNS - indices.size,
      wireBytes,
    },
    detail: current,
  }
}

function measureOnce(fixturePath: string, run: number, fixture: { payloadBytes: number; dbBytes: number }): RunResult {
  const failures: string[] = []
  const sql = installSqlProbe()
  const probes = setProductionProbes()
  const startRss = rssBytes()
  const startHigh = maxRssBytes()

  // ---- 首屏：冷（force=true，必走 buildSessionSummary）与热（缓存命中）
  const store = new UsageStore(fixturePath, () => {})
  resetProductionProbes(probes)
  sql.reset()
  const coldBeforeSql = sql.snapshot()
  const tCold = performance.now()
  const cold = store.sessionDetail({ sessionID: SESSION_ID, limit: PAGE_LIMIT, force: true })
  const coldMs = performance.now() - tCold
  const coldSql = sqlDelta(sql.snapshot(), coldBeforeSql)
  const coldProbe = probeValues(probes)

  resetProductionProbes(probes)
  sql.reset()
  const hotBeforeSql = sql.snapshot()
  const tHot = performance.now()
  store.sessionDetail({ sessionID: SESSION_ID, limit: PAGE_LIMIT })
  const hotMs = performance.now() - tHot
  const hotSql = sqlDelta(sql.snapshot(), hotBeforeSql)
  const wireFirst = rpcWire(cold)
  store.close()

  // ---- 两条完整链：force 每页（复现 15g / CI 数字）与真实前端语义（loadMore 不传 force）
  // 只保留 force 链的统计，不保留它的 10,000 回合 detail——否则两条链的全量
  // 对象同时驻留，会把「单视图内存」高估一倍。
  const forceChain = runChain("force-every-page", fixturePath, probes, sql).chain
  const afterForceRss = rssBytes()
  const cachedRun = runChain("summary-cache", fixturePath, probes, sql)
  const afterCachedRss = rssBytes()

  // ---- 全量加载后的前端纯计算（10,000 回合）
  const detail = cachedRun.detail
  const allTurns = detail.turns
  const tSearchCold = performance.now()
  const matches = filterTurnsByQuery(allTurns, "回合 99")
  const searchColdMs = performance.now() - tSearchCold
  const tSearchHot = performance.now()
  filterTurnsByQuery(allTurns, "回合 99")
  const searchHotMs = performance.now() - tSearchHot
  const afterSearchRss = rssBytes()
  const tExpand = performance.now()
  const expanded = new Set(allTurns.map((turn) => turn.index))
  const expandAllMs = performance.now() - tExpand
  const tCollapse = performance.now()
  const collapsed = new Set<number>()
  const collapseAllMs = performance.now() - tCollapse
  const tCsv = performance.now()
  const csv = buildCsvText(allTurns)
  const csvMs = performance.now() - tCsv
  const afterCsvRss = rssBytes()
  const tJson = performance.now()
  const payload = buildJsonPayload(detail, allTurns, true)
  const jsonPayloadMs = performance.now() - tJson
  const jsonPayloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8")
  const afterFrontendRss = rssBytes()

  const plans = queryPlans(fixturePath)
  const checks: Record<string, boolean> = {
    "游标查询全部命中索引":
      ["userBoundaries", "firstMessage", "pageMessages", "turnCountBefore", "summaryScalars", "lastSeq"].every(
        (name) => /USING (COVERING )?INDEX|SEARCH/.test(plans[name] ?? "") && !/SCAN session_message/.test(plans[name] ?? ""),
      ),
    "首屏 60 回合": cold.turns.length === PAGE_LIMIT,
    "首屏只读 120 行": coldProbe.reads.messages === 120,
    "首屏解析 120 次": coldProbe.parse.parses === 120,
    "首屏汇总正文 0 字节": coldProbe.summary.bodyBytes === 0,
    "首屏汇总扫描 40000 行": coldProbe.summary.scannedRows === 40_000,
    "冷首屏包含全会话汇总 SQL": (coldSql["summary.scalars"]?.count ?? 0) === 1,
    "热首屏命中汇总缓存": (hotSql["summary.scalars"]?.count ?? 0) === 0,
    "force 链每页重复汇总": forceChain.summaryScans === forceChain.pages,
    "cache 链汇总只算 1 次（首屏冷）": cachedRun.chain.summaryScans === 1,
    "两条链均为 167 页": forceChain.pages === 167 && cachedRun.chain.pages === 167,
    "两条链无缺失无重复":
      forceChain.missing === 0 &&
      forceChain.duplicates === 0 &&
      cachedRun.chain.missing === 0 &&
      cachedRun.chain.duplicates === 0,
    "两条链 Σ 页 cost = 全会话":
      Math.abs(forceChain.sigmaCost - TURNS * 0.001) < 1e-6 &&
      Math.abs(cachedRun.chain.sigmaCost - TURNS * 0.001) < 1e-6,
    "单页最大读取 ≤ 130 行":
      forceChain.maxPageReads <= 130 && cachedRun.chain.maxPageReads <= 130,
    "全量 10000 回合": allTurns.length === TURNS,
    "展开集合大小正确": expanded.size === TURNS && collapsed.size === 0 && matches.length > 0,
  }
  for (const [name, ok] of Object.entries(checks)) if (!ok) failures.push(`${name} = false`)

  return {
    run,
    fixture: { turns: TURNS, payloadBytes: fixture.payloadBytes, dbBytes: fixture.dbBytes },
    firstScreen: {
      coldMs,
      hotMs,
      summaryApproxMs: Math.max(0, coldMs - hotMs),
      coldSqlMs: sqlTotal(coldSql),
      hotSqlMs: sqlTotal(hotSql),
      coldJsMs: Math.max(0, coldMs - sqlTotal(coldSql)),
      hotJsMs: Math.max(0, hotMs - sqlTotal(hotSql)),
      coldSql,
      hotSql,
      reads: coldProbe.reads,
      parse: coldProbe.parse,
      summary: coldProbe.summary,
      rpcMs: wireFirst.ms,
      rpcBytes: wireFirst.bytes,
      turns: cold.turns.length,
    },
    chains: [forceChain, cachedRun.chain],
    frontend: {
      loadedTurns: allTurns.length,
      searchColdMs,
      searchHotMs,
      searchMatches: matches.length,
      expandAllMs,
      collapseAllMs,
      csvMs,
      csvBytes: Buffer.byteLength(csv, "utf8"),
      jsonPayloadMs,
      jsonPayloadBytes,
    },
    memory: {
      startRss,
      startHigh,
      afterForceChainRss: afterForceRss,
      afterCachedChainRss: afterCachedRss,
      afterSearchRss,
      afterCsvRss,
      afterFrontendRss,
      peakHigh: maxRssBytes(),
      growthBytes: afterFrontendRss - startRss,
    },
    queryPlans: plans,
    checks,
    failures,
  }
}

// ---------------------------------------------------------------- 入口

function worker(argv: string[]): void {
  const [fixturePath, outPath, runArg, payloadArg, dbArg] = argv
  const { writeFileSync } = require("node:fs") as typeof import("node:fs")
  const result = measureOnce(fixturePath, Number(runArg), {
    payloadBytes: Number(payloadArg),
    dbBytes: Number(dbArg),
  })
  writeFileSync(outPath, JSON.stringify(result))
  console.log(
    `run ${result.run}: 冷首屏 ${result.firstScreen.coldMs.toFixed(0)}ms / 热首屏 ${result.firstScreen.hotMs.toFixed(0)}ms / ` +
      `force 链 ${(result.chains[0]!.wallMs / 1000).toFixed(1)}s / cache 链 ${(result.chains[1]!.wallMs / 1000).toFixed(1)}s / ` +
      `峰值 ${(result.memory.peakHigh / 1048576).toFixed(0)}MB / failures ${result.failures.length}`,
  )
  console.log(
    `  diag: force 链 ${result.chains[0]!.pages} 页 / summaryScalars ${result.chains[0]!.summaryScans} 次 / ` +
      `cache 链 ${result.chains[1]!.pages} 页 / summaryScalars ${result.chains[1]!.summaryScans} 次 / ` +
      `SQL 标签 ${Object.entries(result.chains[0]!.sql).map(([k, v]) => `${k}:${v.count}`).join(" ")}`,
  )
  for (const f of result.failures) console.error(`  - ${f}`)
  // 失败也把完整数据交给父进程聚合；由父进程最终决定是否以非零码退出。
}

function aggregate(runs: RunResult[]): Record<string, unknown> {
  const pick = (fn: (r: RunResult) => number) => distribution(runs.map(fn))
  const chain = (index: number, fn: (c: ChainResult) => number) => distribution(runs.map((r) => fn(r.chains[index]!)))
  const stat = (name: string, fn: (r: RunResult) => number) => ({ name, ...pick(fn) })
  const chainStat = (index: number, name: string, fn: (c: ChainResult) => number) => ({ name, ...chain(index, fn) })
  const mergedSql = (getter: (r: RunResult) => SqlStats): SqlStats => {
    const out: SqlStats = {}
    for (const r of runs) {
      for (const [label, s] of Object.entries(getter(r))) {
        const slot = out[label] ?? (out[label] = { count: 0, ms: 0, maxMs: 0 })
        slot.count += s.count
        slot.ms += s.ms
        slot.maxMs = Math.max(slot.maxMs, s.maxMs)
      }
    }
    return out
  }
  return {
    repeat: runs.length,
    firstScreen: {
      coldMs: stat("冷首屏服务端总耗时", (r) => r.firstScreen.coldMs),
      hotMs: stat("热首屏服务端总耗时", (r) => r.firstScreen.hotMs),
      summaryApproxMs: stat("buildSessionSummary 近似成本（冷−热）", (r) => r.firstScreen.summaryApproxMs),
      coldSqlMs: stat("冷首屏 SQL 耗时", (r) => r.firstScreen.coldSqlMs),
      hotSqlMs: stat("热首屏 SQL 耗时", (r) => r.firstScreen.hotSqlMs),
      coldJsMs: stat("冷首屏 JS 耗时（总−SQL）", (r) => r.firstScreen.coldJsMs),
      hotJsMs: stat("热首屏回合对象构建耗时（总−SQL）", (r) => r.firstScreen.hotJsMs),
      rpcMs: stat("首屏 RPC wire 耗时", (r) => r.firstScreen.rpcMs),
      rpcBytes: stat("首屏 RPC 序列化字节", (r) => r.firstScreen.rpcBytes),
      sqlByLabel: mergedSql((r) => r.firstScreen.coldSql),
      hotSqlByLabel: mergedSql((r) => r.firstScreen.hotSql),
    },
    chains: [0, 1].map((i) => ({
      mode: runs[0]!.chains[i]!.mode,
      wallS: chainStat(i, "全链墙钟秒", (c) => c.wallMs / 1000),
      serverPerPageMs: chainStat(i, "单页服务端耗时", (c) => c.server.median),
      serverPerPageP95Ms: chainStat(i, "单页服务端 P95（链内）", (c) => c.server.p95),
      serverPerPageMaxMs: chainStat(i, "单页服务端最大值（链内）", (c) => c.server.max),
      serverTotalMs: chainStat(i, "全链服务端累计", (c) => c.server.total),
      rpcTotalMs: chainStat(i, "全链 RPC 累计", (c) => c.rpc.total),
      mergeTotalMs: chainStat(i, "全链前端合并累计", (c) => c.frontendMerge.total),
      mergePerPageMaxMs: chainStat(i, "单页前端合并最大值（链内）", (c) => c.frontendMerge.max),
      mergePerPageMedianMs: chainStat(i, "单页前端合并中位数（链内）", (c) => c.frontendMerge.median),
      wireBytes: chainStat(i, "全链 RPC 序列化字节", (c) => c.wireBytes),
      summaryScans: chainStat(i, "全链 summaryScalars 执行次数", (c) => c.summaryScans),
      pages: chainStat(i, "页数", (c) => c.pages),
      loadedTurns: chainStat(i, "加载回合数", (c) => c.loadedTurns),
      sqlByLabel: mergedSql((r) => r.chains[i]!.sql),
      // 每次运行的链内逐页分布（保留失败时序与页面顺序，可复查单调性）
      perPageServerMs: runs.map((r) => r.chains[i]!.pageServerMs),
    })),
    frontend: {
      searchColdMs: stat("搜索首次（建索引）", (r) => r.frontend.searchColdMs),
      searchHotMs: stat("搜索二次（命中索引）", (r) => r.frontend.searchHotMs),
      expandAllMs: stat("全部展开（Set 构造）", (r) => r.frontend.expandAllMs),
      collapseAllMs: stat("全部折叠（Set 构造）", (r) => r.frontend.collapseAllMs),
      csvMs: stat("CSV 导出", (r) => r.frontend.csvMs),
      jsonPayloadMs: stat("JSON 导出", (r) => r.frontend.jsonPayloadMs),
      csvBytes: stat("CSV 字节", (r) => r.frontend.csvBytes),
      jsonPayloadBytes: stat("JSON 导出字节", (r) => r.frontend.jsonPayloadBytes),
      searchMatches: stat("搜索命中回合数", (r) => r.frontend.searchMatches),
    },
    memory: {
      startRss: stat("启动 RSS", (r) => r.memory.startRss),
      peakHigh: stat("峰值高水位 RSS", (r) => r.memory.peakHigh),
      afterForceChainRss: stat("force 链后 RSS", (r) => r.memory.afterForceChainRss),
      afterCachedChainRss: stat("cache 链后 RSS", (r) => r.memory.afterCachedChainRss),
      afterSearchRss: stat("全量搜索后 RSS", (r) => r.memory.afterSearchRss),
      afterCsvRss: stat("CSV 导出后 RSS", (r) => r.memory.afterCsvRss),
      afterFrontendRss: stat("全量前端计算后 RSS", (r) => r.memory.afterFrontendRss),
      growthBytes: stat("内存增长（终−启）", (r) => r.memory.growthBytes),
    },
    queryPlans: runs[0]!.queryPlans,
    checks: runs[0]!.checks,
    failures: runs.flatMap((r) => r.failures.map((f) => `run ${r.run}: ${f}`)),
    raw: runs,
  }
}

function main(): void {
  const { mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs")
  const repeat = Math.max(1, Number(process.argv[2] ?? 3) || 3)
  const dir = `${process.env.TMPDIR ?? "/tmp"}/uc-perf-${process.pid}`
  mkdirSync(dir, { recursive: true })
  const fixturePath = `${dir}/fixture.db`
  const fixture = buildFixture(fixturePath)
  console.log(`fixture: ${TURNS} 回合 / 20,000 消息 / 单条正文 ${(fixture.payloadBytes / 1024).toFixed(1)}KB / DB ${(fixture.dbBytes / 1048576).toFixed(1)}MB`)
  console.log(`重复测量 ${repeat} 次（每次独立子进程，同一 DB 文件，天然冷缓存）`)

  const workerPath = require.resolve("./check-perf")
  const runs: RunResult[] = []
  let allWorkersOk = true
  for (let i = 1; i <= repeat; i++) {
    const out = `${dir}/run-${i}.json`
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        workerPath,
        "worker",
        fixturePath,
        out,
        String(i),
        String(fixture.payloadBytes),
        String(fixture.dbBytes),
      ],
      env: { ...process.env, XDG_CACHE_HOME: `${dir}/cache-${i}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    const text = child.stdout.toString() + child.stderr.toString()
    process.stdout.write(text)
    try {
      runs.push(JSON.parse(require("node:fs").readFileSync(out, "utf8")) as RunResult)
    } catch {
      console.error(`run ${i} 未产出结果（exit ${child.exitCode}），聚合中止`)
      rmSync(dir, { recursive: true, force: true })
      process.exit(1)
    }
    if (child.exitCode !== 0) allWorkersOk = false
  }

  const report = aggregate(runs)
  const outPath = `${process.cwd()}/docs/perf/TASK17_1_raw.json`
  mkdirSync(`${process.cwd()}/docs/perf`, { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\n原始数据：${outPath}`)
  console.log(`${repeat} 次测量全部完成，失败项：${(report.failures as string[]).length}`)
  rmSync(dir, { recursive: true, force: true })
  if (!allWorkersOk || (report.failures as string[]).length > 0) process.exit(1)
}

if (process.argv[2] === "worker") worker(process.argv.slice(3))
else main()
