/**
 * 大规模历史数据性能测试（本批任务 3）：三档规模实测冷/热耗时与峰值内存。
 *
 * 场景：12 月 × 1k 会话（基准）、36 月 × 10k（中等）、60 月 × 50k（大规模）。
 * 数据特征：多项目、多模型、多 agent、不同 token/cost/耗时、部分无项目归属、
 * 部分缺统计字段。每会话多条消息，全部数据可复现（固定种子）。
 *
 * 观察：冷缓存首次统计、热缓存重复统计、缓存淘汰后统计完整性、
 * 内存峰值（maxRSS 差值）。结果一致性做断言（总费用跨路径必须相等）。
 *
 * 用法：bun scripts/check-scale.ts [scale]，scale = base|medium|large|all（默认 all）。
 * 大规模档需要 ~2 分钟和 ~1GB 内存，内存不足时用 base|medium 分级跑。
 */
import { UsageStore } from "../src/server/store"

const DAY = 86_400_000

interface ScaleCase {
  name: string
  months: number
  sessions: number
}

const CASES: Record<string, ScaleCase> = {
  base: { name: "基准 12 月 × 1k 会话", months: 12, sessions: 1_000 },
  medium: { name: "中等 36 月 × 10k 会话", months: 36, sessions: 10_000 },
  large: { name: "大规模 60 月 × 50k 会话", months: 60, sessions: 50_000 },
}

/** 可复现伪随机：mulberry32 */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 构造大规模合成库。返回 DB 文件路径与实际消息数。 */
function buildDb(scale: ScaleCase, dir: string): { file: string; messages: number } {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const file = `${dir}/uc-scale-${scale.sessions}.db`
  const db = new Database(file)
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
    CREATE INDEX session_message_time_created_idx ON session_message (time_created);
    CREATE INDEX session_v2_project_idx ON session_v2 (project_id);
  `)
  const now = new Date()
  const rand = rng(scale.sessions)

  const projects: string[] = []
  for (let p = 0; p < 6; p++) {
    const id = `proj-${p}`
    projects.push(id)
    db.exec(`INSERT INTO project VALUES ('${id}', NULL, '/tmp/scale-${p}', ${p + 1})`)
  }

  const insertSession = db.prepare(
    "INSERT INTO session_v2 (id, project_id, title, time_created, time_updated, model, agent, cost, tokens_input, tokens_output, tokens_cache_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', 1, ?, ?, ?)",
  )

  const models = ["model-a", "model-b", "model-c", "model-d"]
  const providers = ["prov-x", "prov-y"]
  const agents = ["build", "explore", "plan", "general"]
  let messages = 0
  let batch: unknown[][] = []
  const flush = () => {
    db.transaction(() => {
      for (const row of batch) insertMessage.run(...row)
    })()
    batch = []
  }

  for (let s = 0; s < scale.sessions; s++) {
    // 会话起点：从现在往回铺满 months 个月；部分会话无项目（NULL）
    const projectID = s % 17 === 0 ? null : projects[s % projects.length]
    const span = scale.months * 30 * DAY
    const start = Date.now() - rand() * span
    const msgCount = 2 + Math.floor(rand() * 6) // 2-7 条消息
    let last = start
    let sessionCost = 0
    for (let m = 0; m < msgCount; m++) {
      const at = start + m * (60_000 + rand() * 3_600_000)
      last = at
      const modelID = models[Math.floor(rand() * models.length)]
      const providerID = providers[Math.floor(rand() * providers.length)]
      const agent = agents[Math.floor(rand() * agents.length)]
      const input = Math.floor(100 + rand() * 19_900)
      const output = Math.floor(10 + rand() * 4_990)
      const cacheRead = Math.floor(rand() * 200_000)
      const cost = Math.round(rand() * 50_000) / 100_000 // $0-0.5
      sessionCost += cost
      // 部分（2%）缺 cost/tokens 字段
      const payload =
        rand() < 0.02
          ? JSON.stringify({ model: { providerID, id: modelID }, agent })
          : JSON.stringify({
              model: { providerID, id: modelID },
              agent,
              cost,
              tokens: { input, output, cache: { read: cacheRead, write: 0 } },
              time: { created: at, completed: at + Math.floor(500 + rand() * 30_000) },
            })
      batch.push([`m${s}-${m}`, `s${s}`, at, at, payload])
      messages += 1
      if (batch.length >= 5000) flush()
    }
    insertSession.run(
      `s${s}`,
      projectID,
      `会话 ${s}`,
      start,
      last,
      JSON.stringify({ providerID: "prov-x", id: models[s % models.length] }),
      agents[s % agents.length],
      sessionCost,
      null,
      null,
      null,
    )
    if (s % 5000 === 0) flush()
  }
  flush()
  db.close()
  return { file, messages }
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(0)}MB`
}

function runScale(scale: ScaleCase, dir: string, cacheDir: string): boolean {
  console.log(`\n=== ${scale.name} ===`)
  const t0 = performance.now()
  const { file, messages } = buildDb(scale, dir)
  console.log(`数据构造 ${fmtMB(require("node:fs").statSync(file).size)} DB / ${messages} 消息 / ${(performance.now() - t0).toFixed(0)}ms`)

  // 独立缓存目录：冷缓存从空目录开始
  const coldCache = `${cacheDir}/cold-${scale.sessions}`
  require("node:fs").mkdirSync(coldCache, { recursive: true })
  const scopeEnv = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = coldCache

  const store = new UsageStore(file, () => {})
  const from = 0
  const to = Date.now()

  // 冷缓存首次统计（全部历史）
  const coldStart = performance.now()
  const cold = store.snapshot({ from, to, projectID: undefined, force: true })
  const coldMs = performance.now() - coldStart
  const coldRSS = process.resourceUsage().maxRSS / 1024

  // 热缓存重复统计（逐日缓存全命中）
  const warmStart = performance.now()
  const warm = store.snapshot({ from, to, projectID: undefined, force: true })
  const warmMs = performance.now() - warmStart
  const warmRSS = process.resourceUsage().maxRSS / 1024

  // 再热一次（指纹校验路径）
  const warm2Start = performance.now()
  const warm2 = store.snapshot({ from, to, projectID: undefined, force: true })
  const warm2Ms = performance.now() - warm2Start

  const failures: string[] = []
  const expect = (label: string, actual: unknown, wanted: unknown, tolerance = 0) => {
    const ok =
      typeof actual === "number" && typeof wanted === "number"
        ? Math.abs(actual - wanted) <= tolerance
        : actual === wanted
    if (!ok) failures.push(`${label}: got ${actual}, want ${wanted}`)
  }

  // 一致性断言：冷/热/再热三条路径的总费用与请求数完全一致
  expect("cold requests", cold.totals.requests, warm.totals.requests)
  expect("cold cost", cold.totals.cost, warm.totals.cost, 1e-9)
  expect("warm cost (repeat)", warm.totals.cost, warm2.totals.cost, 1e-9)
  expect("cold sessions", cold.totals.sessions, warm.totals.sessions)
  // 统计完整性：requests > 0，且缓存淘汰（60 月 > DAY_CACHE_LIMIT=600 天）后
  // series 活跃天数仍与带数据的天数一致（趋势数据不受淘汰影响）
  expect("requests > 0", cold.totals.requests > 0, true)
  const withData = cold.series.filter((p) => p.requests > 0).length
  expect("series with data > 0", withData > 0, true)
  expect("activeDays matches series", cold.totals.activeDays, withData)
  // 项目归因之和 = 总费用（完整聚合归组，不受 LIMIT 500 影响）
  const projectSum = cold.projectUsage.reduce((sum, row) => sum + row.cost, 0)
  expect("project cost sum = total", projectSum, cold.totals.cost, 1e-6)

  const modelSum = Object.values(cold.models).reduce((sum, m) => sum + m.cost, 0)
  expect("model cost sum = total", modelSum, cold.totals.cost, 1e-6)

  console.log(`冷缓存  ${coldMs.toFixed(0)}ms  req ${cold.totals.requests}  cost $${cold.totals.cost.toFixed(2)}  峰值内存 ${fmtMB(coldRSS * 1024)}`)
  console.log(`热缓存  ${warmMs.toFixed(0)}ms  峰值内存 ${fmtMB(warmRSS * 1024)}`)
  console.log(`再热    ${warm2Ms.toFixed(0)}ms`)
  console.log(`series ${cold.series.length} 天（有数据 ${withData} 天）/ 模型 ${cold.models.length} 行 / 项目 ${cold.projectUsage.length} 行`)

  store.close()
  if (scopeEnv === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = scopeEnv
  require("node:fs").rmSync(file)

  if (failures.length > 0) {
    console.error(`${scale.name} 回归:`)
    for (const f of failures) console.error(`  - ${f}`)
    return false
  }
  console.log(`${scale.name} 通过`)
  return true
}

function main(): void {
  const which = process.argv[2] ?? "all"
  const dir = `${process.env.TMPDIR ?? "/tmp"}/uc-scale-${process.pid}`
  const cacheDir = `${dir}/cache`
  require("node:fs").mkdirSync(dir, { recursive: true })
  const keys = which === "all" ? Object.keys(CASES) : [which]
  let ok = true
  for (const key of keys) {
    const scale = CASES[key]
    if (!scale) {
      console.error(`未知规模：${key}（可选 ${Object.keys(CASES).join("|")}|all）`)
      process.exit(1)
    }
    ok = runScale(scale, dir, cacheDir) && ok
  }
  require("node:fs").rmSync(dir, { recursive: true, force: true })
  if (!ok) process.exit(1)
  console.log("\nscale ok: cold/warm parity, attribution sums match, series complete after eviction")
}

main()
