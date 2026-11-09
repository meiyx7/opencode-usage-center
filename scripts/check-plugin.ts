import { Schema } from "effect"
import plugin from "../dist/index.js"
import { Quota, SessionDetail, Snapshot } from "../src/contract.ts"

const handlers: Record<string, (input: any) => Promise<any>> = {}
const ctx = {
  options: {},
  rpc: {
    register: async (_definition: unknown, next: Record<string, (input: any) => Promise<any>>) => {
      Object.assign(handlers, next)
      return { dispose: async () => {} }
    },
  },
}

await (plugin as any).setup(ctx)
const now = Date.now()
const snapshot = await handlers.snapshot!({ from: now - 30 * 86_400_000, to: now, force: true })
const quota = await handlers.quota!({ force: true })
const sessionID = snapshot.sessions[0]?.id ?? "ses_missing"
const session = await handlers.sessionDetail!({ sessionID, force: true })
const sessionPage = await handlers.sessionDetail!({ sessionID, limit: 5 })
const olderPage = sessionPage.hasMore
  ? await handlers.sessionDetail!({ sessionID, limit: 5, beforeTurn: sessionPage.nextBefore })
  : undefined

function invalid(value: unknown, path: string, out: string[]): void {
  if (value === undefined) {
    out.push(`${path} is undefined`)
    return
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    out.push(`${path} is not finite (${value})`)
    return
  }
  if (typeof value === "bigint") {
    out.push(`${path} is bigint`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => invalid(item, `${path}[${index}]`, out))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) invalid(item, `${path}.${key}`, out)
  }
}

const bad: string[] = []
invalid(snapshot, "snapshot", bad)
invalid(quota, "quota", bad)
invalid(session, "session", bad)
invalid(sessionPage, "sessionPage", bad)
if (olderPage) invalid(olderPage, "olderPage", bad)
if (bad.length) {
  console.error("JSON problems:", bad)
  process.exit(1)
}

// This is the same failure mode the host RPC encoder rejected before:
// an explicit undefined in an optional field made the whole response invalid.
Schema.encodeSync(Snapshot)(snapshot)
Schema.encodeSync(Quota)(quota)
Schema.encodeSync(SessionDetail)(session)
Schema.encodeSync(SessionDetail)(sessionPage)
if (olderPage) Schema.encodeSync(SessionDetail)(olderPage)

console.log(
  "snapshot",
  snapshot.totals.requests,
  snapshot.totals.cost.toFixed(2),
  snapshot.models.length,
  snapshot.series.length,
  snapshot.latency.ttftP95.toFixed(1),
  snapshot.database.ok,
  snapshot.credentials.length,
)
console.log("quota", quota.available, quota.providers.map((p) => `${p.id}:${p.meters.length}`).join(","), quota.error)
console.log(
  "session",
  session.found,
  session.title.slice(0, 20),
  session.turns.length,
  session.requestCount,
  session.toolCount,
  session.cacheHit.toFixed(3),
)
console.log(
  "session page",
  sessionPage.turns.length,
  sessionPage.hasMore,
  sessionPage.nextBefore,
  olderPage ? `${olderPage.turns.length} older` : "no older page",
)
console.log("wire ok")
