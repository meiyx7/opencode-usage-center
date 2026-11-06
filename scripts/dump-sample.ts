import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { UsageStore, defaultDatabasePath } from "../src/server/store"

const store = new UsageStore(defaultDatabasePath())
const now = Date.now()
const snapshot = store.snapshot({ from: now - 30 * 86_400_000, to: now, force: true })
const quota = await store.quota(true)
store.close()
writeFileSync(
  join(import.meta.dir, "..", "preview", "sample.json"),
  JSON.stringify({ snapshot, quota }, null, 2),
)
console.log("wrote preview/sample.json", snapshot.totals.requests, quota.available)
