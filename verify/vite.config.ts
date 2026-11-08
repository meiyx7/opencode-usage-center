import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// GUI 验收 dev server：/oc-proxy 代理到本机 OpenCode 服务的 HTTP API，并自动带上
// 注册文件里的 basic 鉴权（与 @opencode/client 的 Service.discover 同一来源）。
const target = process.env.OPENCODE_URL ?? "http://127.0.0.1:49374"
const registration = JSON.parse(
  readFileSync(join(process.env.XDG_STATE_HOME ?? join(process.env.HOME!, ".local", "state"), "opencode", "service.json"), "utf8"),
) as { password?: string }
const authHeader = registration.password
  ? "Basic " + Buffer.from(`opencode:${registration.password}`).toString("base64")
  : undefined

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 7931,
    proxy: {
      "/oc-proxy": {
        target,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/oc-proxy/, ""),
        headers: authHeader ? { authorization: authHeader } : undefined,
      },
    },
  },
})
