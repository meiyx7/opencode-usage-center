import { createMemo, createSignal, For, Show } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import type { ModelInfo } from "@opencode/client/promise"
import { compact } from "./format"

/**
 * 模型浏览页。两个视角：
 * 1. 常用：最近 30 天真实请求过的模型（数据来自 usage 快照的 ModelRow），带请求次数，可折叠
 * 2. 全部：provider 分组，点击展开该 provider 的模型列表（上下文 / 价格 / 用量 / 隐藏标记）
 * 内部通道（subagent / advisor / auto 路由等非对话模型）单独一组默认折叠。
 * 隐藏标记是本地偏好，不改变 OpenCode 行为。
 */

type HiddenMap = Record<string, boolean>

const CONTEXT_TIERS: [number, string][] = [
  [1_000_000, "1M"],
  [512_000, "512K"],
  [400_000, "400K"],
  [256_000, "256K"],
  [200_000, "200K"],
  [128_000, "128K"],
  [131_072, "128K"],
  [64_000, "64K"],
  [32_000, "32K"],
]

/** Trae 等 IDE 会把内部 agent 通道也列出来；这些不是给人挑的。 */
const AGENT_CHANNEL = /sub_?agent|_agent$|^aquila$|^sagitta$|advisor|search_agent|computer_use|browser_use|file_search|explore_sub/i

function contextLabel(limit: number): string {
  for (const [size, label] of CONTEXT_TIERS) {
    if (limit >= size * 0.97) return label
  }
  if (limit >= 1000) return `${Math.round(limit / 1000)}K`
  return String(limit)
}

function costLabel(model: ModelInfo): string {
  const tier = model.cost.find((entry) => !entry.tier) ?? model.cost[0]
  if (!tier) return "—"
  if (!tier.input && !tier.output) return "免费"
  const fmt = (value: number) => (value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(3))
  return `$${fmt(tier.input)}/$${fmt(tier.output)}`
}

function expensive(model: ModelInfo): boolean {
  const tier = model.cost.find((entry) => !entry.tier) ?? model.cost[0]
  return Boolean(tier && (tier.input >= 2 || tier.output >= 2))
}

export function ModelsExplorer(props: {
  ctx: Context
  models: readonly ModelInfo[]
  providerNames: Map<string, string>
  /** 最近 30 天真实用过的模型（providerID:modelID → 请求次数），来自 usage 快照 */
  usage?: ReadonlyMap<string, { requests: number; cost: number }>
}) {
  const ui = props.ctx.ui
  const [query, setQuery] = createSignal("")
  const [openProvider, setOpenProvider] = createSignal<string>()
  const [showAgents, setShowAgents] = createSignal(false)
  const [showRecent, setShowRecent] = createSignal(true)
  const [hidden, setHidden] = createSignal<HiddenMap>(readHidden())

  function readHidden(): HiddenMap {
    try {
      return JSON.parse(window.localStorage.getItem("usage-center.hidden-models") ?? "{}") as HiddenMap
    } catch {
      return {}
    }
  }

  function toggleHidden(model: ModelInfo) {
    const next = { ...hidden() }
    if (next[model.id]) delete next[model.id]
    else next[model.id] = true
    setHidden(next)
    window.localStorage.setItem("usage-center.hidden-models", JSON.stringify(next))
  }

  const usageOf = (providerID: string, modelID: string) => props.usage?.get(`${providerID}:${modelID}`)

  const filtered = createMemo(() => {
    const raw = query().trim().toLowerCase()
    if (!raw) return props.models
    const terms = raw.split(/\s+/)
    return props.models.filter((model) => {
      const haystack = `${model.providerID} ${model.modelID} ${model.name}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  })

  /** 常用模型：按真实请求次数排序，最多 8 个。 */
  const recent = createMemo(() => {
    if (!props.usage?.size) return []
    const used: { model: ModelInfo; requests: number }[] = []
    for (const model of props.models) {
      const usage = usageOf(model.providerID, model.modelID)
      if (usage?.requests) used.push({ model, requests: usage.requests })
    }
    return used.sort((a, b) => b.requests - a.requests).slice(0, 8)
  })

  const grouped = createMemo(() => {
    const list = filtered()
    const agents: ModelInfo[] = []
    const chat: ModelInfo[] = []
    for (const model of list) {
      if (AGENT_CHANNEL.test(model.modelID) && !query()) agents.push(model)
      else chat.push(model)
    }
    const byProvider = new Map<string, ModelInfo[]>()
    for (const model of chat) {
      const bucket = byProvider.get(model.providerID) ?? []
      bucket.push(model)
      byProvider.set(model.providerID, bucket)
    }
    for (const bucket of byProvider.values()) bucket.sort((a, b) => a.modelID.localeCompare(b.modelID))
    return {
      agents,
      providers: [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])),
    }
  })

  const hiddenCount = createMemo(() => Object.values(hidden()).filter(Boolean).length)

  const accents = ["#6d4aff", "#3b82f6", "#0ea5a4", "#b45309", "#d92d20", "#0f7b4f", "#7c3aed", "#c2410c"]
  const accentOf = (providerID: string) => {
    let hash = 0
    for (let index = 0; index < providerID.length; index++) hash = (hash * 31 + providerID.charCodeAt(index)) >>> 0
    return accents[hash % accents.length]
  }

  return (
    <div class="uc-models-page">
      <div class="uc-card-head">
        <div>
          <div class="uc-card-title">模型浏览</div>
          <div class="uc-card-sub">
            {props.models.length} 个模型 · {grouped().providers.length} 个 provider · 隐藏标记 {hiddenCount()} 个（仅本地记录）
          </div>
        </div>
        <label class="uc-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2 14 14" />
          </svg>
          <input
            aria-label="搜索模型"
            placeholder="搜索 provider 或模型名"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>

      <Show when={recent().length > 0 && !query()}>
        <section class="uc-recent" data-open={showRecent() ? "true" : undefined}>
          <button type="button" class="uc-mp-head uc-recent-head" onClick={() => setShowRecent(!showRecent())}>
            <span class="uc-int-disclosure" aria-hidden="true">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                <path d="M4.5 2.5 8 6l-3.5 3.5" />
              </svg>
            </span>
            <span class="uc-int-section-title">最近 30 天常用</span>
            <span class="uc-recent-note">来自本机真实用量，按请求次数排序</span>
            <span class="uc-mp-count">{recent().length} 个</span>
          </button>
          <Show when={showRecent()}>
            <div class="uc-recent-list">
              <For each={recent()}>
                {({ model, requests }) => (
                  <div class="uc-recent-card" style={{ "--mp-accent": accentOf(model.providerID) }}>
                    <span class="uc-recent-bar" />
                    <div class="uc-recent-main">
                      <b title={model.id}>{model.modelID}</b>
                      <span>{props.providerNames.get(model.providerID) ?? model.providerID}</span>
                    </div>
                    <div class="uc-recent-stats">
                      <b>{compact(requests)}</b>
                      <span>次请求</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </Show>

      <Show when={grouped().providers.length === 0 && (showAgents() || grouped().agents.length === 0)}>
        <div class="uc-empty-line">没有匹配的模型</div>
      </Show>

      <div class="uc-mp-groups">
        <For each={grouped().providers}>
          {([providerID, list]) => {
            const open = () => openProvider() === providerID || Boolean(query())
            const hiddenInGroup = () => list.filter((model) => hidden()[model.id]).length
            const accent = accentOf(providerID)
            const free = () => list.filter((model) => !model.cost.some((tier) => tier.input > 0 || tier.output > 0)).length
            return (
              <div class="uc-mp-group" data-open={open() ? "true" : undefined} style={{ "--mp-accent": accent }}>
                <button type="button" class="uc-mp-head" onClick={() => setOpenProvider(open() && !query() ? undefined : providerID)}>
                  <span class="uc-int-disclosure" aria-hidden="true">
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                      <path d="M4.5 2.5 8 6l-3.5 3.5" />
                    </svg>
                  </span>
                  <span class="uc-int-icon">{providerID.slice(0, 1).toUpperCase()}</span>
                  <span class="uc-int-name">
                    <b>{props.providerNames.get(providerID) ?? providerID}</b>
                    <span>{providerID}</span>
                  </span>
                  <span class="uc-mp-count">
                    {list.length} 个
                    <Show when={free()}> · {free()} 免费</Show>
                    <Show when={hiddenInGroup()}> · 藏 {hiddenInGroup()}</Show>
                  </span>
                </button>
                <Show when={open()}>
                  <div class="uc-mp-listview">
                    <div class="uc-mp-lv-row uc-mp-lv-head">
                      <span>模型</span>
                      <span>上下文</span>
                      <span>价格</span>
                      <span>30 天用量</span>
                      <span></span>
                    </div>
                    <For each={list}>
                      {(model) => {
                        const usage = usageOf(providerID, model.modelID)
                        return (
                          <div class="uc-mp-lv-row" data-hidden={hidden()[model.id] ? "true" : undefined}>
                            <span class="uc-mp-lv-name" title={model.id}>
                              <b>{model.modelID}</b>
                              <Show when={model.name && model.name !== model.modelID}>
                                <span>{model.name}</span>
                              </Show>
                            </span>
                            <span class="uc-mp-lv-num" data-expensive={expensive(model) ? "true" : undefined}>
                              {contextLabel(model.limit.context)}
                            </span>
                            <span class="uc-mp-lv-num" data-expensive={expensive(model) ? "true" : undefined}>
                              {costLabel(model)}
                            </span>
                            <span class="uc-mp-lv-num">{usage ? `${compact(usage.requests)} 次` : "—"}</span>
                            <ui.IconButton
                              icon={hidden()[model.id] ? "eye" : "outline-eye-slash"}
                              label={hidden()[model.id] ? "取消隐藏标记" : "隐藏标记"}
                              onClick={() => toggleHidden(model)}
                            />
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            )
          }}
        </For>

        <Show when={grouped().agents.length > 0}>
          <div class="uc-agents" data-open={showAgents() ? "true" : undefined}>
            <button type="button" class="uc-mp-head" onClick={() => setShowAgents(!showAgents())}>
              <span class="uc-int-disclosure" aria-hidden="true">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                  <path d="M4.5 2.5 8 6l-3.5 3.5" />
                </svg>
              </span>
              <span class="uc-int-icon uc-int-icon-agent">
                <ui.Icon name="cube" size="small" />
              </span>
              <span class="uc-int-name">
                <b>内部通道</b>
                <span>IDE 自己的 agent 与路由模型，不是给人挑的</span>
              </span>
              <span class="uc-mp-count">{grouped().agents.length} 个</span>
            </button>
            <Show when={showAgents()}>
              <div class="uc-mp-listview">
                <For each={grouped().agents}>
                  {(model) => (
                    <div class="uc-mp-lv-row">
                      <span class="uc-mp-lv-name" title={model.id}>
                        <b>{model.modelID}</b>
                        <Show when={model.name && model.name !== model.modelID}>
                          <span>{model.name}</span>
                        </Show>
                      </span>
                      <span class="uc-mp-lv-num">{contextLabel(model.limit.context)}</span>
                      <span class="uc-mp-lv-num">{costLabel(model)}</span>
                      <span class="uc-mp-lv-num">—</span>
                      <span></span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
