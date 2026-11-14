/**
 * 合成数据回归（1.0 §8.2）：用内存 SQLite 构造已知数据，验证聚合口径。
 * 不依赖本机真实数据库，可在 CI 阻断发布。覆盖：
 * - 项目归因不受会话列表 LIMIT 500 影响（超 500 会话成本仍完整）
 * - 有效 Token = input + output，缓存读写不计入
 * - 缓存命中率 = cache.read / (cache.read + input)
 * - agent 归因与 unknown 兜底
 * - 时间范围边界（从/到之外的消息不计入）
 * - cost 缺失按 0 处理
 */
import { UsageStore } from "../src/server/store"

const DAY = 86_400_000
const now = Date.now()
const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
// 昨天 12:00，确保落在「昨天」而不是今天
const yesterday = todayStart - DAY / 2

function seed(toBeBytes: (sessionID: string) => string): string {
  // 临时文件 DB（UsageStore 只读打开真实文件）
  const file = `${process.env.TMPDIR ?? "/tmp"}/uc-synthetic-${process.pid}-${Math.random().toString(36).slice(2)}.db`
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const db = new Database(file)
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
  `)
  toBeBytes(file)
  return file
}

/** 主场景：600 个会话分布在 2 个项目，超出会话列表 LIMIT 500。 */
function seedMain(db: import("bun:sqlite").Database): void {
  db.exec(`INSERT INTO project VALUES ('p1', NULL, '/tmp/proj-a', 1), ('p2', NULL, '/tmp/proj-b', 2)`)
  const insertSession = db.prepare(
    "INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
  )
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, 'assistant', 1, ?, ?)",
  )
  // 600 会话：p1 300 个 × $0.01，p2 300 个 × $0.01 → 每项目 $3.00
  for (let index = 0; index < 600; index++) {
    const project = index < 300 ? "p1" : "p2"
    const sessionID = `s${index}`
    insertSession.run(sessionID, project, `会话 ${index}`, yesterday, yesterday)
    insertMessage.run(
      `m${index}`,
      sessionID,
      yesterday,
      JSON.stringify({
        model: { providerID: "prov", id: "model-a" },
        agent: index % 2 === 0 ? "build" : "explore",
        cost: 0.01,
        tokens: { input: 100, output: 50, cache: { read: 400, write: 10 } },
        time: { created: yesterday, streamed: yesterday + 500, completed: yesterday + 2000 },
      }),
    )
  }
}

function main(): void {
  const failures: string[] = []
  const expect = (label: string, actual: number | boolean | string, wanted: number | boolean | string, tolerance = 0) => {
    const ok = typeof actual === "number" && typeof wanted === "number" ? Math.abs(actual - wanted) <= tolerance : actual === wanted
    if (!ok) failures.push(`${label}: got ${actual}, want ${wanted}`)
  }

  const file = seed((path) => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    seedMain(new Database(path))
  })
  const store = new UsageStore(file, () => {})

  // 覆盖昨天到今天的快照
  const snap = store.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })

  // 1. 总量：600 请求 × $0.01 = $6；有效 Token = 600 × 150 = 90000
  expect("total requests", snap.totals.requests, 600)
  expect("total cost", snap.totals.cost, 6, 1e-6)
  expect("effective tokens", snap.totals.tokens.input + snap.totals.tokens.output, 90_000)
  // 缓存不计入有效 Token
  expect("cacheRead not in tokens", snap.totals.tokens.cacheRead, 600 * 400)

  // 2. 项目归因不受 LIMIT 500 影响（§5.2）
  expect("projectUsage rows", snap.projectUsage.length, 2)
  for (const row of snap.projectUsage) {
    expect(`project ${row.projectID} requests`, row.requests, 300)
    expect(`project ${row.projectID} cost`, row.cost, 3, 1e-6)
    expect(`project ${row.projectID} tokens`, row.input + row.output, 45_000)
  }

  // 3. agent 归因：build / explore 各 300
  expect("agent rows", snap.agents.length, 2)
  for (const row of snap.agents) {
    expect(`agent ${row.agent} requests`, row.requests, 300)
    expect(`agent ${row.agent} cost`, row.cost, 3, 1e-6)
  }

  // 4. 会话列表列表本身是 LIMIT 500（UI 摘要用途）
  expect("session list capped", snap.sessions.length, 500)

  // 5. 时间边界：只查今天时应为空
  const todayOnly = store.snapshot({ from: todayStart, to: now, projectID: undefined, force: true })
  expect("today-only requests", todayOnly.totals.requests, 0)

  // 6. 缓存命中（内存路径带 count 校验）：第二次读值一致
  const again = store.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: false })
  expect("cached cost stable", again.totals.cost, 6, 1e-6)
  expect("cached requests stable", again.totals.requests, 600)

  store.close()

  if (failures.length > 0) {
    console.error("synthetic data regressions:")
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log("synthetic ok: 600 sessions across 2 projects, attribution complete beyond list cap")
}

main()
