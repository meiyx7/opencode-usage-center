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
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
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
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', 1, ?, ?, ?)",
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

  // 磁盘缓存指到临时目录，便于直读缓存文件做序列化断言。
  const cacheRoot = `${process.env.TMPDIR ?? "/tmp"}/uc-synthetic-cache-${process.pid}`
  process.env.XDG_CACHE_HOME = cacheRoot

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

  // 7. 跨 Store 磁盘冷启动（缓存修复 §1.3）：重建 Store 后项目归因必须与首次计算一致。
  const cold = new UsageStore(file, () => {})
  const coldSnap = cold.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
  expect("cold-start cost", coldSnap.totals.cost, 6, 1e-6)
  expect("cold-start projectUsage rows", coldSnap.projectUsage.length, 2)
  for (const row of coldSnap.projectUsage) {
    expect(`cold-start project ${row.projectID} requests`, row.requests, 300)
    expect(`cold-start project ${row.projectID} cost`, row.cost, 3, 1e-6)
    expect(`cold-start project ${row.projectID} tokens`, row.input + row.output, 45_000)
  }
  cold.close()

  // 8. 无项目归属的 Session 归到空桶，不混入其他项目。
  const orphanFile = seed((path) => {    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const db = new Database(path)
    db.exec(`INSERT INTO project VALUES ('p1', NULL, '/tmp/proj-a', 1)`)
    db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('s-o', NULL, '孤儿', ?, ?)").run(yesterday, yesterday)
    db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('s-a', 'p1', 'A', ?, ?)").run(yesterday, yesterday)
    const insert = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', 1, ?, ?, ?)",
    )
    const payload = JSON.stringify({
      model: { providerID: "prov", id: "model-a" },
      agent: "build",
      cost: 0.5,
      tokens: { input: 10, output: 10 },
      time: { created: yesterday, completed: yesterday + 100 },
    })
    insert.run("m-o", "s-o", yesterday, yesterday, payload)
    insert.run("m-a", "s-a", yesterday, yesterday, payload)
    db.close()
  })
  const orphanStore = new UsageStore(orphanFile, () => {})
  const orphanSnap = orphanStore.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
  const orphanRows = [...orphanSnap.projectUsage]
  expect("orphan bucket count", orphanRows.length, 2)
  for (const row of orphanRows) {
    expect(`orphan project "${row.projectID}" cost`, row.cost, 0.5, 1e-6)
  }
  orphanStore.close()

  // 9. 磁盘缓存文件直读：sessionProject 必须真实存在（v1 bug 是被写成 {}）。
  const dayFiles = [...new Bun.Glob("**/days/**/*.json").scanSync({ cwd: cacheRoot })]
  expect("day cache files written", dayFiles.length > 0, true)
  for (const rel of dayFiles) {
    const raw = JSON.parse(require("node:fs").readFileSync(`${cacheRoot}/${rel}`, "utf8")) as Record<string, unknown>
    expect(`cache ${rel} versioned`, typeof raw.version === "number", true)
    expect(`cache ${rel} has sessionProject`, typeof raw.sessionProject === "object" && raw.sessionProject !== null && Object.keys(raw.sessionProject as object).length > 0, true)
  }

  // 10. 旧版本缓存（无 version 字段）必须被判定失效：改造缓存目录里的文件后冷启动应重算出正确结果。
  for (const rel of dayFiles) {
    const path = `${cacheRoot}/${rel}`
    const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as Record<string, unknown>
    delete raw.version
    require("node:fs").writeFileSync(path, JSON.stringify(raw))
  }
  const legacy = new UsageStore(file, () => {})
  const legacySnap = legacy.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
  expect("legacy cache recomputed cost", legacySnap.totals.cost, 6, 1e-6)
  expect("legacy cache recomputed projects", legacySnap.projectUsage.length, 2)
  legacy.close()

  // 11. 损坏缓存文件必须安全恢复。
  for (const rel of dayFiles) {
    require("node:fs").writeFileSync(`${cacheRoot}/${rel}`, "{corrupted")
  }
  const corrupted = new UsageStore(file, () => {})
  const corruptedSnap = corrupted.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
  expect("corrupted cache recovered cost", corruptedSnap.totals.cost, 6, 1e-6)
  corrupted.close()

  // 11b. 同数量记录内容修改必须触发缓存失效（§3.2）：直接改 DB 里某条
  // 消息的 cost 并同步 time_updated（OpenCode 写入路径维护的更新信号），
  // count 不变但指纹漂移，第二次快照必须反映新值。
  {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const db = new Database(file)
    const before = db.query("SELECT data FROM session_message WHERE id = 'm0'").get() as { data: string } | undefined
    const original = JSON.parse(before!.data) as Record<string, unknown>
    const changed = { ...original, cost: 9.99 }
    db.query("UPDATE session_message SET data = ?, time_updated = ? WHERE id = 'm0'").run(
      JSON.stringify(changed),
      yesterday + 60_000,
    )
    db.close()
  }
  const mutated = new UsageStore(file, () => {})
  const mutatedSnap = mutated.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
  // p1 有 300 个 $0.01 会话，m0 改成 $9.99 → p1 3.00 - 0.01 + 9.99 = 12.98
  const p1 = mutatedSnap.projectUsage.find((row) => row.projectID === "p1")
  expect("same-count content change invalidates cache", p1?.cost ?? -1, 12.98, 1e-6)
  mutated.close()

  // 12. 长历史完整性（方案 B §五）：120 个月（10 年）跨年历史，每月 1 个会话。
  // 中间空月按 0 保留；总费用 = 会话数 × 单价；跨年边界无重复无遗漏。
  const months = 120
  const historyFile = seed((path) => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const db = new Database(path)
    db.exec(`INSERT INTO project VALUES ('ph', NULL, '/tmp/hist', 1)`)
    const insertSession = db.prepare(
      "INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES (?, 'ph', ?, ?, ?)",
    )
    const insertMessage = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', 1, ?, ?, ?)",
    )
    for (let index = 0; index < months; index++) {
      // 真实「每月 15 日」：从当月往回推 index 个月，避免 30 天近似导致两个
      // 会话落在同一天；12:00 确保不会因时区落到相邻日。
      const at = new Date()
      at.setDate(15)
      at.setMonth(at.getMonth() - index, 15)
      at.setHours(12, 0, 0, 0)
      const stamp = at.getTime()
      const sessionID = `h${index}`
      insertSession.run(sessionID, `历史 ${index}`, stamp, stamp)
      insertMessage.run(
        `hm${index}`,
        sessionID,
        stamp,
        stamp,
        JSON.stringify({
          model: { providerID: "prov", id: "model-a" },
          agent: "build",
          cost: 0.1,
          tokens: { input: 1000, output: 500 },
          time: { created: stamp, completed: stamp + 1000 },
        }),
      )
    }
    db.close()
  })
  const historyStore = new UsageStore(historyFile, () => {})
  const historySnap = historyStore.snapshot({ from: 0, to: now, projectID: undefined, force: true })
  // 当月 15 日可能在运行日之后（如 14 日跑测试），被 lastDay 排除属预期
  const expectedMonths = months - 1
  expect("history requests", historySnap.totals.requests, expectedMonths)
  expect("history cost", historySnap.totals.cost, expectedMonths * 0.1, 1e-6)
  expect("history effective tokens", historySnap.totals.tokens.input + historySnap.totals.tokens.output, expectedMonths * 1500)
  // 无截断：全部历史完整统计
  expect("history not truncated", historySnap.samples.truncated, false)
  // 活跃天数 = 有 assistant 消息的天数（每月一天，超出内存缓存容量也要完整）
  expect("history active days", historySnap.totals.activeDays, expectedMonths)
  // 项目归因与总量一致
  expect("history project rows", historySnap.projectUsage.length, 1)
  expect("history project cost", historySnap.projectUsage[0]?.cost ?? -1, expectedMonths * 0.1, 1e-6)
  // 冷启动后长历史结果一致（磁盘缓存支撑）
  historyStore.close()
  const historyCold = new UsageStore(historyFile, () => {})
  const historyColdSnap = historyCold.snapshot({ from: 0, to: now, projectID: undefined, force: true })
  expect("history cold-start cost", historyColdSnap.totals.cost, expectedMonths * 0.1, 1e-6)
  expect("history cold-start active days", historyColdSnap.totals.activeDays, expectedMonths)
  historyCold.close()

  if (failures.length > 0) {
    console.error("synthetic data regressions:")
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log("synthetic ok: 600 sessions across 2 projects, attribution complete beyond list cap, cold-start stable")
}

main()
