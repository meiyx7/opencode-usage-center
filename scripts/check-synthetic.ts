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
import { UsageStore, SESSION_PAGE_SQLS } from "../src/server/store"

const DAY = 86_400_000
const now = Date.now()
const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
// 昨天 12:00，确保落在「昨天」而不是今天
const yesterday = todayStart - DAY / 2

/** 与 store 的 localDate 同口径的本地日期（YYYY-MM-DD），供期望值判定用。 */
function localDateOf(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

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

/** 主场景：600 个会话分布在 2 个项目，超出会话列表 LIMIT 500。cost 可换（11c 用等形库）。 */
function seedMain(db: import("bun:sqlite").Database, cost = 0.01): void {
  db.exec(`INSERT INTO project VALUES ('p1', NULL, '/tmp/proj-a', 1), ('p2', NULL, '/tmp/proj-b', 2)`)
  const insertSession = db.prepare(
    "INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
  )
  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', 1, ?, ?, ?)",
  )
  // 600 会话：p1 300 个 × $cost，p2 300 个 × $cost → 每项目 300 × cost
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
        cost,
        tokens: { input: 100, output: 50, cache: { read: 400, write: 10 } },
        time: { created: yesterday, streamed: yesterday + 500, completed: yesterday + 2000 },
      }),
    )
  }
}

async function main(): Promise<void> {
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

  // 11c. 同路径重建 + 相同文件大小 + 相同内容指纹的数据库（评审二轮 P1、
  // 三轮 P1-3）。构造技巧：重建库用同一 seedMain 造（相同的 600 条消息、
  // 相同的 ID 长度、相同的时间戳），只把 cost 从 0.01 换成 0.09——等长
  // 字符串使文件大小一致，相同的 count 与 Σtime_updated 使内容指纹一致。
  // 身份键（path:dev:ino）里只有 inode 不同：重建库绝不能读到旧库缓存。
  // 这同时覆盖三轮移除 size 后的语义——size/指纹撞车时 inode 是唯一防线。
  {
    // 先用旧库把磁盘缓存填上（走一遍冷启动）
    const warmup = new UsageStore(file, () => {})
    warmup.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
    warmup.close()
    const { statSync, rmSync } = require("node:fs") as typeof import("node:fs")
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const oldSize = statSync(file).size
    const oldIno = statSync(file).ino
    // 重建：删掉旧文件，在同一建一个同形异值的库
    rmSync(file)
    const db = new Database(file)
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
    `)
    seedMain(db, 0.09)
    // 复刻 11b 对旧库做过的修改：m0 的 time_updated 同样 +60s。这样重建库
    // 与 11b 之后的旧库「文件大小相同 + 内容指纹（count|Σtime_updated）相同」，
    // 两个弱身份信号全部撞车——能否隔离完全取决于身份键里的 dev/inode。
    db.query("UPDATE session_message SET time_updated = ? WHERE id = 'm0'").run(yesterday + 60_000)
    db.close()
    expect("rebuilt db same size", statSync(file).size, oldSize)
    expect("rebuilt db new inode", statSync(file).ino !== oldIno, true)
    const rebuilt = new UsageStore(file, () => {})
    const rebuiltSnap = rebuilt.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
    // 重建库每条 $0.09（600 × 0.09 = $54）；若误读旧库缓存（$0.01×600 = $6），这里会得到 6
    expect("rebuilt db reads own cache only", rebuiltSnap.totals.cost, 54, 1e-6)
    expect("rebuilt db requests", rebuiltSnap.totals.requests, 600)
    rebuilt.close()
  }

  // 12. 长历史完整性（方案 B §五）：120 个月（10 年）跨年历史，每月 1 个会话。
  // 中间空月按 0 保留；总费用 = 会话数 × 单价；跨年边界无重复无遗漏。
  const months = 120
  /** 落在查询范围（≤ now）内的会话 ID，期望值由此动态推导。 */
  const expected = new Set<string>()
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
      // 会话落在同一天；12:00 确保不会因时区落到相邻日。会记录实际生成的
      // 日期，期望值按「落在 ≤ 运行时刻的 15 日个数」动态计算——当月 15 日
      // 是否已到取决于运行时刻与时区，不能写死。
      const at = new Date()
      at.setDate(15)
      at.setMonth(at.getMonth() - index, 15)
      at.setHours(12, 0, 0, 0)
      const stamp = at.getTime()
      const sessionID = `h${index}`
      // store 对「今天」聚合整个本地日（dayBounds 到次日零点），所以判定
      // 标准是「本地日期 ≤ 今天的本地日期」而不是时间戳先后——极东时区
      // （UTC+14）跑测试时当月 15 日可能已经是今天。
      if (localDateOf(stamp) <= localDateOf(now)) expected.add(sessionID)
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
  const expectedMonths = expected.size
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

  // 13. DST 夏令时日期边界（本批任务 1 + 评审 P1）：dayBounds 必须按本地
  // 日历推次日零点。在 DST 结束日（25 小时）与开始日（23 小时）前后的
  // 「差异缝隙」上放消息：固定 +86400000 的旧实现会把边界偏 1 小时——
  // 25th hour 那条漏算、开始日次日凌晨那条被重复统计。每个时区一套
  // 期望值，测试块内固定运行时区，与 CI 的时区无关。
  {
    const prevTZ = process.env.TZ
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    // 用带固定偏移的 UTC 时间反向构造各时区的本地时刻：先查该时区在该
    // 时刻的偏移量，再从 UTC 减掉偏移。避免依赖运行环境时区。
    const makeStamp = (y: number, m: number, d: number, hh: number, mm: number, tz: string) => {
      const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`
      const offsetMinutes = new Date(`${iso}Z`).toLocaleString("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      const match = /GMT([+-]\d{2}):(\d{2})/.exec(offsetMinutes)
      const sign = match?.[1].startsWith("-") ? -1 : 1
      const oh = parseInt(match?.[1].slice(1) ?? "0", 10)
      const om = parseInt(match?.[2] ?? "0", 10)
      const utcGuess = new Date(`${iso}Z`).getTime()
      return utcGuess - sign * (oh * 60 + om) * 60_000
    }
    // 每个时区：DST 开始/结束日（无 DST 的时区只放月末年末对）与期望分桶。
    // gap 消息专挑新旧实现差异缝隙（23:30 / 次日 00:30）；pair 消息验证
    // 普通日历边界（前一条 23:30 属前一日，后一条 00:30 属次日）。
    const CASES13: { tz: string; messages: { date: string; hh: number; mm: number }[]; want: Record<string, number> }[] = [
      {
        tz: "America/New_York",
        messages: [
          { date: "2026-11-01", hh: 12, mm: 0 }, // 25 小时那天中午
          { date: "2026-11-01", hh: 23, mm: 30 }, // 25th hour，旧实现漏算
          { date: "2026-11-02", hh: 0, mm: 30 }, // 次日凌晨
          { date: "2026-03-08", hh: 12, mm: 0 }, // 23 小时那天中午
          { date: "2026-03-09", hh: 0, mm: 30 }, // 次日凌晨，旧实现重复
        ],
        want: { "2026-11-01": 2, "2026-11-02": 1, "2026-03-08": 1, "2026-03-09": 1 },
      },
      {
        tz: "Europe/London",
        messages: [
          { date: "2026-10-25", hh: 12, mm: 0 }, // 英国 DST 结束（25 小时那天）中午
          { date: "2026-10-25", hh: 23, mm: 30 }, // 25th hour
          { date: "2026-10-26", hh: 0, mm: 30 },
          { date: "2026-03-29", hh: 12, mm: 0 }, // 英国 DST 开始（23 小时那天）中午
          { date: "2026-03-30", hh: 0, mm: 30 },
        ],
        want: { "2026-10-25": 2, "2026-10-26": 1, "2026-03-29": 1, "2026-03-30": 1 },
      },
      {
        tz: "Asia/Shanghai",
        // 无夏令时：24 小时日 + 月末/年末边界（评审要求普通日期覆盖）
        messages: [
          { date: "2026-06-15", hh: 12, mm: 0 },
          { date: "2026-06-15", hh: 23, mm: 30 },
          { date: "2026-06-16", hh: 0, mm: 30 },
          { date: "2026-01-31", hh: 23, mm: 30 },
          { date: "2026-02-01", hh: 0, mm: 30 },
          { date: "2025-12-31", hh: 23, mm: 30 },
          { date: "2026-01-01", hh: 0, mm: 30 },
        ],
        want: { "2026-06-15": 2, "2026-06-16": 1, "2026-01-31": 1, "2026-02-01": 1, "2025-12-31": 1, "2026-01-01": 1 },
      },
    ]
    for (const spec of CASES13) {
      process.env.TZ = spec.tz
      const dstFile = `${process.env.TMPDIR ?? "/tmp"}/uc-dst-${process.pid}-${Math.random().toString(36).slice(2)}.db`
      const db = new Database(dstFile)
      db.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
        CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      `)
      db.exec(`INSERT INTO project VALUES ('pd', NULL, '/tmp/dst', 1)`)
      db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('s-dst', 'pd', 'DST', NULL, NULL)").run()
      const insert = db.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
      )
      spec.messages.forEach((item, index) => {
        const [y, m, d] = item.date.split("-").map((v) => parseInt(v, 10))
        const stamp = makeStamp(y, m, d, item.hh, item.mm, spec.tz)
        insert.run(`${spec.tz}-${index}`, "s-dst", index + 1, stamp, stamp, JSON.stringify({
          model: { providerID: "prov", id: "model-a" },
          agent: "build",
          cost: 0.1,
          tokens: { input: 100, output: 50 },
          time: { created: stamp, completed: stamp + 100 },
        }))
      })
      db.close()

      const dstStore = new UsageStore(dstFile, () => {})
      const dstSnap = dstStore.snapshot({ from: 0, to: now, projectID: undefined, force: true })
      const total = spec.messages.length
      expect(`[${spec.tz}] requests（${total} 条各统计一次）`, dstSnap.totals.requests, total)
      expect(`[${spec.tz}] cost`, dstSnap.totals.cost, total * 0.1, 1e-6)
      const byDate = new Map(dstSnap.series.filter((p) => p.requests > 0).map((p) => [p.date, p.requests]))
      for (const [date, wanted] of Object.entries(spec.want)) {
        expect(`[${spec.tz}] ${date}`, byDate.get(date) ?? -1, wanted)
      }
      dstStore.close()
      require("node:fs").rmSync(dstFile)
    }
    if (prevTZ === undefined) delete process.env.TZ
    else process.env.TZ = prevTZ
  }

  // 14. Schema 兼容（本批任务 2）：缺 session_message.time_updated（缓存
  // 指纹依赖的列）时，schemaProbe 必须拦截并降级为空快照，不允许任何
  // SQL 崩溃或错误统计。
  {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const legacyFile = `${process.env.TMPDIR ?? "/tmp"}/uc-legacy-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const db = new Database(legacyFile)
    // 旧结构：session_message 无 time_updated 列
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
    `)
    db.exec(`INSERT INTO project VALUES ('p1', NULL, '/tmp/legacy', 1)`)
    db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('s1', 'p1', '旧', ?, ?)").run(yesterday, yesterday)
    db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES ('m1', 's1', 'assistant', 1, ?, ?)").run(
      yesterday,
      JSON.stringify({ model: { providerID: "prov", id: "m" }, agent: "build", cost: 1.23, tokens: { input: 10, output: 5 }, time: { created: yesterday } }),
    )
    db.close()

    const logs: string[] = []
    const legacyStore = new UsageStore(legacyFile, (message, detail) => logs.push(`${message} ${detail ?? ""}`))
    const legacySnap = legacyStore.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
    // 降级：空快照而非崩溃或错误数据
    expect("legacy schema snapshot empty", legacySnap.totals.requests, 0)
    expect("legacy schema snapshot cost", legacySnap.totals.cost, 0)
    // 诊断信息能定位到具体缺的列
    expect("legacy schema error mentions column", logs.some((l) => l.includes("time_updated")), true)
    legacyStore.close()
    require("node:fs").rmSync(legacyFile)

    // 缺整表：credential 表不存在时同样降级并指名缺表，不崩溃。
    const noTableFile = `${process.env.TMPDIR ?? "/tmp"}/uc-notable-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const db2 = new Database(noTableFile)
    db2.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
    `)
    db2.close()
    const tableLogs: string[] = []
    const noTableStore = new UsageStore(noTableFile, (message, detail) => tableLogs.push(`${message} ${detail ?? ""}`))
    const noTableSnap = noTableStore.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
    expect("missing table snapshot empty", noTableSnap.totals.requests, 0)
    expect("missing table error mentions table", tableLogs.some((l) => l.includes("credential")), true)
    noTableStore.close()
    require("node:fs").rmSync(noTableFile)
  }

  // 15. 统计口径对账（统计口径统一批次任务 6）：多项目、多模型、多 agent、
  // 跨 provider 同名模型、无项目、缺 cost/tokens、unknown 兜底——三个维度
  // 的费用与 Token 之和必须与总量对账，unknown 桶不得丢失。
  {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const recFile = `${process.env.TMPDIR ?? "/tmp"}/uc-recon-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const db = new Database(recFile)
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_time_created_idx ON session_message (time_created);
    `)
    db.exec(`INSERT INTO project VALUES ('pa', NULL, '/tmp/rec-a', 1), ('pb', NULL, '/tmp/rec-b', 2)`)
    const insertSession = db.prepare(
      "INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
    )
    const insertMessage = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', 1, ?, ?, ?)",
    )
    // 预期值直接从构造参数推导
    const want = { cost: 0, input: 0, output: 0, cacheRead: 0, requests: 0 }
    const add = (cost: number, input: number, output: number, cacheRead: number) => {
      want.cost += cost
      want.input += input
      want.output += output
      want.cacheRead += cacheRead
      want.requests += 1
    }
    let seq = 0
    const put = (sessionID: string, projectID: string | null, payload: Record<string, unknown>) => {
      insertSession.run(sessionID, projectID, `对账 ${sessionID}`, yesterday, yesterday)
      insertMessage.run(`rm${seq++}`, sessionID, yesterday, yesterday, JSON.stringify(payload))
      const tokens = (payload.tokens ?? {}) as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      // 缺 cost/tokens 的消息按 0 计入预期值（与聚合的 num() 语义一致）
      add(typeof payload.cost === "number" ? payload.cost : 0, tokens.input ?? 0, tokens.output ?? 0, tokens.cache?.read ?? 0)
      // 独立累计 reasoning / cacheWrite 预期（评审要求非零覆盖）
      wantReasoning += tokens.reasoning ?? 0
      wantCacheWrite += tokens.cache?.write ?? 0
    }
    let wantReasoning = 0
    let wantCacheWrite = 0
    const msg = (cost: number, providerID: string, modelID: string, agent: string, input: number, output: number, cacheRead = 0, extra?: { reasoning?: number; cacheWrite?: number }) => ({
      model: { providerID, id: modelID },
      agent,
      cost,
      tokens: { input, output, reasoning: extra?.reasoning ?? 0, cache: { read: cacheRead, write: extra?.cacheWrite ?? 0 } },
      time: { created: yesterday, completed: yesterday + 1000 },
    })
    // 多项目 × 多模型 × 多 agent 组合（部分带非零 reasoning / cacheWrite）
    put("ra1", "pa", msg(1.5, "prov-x", "model-a", "build", 100, 50, 200, { reasoning: 300, cacheWrite: 500 }))
    put("ra2", "pa", msg(0.25, "prov-y", "model-a", "explore", 60, 30, 0, { reasoning: 40 })) // 同名模型跨 provider
    put("ra3", "pb", msg(2, "prov-x", "model-b", "build", 200, 100, 400, { cacheWrite: 1200 }))
    put("ra4", "pb", msg(0.75, "prov-x", "model-c", "plan", 40, 20, 80))
    // 无项目归属（projectID NULL）→ 空串桶
    put("ra5", null, msg(0.5, "prov-y", "model-b", "general", 10, 5, 20, { reasoning: 15, cacheWrite: 25 }))
    // 缺 cost（订阅内）与缺 tokens 对象
    put("ra6", "pa", { model: { providerID: "prov-x", id: "model-a" }, agent: "build", time: { created: yesterday, completed: yesterday + 500 } })
    // agent 缺失 → unknown 桶
    put("ra7", "pb", { model: { providerID: "prov-x", id: "model-d" }, cost: 0.1, tokens: { input: 30, output: 15 }, time: { created: yesterday, completed: yesterday + 500 } })
    db.close()

    const recStore = new UsageStore(recFile, () => {})
    const rec = recStore.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
    // 总量对账
    expect("recon total cost", rec.totals.cost, want.cost, 1e-9)
    expect("recon total input", rec.totals.tokens.input, want.input)
    expect("recon total output", rec.totals.tokens.output, want.output)
    expect("recon total cacheRead", rec.totals.tokens.cacheRead, want.cacheRead)
    expect("recon total requests", rec.totals.requests, want.requests)
    // Σ 模型 = 总量（同名模型跨 provider 必须分行，不合并）
    let modelCost = 0
    let modelRows = 0
    const modelKeys = new Set<string>()
    for (const row of rec.models) {
      modelCost += row.cost
      modelRows += 1
      modelKeys.add(`${row.providerID}:${row.modelID}`)
    }
    expect("recon Σ model cost = total", modelCost, rec.totals.cost, 1e-9)
    expect("recon model-a split by provider", modelKeys.has("prov-x:model-a") && modelKeys.has("prov-y:model-a"), true)
    // Σ agent = 总量（unknown 桶保留）
    let agentCost = 0
    let hasUnknownAgent = false
    for (const row of rec.agents) {
      agentCost += row.cost
      if (row.agent === "unknown") hasUnknownAgent = true
    }
    expect("recon Σ agent cost = total", agentCost, rec.totals.cost, 1e-9)
    expect("recon unknown agent kept", hasUnknownAgent, true)
    // Σ 项目 = 总量（无项目桶保留且计入）
    let projectCost = 0
    let hasEmptyProject = false
    for (const row of rec.projectUsage) {
      projectCost += row.cost
      if (row.projectID === "") hasEmptyProject = true
    }
    expect("recon Σ project cost = total", projectCost, rec.totals.cost, 1e-9)
    expect("recon projectless bucket kept", hasEmptyProject, true)
    // Σ 有效 Token 对账（模型维度）
    let modelTokensSum = 0
    for (const row of rec.models) modelTokensSum += row.input + row.output
    expect("recon Σ model tokens = total", modelTokensSum, want.input + want.output)
    // 项目维度有效 Token 对账（评审 P0：总体 = 各项目之和 + 无项目）
    let projectTokensSum = 0
    let projectlessTokens = 0
    for (const row of rec.projectUsage) {
      if (row.projectID === "") projectlessTokens += row.input + row.output
      else projectTokensSum += row.input + row.output
    }
    expect("recon Σ project tokens + projectless = total", projectTokensSum + projectlessTokens, rec.totals.tokens.input + rec.totals.tokens.output)
    expect("recon projectless tokens kept", projectlessTokens > 0, true)
    // Agent 维度有效 Token 对账（评审 P0：总体 = 各 agent 之和 + unknown）
    let agentTokensSum = 0
    let unknownAgentTokens = 0
    for (const row of rec.agents) {
      if (row.agent === "unknown") unknownAgentTokens += row.input + row.output
      else agentTokensSum += row.input + row.output
    }
    expect("recon Σ agent tokens + unknown = total", agentTokensSum + unknownAgentTokens, rec.totals.tokens.input + rec.totals.tokens.output)
    // Reasoning / CacheWrite 独立预期对账（评审要求非零数据）
    expect("recon reasoning = expected", rec.totals.tokens.reasoning, wantReasoning)
    expect("recon cacheWrite = expected", rec.totals.tokens.cacheWrite, wantCacheWrite)
    expect("recon reasoning nonzero", wantReasoning > 0, true)
    expect("recon cacheWrite nonzero", wantCacheWrite > 0, true)
    // 缺 cost 的会话贡献 $0 但会话本身计入
    expect("recon missing cost counted as 0", rec.totals.cost > 0, true)
    // 会话列表行与聚合口径一致（同一会话跨路径对账）
    const listed = rec.sessions.find((s) => s.id === "ra1")
    expect("recon session row cost", listed?.cost ?? -1, 1.5, 1e-9)
    expect("recon session row tokens", listed ? listed.input + listed.output : -1, 150)
    // 会话详情（Session Replay 路径）与会话列表行对账
    const detail = recStore.sessionDetail({ sessionID: "ra1", force: true })
    expect("recon detail cost = list row", detail.cost, listed?.cost ?? -2, 1e-9)
    expect("recon detail tokens = list row", detail.tokens.input + detail.tokens.output, 150)
    recStore.close()
    require("node:fs").rmSync(recFile)

    // 15b. 单会话单模型最小用例：一个会话一条消息，所有维度对账退化为恒等。
    const minFile = `${process.env.TMPDIR ?? "/tmp"}/uc-min-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const dbMin = new Database(minFile)
    dbMin.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_time_created_idx ON session_message (time_created);
    `)
    dbMin.exec(`INSERT INTO project VALUES ('pm', NULL, '/tmp/min', 1)`)
    dbMin.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('rm1', 'pm', '最小', ?, ?)").run(yesterday, yesterday)
    dbMin.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('rmm1', 'rm1', 'assistant', 1, ?, ?, ?)").run(
      yesterday,
      yesterday,
      JSON.stringify({ model: { providerID: "prov-x", id: "model-a" }, agent: "build", cost: 0.4, tokens: { input: 80, output: 40, cache: { read: 120, write: 0 } }, time: { created: yesterday, completed: yesterday + 800 } }),
    )
    dbMin.close()
    const minStore = new UsageStore(minFile, () => {})
    const min = minStore.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
    expect("min requests", min.totals.requests, 1)
    expect("min cost", min.totals.cost, 0.4, 1e-9)
    expect("min models rows", min.models.length, 1)
    expect("min model = total", min.models[0]?.cost ?? -1, min.totals.cost, 1e-9)
    expect("min agents rows", min.agents.length, 1)
    expect("min project rows", min.projectUsage.length, 1)
    expect("min sessions", min.totals.sessions, 1)
    const minDetail = minStore.sessionDetail({ sessionID: "rm1", force: true })
    expect("min detail cost", minDetail.cost, 0.4, 1e-9)
    expect("min detail requests", minDetail.requestCount, 1)
    minStore.close()
    require("node:fs").rmSync(minFile)

    // 15c. 无模型归属：缺 model 字段的消息必须进 unknown 模型桶，不丢失。
    const unkFile = `${process.env.TMPDIR ?? "/tmp"}/uc-unk-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const dbUnk = new Database(unkFile)
    dbUnk.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_time_created_idx ON session_message (time_created);
    `)
    dbUnk.exec(`INSERT INTO project VALUES ('pu', NULL, '/tmp/unk', 1)`)
    dbUnk.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('ru1', 'pu', '无模型', ?, ?)").run(yesterday, yesterday)
    dbUnk.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('rum1', 'ru1', 'assistant', 1, ?, ?, ?)").run(
      yesterday,
      yesterday,
      JSON.stringify({ agent: "build", cost: 0.7, tokens: { input: 20, output: 10 }, time: { created: yesterday, completed: yesterday + 300 } }),
    )
    dbUnk.close()
    const unkStore = new UsageStore(unkFile, () => {})
    const unk = unkStore.snapshot({ from: todayStart - DAY, to: now, projectID: undefined, force: true })
    expect("unknown model requests", unk.totals.requests, 1)
    expect("unknown model cost kept", unk.totals.cost, 0.7, 1e-9)
    expect("unknown model bucket", unk.models.length, 1)
    expect("unknown model id", unk.models[0]?.modelID ?? "", "unknown")
    expect("unknown model provider", unk.models[0]?.providerID ?? "", "unknown")
    expect("unknown Σ model = total", unk.models[0]?.cost ?? -1, unk.totals.cost, 1e-9)
    unkStore.close()
    require("node:fs").rmSync(unkFile)

    // 15d. 分页对账：会话详情翻页（beforeTurn）的各页费用/Token 之和 = 整会话总量。
    // 数据库 schema 含 OpenCode 真实复合索引（session_id+seq 与 session_id+type+seq），
    // 让分页探测查询走真索引（第二批 TASK-02）。
    const pageFile = `${process.env.TMPDIR ?? "/tmp"}/uc-page-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const dbPage = new Database(pageFile)
    dbPage.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_time_created_idx ON session_message (time_created);
      CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
      CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
    `)
    dbPage.exec(`INSERT INTO project VALUES ('pp', NULL, '/tmp/page', 1)`)
    dbPage.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('rp1', 'pp', '分页', ?, ?)").run(yesterday, yesterday)
    const pageMsg = dbPage.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    // 5 个回合，每回合 1 条 user + 1 条 assistant（cost 0.1 × 5 = 0.5）
    const turnCount = 5
    for (let index = 0; index < turnCount; index++) {
      const at = yesterday - (turnCount - index) * 3_600_000
      pageMsg.run(`pm-u${index}`, "rp1", "user", index * 2 + 1, at, at, JSON.stringify({ text: `第 ${index + 1} 问` }))
      pageMsg.run(`pm-a${index}`, "rp1", "assistant", index * 2 + 2, at + 1000, at + 1000, JSON.stringify({
        model: { providerID: "prov-x", id: "model-a" },
        agent: "build",
        cost: 0.1,
        tokens: { input: 50, output: 25 },
        time: { created: at + 1000, completed: at + 2000 },
      }))
    }
    dbPage.close()
    const pageStore = new UsageStore(pageFile, () => {})
    const fullDetail = pageStore.sessionDetail({ sessionID: "rp1", force: true })
    expect("page full cost", fullDetail.cost, turnCount * 0.1, 1e-9)
    expect("page full turns", fullDetail.turns.length, turnCount)
    // 逐页往后翻，各页之和必须等于整会话
    let pageCost = 0
    let pageTurns = 0
    let before: number | undefined
    for (;;) {
      const page = pageStore.sessionDetail({ sessionID: "rp1", beforeTurn: before, limit: 2, force: true })
      for (const turn of page.turns) {
        pageCost += turn.cost
        pageTurns += 1
      }
      if (!page.hasMore) break
      before = page.nextBefore
    }
    expect("page turns sum = full", pageTurns, turnCount)
    expect("page cost sum = full", pageCost, fullDetail.cost, 1e-9)
    pageStore.close()
    require("node:fs").rmSync(pageFile)

    // 15e. 真分页证据（第二批 TASK-05E）：大分页 + 读取范围受限 + 独立预期值
    // 汇总对账 + 边界会话。构造 220 回合（1 user + 1 assistant，cost 0.01/回合）。
    const bigPageFile = `${process.env.TMPDIR ?? "/tmp"}/uc-bigpage-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const dbBig = new Database(bigPageFile)
    dbBig.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_time_created_idx ON session_message (time_created);
      CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
      CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
    `)
    dbBig.exec(`INSERT INTO project VALUES ('pb', NULL, '/tmp/bigpage', 1)`)
    dbBig.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('bg1', 'pb', '大分页', ?, ?)").run(yesterday, yesterday)
    // 复杂会话覆盖（TASK-05C）：普通回合 + 无 assistant 的 user + 一 user 多 assistant
    // + 工具错误 + 缺 cost + 坏 JSON + 头部无 user 的 assistant（合成回合）。
    const bigMsg = dbBig.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    let bigSeq = 0
    let bigTime = yesterday - 220 * 3_600_000
    // 头部合成回合：assistant 无前置 user（cost 0.5）
    bigMsg.run(`bg-m${bigSeq++}`, "bg1", "assistant", bigSeq, bigTime, bigTime, JSON.stringify({
      model: { providerID: "prov-x", id: "model-a" }, agent: "build", cost: 0.5,
      tokens: { input: 100, output: 50, cache: { read: 20, write: 5 } },
      time: { created: bigTime, streamed: bigTime + 500, completed: bigTime + 1500 },
      content: [{ type: "tool", id: "t-head", name: "bash", state: { status: "error", error: "boom" } }],
    }))
    bigTime += 3_600_000
    // 普通回合 × 218：1 user + 1 assistant
    for (let i = 0; i < 218; i++) {
      bigMsg.run(`bg-m${bigSeq++}`, "bg1", "user", bigSeq, bigTime, bigTime, JSON.stringify({ text: `问题 ${i + 1}` }))
      const assistantCost = i % 3 === 0 ? undefined : 0.01 // 每 3 回合缺 cost（订阅内）
      const payload: Record<string, unknown> = {
        model: { providerID: "prov-x", id: "model-a" },
        agent: "build",
        cost: assistantCost,
        tokens: { input: 40, output: 20, reasoning: i % 5 === 0 ? 10 : 0, cache: { read: 15, write: i % 7 === 0 ? 8 : 0 } },
        time: { created: bigTime + 100, streamed: bigTime + 600, completed: bigTime + 2100 },
      }
      if (i === 9) {
        // 一 user 多 assistant：在本回合塞第二条 assistant（下一条消息）
        bigMsg.run(`bg-m${bigSeq++}`, "bg1", "assistant", bigSeq, bigTime + 100, bigTime + 100, JSON.stringify(payload))
        bigSeq++
        bigMsg.run(`bg-m${bigSeq++}`, "bg1", "assistant", bigSeq, bigTime + 300, bigTime + 300, JSON.stringify({ ...payload, cost: 0.02 }))
      } else if (i === 20) {
        // 工具 + 工具错误 + state.error 真值边界（复审收尾项）：""/false/0
        // 是 JS falsy——旧口径不计错；SQL 必须用真值判断而非 IS NOT NULL。
        payload.content = [
          { type: "tool", id: "t1", name: "read", state: { status: "completed" } },
          { type: "tool", id: "t2", name: "bash", state: { status: "error", error: "exit 1" } },
          { type: "tool", id: "t3", name: "grep", state: { status: "completed", error: "" } },
          { type: "tool", id: "t4", name: "edit", state: { status: "completed", error: false } },
          { type: "tool", id: "t5", name: "glob", state: { status: "completed", error: 0 } },
        ]
        bigMsg.run(`bg-m${bigSeq++}`, "bg1", "assistant", bigSeq, bigTime + 100, bigTime + 100, JSON.stringify(payload))
      } else if (i === 30) {
        // 坏 JSON：按 0 计入，不得让会话详情失败
        bigMsg.run(`bg-m${bigSeq++}`, "bg1", "assistant", bigSeq, bigTime + 100, bigTime + 100, "{broken json")
      } else {
        bigMsg.run(`bg-m${bigSeq++}`, "bg1", "assistant", bigSeq, bigTime + 100, bigTime + 100, JSON.stringify(payload))
      }
      bigTime += 3_600_000
    }
    // 尾部：user 无 assistant 回合
    bigMsg.run(`bg-m${bigSeq++}`, "bg1", "user", bigSeq, bigTime, bigTime, JSON.stringify({ text: "最后一问没有回复" }))
    dbBig.close()

    const bigStore = new UsageStore(bigPageFile, () => {})
    // 独立预期值：0.5（头部）+ Σ 218 普通回合 cost + 0.02（i=9 的第二条 assistant）。
    // i%3==0 的回合（0,3,...,216 → 73 个）缺 cost 按 0；i=30 同时是 %3==0 且坏 JSON，
    // 两者都按 0，不产生额外修正项。
    const normalTurns = 218
    const zeroCostTurns = Math.floor((normalTurns - 1) / 3) + 1 // i=0,3,...,216 → 73
    const doubleAssistantTurn = 1 // i=9 追加 0.02
    const wantBigCost = 0.5 + (normalTurns - zeroCostTurns) * 0.01 + doubleAssistantTurn * 0.02
    const first = bigStore.sessionDetail({ sessionID: "bg1", force: true })
    expect("big totalTurns (218 user + 合成头 + 尾部无回复)", first.totalTurns, 220)
    expect("big promptCount", first.promptCount, 219)
    expect("big cost = 独立预期", first.cost, wantBigCost, 1e-9)
    // 坏 JSON 行仍计入请求数（复审 P1）：218 正常 + 头部 1 + 双发 1 = 220
    expect("big requestCount 含坏 JSON 行", first.requestCount, 220)
    expect("big toolCount（含 falsy error 工具）", first.toolCount, 6)
    // 工具错误 2（头 t-head + i=20 的 t2）；i=20 的 data.error 字段不存在
    expect("big errorCount = tool errors", first.errorCount, 2)
    // 首页只含最后 60 回合；合成回合在全局 index 1，翻到第一页验证。
    expect("big latest page first index", first.turns[0]?.index ?? -1, 161)
    const headPage = bigStore.sessionDetail({ sessionID: "bg1", beforeTurn: 2, limit: 2, force: true })
    expect("big head synthetic turn", headPage.turns[0]?.prompt ?? "", "（会话开始）")
    expect("big head page turns (合成回合页)", headPage.turns.length, 1)
    expect("big head page hasMore=false (终止语义)", headPage.hasMore, false)

    // 读取范围计数：翻完全部页，每页读取消息数必须受限（真分页证据）。
    // 旧实现每次读全会话消息（~445 行/页 × 4 页）；新实现各页 ≤ limit 回合对应的消息数。
    const reads = { messages: 0, assistant: 0 }
    ;(globalThis as { __ucPageReads?: typeof reads }).__ucPageReads = reads
    let bigCursor: number | undefined
    let bigLoaded = 0
    let bigCostSum = 0
    const bigIndexes: number[] = []
    let maxMessagesPerPage = 0
    for (;;) {
      const before = reads.messages
      const page = bigStore.sessionDetail({ sessionID: "bg1", beforeTurn: bigCursor, limit: 60, force: true })
      maxMessagesPerPage = Math.max(maxMessagesPerPage, reads.messages - before)
      for (const turn of page.turns) {
        bigLoaded += 1
        bigCostSum += turn.cost
        bigIndexes.push(turn.index)
      }
      if (!page.hasMore) break
      bigCursor = page.nextBefore
    }
    delete (globalThis as { __ucPageReads?: typeof reads }).__ucPageReads
    expect("big loaded = totalTurns", bigLoaded, first.totalTurns)
    expect("big Σ page cost = summary", bigCostSum, first.cost, 1e-9)
    // 全会话消息数 = 445（合成头 1 + 218×(1-2) user/assistant + 尾部 1）；单页读取必须远小于全会话。
    const totalMessages = 1 + 219 + 220 + 3 + 1 // 估算：头1 + user219 + assistant220 + 双发1 + 尾1（按精确插入数重算）
    expect("big page reads bounded (max page < 全会话)", maxMessagesPerPage < totalMessages, true)
    expect("big page reads bounded (max page ≤ ~125 行)", maxMessagesPerPage <= 130, true)

    // 真分页证据：页链完整。排序后回合序号必须连续 1..totalTurns，无重复无遗漏。
    const sortedIndexes = [...bigIndexes].sort((a, b) => a - b)
    expect(
      "big indexes contiguous 1..totalTurns",
      sortedIndexes.join(",") === sortedIndexes.map((_, i) => i + 1).join(","),
      true,
    )

    // 缓存行为（TASK-05D）：连续两次无 force 请求命中同一汇总（generatedAt 不变）；
    // force 刷新后重建。翻页循环里每页 force:true 都会重建汇总，因此缓存断言
    // 在循环后独立做两次无 force 请求。
    const cacheHit1 = bigStore.sessionDetail({ sessionID: "bg1" })
    const cacheHit2 = bigStore.sessionDetail({ sessionID: "bg1" })
    expect("cache: generatedAt unchanged on hit", cacheHit2.generatedAt, cacheHit1.generatedAt)
    expect("cache: hit data identical", cacheHit2.cost, first.cost, 1e-9)
    const forced = bigStore.sessionDetail({ sessionID: "bg1", force: true })
    expect("cache: force refresh rebuilds summary", forced.generatedAt > cacheHit1.generatedAt, true)
    expect("cache: forced data identical", forced.cost, first.cost, 1e-9)
    bigStore.close()
    require("node:fs").rmSync(bigPageFile)

    // 15f. 页大小边界（复审 P1）：59/60/61 个 user 回合 × 有无头部合成回合，
    // 首屏与连续翻页的回合数、序号、hasMore、nextBefore 全断言。
    const edgeFiles: string[] = []
    const edgeCase = (label: string, userTurns: number, headSynthetic: boolean) => {
      const file = `${process.env.TMPDIR ?? "/tmp"}/uc-edge-${process.pid}-${Math.random().toString(36).slice(2)}.db`
      edgeFiles.push(file)
      const db = new Database(file)
      db.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
        CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
        CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
        CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
      `)
      db.exec(`INSERT INTO project VALUES ('pe', NULL, '/tmp/edge', 1)`)
      db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('ed1', 'pe', ?, 1, 1)").run(label)
      const msg = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, 'ed1', ?, ?, ?, ?, ?)")
      let seq = 0
      const assistantPayload = JSON.stringify({ cost: 0.01, model: { providerID: "p", id: "m" }, agent: "b", tokens: {}, time: { created: 1, completed: 10 } })
      if (headSynthetic) {
        msg.run(`e${seq}`, "assistant", ++seq, 1, 1, assistantPayload)
      }
      for (let i = 0; i < userTurns; i++) {
        msg.run(`e${seq}`, "user", ++seq, i, i, JSON.stringify({ text: `q${i}` }))
        msg.run(`e${seq}`, "assistant", ++seq, i, i, assistantPayload)
      }
      db.close()
      const store = new UsageStore(file, () => {})
      const total = userTurns + (headSynthetic ? 1 : 0)
      const head = store.sessionDetail({ sessionID: "ed1", force: true })
      expect(`${label}: totalTurns`, head.totalTurns, total)
      expect(`${label}: 首页回合数 ≤ 60`, head.turns.length <= 60, true)
      expect(`${label}: 首页回合数`, head.turns.length, Math.min(total, 60))
      // 连续翻页：回合数守上限、序号连续、无重复
      let cursor: number | undefined
      const seen: number[] = []
      let pageCount = 0
      for (;;) {
        const page = store.sessionDetail({ sessionID: "ed1", beforeTurn: cursor, limit: 60, force: true })
        pageCount += 1
        expect(`${label}: 每页回合数 ≤ 60`, page.turns.length <= 60, true)
        for (const turn of page.turns) seen.push(turn.index)
        if (!page.hasMore) break
        cursor = page.nextBefore
        expect(`${label}: nextBefore 合法`, cursor! >= 2 && cursor! <= total, true)
      }
      const sorted = [...seen].sort((a, b) => a - b)
      expect(`${label}: 翻页序号连续 1..${total} 无重复`, sorted.join(",") === sorted.map((_, i) => i + 1).join(","), true)
      expect(`${label}: 翻页总数`, seen.length, total)
      store.close()
      require("node:fs").rmSync(file)
    }
    edgeCase("边界 59 user 无头", 59, false)
    edgeCase("边界 60 user 无头", 60, false)
    edgeCase("边界 61 user 无头", 61, false)
    edgeCase("边界 59 user 有头", 59, true)
    edgeCase("边界 60 user 有头", 60, true)
    edgeCase("边界 61 user 有头", 61, true)

    // 15g. 10,000 回合长会话（复审 P2 → 阶段 A 补充；TASK-07 扩展）：大体积
    // 正文/思考/工具内容 + 分阶段读取量探针。首屏只解析当前页，全链翻页完整，
    // 汇总与独立预期对账，记录各阶段耗时与字节数。
    const hugeFile = `${process.env.TMPDIR ?? "/tmp"}/uc-huge-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const dbHuge = new Database(hugeFile)
    dbHuge.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_time_created_idx ON session_message (time_created);
      CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
      CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
    `)
    dbHuge.exec(`INSERT INTO project VALUES ('ph', NULL, '/tmp/huge', 1)`)
    dbHuge.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('hg1', 'ph', '万回合', 1, 1)").run()
    const hugeMsg = dbHuge.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, 'hg1', ?, ?, ?, ?, ?)")
    const hugeTurns = 10_000
    // 大体积正文（TASK-07）：每条 assistant 带数 KB 的文本/思考/工具输出，
    // 让「全量正文传入 JS」与「只传当前页」的差距在字节数上可见。
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
    dbHuge.transaction(() => {
      for (let i = 0; i < hugeTurns; i++) {
        hugeMsg.run(`h${i}u`, "user", i * 2 + 1, i, i, JSON.stringify({ text: `回合 ${i}` }))
        hugeMsg.run(`h${i}a`, "assistant", i * 2 + 2, i, i, hugePayload)
      }
    })()
    dbHuge.close()
    const hugeStore = new UsageStore(hugeFile, () => {})
    const tBuild = performance.now()
    const hugeFirst = hugeStore.sessionDetail({ sessionID: "hg1", force: true })
    const tFirst = performance.now()
    expect("huge totalTurns", hugeFirst.totalTurns, hugeTurns)
    expect("huge 首屏回合数 = 60", hugeFirst.turns.length, 60)
    expect("huge 大体积正文下 toolCount 正常", hugeFirst.toolCount, hugeTurns)
    // 分阶段探针（TASK-07）：pageReads = 分页阶段传入 JS 的正文行/字节；
    // summaryProbe = 汇总阶段结构化扫描行数与正文字节（必须为 0）。
    // parseProbe = JSON.parse 次数与字节数（只应覆盖当前页 + user 行）。
    const hugeReads = { messages: 0, assistant: 0, bodyBytes: 0 }
    const hugeSummary = { scannedRows: 0, bodyBytes: 0 }
    const hugeParse = { parses: 0, parseBytes: 0 }
    ;(globalThis as { __ucPageReads?: typeof hugeReads }).__ucPageReads = hugeReads
    ;(globalThis as { __ucSummaryProbe?: typeof hugeSummary }).__ucSummaryProbe = hugeSummary
    ;(globalThis as { __ucReadProbe?: typeof hugeParse }).__ucReadProbe = hugeParse
    hugeSummary.scannedRows = 0
    hugeSummary.bodyBytes = 0
    hugeParse.parses = 0
    hugeParse.parseBytes = 0
    const pageBefore = { ...hugeReads }
    const parseBefore = { ...hugeParse }
    hugeStore.sessionDetail({ sessionID: "hg1", force: true })
    const firstReads = hugeReads.messages - pageBefore.messages
    const firstBytes = hugeReads.bodyBytes - pageBefore.bodyBytes
    const firstParses = hugeParse.parses - parseBefore.parses
    const firstParseBytes = hugeParse.parseBytes - parseBefore.parseBytes
    const firstScanned = hugeSummary.scannedRows
    const summaryBodyBytes = hugeSummary.bodyBytes
    expect("huge 首屏读取消息数 ≤ ~125（非 20000）", firstReads <= 130, true)
    expect("huge 汇总阶段正文传入 JS 字节 = 0", summaryBodyBytes, 0)
    expect("huge 首屏 JSON 解析次数 ≤ 页内消息数（非 20000）", firstParses <= firstReads, true)
    const singleRowBytes = hugePayload.length + JSON.stringify({ text: `回合 0` }).length
    expect("huge 首屏解析字节 ≈ 当前页（< 5% 全会话）", firstParseBytes < hugeTurns * singleRowBytes * 0.05, true)
    let hugeCursor: number | undefined
    let hugeLoaded = 0
    let hugeCost = 0
    let hugePages = 0
    const readPerFirst = firstReads
    let maxPageReads = readPerFirst
    for (;;) {
      const before = hugeReads.messages
      const page = hugeStore.sessionDetail({ sessionID: "hg1", beforeTurn: hugeCursor, limit: 60, force: true })
      const pageReads = hugeReads.messages - before
      maxPageReads = Math.max(maxPageReads, pageReads)
      hugeLoaded += page.turns.length
      for (const turn of page.turns) hugeCost += turn.cost
      hugePages += 1
      if (!page.hasMore) break
      hugeCursor = page.nextBefore
    }
    ;(globalThis as { __ucPageReads?: typeof hugeReads }).__ucPageReads = undefined
    ;(globalThis as { __ucSummaryProbe?: typeof hugeSummary }).__ucSummaryProbe = undefined
    ;(globalThis as { __ucReadProbe?: typeof hugeParse }).__ucReadProbe = undefined
    const tAll = performance.now()
    expect("huge 翻页总回合", hugeLoaded, hugeTurns)
    expect("huge Σ页cost = 汇总", hugeCost, hugeFirst.cost, 1e-9)
    expect("huge 汇总 = 独立预期", hugeFirst.cost, hugeTurns * 0.001, 1e-9)
    expect("huge 每页读取 ≤ 130 行（真分页，全会话 20000 行）", maxPageReads <= 130, true)
    console.log(
      `[长会话] ${hugeTurns} 回合: 首屏 ${(tFirst - tBuild).toFixed(0)}ms / 正文 ${firstReads} 行 ${(firstBytes / 1048576).toFixed(1)}MB / JSON 解析 ${firstParses} 次 ${(firstParseBytes / 1048576).toFixed(1)}MB / 汇总结构化扫描 ${firstScanned} 行（正文传入 0 字节）/ 全链 ${hugePages} 页 ${(tAll - tFirst).toFixed(0)}ms / 单页最大读取 ${maxPageReads} 行`,
    )
    hugeStore.close()
    require("node:fs").rmSync(hugeFile)

    // 15i. Revert 缓存失效行为测试（TASK-08 行为验证，复审补充）：服务端侧
    // 模拟 Revert——删除消息后 force 读取，已删回合不得出现，其他会话缓存
    // 不受影响；invalidateDetailCache / markSessionReverted 模块单元验证。
    const revertFile = `${process.env.TMPDIR ?? "/tmp"}/uc-revert-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const dbRev = new Database(revertFile)
    dbRev.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
      CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
    `)
    dbRev.exec(`INSERT INTO project VALUES ('pr', NULL, '/tmp/revert', 1)`)
    const revSess = dbRev.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES (?, 'pr', ?, 1, 1)")
    revSess.run("rv1", "Revert 会话")
    revSess.run("rv2", "无关会话")
    const revMsg = dbRev.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    const revPayload = JSON.stringify({ cost: 0.01, model: { providerID: "p", id: "m" }, agent: "b", tokens: {}, time: { created: 1, completed: 10 } })
    // rv1: 5 回合；rv2: 2 回合
    for (let i = 0; i < 5; i++) {
      revMsg.run(`r1u${i}`, "rv1", "user", i * 2 + 1, i, i, JSON.stringify({ text: `rv1 回合 ${i + 1}` }))
      revMsg.run(`r1a${i}`, "rv1", "assistant", i * 2 + 2, i, i, revPayload)
    }
    for (let i = 0; i < 2; i++) {
      revMsg.run(`r2u${i}`, "rv2", "user", i * 2 + 1, i, i, JSON.stringify({ text: `rv2 回合 ${i + 1}` }))
      revMsg.run(`r2a${i}`, "rv2", "assistant", i * 2 + 2, i, i, revPayload)
    }
    dbRev.close()
    const revStore = new UsageStore(revertFile, () => {})
    const beforeRevert = revStore.sessionDetail({ sessionID: "rv1", force: true })
    expect("revert: 初次 5 回合", beforeRevert.totalTurns, 5)
    // 缓存命中（无 force）：读的是缓存的汇总
    const cachedRead = revStore.sessionDetail({ sessionID: "rv1" })
    expect("revert: TTL 内缓存命中", cachedRead.generatedAt, beforeRevert.generatedAt)
    // 模拟 Revert：删除最后 2 回合的消息（rv1 只剩 3 回合）。直接读写打开
    //（仅测试环境修改自己的 fixture；插件运行时永远只读打开真实库）。
    const rawRev = new Database(revertFile, { readwrite: true, create: false })
    rawRev.exec(`DELETE FROM session_message WHERE session_id = 'rv1' AND seq >= 7`)
    rawRev.close()
    // 无 force：TTL 内仍读旧汇总（60s 兜底窗口）——如实断言现有行为
    const staleRead = revStore.sessionDetail({ sessionID: "rv1" })
    expect("revert: TTL 内汇总仍为旧值（兜底窗口行为）", staleRead.totalTurns, 5)
    // force 读取：汇总立即反映删除后状态
    const forcedAfterRevert = revStore.sessionDetail({ sessionID: "rv1", force: true })
    expect("revert: force 后汇总 = 3 回合", forcedAfterRevert.totalTurns, 3)
    expect("revert: force 后成本同步", forcedAfterRevert.cost, 3 * 0.01, 1e-9)
    expect("revert: 页内无已删回合", forcedAfterRevert.turns.length, 3)
    // 无关会话缓存不受影响（rv2 从未读过 → 读到的是新数据；再读一次命中缓存验证 LRU 不串）
    const other1 = revStore.sessionDetail({ sessionID: "rv2", force: true })
    const other2 = revStore.sessionDetail({ sessionID: "rv2" })
    expect("revert: 无关会话数据正常", other1.totalTurns, 2)
    expect("revert: 无关会话缓存命中", other2.generatedAt, other1.generatedAt)
    // 前端缓存失效模块单元验证（Bun 可直接 import TS 模块）
    const frontCache = require("../src/gui/session-detail") as {
      invalidateDetailCache: (sessionID?: string) => void
      markSessionReverted: (sessionID: string) => void
    }
    expect("revert: 前端失效函数可导入", typeof frontCache.invalidateDetailCache, "function")
    expect("revert: 脏标记函数可导入", typeof frontCache.markSessionReverted, "function")
    frontCache.invalidateDetailCache("rv1") // 指定 ID 清理不抛错
    frontCache.invalidateDetailCache() // 全清不抛错
    frontCache.markSessionReverted("rv1") // 标记不抛错
    revStore.close()
    require("node:fs").rmSync(revertFile)

    // 15j. 前端事件行为测试（TASK-11）：验证 handleDetailEvent 的实际分支决策
    // 与事件订阅生命周期，而非仅验证函数可导入。
    const detailModule = require("../src/gui/session-detail") as {
      handleDetailEvent: (
        kind: string,
        eventSession: string | undefined,
        ownSessionID: string,
      ) => { invalidate: boolean; forceReload: boolean; markGone: boolean }
      consumeDetailEvents: (
        events: AsyncIterable<{ type: string; data?: { sessionID?: string; id?: string } }>,
        signal: AbortSignal,
        sessionID: string,
        actions: { invalidate: () => void; markGone: () => void; forceReload: () => void },
      ) => Promise<void>
    }
    const own = "ses-own"
    // 缓存命中场景同样会建立订阅（订阅在 onMount 缓存判断之前）——分支函数
    // 是纯函数，与订阅建立解耦；这里验证各事件类型的决策输出。
    const committed = detailModule.handleDetailEvent("session.revert.committed", own, own)
    expect("15j committed → 失效缓存", committed.invalidate, true)
    expect("15j committed → 强制刷新", committed.forceReload, true)
    expect("15j committed → 不标记删除", committed.markGone, false)
    const cleared = detailModule.handleDetailEvent("session.revert.cleared", own, own)
    expect("15j cleared → 不失效缓存（数据未变）", cleared.invalidate, false)
    expect("15j cleared → 不刷新（避免重复请求）", cleared.forceReload, false)
    const deleted = detailModule.handleDetailEvent("session.deleted", own, own)
    expect("15j deleted → 失效缓存", deleted.invalidate, true)
    expect("15j deleted → 不强制刷新（不再请求）", deleted.forceReload, false)
    expect("15j deleted → 标记会话已删除", deleted.markGone, true)
    const jOther1 = detailModule.handleDetailEvent("session.revert.committed", "ses-other", own)
    const jOther2 = detailModule.handleDetailEvent("session.deleted", "ses-other", own)
    expect(
      "15j 其他会话事件 → 全部不动作",
      JSON.stringify(jOther1) === JSON.stringify({ invalidate: false, forceReload: false, markGone: false }) &&
        JSON.stringify(jOther2) === JSON.stringify({ invalidate: false, forceReload: false, markGone: false }),
      true,
    )
    // 订阅生命周期（卸载清理等价验证）：AbortController.abort() 后，for-await
    // 消费循环终止（生产组件 onCleanup 调同一 API）。mock 一个可中断生成器。
    const controller15j = new AbortController()
    let delivered = 0
    // mock 事件源：两次事件后阻塞等待（模拟真实订阅的长驻循环）。abort 后
    // 生成器在下一次恢复点检查 aborted 并退出——与真实 client.event.subscribe
    // 的 signal 联动语义一致（消费循环终止，不再拉取事件）。
    const mockSubscribe = async function* () {
      for (let i = 0; i < 10; i++) {
        if (eventsControllerMockAborted(controller15j)) return
        yield { type: "session.revert.committed", data: { sessionID: own } }
      }
    }
    const consume = async () => {
      for await (const event of mockSubscribe()) {
        delivered += 1
        if (delivered === 1) controller15j.abort() // 模拟组件卸载
      }
    }
    // eventsControllerMockAborted 在恢复点之间也能生效：mock 的 yield 是同步
    // 完成（无挂起 await），abort 后下一次 for-await 迭代调用 next() 时检查。
    function eventsControllerMockAborted(c: AbortController): boolean {
      return c.signal.aborted
    }
    await consume()
    expect("15j 卸载（abort）后订阅循环退出", delivered, 1)
    expect("15j abort 生效", controller15j.signal.aborted, true)

    // 15j 补强（TASK-13）：走生产消费函数 consumeDetailEvents 的完整行为——
    // 动作计数（不是只看分支返回值）、卸载终止、删除事件在请求竞态中的角色。
    const events15j: { type: string; data: { sessionID: string } }[] = [
      { type: "session.revert.cleared", data: { sessionID: own } }, // 无动作
      { type: "session.revert.committed", data: { sessionID: own } }, // invalidate + reload
      { type: "session.revert.committed", data: { sessionID: "ses-foreign" } }, // 他会话：无动作
      { type: "session.deleted", data: { sessionID: own } }, // invalidate + markGone
      { type: "session.revert.committed", data: { sessionID: own } }, // markGone 后仍会到达？动作继续执行但 load 短路
    ]
    const counts = { invalidate: 0, markGone: 0, forceReload: 0 }
    const lifecycle = new AbortController()
    // 生产订阅的 abort 联动：signal 中止后 mock 源停止产出
    const source15j = async function* () {
      for (const event of events15j) {
        if (lifecycle.signal.aborted) return
        yield event
      }
    }
    const consumePromise = detailModule.consumeDetailEvents(source15j(), lifecycle.signal, own, {
      invalidate: () => (counts.invalidate += 1),
      markGone: () => (counts.markGone += 1),
      forceReload: () => (counts.forceReload += 1),
    })
    await consumePromise
    expect("15j cleared 不触发任何动作后 committed 失效 1 次", counts.invalidate, 2)
    expect("15j committed 强刷 1 次 + markGone 后不刷新", counts.forceReload, 1)
    expect("15j deleted 标记删除 1 次", counts.markGone, 1)
    // 卸载终止：标记为 gone 的事件流，abort 后不再消费剩余事件
    const countsAbort = { invalidate: 0, markGone: 0, forceReload: 0 }
    const lifecycle2 = new AbortController()
    const endlessSource = async function* () {
      for (let i = 0; ; i++) {
        if (lifecycle2.signal.aborted) return
        yield { type: "session.revert.committed", data: { sessionID: own } }
      }
    }
    const consumeAbort = detailModule.consumeDetailEvents(endlessSource(), lifecycle2.signal, own, {
      invalidate: () => (countsAbort.invalidate += 1),
      markGone: () => (countsAbort.markGone += 1),
      forceReload: () => {
        countsAbort.forceReload += 1
        if (countsAbort.forceReload === 1) lifecycle2.abort() // 模拟组件卸载
      },
    })
    await consumeAbort
    expect("15j 卸载后消费循环终止（动作不再执行）", countsAbort.invalidate > countsAbort.forceReload, false)
    expect("15j 卸载后 forceReload 恰好 1 次", countsAbort.forceReload, 1)

    // 15k. 前端分页数据流回归（TASK-14）：与组件 loadMore 共用同一实现——
    // canLoadMore（入口守卫）+ loadMoreProgress（游标判定）+
    // applyLoadMoreResult（响应归并）。220 回合 fixture 驱动连续请求；
    // 10k 长会话规模验证留在 TASK-17 性能验收。
    const front = require("../src/gui/session-detail") as {
      mergeTurns: (a: readonly SessionTurn[], b: readonly SessionTurn[]) => SessionTurn[]
      withTurns: (d: SessionDetail, t: SessionTurn[]) => SessionDetail
      canLoadMore: (state: {
        sessionGone: boolean
        hasMore: boolean
        loadingMore: boolean
        refreshing: boolean
        inFlight: number
      }) => boolean
      loadMoreProgress: (
        response: { turns: readonly SessionTurn[] },
        nextBefore: number,
      ) => { progress: boolean; reason: "ok" | "empty" | "stalled" }
      applyLoadMoreResult: (current: SessionDetail, next: SessionDetail) => SessionDetail
    }
    // withTurns 只读 id/title 等展示字段之外的汇总字段——最小占位即可
    const emptyDetailLike = {
      found: true,
      id: "fk1",
      title: "t",
      projectID: "",
      projectName: "",
      directory: "",
      providerID: "unknown",
      modelID: "unknown",
      agent: "",
      timeCreated: 0,
      timeUpdated: 0,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      totalTurns: 220,
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
      generatedAt: 0,
    } as unknown as SessionDetail
    const mkTurn = (index: number, cost: number): SessionTurn =>
      ({
        index,
        seq: index,
        time: 0,
        prompt: `回合 ${index}`,
        promptTruncated: false,
        files: [],
        agents: [],
        requests: [],
        cost,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        toolCount: 0,
        errorCount: 0,
        duration: 0,
        ttft: 0,
        cacheHit: 0,
      }) as SessionTurn
    // 合并去重：重叠 index 后者胜出，结果按 index 升序
    const mergedA = front.mergeTurns([mkTurn(3, 0.1), mkTurn(4, 0.1)], [mkTurn(1, 0.1), mkTurn(2, 0.1), mkTurn(3, 0.2)])
    expect("15k 合并后无重复 index", new Set(mergedA.map((t) => t.index)).size, mergedA.length)
    expect("15k 合并后升序", mergedA.map((t) => t.index).join(","), "1,2,3,4")
    expect("15k 重叠 index 后者胜出", mergedA.find((t) => t.index === 3)?.cost, 0.2, 1e-9)
    // withTurns 的 hasMore/nextBefore 语义：首回合 index>1 表示还有更早
    const wtA = front.withTurns({ ...emptyDetailLike, turns: [] }, [mkTurn(1, 0)])
    expect("15k 首回合 index=1 → hasMore=false", wtA.hasMore, false)
    const wtB = front.withTurns({ ...emptyDetailLike, turns: [] }, [mkTurn(3, 0)])
    expect("15k 首回合 index=3 → hasMore=true", wtB.hasMore, true)
    expect("15k nextBefore=首回合 index", wtB.nextBefore, 3)
    // loadMoreProgress 四场景直测（复审要求：游标保护必须有防回归断言）
    expect("15k 游标判定 ok", front.loadMoreProgress({ turns: [mkTurn(101, 0)] }, 161).reason, "ok")
    expect("15k 游标判定空页", front.loadMoreProgress({ turns: [] }, 161).reason, "empty")
    expect("15k 游标判定持平", front.loadMoreProgress({ turns: [mkTurn(161, 0)] }, 161).reason, "stalled")
    expect("15k 游标判定倒退", front.loadMoreProgress({ turns: [mkTurn(200, 0)] }, 161).reason, "stalled")
    // 无进展/空页保留 current 回合不动（复审要求）：只终止分页，不合并异常页。
    // 回合对象保持原引用——合并路径未被执行，已有回合未被重建。
    const current15k = {
      ...emptyDetailLike,
      turns: [mkTurn(161, 0), mkTurn(162, 0)],
      hasMore: true,
      nextBefore: 161,
    } as SessionDetail
    const stalled15k = front.applyLoadMoreResult(current15k, {
      ...emptyDetailLike,
      turns: [mkTurn(161, 0), mkTurn(162, 0)],
      hasMore: true,
      nextBefore: 161,
    } as SessionDetail)
    expect("15k 无进展回合数不变", stalled15k.turns.length, 2)
    expect("15k 无进展回合对象原样保留", stalled15k.turns[0] === current15k.turns[0], true)
    expect("15k 无进展终止分页", stalled15k.hasMore, false)
    expect("15k 无进展游标归零", stalled15k.nextBefore, 0)
    const empty15k = front.applyLoadMoreResult(current15k, {
      ...emptyDetailLike,
      turns: [],
      hasMore: false,
      nextBefore: 0,
    } as SessionDetail)
    expect("15k 空页保留已加载回合", empty15k.turns.length, 2)
    expect("15k 空页终止分页", empty15k.hasMore, false)
    // 有进展：合并新增回合、游标前移
    const grown15k = front.applyLoadMoreResult(current15k, {
      ...emptyDetailLike,
      turns: [mkTurn(159, 0), mkTurn(160, 0)],
      hasMore: true,
      nextBefore: 159,
    } as SessionDetail)
    expect("15k 有进展回合数增加", grown15k.turns.length, 4)
    expect("15k 有进展游标前移", grown15k.nextBefore, 159)
    // 连续三页模拟（服务端 10k 会话）：每页 60 回合，合并后无重复、无乱序、
    // 游标单调递减、第三页后继续有 hasMore（前端可继续加载）。
    // 自建轻量分页库：220 回合（首页 60 + 二页 60 + 三页 60 + 剩余 40）
    const file15k = `${process.env.TMPDIR ?? "/tmp"}/uc-f15k-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const db15k = new Database(file15k)
    db15k.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
      CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
    `)
    db15k.exec(`INSERT INTO project VALUES ('pf', NULL, '/tmp/f15k', 1)`)
    db15k.prepare("INSERT INTO session_v2 (id, project_id, title, time_created, time_updated) VALUES ('fk1', 'pf', '前端分页', 1, 1)").run()
    const msg15k = db15k.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, 'fk1', ?, ?, ?, ?, ?)")
    const pay15k = JSON.stringify({ cost: 0.001, model: { providerID: "prov-x", id: "model-a" }, agent: "build", tokens: {}, time: { created: 1, completed: 10 } })
    db15k.transaction(() => {
      for (let i = 0; i < 220; i++) {
        msg15k.run(`k${i}u`, "user", i * 2 + 1, i, i, JSON.stringify({ text: `回合 ${i + 1}` }))
        msg15k.run(`k${i}a`, "assistant", i * 2 + 2, i, i, pay15k)
      }
    })()
    db15k.close()
    const store15k = new UsageStore(file15k, () => {})
    // 首屏由 load() 建立分页状态（withTurns）；之后三次 loadMore 全部走
    // 生产函数 applyLoadMoreResult——与组件 loadMore 的响应处理完全同源。
    const firstPage15k = store15k.sessionDetail({ sessionID: "fk1", limit: 60, force: true })
    let frontDetail = front.withTurns(
      { ...emptyDetailLike, turns: [], hasMore: false, nextBefore: 0 } as SessionDetail,
      [...firstPage15k.turns],
    )
    const seenIndexes = new Set<number>()
    let lastCostSum = 0
    for (const turn of frontDetail.turns) {
      expect("15k 首屏无重复 index", seenIndexes.has(turn.index), false)
      seenIndexes.add(turn.index)
      lastCostSum += turn.cost
    }
    expect("15k 首屏 60 回合且 hasMore", frontDetail.turns.length === 60 && frontDetail.hasMore, true)
    // 模拟组件 loadMore 完整调用链：入口守卫 → 服务端游标请求 → 归并。
    // 连续调用直到 hasMore=false，断言请求次数与每页追加/游标推进。
    const guardState = {
      sessionGone: false,
      loadingMore: false,
      refreshing: false,
      inFlight: 0,
    }
    let loadMoreCalls = 0
    const runLoadMore = () => {
      if (!front.canLoadMore({ ...guardState, hasMore: frontDetail.hasMore })) return
      loadMoreCalls += 1
      const pageDetail = store15k.sessionDetail({
        sessionID: "fk1",
        beforeTurn: frontDetail.nextBefore,
        limit: 60,
        force: true,
      })
      const beforeCount = frontDetail.turns.length
      const beforeCursor = frontDetail.nextBefore
      frontDetail = front.applyLoadMoreResult(frontDetail, pageDetail)
      expect(`15k 第 ${loadMoreCalls + 1} 页仅追加新增回合`, frontDetail.turns.length, beforeCount + pageDetail.turns.length)
      expect(`15k 第 ${loadMoreCalls + 1} 页游标前移`, frontDetail.nextBefore < beforeCursor, true)
      for (const turn of pageDetail.turns) {
        expect(`15k 第 ${loadMoreCalls + 1} 页无重复 index`, seenIndexes.has(turn.index), false)
        seenIndexes.add(turn.index)
        lastCostSum += turn.cost
      }
    }
    runLoadMore()
    runLoadMore()
    runLoadMore()
    expect("15k 三次 loadMore 请求", loadMoreCalls, 3)
    // 到达终点后守卫拦下后续点击：不再请求
    runLoadMore()
    expect("15k 终点后不再请求", loadMoreCalls, 3)
    expect("15k 四页合计 220 回合", frontDetail.turns.length, 220)
    expect("15k 序号连续无乱序（1..220）", frontDetail.turns.map((t) => t.index).join(","), Array.from({ length: 220 }, (_, i) => i + 1).join(","))
    expect("15k Σ回合cost 与页数据一致", frontDetail.turns.reduce((sum, t) => sum + t.cost, 0), 220 * 0.001, 1e-9)
    expect("15k 覆盖回合 cost 全量对账", lastCostSum, 220 * 0.001, 1e-9)
    expect("15k 到达终点 hasMore=false", frontDetail.hasMore, false)
    expect("15k 到达终点 nextBefore=0", frontDetail.nextBefore, 0)
    // 服务端重复返回当前页（游标不前进）：保留回合不动、终止分页，
    // 且下一次点击被入口守卫拦下——不会无限请求同一页。
    const repeatCurrent = {
      ...emptyDetailLike,
      turns: [...firstPage15k.turns],
      hasMore: true,
      nextBefore: 161,
    } as SessionDetail
    const stalledCallCount = loadMoreCalls
    const stalledResult = front.applyLoadMoreResult(repeatCurrent, {
      ...repeatCurrent,
      turns: [...firstPage15k.turns],
    })
    expect("15k 重复页保留回合引用", stalledResult.turns[0] === repeatCurrent.turns[0], true)
    expect("15k 重复页终止分页", stalledResult.hasMore, false)
    expect(
      "15k 重复页后守卫拒绝请求",
      front.canLoadMore({ ...guardState, hasMore: stalledResult.hasMore }),
      false,
    )
    expect("15k 重复页未额外请求", loadMoreCalls, stalledCallCount)
    // 守卫各维度单独生效：删除 / 加载中 / 刷新中 / 请求在途
    expect(
      "15k 删除状态守卫拒绝",
      front.canLoadMore({ ...guardState, sessionGone: true, hasMore: true }),
      false,
    )
    expect(
      "15k 加载中守卫拒绝",
      front.canLoadMore({ ...guardState, loadingMore: true, hasMore: true }),
      false,
    )
    expect(
      "15k 刷新中守卫拒绝",
      front.canLoadMore({ ...guardState, refreshing: true, hasMore: true }),
      false,
    )
    expect(
      "15k 请求在途时守卫拒绝",
      front.canLoadMore({ ...guardState, hasMore: true, inFlight: 1 }),
      false,
    )
    store15k.close()
    require("node:fs").rmSync(file15k)

    // 15h. 查询计划自动化回归（TASK-09，复审修正后）：直接引用 store.ts 导出的
    // SESSION_PAGE_SQLS——生产查询与测试共用同一份 SQL 文本，改生产不改测试
    // 不再可能。断言命中索引（SEARCH/COVERING）、无全表扫描、无临时排序。
    // 只读约束下不断言索引名称存在性（真实库缺索引时插件仍可用，仅性能退化）。
    const planFile = `${process.env.TMPDIR ?? "/tmp"}/uc-plan-${process.pid}-${Math.random().toString(36).slice(2)}.db`
    const dbPlan = new Database(planFile)
    dbPlan.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT, time_active INTEGER);
      CREATE INDEX session_message_time_created_idx ON session_message (time_created);
      CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
      CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
    `)
    const planQuery = (sql: string): string => {
      const rows = dbPlan.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
      return rows.map((r) => r.detail).join(" | ")
    }
    // 占位符填具体值（EXPLAIN 不执行，参数只影响计划文本展示）
    const planChecks: [string, string, RegExp][] = [
      [
        "user 边界探测（页起点）",
        SESSION_PAGE_SQLS.userBoundaries.replace(/\?/g, "100").replace(/LIMIT \d+/, "LIMIT 61"),
        /SEARCH( COVERING)? session_message USING( COVERING)? INDEX session_message_session_type_seq_idx/,
      ],
      [
        "会话首条消息（头部合成回合判定）",
        SESSION_PAGE_SQLS.firstMessage.replace(/\?/g, "'x'"),
        /SEARCH session_message USING INDEX session_message_session_seq_idx/,
      ],
      [
        "本页消息读取（唯一带 data 本体的查询）",
        SESSION_PAGE_SQLS.pageMessages.replace(/\?/g, "1").replace(/seq < \d+/, "seq < 100"),
        /SEARCH session_message USING INDEX session_message_session_seq_idx/,
      ],
      [
        "游标前回合计数",
        SESSION_PAGE_SQLS.turnCountBefore.replace(/\?/g, "100"),
        /SEARCH( COVERING)? session_message USING( COVERING)? INDEX session_message_session_type_seq_idx/,
      ],
      [
        "汇总标量聚合（json_extract，无 data 本体列）",
        SESSION_PAGE_SQLS.summaryScalars.replace(/\?/g, "'x'"),
        /SEARCH( COVERING)? session_message USING( COVERING)? INDEX session_message_session_type_seq_idx/,
      ],
      [
        "最后一条消息 seq",
        SESSION_PAGE_SQLS.lastSeq.replace(/\?/g, "'x'"),
        /SEARCH( COVERING)? session_message USING( COVERING)? INDEX session_message_session_seq_idx/,
      ],
      // 工具统计（json_each 展开）：引用生产 SQL（TASK-12 共用），占位符填实参。
      // 需要回表读 data 参与 json_extract → 非 COVERING；SCAN je 是 json_each
      // 虚拟表展开（非会话表扫描，由「无全表扫描」断言区分）。
      [
        "工具统计 json_each 聚合（生产 SQL）",
        SESSION_PAGE_SQLS.toolStats.replace(/\?/g, "'x'"),
        /SEARCH sm USING INDEX session_message_session_type_seq_idx/,
      ],
    ]
    for (const [label, sql, expected] of planChecks) {
      const detail = planQuery(sql)
      expect(`${label} 命中索引（SEARCH）`, expected.test(detail), true)
      expect(`${label} 无全表扫描`, /SCAN session_message(?!_)/.test(detail), false)
      expect(`${label} 无临时排序`, /TEMP B-TREE/.test(detail), false)
    }
    dbPlan.close()
    require("node:fs").rmSync(planFile)
  }

  if (failures.length > 0) {
    console.error("synthetic data regressions:")
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log("synthetic ok: 600 sessions across 2 projects, attribution complete beyond list cap, cold-start stable")
}

void main()
