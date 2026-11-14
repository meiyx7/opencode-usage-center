import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import type {
  CredentialEntry,
  IntegrationInfo,
  IntegrationMethod,
  ModelInfo,
  ProviderInfo,
} from "@opencode/client/promise"
import type { Quota, QuotaProvider } from "../contract"
import type { Meter } from "../contract"
import { expiryLabel, meterAmount, percent, resetLabel } from "./format"

/**
 * 凭据与模型页。数据全部来自 `ctx.client`（认证过的服务端 API），不在窗口里碰
 * 数据库：登录方式、OAuth 发起、凭据增删只有 API 有，统一走 API 还能订阅
 * credential/integration/provider 事件做实时刷新。
 *
 * 界面上绝不渲染完整密钥：access/refresh/key 只显示尾 4 位。
 */

type AuthRow = {
  integrationID: string
  name: string
  methods: IntegrationMethod[]
  credentials: CredentialEntry[]
  /** 插件 RPC 快照的凭据行：登录状态展示以此为准，与总览页同源。 */
  serverCredentials: import("../contract").CredentialRow[]
  /** 该集成下模型数量（没有 provider 的集成是 undefined） */
  modelCount?: number
  providerActivation?: ProviderInfo["activation"]
  providerPackage?: string
}

type LoginFlow = {
  integrationID: string
  integrationName: string
  methodID: string
  methodLabel: string
  attemptID: string
  url: string
  instructions: string
  mode: "auto" | "code"
  expires: number
}

const OAUTH_POLL_MS = 1500

/** 只显示尾 4 位，中间不补星星，避免暗示长度。 */
function secretTail(value: string | undefined): string {
  if (!value) return ""
  const tail = value.slice(-4)
  return `••••${tail}`
}

/** 从 OAuth 凭据里解析人类可读的账号信息，字段随插件版本变化，全部容错。 */
function accountHint(credential: CredentialEntry): string | undefined {
  if (credential.value.type !== "oauth") return undefined
  const metadata = (credential.value.metadata ?? {}) as Record<string, unknown>
  // qoder-bridge 把账号放在 metadata.accountId / region
  const direct =
    (typeof metadata.accountId === "string" && metadata.accountId) ||
    (typeof metadata.account === "string" && metadata.account) ||
    (typeof metadata.user === "string" && metadata.user) ||
    (typeof metadata.email === "string" && metadata.email)
  if (direct) {
    const region = typeof metadata.region === "string" ? metadata.region : undefined
    return region ? `${direct} (${region})` : direct
  }
  // magpie 的 1.x 认证存在 metadata.v1 / refresh（v1auth JSON）里
  const candidates: unknown[] = [metadata.v1, metadata.account, metadata.user]
  const refresh = credential.value.refresh
  if (refresh && refresh.startsWith("{")) {
    try {
      candidates.push(JSON.parse(refresh))
    } catch {
      // refresh 不是 JSON 就跳过
    }
  }
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue
    const value = raw as Record<string, unknown>
    const account =
      (typeof value.account === "string" && value.account) ||
      (typeof value.user === "string" && value.user) ||
      (typeof value.email === "string" && value.email) ||
      (typeof value.phone === "string" && value.phone) ||
      (typeof value.name === "string" && value.name)
    if (account) return account
    const site = typeof value.site === "string" ? value.site : undefined
    const device = typeof value.device === "string" ? value.device.slice(0, 8) : undefined
    if (site || device) return [site, device].filter(Boolean).join(" · ")
  }
  return undefined
}

function methodLabel(method: IntegrationMethod): string {
  if (method.type === "oauth" || method.type === "external" || method.type === "command") return method.label
  if (method.type === "key") return method.label ?? "API Key"
  if (method.type === "env") return `环境变量 ${method.names.join(" / ")}`
  return (method as { type: string }).type
}

/** 登录方式的短标签与种类：按钮显示短词，详情放 title。 */
function methodShort(method: IntegrationMethod): { label: string; kind: "oauth" | "key" | "command"; hint: string } {
  if (method.type === "oauth") {
    const label = method.label
    // qoder/zcode 的多账号 OAuth 标签很长，压成短词
    const short =
      /CN.*Enterprise|VPC/i.test(label) ? "OAuth 企业版"
      : /CN/i.test(label) ? "OAuth CN"
      : /BigModel|智谱/.test(label) ? "OAuth 智谱"
      : /team/i.test(label) ? "OAuth 团队"
      : /app/i.test(label) ? "OAuth 应用"
      : /Z\.ai/i.test(label) ? "OAuth Z.ai"
      : "OAuth 浏览器"
    return { label: short, kind: "oauth", hint: label }
  }
  if (method.type === "key") {
    return { label: /GLM|site/i.test(method.label ?? "") ? "API Key" : "API Key", kind: "key", hint: method.label ?? "API Key" }
  }
  if (method.type === "command") {
    return { label: "终端登录", kind: "command", hint: `${method.label}（${(method as { command?: string[] }).command?.join(" ") ?? ""}）` }
  }
  return { label: method.type, kind: "key", hint: method.type }
}

/** 登录方式是否可以在本界面发起。env/key 走表单，oauth 走浏览器，command 交给终端。 */
function startableMethods(methods: readonly IntegrationMethod[]): IntegrationMethod[] {
  return methods.filter((method) => method.type === "oauth" || method.type === "key" || method.type === "command")
}

function readableActionError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  // 服务端 500 不带响应体，client 只抛状态码；常见失败按场景给出可操作的提示。
  if (/UnexpectedStatus.*500|status.*500/.test(raw)) {
    return "服务端拒绝了这次登录（通常是因为该集成已登录且只允许一个账号）。先删除已有凭据再试，或改用 TUI 的 /login 查看详细错误。"
  }
  if (/401|Unauthorized/.test(raw)) return "OpenCode 服务需要鉴权，请重启 OpenCode 后再试。"
  if (/404/.test(raw)) return "该登录方式在当前服务端不可用。"
  return raw
}

export function IntegrationsPage(props: {
  ctx: Context
  quota?: Quota
  onRetryQuota?: () => void
  /** 插件 RPC 快照里的凭据行：与总览页「凭据有效期」同源，登录状态以此为准。 */
  serverCredentials?: readonly import("../contract").CredentialRow[]
  /** 凭据发生变化（登录/删除/启用）后调用，让宿主页面强制刷新 RPC 快照。 */
  onCredentialsChanged?: () => void
}) {
  const client = props.ctx.client
  const ui = props.ctx.ui
  const [integrations, setIntegrations] = createSignal<IntegrationInfo[]>([])
  const [credentials, setCredentials] = createSignal<CredentialEntry[]>([])
  const [models] = createSignal<ModelInfo[]>([])
  const [providers, setProviders] = createSignal<ProviderInfo[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [expanded, setExpanded] = createSignal<string>()
  const [busyID, setBusyID] = createSignal("")
  const [flow, setFlow] = createSignal<LoginFlow>()
  const [flowState, setFlowState] = createSignal<"waiting" | "complete" | "failed" | "expired">("waiting")
  const [flowMessage, setFlowMessage] = createSignal("")

  /**
   * 登录状态以 serverCredentials（插件 RPC，与总览页同源）为准：卡片行的
   * 存在性、active、到期时间都用它。host 的 credential.list() 只在展开时
   * 补充账号提示 / Key 尾号这类 RPC 契约里没有的字段，以及供写操作刷新。
   */
  const serverByIntegration = createMemo<Map<string, import("../contract").CredentialRow[]>>(() => {
    const map = new Map<string, import("../contract").CredentialRow[]>()
    for (const credential of props.serverCredentials ?? []) {
      const list = map.get(credential.integrationID) ?? []
      list.push(credential)
      map.set(credential.integrationID, list)
    }
    return map
  })

  async function load(quiet = false) {
    if (!quiet) setLoading(true)
    setError("")
    try {
      const [integrationList, credentialList, modelList, providerList] = await Promise.all([
        client.integration.list(),
        client.credential.list(),
        client.model.list(),
        client.provider.list(),
      ])
      setIntegrations(integrationList.data)
      setCredentials(credentialList)
      setProviders(providerList.data)
      return modelList.data
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return []
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void load()
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const _event of client.event.subscribe({
          types: ["credential.updated", "credential.switched", "integration.updated", "provider.updated", "model.updated"],
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          void load(true)
          // 凭据事件意味着 RPC 快照里的凭据行也过期了，让宿主页面静默刷新。
          props.onCredentialsChanged?.()
        }
      } catch {
        // 事件订阅失败时靠手动刷新兜底
      }
    })()
    onCleanup(() => controller.abort())
  })

  const byIntegration = createMemo<Map<string, CredentialEntry[]>>(() => {
    const map = new Map<string, CredentialEntry[]>()
    for (const credential of credentials()) {
      const list = map.get(credential.integrationID) ?? []
      list.push(credential)
      map.set(credential.integrationID, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id))
    }
    return map
  })

  const modelCountByProvider = createMemo<Map<string, number>>(() => {
    const map = new Map<string, number>()
    for (const model of models()) map.set(model.providerID, (map.get(model.providerID) ?? 0) + 1)
    return map
  })

  const providerByIntegration = createMemo<Map<string, ProviderInfo[]>>(() => {
    const map = new Map<string, ProviderInfo[]>()
    for (const provider of providers()) {
      const integrationID = provider.integrationID
      if (!integrationID) continue
      const list = map.get(integrationID) ?? []
      list.push(provider)
      map.set(integrationID, list)
    }
    return map
  })

  /** 只显示有登录方式或有凭据的集成，246 个里绝大多数与本机无关。 */
  const rows = createMemo<AuthRow[]>(() => {
    const credentialMap = byIntegration()
    const serverMap = serverByIntegration()
    const providerMap = providerByIntegration()
    const out: AuthRow[] = []
    for (const integration of integrations()) {
      const list = credentialMap.get(integration.id)
      const serverList = serverMap.get(integration.id)
      const integrationProviders = providerMap.get(integration.id)
      if (!list?.length && !serverList?.length && !integrationProviders?.length) continue
      const modelCount = integrationProviders?.reduce(
        (sum, provider) => sum + (modelCountByProvider().get(provider.id) ?? 0),
        0,
      )
      out.push({
        integrationID: integration.id,
        name: integration.name,
        methods: integration.methods,
        credentials: list ?? [],
        serverCredentials: serverList ?? [],
        modelCount,
        providerActivation: integrationProviders?.[0]?.activation,
        providerPackage: integrationProviders?.[0]?.package,
      })
    }
    // 有凭据的在前，其余按名称
    out.sort((a, b) => Number(b.credentials.length > 0 || b.serverCredentials.length > 0) - Number(a.credentials.length > 0 || a.serverCredentials.length > 0) || a.name.localeCompare(b.name))
    return out
  })

  /**
   * 供应商额度（来自插件自己的 quota RPC）按 integrationID 分组，供卡片头部
   * 展示概要、展开区展示完整 meters。与凭据数据源独立，任一侧失败互不阻塞。
   */
  const quotaByIntegration = createMemo<Map<string, QuotaProvider>>(() => {
    const map = new Map<string, QuotaProvider>()
    for (const provider of props.quota?.providers ?? []) map.set(provider.id, provider)
    return map
  })
  /** 有额度的供应商但没有任何凭据/集成行时（如凭据已删但接口仍在返回），补一张展示卡。 */
  const quotaOnlyRows = createMemo<AuthRow[]>(() => {
    const out: AuthRow[] = []
    for (const provider of props.quota?.providers ?? []) {
      if (rows().some((row) => row.integrationID === provider.id)) continue
      out.push({
        integrationID: provider.id,
        name: provider.name,
        methods: [],
        credentials: [],
        serverCredentials: serverByIntegration().get(provider.id) ?? [],
      })
    }
    return out
  })

  /**
   * 合并页签的卡片顺序：有额度 meters 的最前（默认展开），已登录次之，
   * 未登录（无凭据也无可用额度）靠后。
   */
  const sortedRows = createMemo<AuthRow[]>(() => {
    const rank = (row: AuthRow) => {
      const quota = quotaByIntegration().get(row.integrationID)
      if (quota && quota.meters.length > 0) return 0
      if (row.credentials.length > 0) return 1
      return 2
    }
    return [...rows(), ...quotaOnlyRows()].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
    )
  })

  /** 有额度 meters 的卡片默认展开；用户手动收起后记入 dismissed，不再自动弹开。 */
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set<string>())
  /** 默认展开所有有额度 meters 且未被手动收起的卡片。 */
  const autoOpen = createMemo<ReadonlySet<string>>(() => {
    const open = new Set<string>()
    for (const row of sortedRows()) {
      const quota = quotaByIntegration().get(row.integrationID)
      if (quota && quota.meters.length > 0 && !dismissed().has(row.integrationID)) open.add(row.integrationID)
    }
    return open
  })

  async function startOAuth(row: AuthRow, method: IntegrationMethod, answers?: Record<string, string>) {
    setBusyID(`${row.integrationID}:${"id" in method ? method.id : method.type}`)
    try {
      const result = await client.integration.oauth.connect({
        integrationID: row.integrationID,
        methodID: (method as { id: string }).id,
        answer: answers,
      })
      setFlow({
        integrationID: row.integrationID,
        integrationName: row.name,
        methodID: (method as { id: string }).id,
        methodLabel: methodLabel(method),
        attemptID: result.data.attemptID,
        url: result.data.url,
        instructions: result.data.instructions,
        mode: result.data.mode,
        expires: result.data.time.expires,
      })
      setFlowState("waiting")
      setFlowMessage("")
      props.ctx.system.openExternal(result.data.url)
    } catch (cause) {
      props.ctx.toast.show({
        title: `无法发起登录：${row.name}`,
        description: readableActionError(cause),
        variant: "error",
      })
    } finally {
      setBusyID("")
    }
  }

  async function startKey(row: AuthRow, method: IntegrationMethod) {
    const withForm = method as { form?: { key: string; title?: string; required?: boolean; options?: { value: string; label: string }[] }[] }
    const answers: Record<string, string> = {}
    // 有表单的 key 方法（如 zcode 的 site 选择）逐个问；Host 的 prompt 不支持多选，用 select
    for (const field of withForm.form ?? []) {
      if (field.options?.length) {
        const picked = await props.ctx.dialogs.select<string>({
          title: field.title ?? field.key,
          options: field.options.map((option) => ({ title: option.label, value: option.value })),
        })
        if (picked === undefined) return
        answers[field.key] = picked
      } else {
        const text = await props.ctx.dialogs.prompt({ title: field.title ?? field.key, secret: /key|token/i.test(field.key) })
        if (text === undefined) return
        answers[field.key] = text
      }
    }
    const key = await props.ctx.dialogs.prompt({ title: `粘贴 ${row.name} 的 API Key`, secret: true })
    if (!key) return
    setBusyID(`${row.integrationID}:key`)
    try {
      await client.integration.connect.key({ integrationID: row.integrationID, key, answer: Object.keys(answers).length ? answers : undefined })
      props.ctx.toast.show({ title: `${row.name} 的 API Key 已保存`, variant: "success" })
      void load(true)
      props.onCredentialsChanged?.()
    } catch (cause) {
      props.ctx.toast.show({
        title: `保存失败`,
        description: readableActionError(cause),
        variant: "error",
      })
    } finally {
      setBusyID("")
    }
  }

  async function startCommand(row: AuthRow, method: IntegrationMethod) {
    const command = (method as { command?: string[] }).command ?? []
    setBusyID(`${row.integrationID}:command`)
    try {
      const result = await client.integration.command.connect({
        integrationID: row.integrationID,
        methodID: (method as { id: string }).id,
      })
      props.ctx.dialogs.alert({
        title: "在终端里完成登录",
        description: `服务端正在运行：${command.join(" ") || methodLabel(method)}\n\n完成后这里会自动更新。`,
      })
      // 轮询几次状态，完成后刷新
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const status = await client.integration.command.status({
          integrationID: row.integrationID,
          attemptID: result.data.attemptID,
        })
        if (status.data.status !== "pending") break
      }
      void load(true)
      props.onCredentialsChanged?.()
    } catch (cause) {
      props.ctx.toast.show({
        title: `无法发起命令行登录`,
        description: readableActionError(cause),
        variant: "error",
      })
    } finally {
      setBusyID("")
    }
  }

  async function removeCredential(credential: CredentialEntry) {
    const confirmed = await props.ctx.dialogs.confirm({
      title: `删除凭据「${credential.label}」？`,
      description: "删除后需要重新登录才能继续使用该账号。此操作不可撤销。",
      confirm: "删除",
      danger: true,
    })
    if (!confirmed) return
    setBusyID(credential.id)
    try {
      await client.credential.remove({ credentialID: credential.id })
      props.ctx.toast.show({ title: "凭据已删除", variant: "success" })
      void load(true)
      props.onCredentialsChanged?.()
    } catch (cause) {
      props.ctx.toast.show({
        title: "删除失败",
        description: readableActionError(cause),
        variant: "error",
      })
    } finally {
      setBusyID("")
    }
  }

  async function activateCredential(credential: CredentialEntry) {
    setBusyID(credential.id)
    try {
      await client.credential.activate({ credentialID: credential.id })
      props.ctx.toast.show({ title: "已切换为当前使用的凭据", variant: "success" })
      void load(true)
      props.onCredentialsChanged?.()
    } catch (cause) {
      props.ctx.toast.show({
        title: "切换失败",
        description: readableActionError(cause),
        variant: "error",
      })
    } finally {
      setBusyID("")
    }
  }

  // OAuth 登录流程轮询
  onMount(() => {
    const timer = window.setInterval(async () => {
      const current = flow()
      if (!current || flowState() !== "waiting") return
      try {
        const status = await client.integration.oauth.status({
          integrationID: current.integrationID,
          attemptID: current.attemptID,
        })
        if (status.data.status === "complete") {
          setFlowState("complete")
          setFlowMessage("登录成功，凭据已保存")
          void load(true)
          props.onCredentialsChanged?.()
        } else if (status.data.status === "failed") {
          setFlowState("failed")
          setFlowMessage(status.data.message || "登录失败")
        } else if (status.data.status === "expired") {
          setFlowState("expired")
          setFlowMessage("登录链接已过期，请重新发起")
        }
      } catch {
        // 网络抖动，下一轮再试
      }
    }, OAUTH_POLL_MS)
    onCleanup(() => window.clearInterval(timer))
  })

  return (
    <div class="uc-integrations">
      <div class="uc-card-head">
        <div>
          <div class="uc-card-title">凭据与额度</div>
          <div class="uc-card-sub">
            登录状态、多账号与订阅额度 · 点开供应商卡片看各窗口用量
          </div>
        </div>
        <Show
          when={props.quota && !props.quota.available}
          fallback={
            props.quota ? undefined : (
              <button type="button" class="uc-text-button" onClick={props.onRetryQuota} title="额度接口最长 8 秒，超时后可重试">
                额度读取中，点此重试
              </button>
            )
          }
        >
          <span class="uc-badge uc-badge-muted">额度未连接</span>
        </Show>
        <ui.Button variant="ghost" size="small" icon="refresh" busy={loading()} onClick={() => void load(true)}>
          刷新
        </ui.Button>
      </div>

      <Show when={props.quota && props.quota.error && !props.quota.available}>
        <div class="uc-quota-error">
          <span>{props.quota!.error}</span>
          <Show when={props.onRetryQuota}>
            <button type="button" class="uc-text-button" onClick={props.onRetryQuota}>
              重试
            </button>
          </Show>
        </div>
      </Show>

      <Show when={error()}>
        <div class="uc-notice" data-tone="error">
          <ui.Icon name="circle-exclamation" size="small" />
          <span>{error()}</span>
          <button type="button" class="uc-text-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="uc-int-grid" aria-hidden="true">
          <For each={[0, 1, 2, 3, 4, 5]}>
            {() => (
              <div class="uc-int-card uc-skeleton" style={{ "min-height": "64px" }}>
                <span class="uc-sk-line" style={{ width: "38%", margin: "12px" }} />
                <span class="uc-sk-line" style={{ width: "62%", margin: "0 12px 12px" }} />
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={!loading() && rows().length === 0 && quotaOnlyRows().length === 0}>
        <div class="uc-empty-line">还没有任何登录或凭据。点右上角「刷新」或先在 TUI 里 /login。</div>
      </Show>

      <Show when={!loading()}>
      <div class="uc-int-grid">
        <For each={sortedRows()}>
          {(row) => {
            /** 手动点过头部就用手动状态；否则有额度 meters 的卡片默认展开。 */
            const open = () => (expanded() !== undefined ? expanded() === row.integrationID : autoOpen().has(row.integrationID))
            /**
             * 登录状态以 server 凭据（插件 RPC，与总览页同源）为准；host 数据
             * 只补充展开区的账号提示 / Key 尾号。server 没返回时（弹窗刚打开、
             * 快照未到）回退 host 数据，避免闪「未登录」。
             */
            const signed = () =>
              props.serverCredentials ? row.serverCredentials.length > 0 : row.credentials.length > 0
            const serverActive = () => row.serverCredentials.find((credential) => credential.active)
            const active = () => row.credentials.find((credential) => credential.active)
            const quotaProvider = () => quotaByIntegration().get(row.integrationID)
            const summary = () => (quotaProvider() ? quotaSummary(quotaProvider()!) : undefined)
            const tag = () => {
              if (!signed()) {
                // 有额度数据说明服务端凭据仍在，只是不在本机集成列表里；不显示「未登录」。
                if (quotaProvider() && quotaProvider()!.available) return { text: "已登录", tone: "ok" as const }
                return { text: "未登录", tone: "none" as const }
              }
              if (props.serverCredentials) {
                const serverOAuth = row.serverCredentials.find((credential) => credential.type === "oauth")
                if (row.serverCredentials.length > 1) return { text: `${row.serverCredentials.length} 个账号`, tone: "ok" as const }
                return expiryLabel(serverOAuth?.expires)
              }
              const oauth = row.credentials.find((credential) => credential.value.type === "oauth")
              const expires = oauth && "expires" in credentialValueOf(oauth) ? credentialValueOf(oauth).expires : undefined
              const label = expiryLabel(expires || undefined)
              if (row.credentials.length > 1) return { text: `${row.credentials.length} 个账号`, tone: "ok" as const }
              return { text: label.text, tone: label.tone }
            }
            const toggle = () => {
              const next = open() ? undefined : row.integrationID
              setExpanded(next)
              // 手动收起一张默认展开的卡后不再自动弹开；展开其它卡时也一并记录。
              setDismissed((prev) => {
                const merged = new Set(prev)
                for (const id of autoOpen()) merged.add(id)
                if (next) merged.delete(next)
                return merged
              })
            }
            return (
              <div class="uc-int-card" data-open={open() ? "true" : undefined} data-signed={signed() ? "true" : undefined}>
                <button
                  type="button"
                  class="uc-int-head"
                  onClick={toggle}
                >
                  <span class="uc-int-top">
                    <span class="uc-int-icon">{row.name.slice(0, 1).toUpperCase()}</span>
                    <span class="uc-int-name">
                      <b>{row.name}</b>
                      <span>
                        {row.modelCount ? `${row.modelCount} 个模型` : row.integrationID}
                        {signed() ? ` · ${(serverActive() ?? active())?.label ?? "已登录"}` : ""}
                      </span>
                    </span>
                    <span class="uc-exp-tag" data-tone={tag().tone}>
                      {tag().text}
                    </span>
                    <Show when={summary()}>
                      {(value) => (
                        <span class="uc-exp-tag uc-int-quota-tag" data-tone={value().tone} title={quotaProvider()?.plan}>
                          {value().text}
                        </span>
                      )}
                    </Show>
                  </span>
                  <Show when={signed()}>
                    <span class="uc-int-meta">
                      <For each={row.serverCredentials.slice(0, 3)}>
                        {(credential) => (
                          <span class="uc-int-chip" data-active={credential.active ? "true" : undefined}>
                            <i />
                            {credential.label}
                          </span>
                        )}
                      </For>
                      <Show when={row.serverCredentials.length > 3}>
                        <span class="uc-int-chip">+{row.serverCredentials.length - 3}</span>
                      </Show>
                    </span>
                  </Show>
                  <span class="uc-int-more">
                    {open() ? "收起" : "管理"}
                    <span class="uc-int-disclosure" aria-hidden="true">
                      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                        <path d="M4.5 2.5 8 6l-3.5 3.5" />
                      </svg>
                    </span>
                  </span>
                </button>

                <Show when={open()}>
                  <div class="uc-int-body">
                    <Show
                      when={quotaProvider()}
                      fallback={
                        <Show when={props.quota === undefined}>
                          <div class="uc-int-quota-note">订阅额度读取中…</div>
                        </Show>
                      }
                    >
                      <Show when={quotaProvider()!.meters.length > 0}>
                        <div class="uc-int-section-title">订阅额度</div>
                        <QuotaMeters provider={quotaProvider()!} />
                      </Show>
                      <Show when={quotaProvider()!.meters.length === 0}>
                        <div class="uc-int-quota-note">
                          {quotaProvider()!.note || quotaProvider()!.error || "未暴露额度"}
                        </div>
                      </Show>
                    </Show>
                    <Show when={serverCredentialsOf(row).length > 0 || row.credentials.length > 0}>
                      <div class="uc-int-section-title">凭据</div>
                      <For each={serverCredentialsOf(row).length > 0 ? serverCredentialsOf(row) : row.credentials}>
                        {(credential) => {
                          /** server 行没有 value 字段；host 行才有完整对象。 */
                          const host = () => "value" in credential ? (credential as CredentialEntry) : undefined
                          const isOAuth = () => (host() ? host()!.value.type === "oauth" : (credential as import("../contract").CredentialRow).type === "oauth")
                          const expires = () => ("expires" in credential ? credential.expires : host() && host()!.value.type === "oauth" ? (host()!.value as { expires?: number }).expires : undefined)
                          const label = () => expiryLabel(expires() || undefined)
                          const hint = () => (host() ? accountHint(host()!) : undefined)
                          const name = () => hint() ?? credential.label
                          return (
                            <div class="uc-cred-row">
                              <span class="uc-cred-dot" data-active={credential.active ? "true" : undefined} />
                              <span class="uc-cred-main">
                                <b title={credential.id}>{name()}</b>
                                <span>
                                  {isOAuth()
                                    ? "OAuth"
                                    : host() && host()!.value.type === "key"
                                      ? `API Key ${secretTail((host()!.value as { key?: string }).key)}`
                                      : "API Key"}
                                  {expires() ? ` · ${new Date(expires()!).toLocaleDateString("zh-CN")} 到期` : ""}
                                  {credential.active ? " · 使用中" : ""}
                                </span>
                              </span>
                              <span class="uc-exp-tag" data-tone={label().tone}>
                                {label().text}
                              </span>
                              <Show when={!credential.active}>
                                <ui.Button
                                  size="small"
                                  variant="ghost"
                                  busy={busyID() === credential.id}
                                  onClick={() => void activateCredential(credential as CredentialEntry)}
                                >
                                  启用
                                </ui.Button>
                              </Show>
                              <ui.IconButton
                                icon="trash"
                                label="删除凭据"
                                onClick={() => void removeCredential(credential as CredentialEntry)}
                              />
                            </div>
                          )
                        }}
                      </For>
                    </Show>

                    <div class="uc-int-section-title">登录方式</div>
                    <div class="uc-int-methods">
                      <For each={startableMethods(row.methods).map((method) => ({ method, short: methodShort(method) }))}>
                        {({ method, short }) => (
                          <button
                            type="button"
                            class="uc-method"
                            data-kind={short.kind}
                            title={short.hint}
                            disabled={busyID() === `${row.integrationID}:${"id" in method ? method.id : method.type}`}
                            onClick={() => {
                              if (method.type === "oauth") void startOAuth(row, method)
                              else if (method.type === "key") void startKey(row, method)
                              else if (method.type === "command") void startCommand(row, method)
                            }}
                          >
                            <ui.Icon
                              name={short.kind === "oauth" ? "globe" : short.kind === "command" ? "terminal" : "lock"}
                              size="small"
                            />
                            <span class="uc-method-label">{short.label}</span>
                            <Show when={row.credentials.some((credential) => credential.value.type === "oauth" && credential.value.methodID === (method as { id: string }).id)}>
                              <span class="uc-method-on" title="当前凭据使用的登录方式">使用中</span>
                            </Show>
                          </button>
                        )}
                      </For>
                      <For each={row.methods.filter((method) => method.type === "env")}>
                        {(method) => (
                          <span class="uc-int-env" title="通过环境变量提供，无需在此登录">
                            {methodLabel(method)}
                          </span>
                        )}
                      </For>
                    </div>

                    <Show when={row.providerPackage}>
                      <div class="uc-int-provider">
                        <span>{row.providerActivation === "auto" ? "自动激活" : row.providerActivation === "enabled" ? "已启用" : "已停用"}</span>
                        <span class="uc-int-pkg" title={row.providerPackage}>{row.providerPackage}</span>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      </Show>

      <Show when={flow()}>
        {(current) => (
          <div class="uc-flow" data-state={flowState()}>
            <div class="uc-flow-head">
              <b>{current().integrationName} 登录</b>
              <span class="uc-flow-method">{current().methodLabel}</span>
              <Show when={flowState() === "waiting"}>
                <span class="uc-spinner uc-flow-spinner" />
              </Show>
              <button type="button" class="uc-text-button" onClick={() => setFlow(undefined)}>
                关闭
              </button>
            </div>
            <div class="uc-flow-body">
              <Show when={flowState() === "waiting"} fallback={<span class="uc-flow-result">{flowMessage()}</span>}>
                <span>
                  已在浏览器打开登录页。
                  <Show when={current().mode === "code"} fallback={<> 完成后这里会自动确认。</>}>
                    {" "}把页面给出的代码粘贴到终端提示处，完成后这里会自动确认。
                  </Show>
                </span>
                <button
                  type="button"
                  class="uc-text-button"
                  onClick={() => props.ctx.system.openExternal(current().url)}
                >
                  重新打开浏览器
                </button>
              </Show>
            </div>
            <div class="uc-flow-foot">
              <Show when={flowState() === "waiting"}>
                <span>
                  等待中 · {current().expires ? `链接 ${new Date(current().expires).toLocaleTimeString("zh-CN")} 前有效` : ""}
                </span>
              </Show>
              <Show when={flowState() === "complete"}>
                <button type="button" class="uc-text-button" onClick={() => setFlow(undefined)}>
                  完成
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

/** OAuth 凭据的 expires 字段访问，兼容类型收窄。 */
function credentialValueOf(credential: CredentialEntry): { expires?: number } {
  return credential.value.type === "oauth" ? credential.value : {}
}

/** 展开区凭据行：server 行（RPC）优先，host 行兜底。 */
function serverCredentialsOf(row: AuthRow): import("../contract").CredentialRow[] {
  return row.serverCredentials
}

/** 卡片头部的额度概要：占用最高的窗口 + 剩余窗口数。 */
function quotaSummary(provider: QuotaProvider): { text: string; tone: "ok" | "warn" | "danger" | "none" } {
  const worst = provider.meters.reduce<Meter | undefined>((best, meter) => (!best || meter.percent > best.percent ? meter : best), undefined)
  if (!worst) return { text: provider.note || provider.error || "未暴露额度", tone: "none" }
  const tone = worst.percent >= 90 ? "danger" : worst.percent >= 70 ? "warn" : "ok"
  const more = provider.meters.length > 1 ? ` 等 ${provider.meters.length} 项` : ""
  return { text: `${worst.label} ${percent(worst.percent)}${more}`, tone }
}

/** 展开区里的完整额度 meters，复用额度页的仪表行样式。 */
function QuotaMeters(props: { provider: QuotaProvider }) {
  return (
    <div class="uc-int-quota">
      <For each={props.provider.meters}>
        {(meter) => (
          <div class="uc-meter-row">
            <div class="uc-meter-top">
              <span>
                {meter.label}
                <small>{meter.resetsAt ? resetLabel(meter.resetsAt) : meterAmount(meter.used, meter.limit, meter.unit)}</small>
              </span>
              <b style={{ color: meter.percent >= 90 ? "var(--uc-red)" : undefined }}>{percent(meter.percent)}</b>
            </div>
            <div class="uc-meter">
              <i
                style={{
                  width: `${Math.max(1, Math.min(100, meter.percent))}%`,
                  background: meter.percent >= 90 ? "var(--uc-red)" : meter.percent >= 70 ? "var(--uc-amber)" : "var(--uc-accent)",
                }}
              />
            </div>
          </div>
        )}
      </For>
      <Show when={props.provider.meters.length === 0}>
        <div class="uc-int-quota-note">{props.provider.note || props.provider.error || "未暴露额度"}</div>
      </Show>
    </div>
  )
}
