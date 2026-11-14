/**
 * check-scale 的统计阶段子进程（独立进程执行，数据构造的内存不进入本进程历史）。
 *
 * 入参：argv[2] = UsageStore 模块路径，argv[3] = 输入 JSON 路径。
 * 输入 JSON：{ file, expectedPath, outPath }
 * 输出：向 outPath 写测量结果 JSON；对账失败时 exit 2 并在结果中带 failures。
 *
 * 注意：不要用 `bun -e <script>` 方式替代本文件——Bun 1.3 对约 4KB 以上的
 * -e 脚本会静默不执行（exit 0、无输出），文件模式没有这个问题。
 */
import { UsageStore } from "../src/server/store"
import { readFileSync, writeFileSync } from "node:fs"

const input = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as {
  file: string
  expectedPath: string
  outPath: string
}
const expected = JSON.parse(readFileSync(input.expectedPath, "utf8")) as {
  sessions: number
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** macOS ru_maxrss 单位为 bytes；Linux getrusage 惯例为 KB。统一换算成 bytes。 */
const toBytes = (maxRss: number): number => (process.platform === "darwin" ? maxRss : maxRss * 1024)
const rssNow = () => toBytes(process.memoryUsage.rss())
const baseline = rssNow()

const store = new UsageStore(input.file, () => {})
const to = Date.now()
const coldStart = performance.now()
const cold = store.snapshot({ from: 0, to, projectID: undefined, force: true })
const coldMs = performance.now() - coldStart
// 进程峰值（含基线 + 本次统计）
const peakProc = toBytes(process.resourceUsage().maxRSS)

const warmStart = performance.now()
const warm = store.snapshot({ from: 0, to, projectID: undefined, force: true })
const warmMs = performance.now() - warmStart
const warm2Start = performance.now()
const warm2 = store.snapshot({ from: 0, to, projectID: undefined, force: true })
const warm2Ms = performance.now() - warm2Start

const failures: string[] = []
const expect = (label: string, actual: unknown, wanted: unknown, tolerance = 0) => {
  const ok =
    typeof actual === "number" && typeof wanted === "number"
      ? Math.abs(actual - wanted) <= tolerance
      : actual === wanted
  if (!ok) failures.push(`${label}: got ${actual}, want ${wanted}`)
}

// 独立预期值对账（评审核心要求：证明数据没有被整体漏算，不从统计结果反推）
expect("sessions = expected", cold.totals.sessions, expected.sessions)
expect("requests = expected", cold.totals.requests, expected.requests)
expect("input = expected", cold.totals.tokens.input, expected.input)
expect("output = expected", cold.totals.tokens.output, expected.output)
expect("reasoning = expected", cold.totals.tokens.reasoning, expected.reasoning)
expect("cacheRead = expected", cold.totals.tokens.cacheRead, expected.cacheRead)
expect("cacheWrite = expected", cold.totals.tokens.cacheWrite, expected.cacheWrite)
expect("cost = expected", cold.totals.cost, expected.cost, 1e-6)
// 冷/热/再热三路径一致
expect("warm requests = cold", warm.totals.requests, cold.totals.requests)
expect("warm cost = cold", warm.totals.cost, cold.totals.cost, 1e-9)
expect("warm2 cost = cold", warm2.totals.cost, cold.totals.cost, 1e-9)
// 三维度费用与 Token 对账
expect("Σ model cost = total", cold.models.reduce((s, m) => s + m.cost, 0), cold.totals.cost, 1e-6)
expect("Σ agent cost = total", cold.agents.reduce((s, a) => s + a.cost, 0), cold.totals.cost, 1e-6)
expect("Σ project cost = total", cold.projectUsage.reduce((s, p) => s + p.cost, 0), cold.totals.cost, 1e-6)
expect("Σ model tokens = total", cold.models.reduce((s, m) => s + m.input + m.output, 0), cold.totals.tokens.input + cold.totals.tokens.output)
expect("Σ agent tokens = total", cold.agents.reduce((s, a) => s + a.input + a.output, 0), cold.totals.tokens.input + cold.totals.tokens.output)
expect("Σ project tokens = total", cold.projectUsage.reduce((s, p) => s + p.input + p.output, 0), cold.totals.tokens.input + cold.totals.tokens.output)
// 缓存淘汰后统计完整性（60 月 > DAY_CACHE_LIMIT 600 天）
const seriesWithData = cold.series.filter((p) => p.requests > 0).length
expect("activeDays matches series", cold.totals.activeDays, seriesWithData)
// 未知归属桶保留（无项目会话约 6% 必然产生空桶）
expect("projectless bucket kept", cold.projectUsage.some((p) => p.projectID === ""), true)

const result = {
  failures,
  baseline,
  peakProc,
  coldMs,
  warmMs,
  warm2Ms,
  actual: {
    sessions: cold.totals.sessions,
    requests: cold.totals.requests,
    input: cold.totals.tokens.input,
    output: cold.totals.tokens.output,
    reasoning: cold.totals.tokens.reasoning,
    cacheRead: cold.totals.tokens.cacheRead,
    cacheWrite: cold.totals.tokens.cacheWrite,
    cost: cold.totals.cost,
  },
  seriesWithData,
  modelRows: cold.models.length,
  projectRows: cold.projectUsage.length,
  agentRows: cold.agents.length,
}
writeFileSync(input.outPath, JSON.stringify(result))
store.close()
if (failures.length > 0) process.exit(2)
