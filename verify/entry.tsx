/**
 * GUI 验收入口：在浏览器里直接渲染 IntegrationsPage 与 ModelsExplorer，
 * ctx.client 指向本机真实 OpenCode 服务（通过本地代理），其余宿主能力用 stub。
 * 这是临时验收工具，不参与插件构建。
 */
import { render } from "solid-js/web"
import type { Context } from "@opencode/plugin/gui"
import { OpenCode } from "@opencode/client/promise"
import { IntegrationsPage } from "../src/gui/integrations"
import { UsagePage } from "../src/gui/page"
import { ModelsExplorer } from "../src/gui/models-explorer"
import { SessionDetailView } from "../src/gui/session-detail"
import type { SessionRow } from "../src/contract"
// vite dev server 把 /oc-proxy/* 转发到本机服务（见 verify/proxy 说明），浏览器直连避免 CORS
const client = OpenCode.make({ baseUrl: window.location.origin + "/oc-proxy" })

const ui = {
  Icon: (props: { name: string; size?: string }) => <span title={props.name}>[{props.name}]</span>,
  Button: (props: any) => (
    <button type="button" disabled={props.disabled} onClick={props.onClick}>
      {props.busy ? "…" : ""}
      {props.children}
    </button>
  ),
  IconButton: (props: any) => (
    <button type="button" title={props.label} onClick={props.onClick}>
      [{props.icon}]
    </button>
  ),
  Menu: () => <span />,
  Loader: () => <span>⟳</span>,
  Dialog: (props: any) => <div class="stub-dialog">{props.children}</div>,
  Switch: () => <span />,
  TextInput: () => <span />,
  Tooltip: (props: any) => props.children,
  Markdown: () => <span />,
  Code: () => <span />,
} as unknown as Context["ui"]

const toasts: string[] = []
const ctx = {
  client,
  id: "usage-center",
  ui,
  system: {
    copy: async () => {},
    save: async () => true,
    openExternal: (url: string) => {
      toasts.push(`openExternal: ${url}`)
      console.log("[openExternal]", url)
    },
  },
  toast: {
    show: (options: { title: string; description?: string; variant?: string }) => {
      toasts.push(`${options.variant ?? "info"}: ${options.title} ${options.description ?? ""}`)
      console.log("[toast]", options)
      return { dismiss: () => {} }
    },
  },
  dialogs: {
    confirm: async (options: { title: string }) => {
      console.log("[confirm]", options.title)
      return window.confirm(options.title)
    },
    alert: async (options: { title: string; description?: string }) => {
      console.log("[alert]", options)
      window.alert(`${options.title}\n${options.description ?? ""}`)
    },
    prompt: async (options: { title: string; secret?: boolean }) => {
      const value = window.prompt(options.title)
      console.log("[prompt]", options.title, value ? "(输入了值)" : "(取消)")
      return value ?? undefined
    },
    select: async <T,>(options: { title: string; options: { title: string; value: T }[] }) => {
      const labels = options.options.map((option, index) => `${index + 1}. ${option.title}`).join("\n")
      const picked = window.prompt(`${options.title}\n${labels}\n输入序号`)
      if (picked === null) return undefined
      const index = Number(picked) - 1
      return options.options[index]?.value
    },
    open: () => ({ close: () => {} }),
    active: () => false,
  },
} as unknown as Context

function App() {
  return (
    <div class="uc-root" style={{ "--uc-strong": "#1a1a1a", "--uc-muted": "#555", "--uc-faint": "#999", "--uc-border": "#e2e2e2", "--uc-card": "#fff", "--uc-layer": "#fafafa", "--uc-layer-2": "#f0f0f0", "--uc-accent": "#6d4aff", "--uc-track": "#ececec", "--uc-green": "#0f7b4f", "--uc-red": "#d92d20", "--uc-amber": "#b45309" } as Record<string, string>}>
      <style>{CSS_TEXT}</style>
      <h2 style={{ "font-size": "14px", margin: "0 0 8px" }}>凭据页（真实数据）</h2>
      <IntegrationsPage ctx={ctx} />
      <h2 style={{ "font-size": "14px", margin: "24px 0 8px" }}>额度与时效（真实数据）</h2>
      <UsagePage ctx={ctx} embedded />
      <h2 style={{ "font-size": "14px", margin: "24px 0 8px" }}>模型页（真实数据）</h2>
      <ModelsPage />
      <h2 style={{ "font-size": "14px", margin: "24px 0 8px" }}>会话明细时间轴（真实数据）</h2>
      <SessionPage />
    </div>
  )
}

import { createResource, Show } from "solid-js"
import { Usage } from "../src/contract"
function ModelsPage() {
  const [data] = createResource(async () => {
    const [modelList, providerList] = await Promise.all([client.model.list(), client.provider.list()])
    return { models: modelList.data, names: new Map(providerList.data.map((p) => [p.id, p.name])) }
  })
  return (
    <ModelsExplorer
      ctx={ctx}
      models={data()?.models ?? []}
      providerNames={data()?.names ?? new Map()}
      usage={new Map([
        ["opencode-go:deepseek-v4.1-flash", { requests: 11234, cost: 0 }],
        ["opencode-go:minimax-m3.1-flash-free", { requests: 5472, cost: 0 }],
        ["opencode:space-bunny-free", { requests: 5015, cost: 0 }],
        ["zcode:GLM-5.3-Flash", { requests: 696, cost: 0 }],
        ["opencode:step-5-preview-free", { requests: 689, cost: 0 }],
        ["opencode-go:gpt-6-luna", { requests: 520, cost: 0 }],
        ["trae-cn:deepseek-v4.1-flash-max", { requests: 313, cost: 0 }],
        ["opencode-go:claude-haiku-5-5", { requests: 59, cost: 0 }],
      ])}
    />
  )
}

function SessionPage() {
  const [data] = createResource(async () => {
    // 从 usage RPC 拿最近会话列表，取请求最多的一个（时间轴内容最丰富）
    const api = client.rpc(Usage)
    const snapshot = await api.snapshot({ from: Date.now() - 30 * 86_400_000, to: Date.now(), projectID: undefined, force: false })
    const rows: SessionRow[] = snapshot.sessions ?? []
    const pick = [...rows].sort((a, b) => b.requests - a.requests)[0]
    if (!pick) throw new Error("没有会话")
    return pick
  })
  return (
    <Show when={data()} fallback={<div style={{ color: "#999", "font-size": "12px" }}>{data.error ? String(data.error).slice(0, 120) : "加载会话列表…"}</div>}>
      {(session) => <SessionDetailView ctx={ctx} session={session()} projectName="verify" onBack={() => {}} />}
    </Show>
  )
}

import pageCSS from "../src/gui/page.tsx?raw"
// page.tsx 里 CSS 常量嵌在组件文件内，直接抽 `const CSS = \`...\`` 之间的内容
const match = /const CSS = `([\s\S]*?)`\n/.exec(pageCSS as string)
const CSS_TEXT = match?.[1] ?? ""

render(() => <App />, document.getElementById("app")!)
