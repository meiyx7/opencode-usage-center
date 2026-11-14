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
/** 维度预期键与统计实现一致：模型 = provider:model，agent 原样，无项目 = 空串。 */
const expected = JSON.parse(readFileSync(input.expectedPath, "utf8")) as {
  sessions: number
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  projectCost: Record<string, number>
  modelCost: Record<string, number>
  agentCost: Record<string, number>
  projectTokens: Record<string, number>
  modelTokens: Record<string, number>
  agentTokens: Record<string, number>
}

/** macOS ru_maxrss 单位为 bytes；Linux getrusage 惯例为 KB。统一换算成 bytes。 */
const toBytes = (maxRss: number): number => (process.platform === "darwin" ? maxRss : maxRss * 1024)
// 高水位口径：maxRSS 是进程生命周期峰值（只增不减），统计阶段的内存增量必须
// 用「统计前 maxRSS − 统计后 maxRSS」的高水位差，而不是与当前 RSS 相减——
// 若运行时启动阶段曾冲高，后者会把启动峰值误算成本次统计的增量。
const maxRssNow = () => toBytes(process.resourceUsage().maxRSS)
const rssNow = () => toBytes(process.memoryUsage.rss())
const baselineRss = rssNow()
const baselineHigh = maxRssNow()

const store = new UsageStore(input.file, () => {})
const to = Date.now()
const coldStart = performance.now()
const cold = store.snapshot({ from: 0, to, projectID: undefined, force: true })
const coldMs = performance.now() - coldStart

const warmStart = performance.now()
const warm = store.snapshot({ from: 0, to, projectID: undefined, force: true })
const warmMs = performance.now() - warmStart
const warm2Start = performance.now()
const warm2 = store.snapshot({ from: 0, to, projectID: undefined, force: true })
const warm2Ms = performance.now() - warm2Start
// 峰值采集放在全部统计步骤结束之后：三次 snapshot 的高水位都计入。
const peakHigh = maxRssNow()
const stageDelta = peakHigh - baselineHigh

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
// 三维度逐 Key 对账（评审 P0：汇总相等不能证明每笔费用归属正确——某模型
// 错配另一模型时总和不变。与独立预期值逐项比较，并双向检查多余/缺失 Key）。
const expectMap = (
  label: string,
  actualRows: { key: string; cost: number; tokens: number }[],
  wantCost: Record<string, number>,
  wantTokens: Record<string, number>,
) => {
  const actualCost: Record<string, number> = {}
  const actualTokens: Record<string, number> = {}
  for (const row of actualRows) {
    actualCost[row.key] = (actualCost[row.key] ?? 0) + row.cost
    actualTokens[row.key] = (actualTokens[row.key] ?? 0) + row.tokens
  }
  const keys = new Set([...Object.keys(actualCost), ...Object.keys(wantCost)])
  for (const key of [...keys].sort()) {
    if (!(key in wantCost)) {
      failures.push(`${label}: 多余 Key "${key}"（统计有、预期无，cost=${actualCost[key]}）`)
      continue
    }
    if (!(key in actualCost)) {
      failures.push(`${label}: 缺失 Key "${key}"（预期有、统计无，cost=${wantCost[key]}）`)
      continue
    }
    expect(`${label}[${key}] cost`, actualCost[key], wantCost[key], 1e-6)
    expect(`${label}[${key}] tokens`, actualTokens[key], wantTokens[key], 0)
  }
}
// 模型维度：键含 provider（统计实现按 provider:model 分行）。
expectMap(
  "model",
  cold.models.map((m) => ({ key: `${m.providerID}:${m.modelID}`, cost: m.cost, tokens: m.input + m.output })),
  expected.modelCost,
  expected.modelTokens,
)
// Agent 维度（消息未标注 agent 时统计归入 unknown 桶）。
expectMap(
  "agent",
  cold.agents.map((a) => ({ key: a.agent, cost: a.cost, tokens: a.input + a.output })),
  expected.agentCost,
  expected.agentTokens,
)
// 项目维度（无项目归属的会话归入空串桶）。
expectMap(
  "project",
  cold.projectUsage.map((p) => ({ key: p.projectID, cost: p.cost, tokens: p.input + p.output })),
  expected.projectCost,
  expected.projectTokens,
)
// 冷/热/再热三路径一致
// 缓存淘汰后统计完整性（60 月 > DAY_CACHE_LIMIT 600 天）
const seriesWithData = cold.series.filter((p) => p.requests > 0).length
expect("activeDays matches series", cold.totals.activeDays, seriesWithData)
// 未知归属桶保留（无项目会话约 6% 必然产生空桶）
expect("projectless bucket kept", cold.projectUsage.some((p) => p.projectID === ""), true)

const result = {
  failures,
  baselineRss,
  baselineHigh,
  peakHigh,
  stageDelta,
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
