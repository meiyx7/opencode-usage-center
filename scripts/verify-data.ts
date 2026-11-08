// 验收脚本 1：数据层。用 @opencode/client 直连本机服务，模拟 IntegrationsPage 的数据获取逻辑。
import { OpenCode } from "@opencode/client/promise"
import { Service } from "@opencode/client/service"

const endpoint = await Service.discover()
if (!endpoint) {
  console.error("没有发现本机 OpenCode 服务")
  process.exit(1)
}
const client = OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.auth ? Service.headers(endpoint) : undefined })

const integrations = (await client.integration.list()).data
const credentials = await client.credential.list()
const models = (await client.model.list()).data
const providers = (await client.provider.list()).data

console.log("integration.list:", integrations.length)
console.log("credential.list:", credentials.length)
console.log("model.list:", models.length)
console.log("provider.list:", providers.length)

// 复现组件的 rows() 逻辑
const credentialMap = new Map()
for (const c of credentials) {
  const list = credentialMap.get(c.integrationID) ?? []
  list.push(c)
  credentialMap.set(c.integrationID, list)
}
const providerMap = new Map()
for (const p of providers) {
  if (!p.integrationID) continue
  const list = providerMap.get(p.integrationID) ?? []
  list.push(p)
  providerMap.set(p.integrationID, list)
}
const modelCount = new Map()
for (const m of models) modelCount.set(m.providerID, (modelCount.get(m.providerID) ?? 0) + 1)

const rows = []
for (const integration of integrations) {
  const list = credentialMap.get(integration.id)
  const ips = providerMap.get(integration.id)
  if (!list?.length && !ips?.length) continue
  rows.push({
    id: integration.id,
    name: integration.name,
    methods: integration.methods.map((m) => m.type + (m.type === "oauth" ? `(${m.id})` : "")),
    credentials: (list ?? []).map((c) => ({
      label: c.label,
      type: c.value.type,
      active: c.active,
      hasExpires: c.value.type === "oauth" ? typeof c.value.expires === "number" : false,
    })),
    modelCount: ips?.reduce((sum, p) => sum + (modelCount.get(p.id) ?? 0), 0) ?? 0,
    activation: ips?.[0]?.activation,
  })
}
rows.sort((a, b) => Number(b.credentials.length > 0) - Number(a.credentials.length > 0) || a.name.localeCompare(b.name))

console.log("\n组件将显示的行：")
for (const row of rows) {
  console.log(`- ${row.name} (${row.id})`)
  console.log(`    登录方式: ${row.methods.join(", ")}`)
  console.log(`    凭据: ${row.credentials.map((c) => `${c.label}[${c.type}${c.active ? ",active" : ""}]`).join("; ") || "无"}`)
  console.log(`    模型: ${row.modelCount} · provider 激活: ${row.activation ?? "—"}`)
}

// 验证 secretTail / accountHint 输入
console.log("\nOAuth 凭据字段检查（不打印值，只打印形状）：")
for (const c of credentials) {
  if (c.value.type !== "oauth") continue
  const meta = c.value.metadata ?? {}
  console.log(`- ${c.integrationID}: methodID=${c.value.methodID} expires=${typeof c.value.expires} metadataKeys=${Object.keys(meta).join("|") || "无"} refreshIsJson=${c.value.refresh.startsWith("{")}`)
}
process.exit(0)
