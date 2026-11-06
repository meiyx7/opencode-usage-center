import { UsageStore, defaultDatabasePath } from "../src/server/store"

const store = new UsageStore(defaultDatabasePath(), (message, detail) => {
  console.warn(message, detail ?? "")
})

const now = Date.now()
for (const [label, days] of [
  ["today", 1],
  ["7d", 7],
  ["30d", 30],
] as const) {
  const from = days === 1 ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : now - days * 86_400_000
  const started = performance.now()
  const snapshot = store.snapshot({ from, to: now, projectID: undefined, force: true })
  const elapsed = Math.round(performance.now() - started)
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
