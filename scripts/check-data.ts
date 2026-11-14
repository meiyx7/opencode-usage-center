import { UsageStore, defaultDatabasePath } from "../src/server/store"

const store = new UsageStore(defaultDatabasePath(), (message, detail) => {
  console.warn(message, detail ?? "")
})

const now = Date.now()
/** 各范围的聚合耗时，供末尾的性能基线断言。 */
const timings: Record<string, number> = {}
for (const [label, days] of [
  ["today", 1],
  ["7d", 7],
  ["30d", 30],
] as const) {
  const from = days === 1 ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : now - days * 86_400_000
  const started = performance.now()
  const snapshot = store.snapshot({ from, to: now, projectID: undefined, force: true })
  const elapsed = Math.round(performance.now() - started)
  timings[label] = elapsed
  console.log(
    label,
    `${elapsed}ms`,
    "req",
    snapshot.totals.requests,
    "tokens",
    snapshot.totals.tokens.input + snapshot.totals.tokens.output,
    "cost",
    snapshot.totals.cost.toFixed(2),
    "models",
    snapshot.models.length,
    "series",
    snapshot.series.length,
    "latency",
    snapshot.latency.samples,
    `${snapshot.latency.ttftP50.toFixed(1)}s/`,
    `${snapshot.latency.ttftP95.toFixed(1)}s`,
    "db",
    snapshot.database.ok,
    snapshot.database.error,
  )
}

const quota = await store.quota(true)
console.log("quota", JSON.stringify(quota))
store.close()

/**
 * 性能回归基线（P0）：30 天聚合必须稳定在阈值内。超出即退出非零，CI 和
 * 本机都能发现性能退化。阈值按方案 §5.5（30 天 P95 < 1.5s）放宽到 2s，
 * 给 CI 机器留余量；「today」走今天现算路径，单独 300ms 上限。
 */
const BASELINES_MS: Record<string, number> = { today: 300, "7d": 800, "30d": 2000 }
const regressions = Object.entries(BASELINES_MS).filter(([label, limit]) => {
  const row = timings[label]
  return row !== undefined && row > limit
})
if (regressions.length > 0) {
  console.error(
    "performance regression:",
    regressions.map(([label, limit]) => `${label} ${timings[label]}ms > ${limit}ms`).join(", "),
  )
  process.exit(1)
}
console.log("perf ok", Object.entries(BASELINES_MS).map(([label, limit]) => `${label}<=${limit}ms`).join(" "))
