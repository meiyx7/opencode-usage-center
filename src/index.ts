import { Plugin } from "@opencode/plugin"
import { Usage } from "./contract"
import { defaultDatabasePath, UsageStore } from "./server/store"

/**
 * RPC responses are JSON values. An explicit `undefined` property (for example
 * `expires: undefined` on an API key) makes the host reject the whole response
 * with `Expected JSON value at ["output"]`, so strip those before returning.
 */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Server half. It owns the read-only SQLite access and the OpenCode Go quota
 * request, so the window never sees a credential or a full database row.
 */
export default Plugin.define({
  id: "usage-center",
  async setup(ctx) {
    const configured = typeof ctx.options.dbPath === "string" ? ctx.options.dbPath : ""
    const store = new UsageStore(configured || defaultDatabasePath(), (message, detail) => {
      // The host routes plugin logs into opencode.log. Keep it to one line.
      console.warn(`[usage-center] ${message}${detail ? `: ${String(detail)}` : ""}`)
    })

    const registration = await ctx.rpc.register(Usage, {
      snapshot: async (input) => wire(store.snapshot(input)),
      quota: async (input) => wire(await store.quota(Boolean(input.force))),
    })

    return async () => {
      await registration.dispose()
      store.close()
    }
  },
})
