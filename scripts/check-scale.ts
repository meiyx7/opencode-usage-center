/**
 * 大规模历史数据性能测试（数据可靠性收尾批次任务 3；评审修订版 2）。
 *
 * 三档规模：12 月 × 1k / 36 月 × 10k / 60 月 × 50k 会话，数据特征覆盖
 * 多项目、多模型、多 agent、不同 token/cost/耗时、部分无项目归属、
 * 部分缺统计字段、非零 reasoning/cacheWrite。全部数据可复现（固定种子）。
 *
 * 测量方式（评审二轮修订）：
 * - 统计阶段在独立子进程（scripts/scale-worker.ts）中执行：数据构造
 *   （父进程）不污染统计的 RSS 基线。
 * - 内存增量用 maxRSS 高水位差：统计前记一次 maxRSS，全部统计步骤结束后
 *   再记一次，两者之差即统计阶段增量——不与当前 RSS 相减（运行时启动
 *   阶段的历史峰值会污染该口径）。平台单位换算：macOS ru_maxrss 为 bytes，
 *   Linux 为 KB。
 * - 报告启动基线 RSS、基线高水位、统计后高水位、统计阶段增量四项。
 *
 * 对账方式（评审二轮修订：维度逐 Key 对账）：
 * - 数据生成时独立累计预期值（sessions/requests/各 Token 分量/cost/
 *   三维度的费用与有效 Token），不从被测统计结果反推；全部用可序列化的
 *   普通对象（第一版误用 Map，JSON.stringify 会丢成 {}）。
 * - worker 对每个维度逐 Key 比较（模型键含 provider），双向检查多余/
 *   缺失 Key——汇总相等不能证明每笔费用归属正确。
 *
 * 用法：bun scripts/check-scale.ts [base|medium|large|all]（默认 all）；
 * npm 脚本 test:scale(base) / test:scale:medium / test:scale:large /
 * test:scale:all。
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

/** 可复现伪随机：mulberry32。种子由规模决定，同档数据逐次一致。 */
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

/** 独立累计的预期值（数据生成阶段填充，与被测统计完全无关）。 */
interface Expected {
  sessions: number
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  /** 维度费用预期：键为 projectID（无项目为空串）/ agent / provider:model。 */
  projectCost: Record<string, number>
  modelCost: Record<string, number>
  agentCost: Record<string, number>
  /** 维度有效 Token 预期（input+output），与费用分开逐 Key 对账。 */
  projectTokens: Record<string, number>
  modelTokens: Record<string, number>
  agentTokens: Record<string, number>
}

function newExpected(): Expected {
  return {
    sessions: 0,
    requests: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    projectCost: {},
    modelCost: {},
    agentCost: {},
    projectTokens: {},
    modelTokens: {},
    agentTokens: {},
  }
}

function bump(costMap: Record<string, number>, tokenMap: Record<string, number>, key: string, cost: number, tokens: number): void {
  costMap[key] = (costMap[key] ?? 0) + cost
  tokenMap[key] = (tokenMap[key] ?? 0) + tokens
}

/**
 * 构造大规模合成库，同时独立累计预期值。
 * 返回 DB 文件路径、消息总数与预期对象（供子进程对账用，序列化为 JSON）。
 */
function buildDb(scale: ScaleCase, dir: string): { file: string; messages: number; expectedPath: string } {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  const { writeFileSync } = require("node:fs") as typeof import("node:fs")
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
  const expected = newExpected()
  let messages = 0
  let batch: unknown[][] = []
  const flush = () => {
    db.transaction(() => {
      for (const row of batch) insertMessage.run(...row)
    })()
    batch = []
  }

  for (let s = 0; s < scale.sessions; s++) {
    // 会话起点从现在往回铺满 months 个月；部分会话无项目（NULL，约 6%）
    const projectless = s % 17 === 0
    const projectID = projectless ? null : projects[s % projects.length]
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
      const reasoning = rand() < 0.4 ? Math.floor(rand() * 5_000) : 0
      const cacheRead = Math.floor(rand() * 200_000)
      const cacheWrite = rand() < 0.3 ? Math.floor(rand() * 20_000) : 0
      const cost = Math.round(rand() * 50_000) / 100_000 // $0-0.5
      sessionCost += cost
      // 2% 消息缺整个 tokens 对象（与 cost 一起缺失）
      const missing = rand() < 0.02
      const payload = missing
        ? JSON.stringify({ model: { providerID, id: modelID }, agent })
        : JSON.stringify({
            model: { providerID, id: modelID },
            agent,
            cost,
            tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
            time: { created: at, completed: at + Math.floor(500 + rand() * 30_000) },
          })
      batch.push([`m${s}-${m}`, `s${s}`, at, at, payload])
      messages += 1
      // 独立预期值：与聚合的 num() 语义一致——缺失字段按 0
      const eCost = missing ? 0 : cost
      const eInput = missing ? 0 : input
      const eOutput = missing ? 0 : output
      const eReasoning = missing ? 0 : reasoning
      const eCacheRead = missing ? 0 : cacheRead
      const eCacheWrite = missing ? 0 : cacheWrite
      expected.requests += 1
      expected.cost += eCost
      expected.input += eInput
      expected.output += eOutput
      expected.reasoning += eReasoning
      expected.cacheRead += eCacheRead
      expected.cacheWrite += eCacheWrite
      // 维度预期键与统计实现一致：模型 = provider:model，agent 原样，无项目 = 空串。
      // 有效 Token 分量与费用分开累计，两个维度都要逐 Key 对账。
      const eTokens = eInput + eOutput
      bump(expected.modelCost, expected.modelTokens, `${providerID}:${modelID}`, eCost, eTokens)
      bump(expected.agentCost, expected.agentTokens, agent, eCost, eTokens)
      bump(expected.projectCost, expected.projectTokens, projectless ? "" : projectID!, eCost, eTokens)
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
    expected.sessions += 1
    if (s % 5000 === 0) flush()
  }
  flush()
  db.close()
  const expectedPath = `${dir}/expected-${scale.sessions}.json`
  writeFileSync(expectedPath, JSON.stringify(expected))
  return { file, messages, expectedPath }
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(0)}MB`
}


function runScale(scale: ScaleCase, dir: string, cacheDir: string): boolean {
  console.log(`\n=== ${scale.name} ===`)
  const t0 = performance.now()
  const { file, messages, expectedPath } = buildDb(scale, dir)
  console.log(`数据构造 ${fmtMB(require("node:fs").statSync(file).size)} DB / ${messages} 消息 / ${(performance.now() - t0).toFixed(0)}ms`)

  // 独立缓存目录：冷缓存从空目录开始
  const coldCache = `${cacheDir}/cold-${scale.sessions}`
  require("node:fs").mkdirSync(coldCache, { recursive: true })

  // 统计阶段在独立子进程中执行：父进程的数据构造不进入子进程的内存历史。
  // 注意必须用文件模式（scripts/scale-worker.ts）而不是 bun -e：Bun 1.3 对
  // 约 4KB 以上的 -e 脚本会静默不执行（exit 0、无输出、无错误）。
  const outPath = `${dir}/result-${scale.sessions}.json`
  const childInputPath = `${dir}/input-${scale.sessions}.json`
  require("node:fs").writeFileSync(
    childInputPath,
    JSON.stringify({ file, expectedPath, outPath }),
  )
  const workerPath = require.resolve("./scale-worker")
  const child = Bun.spawnSync({
    cmd: [process.execPath, workerPath, workerPath, childInputPath],
    env: { ...process.env, XDG_CACHE_HOME: coldCache },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (child.exitCode !== 0) {
    console.error(`${scale.name} 子进程失败（exit ${child.exitCode}）:`)
    console.error(child.stderr.toString().slice(0, 2000))
    // 对账失败（exit 2）时结果文件仍写出了失败明细，尽量打印
    try {
      const r = JSON.parse(require("node:fs").readFileSync(outPath, "utf8"))
      for (const f of r.failures ?? []) console.error(`  - ${f}`)
    } catch {
      // 结果文件不存在就以 stderr 为准
    }
    return false
  }
  const r = JSON.parse(require("node:fs").readFileSync(outPath, "utf8"))

  // 子进程已完成全部对账断言（失败会 exit 2）；这里汇总展示
  console.log(`冷缓存  ${r.coldMs.toFixed(0)}ms  req ${r.actual.requests}  cost $${r.actual.cost.toFixed(2)}`)
  console.log(`热缓存  ${r.warmMs.toFixed(0)}ms  再热 ${r.warm2Ms.toFixed(0)}ms`)
  console.log(`内存  启动基线 RSS ${fmtMB(r.baselineRss)} · 基线高水位 ${fmtMB(r.baselineHigh)} · 统计后高水位 ${fmtMB(r.peakHigh)} · 统计阶段增量 ${fmtMB(r.stageDelta)}`)
  console.log(`series ${r.seriesWithData} 天有数据 / 模型 ${r.modelRows} / 项目 ${r.projectRows} / agent ${r.agentRows} 行`)

  console.log(`${scale.name} 通过（独立预期值对账 + 三维度对账全部一致）`)
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
  console.log("\nscale ok: independent expectations reconciled, cold/warm parity, per-stage memory measured")
}

main()
