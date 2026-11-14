import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import { Usage } from "../contract"
import type { AgentRow, CredentialRow, LatencyModelRow, Meter, ModelRow, ProjectRow, ProjectUsageRow, Quota, SeriesPoint, SessionRow, Snapshot } from "../contract"
import {
  compact,
  csvCell,
  dateText,
  duration,
  expiryLabel,
  meterAmount,
  modelInitial,
  money,
  percent,
  providerName,
  rangeBounds,
  RANGES,
  readableError,
  relativeTime,
  resetLabel,
  shortModel,
  type RangeKind,
} from "./format"
import { SessionDetailView } from "./session-detail"
import { IntegrationsPage } from "./integrations"
import { ModelsExplorer } from "./models-explorer"

type Alert = { title: string; detail: string; action: string; target: string }
type Tab = "overview" | "integrations" | "latency" | "sessions" | "models"

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "总览" },
  { id: "integrations", label: "凭据与额度" },
  { id: "latency", label: "时延" },
  { id: "sessions", label: "会话明细" },
  { id: "models", label: "模型" },
]

/** What each tab badge means, in plain words. Shown as the tab's title tooltip. */
function tabHint(id: Tab, quotaAlert: boolean, latencyAlert: boolean): string {
  if (id === "integrations" && quotaAlert) return "凭据与额度 · 红点：某项订阅额度已用 ≥90%"
  if (id === "latency" && latencyAlert) return "时延 · 黄点：首字 P95 超过 30 秒，值得留意"
  return TABS.find((tab) => tab.id === id)?.label ?? ""
}

type CachedView = { snapshot: Snapshot; quota?: Quota; at: number }
const VIEW_CACHE = new Map<string, CachedView>()
const VIEW_CACHE_LIMIT = 12

/** Cache key uses the range preset and resolved project id, not `Date.now()`. */
function viewKey(range: RangeKind, projectID?: string): string {
  return `${range}|${projectID ?? "all"}`
}

const CHART_COLORS = ["var(--uc-accent)", "var(--uc-blue)", "var(--uc-teal)", "var(--uc-track)"]

function niceMax(value: number): { top: number; step: number } {
  if (!Number.isFinite(value) || value <= 0) return { top: 1, step: 0.25 }
  const raw = value / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  const step = factor * magnitude
  return { top: step * 4, step }
}

function sumTokens(model: ModelRow): number {
  return model.input + model.output
}

function Sparkline(props: { values: number[]; color: string }) {
  const path = createMemo(() => {
    const values = props.values.length ? props.values : [0, 0]
    const max = Math.max(1, ...values)
    const step = 64 / Math.max(1, values.length - 1)
    const points = values.map((value, index) => {
      const x = 1 + step * index
      const y = 25 - (value / max) * 20
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    const line = points.length === 1 ? `1,25 63,25` : points.join(" ")
    return { line: `M${line}`, area: `M1,26 L${line} L63,26 Z` }
  })
  return (
    <svg class="uc-spark" viewBox="0 0 64 26" aria-hidden="true">
      <path class="uc-spark-area" d={path().area} fill={props.color} />
      <path d={path().line} stroke={props.color} />
    </svg>
  )
}

function TrendChart(props: { points: readonly SeriesPoint[] }) {
  const data = createMemo(() => props.points.slice(-30))
  const maxValue = createMemo(() => Math.max(1, ...data().map((point) => point.input + point.output)))
  const scale = createMemo(() => niceMax(maxValue()))
  const W = 640
  const H = 212
  const L = 42
  const R = 8
  const T = 14
  const B = 27
  const plotW = W - L - R
  const plotH = H - T - B
  const step = createMemo(() => plotW / Math.max(data().length, 1))
  const barWidth = createMemo(() => Math.min(16, Math.max(3, step() * 0.56)))
  const average = createMemo(() => {
    if (!data().length) return 0
    return data().reduce((sum, point) => sum + point.input + point.output, 0) / data().length
  })

  return (
    <div class="uc-chart">
      <Show
        when={data().length > 0}
        fallback={<div class="uc-empty uc-empty-chart">当前范围还没有模型调用记录</div>}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Token 趋势">
          <For each={[0, 1, 2, 3, 4]}>
            {(index) => {
              const value = () => (scale().step * (4 - index))
              const y = () => T + (plotH * index) / 4
              return (
                <>
                  <line
                    x1={L}
                    y1={y()}
                    x2={W - R}
                    y2={y()}
                    stroke="var(--uc-grid)"
                    stroke-width="1"
                    stroke-dasharray={index === 4 ? "0" : "3 3"}
                  />
                  <text
                    x={L - 7}
                    y={y() + 3}
                    text-anchor="end"
                    font-size="8.5"
                    fill="var(--uc-faint)"
                    font-family="inherit"
                  >
                    {compact(value())}
                  </text>
                </>
              )
            }}
          </For>
          <line
            x1={L}
            y1={T + plotH * (1 - average() / scale().top)}
            x2={W - R}
            y2={T + plotH * (1 - average() / scale().top)}
            stroke="var(--uc-accent)"
            stroke-width="1"
            stroke-dasharray="4 4"
            opacity="0.55"
          />
          <For each={data()}>
            {(point, index) => {
              const total = () => point.input + point.output
              const height = () => Math.max(total() > 0 ? 1.2 : 0, (total() / scale().top) * plotH)
              const x = () => L + step() * index() + (step() - barWidth()) / 2
              const y = () => T + plotH - height()
              const last = () => index() === data().length - 1
              return (
                <rect
                  x={x()}
                  y={y()}
                  width={barWidth()}
                  height={height()}
                  rx="2"
                  fill={last() ? "var(--uc-accent)" : "var(--uc-bar)"}
                >
                  <title>
                    {point.date} · {compact(total())} tokens · {money(point.cost)}
                  </title>
                </rect>
              )
            }}
          </For>
          <For each={data()}>
            {(point, index) => {
              if (index() !== 0 && index() !== data().length - 1 && index() % 5 !== 0) return null
              const x = () => L + step() * index() + step() / 2
              return (
                <text
                  x={x()}
                  y={H - 5}
                  text-anchor="middle"
                  font-size="8.3"
                  fill="var(--uc-faint)"
                  font-family="inherit"
                >
                  {point.date.slice(5)}
                </text>
              )
            }}
          </For>
        </svg>
      </Show>
    </div>
  )
}

function CostDonut(props: { models: readonly ModelRow[]; total: number }) {
  const groups = createMemo(() => {
    const sorted = [...props.models].sort((a, b) => b.cost - a.cost)
    const top = sorted.filter((model) => model.cost > 0).slice(0, 3)
    const rest = sorted.filter((model) => model.cost > 0).slice(3)
    const other = rest.reduce((sum, model) => sum + model.cost, 0)
    const result = top.map((model, index) => ({
      name: shortModel(model.modelID),
      value: model.cost,
      color: CHART_COLORS[index]!,
    }))
    if (other > 0) result.push({ name: `其他 ${rest.length} 个`, value: other, color: CHART_COLORS[3]! })
    return result
  })
  const circumference = 2 * Math.PI * 34
  const segments = createMemo(() => {
    let offset = 0
    return groups().map((group) => {
      const length = props.total > 0 ? (group.value / props.total) * circumference : 0
      const segment = { ...group, length, offset }
      offset += length
      return segment
    })
  })
  return (
    <div class="uc-cost">
      <div class="uc-donut">
        <svg viewBox="0 0 92 92" aria-hidden="true">
          <circle cx="46" cy="46" r="34" fill="none" stroke="var(--uc-track)" stroke-width="9" />
          <For each={segments()}>
            {(group) => (
              <circle
                cx="46"
                cy="46"
                r="34"
                fill="none"
                stroke={group.color}
                stroke-width="9"
                stroke-dasharray={`${Math.max(group.length - 1.5, 0)} ${circumference}`}
                stroke-dashoffset={-group.offset}
                transform="rotate(-90 46 46)"
              />
            )}
          </For>
        </svg>
        <div class="uc-donut-center">
          <b>{money(props.total)}</b>
          <span>费用</span>
        </div>
      </div>
      <div class="uc-cost-legend">
        <Show when={groups().length > 0} fallback={<span class="uc-empty-line">暂无费用</span>}>
          <For each={groups()}>
            {(group) => (
              <div class="uc-cost-item">
                <i style={{ background: group.color }} />
                <span class="uc-cost-name">{group.name}</span>
                <b>{money(group.value)}</b>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function QuotaCard(props: { quota?: Quota; onRetry: () => void }) {
  const providers = () => props.quota?.providers ?? []
  const liveProviders = createMemo(() => providers().filter((provider) => provider.available && provider.meters.length > 0))
  /** The most-consumed window across every provider drives the ring and the warning tone. */
  const primary = createMemo<Meter | undefined>(() => {
    const all = providers().flatMap((provider) => provider.meters)
    if (all.length === 0) return undefined
    return all.reduce((worst, meter) => (meter.percent > worst.percent ? meter : worst), all[0]!)
  })
  /** 大环展示的是“占用最高的那个窗口”，必须注明它属于哪家供应商。 */
  const primaryOwner = createMemo(() =>
    providers().find((provider) => provider.meters.some((meter) => meter === primary())),
  )
  const ringPercent = () => Math.max(0, Math.min(100, primary()?.percent ?? 0))
  const ringColor = () => (ringPercent() >= 90 ? "var(--uc-red)" : ringPercent() >= 70 ? "var(--uc-amber)" : "var(--uc-accent)")
  const circumference = 2 * Math.PI * 36
  const meterColor = (meter: Meter) => (meter.percent >= 90 ? "var(--uc-red)" : meter.percent >= 70 ? "var(--uc-amber)" : "var(--uc-accent)")
  return (
    <section class="uc-card uc-quota">
      <div class="uc-card-head">
        <div>
          <div class="uc-card-title">订阅额度</div>
          <div class="uc-card-sub">多供应商 · 供应商接口返回的当前用量</div>
        </div>
        <Show
          when={props.quota?.available}
          fallback={<span class="uc-badge uc-badge-muted">{props.quota ? "未连接" : "读取中"}</span>}
        >
          <span class="uc-card-sub" style={{ "padding-top": "2px" }}>数据来自供应商接口</span>
        </Show>
      </div>
      <Show when={props.quota} fallback={<div class="uc-empty-line">正在读取额度…</div>}>
        <Show
          when={providers().length > 0}
          fallback={
            <div class="uc-quota-error">
              <span>{props.quota!.error || "额度接口暂不可用"}</span>
              <button type="button" class="uc-text-button" onClick={props.onRetry}>
                重试
              </button>
            </div>
          }
        >
          <Show when={primary()}>
            {(worst) => (
              <div class="uc-quota-top">
                <div class="uc-quota-donut">
                  <svg viewBox="0 0 96 96" aria-hidden="true">
                    <circle cx="48" cy="48" r="36" fill="none" stroke="var(--uc-track)" stroke-width="9" />
                    <circle
                      cx="48"
                      cy="48"
                      r="36"
                      fill="none"
                      stroke={ringColor()}
                      stroke-width="9"
                      stroke-linecap="round"
                      stroke-dasharray={`${(circumference * ringPercent()) / 100} ${circumference}`}
                      transform="rotate(-90 48 48)"
                    />
                  </svg>
                  <div class="uc-quota-center">
                    <b style={{ color: ringColor() }}>{Math.round(ringPercent())}%</b>
                    <span>{worst().label}</span>
                  </div>
                </div>
                <div class="uc-meters">
                  <div class="uc-quota-ring-owner">
                    占用最高的窗口：{primaryOwner()?.name ?? "未知供应商"}
                    <Show when={primaryOwner()?.plan}> · {primaryOwner()!.plan}</Show>
                  </div>
                  <For each={liveProviders()}>
                    {(provider) => (
                      <div class="uc-quota-provider">
                        <div class="uc-quota-provider-head">
                          <span>{provider.name}</span>
                          <Show when={provider.plan}>
                            <small>{provider.plan}</small>
                          </Show>
                        </div>
                        <For each={provider.meters}>
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
                                <i style={{ width: `${Math.max(1, Math.min(100, meter.percent))}%`, background: meterColor(meter) }} />
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
          <Show when={liveProviders().length === 0}>
            <div class="uc-quota-notes">
              <For each={providers()}>
                {(provider) => (
                  <div class="uc-quota-note" data-tone="muted">
                    <i />
                    {provider.name}：{provider.note || provider.error || "未暴露额度"}
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={liveProviders().length > 0}>
            <div class="uc-quota-note" data-tone={ringPercent() >= 90 ? "danger" : "muted"}>
              <i />
              {ringPercent() >= 90
                ? `${primaryOwner()?.name ?? "该供应商"} ${primary()!.label}即将用完 · 重置前建议切换到按量模型`
                : `${primaryOwner()?.name ?? ""} ${primary()!.label}已用 ${percent(ringPercent())} · 下方按供应商列出各自额度`}
            </div>
          </Show>
        </Show>
      </Show>
    </section>
  )
}

function ExpiryCard(props: { credentials: readonly CredentialRow[]; limit?: number; onOpenQuota?: () => void }) {
  const rows = createMemo(() => props.credentials.slice(0, props.limit ?? 3))
  /** 首行快要过期时卡片给出醒目提示，平时是安静的辅助文案。 */
  const soon = createMemo(() =>
    rows().find((credential) => credential.expires && credential.expires - Date.now() < 14 * 86_400_000),
  )
  return (
    <section class="uc-card uc-expiry">
      <div class="uc-card-head">
        <div>
          <div class="uc-card-title">凭据有效期</div>
          <div class="uc-card-sub">OAuth 登录与 API Key 的到期时间 · 不代表套餐到期</div>
        </div>
        <Show
          when={soon()}
          fallback={<span class="uc-card-sub" style={{ "padding-top": "2px" }}>{rows().length} 个凭据</span>}
        >
          {(credential) => (
            <button type="button" class="uc-card-link" data-tone="warn" onClick={props.onOpenQuota} title="查看凭据与额度">
              {expiryLabel(credential().expires).text}内到期 <span>→</span>
            </button>
          )}
        </Show>
      </div>
      <Show when={rows().length > 0} fallback={<div class="uc-empty-line">未发现可监控的凭据</div>}>
        <div class="uc-exp-list">
          <For each={rows()}>
            {(credential) => {
              const tag = () => expiryLabel(credential.expires)
              return (
                <div class="uc-exp-row">
                  <span class="uc-exp-icon">{modelInitial(credential.provider)}</span>
                  <span class="uc-exp-name">
                    <b>{credential.provider}</b>
                    <span>
                      {credential.type === "oauth" ? "OAuth" : "API Key"}
                      {credential.expires ? ` · ${dateText(credential.expires)}` : " · 无到期时间"}
                    </span>
                  </span>
                  <span class="uc-exp-tag" data-tone={tag().tone}>
                    {tag().text}
                  </span>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

function HealthCard(props: { latency: Snapshot["latency"]; insight?: { model: string; costShare: number; tokenShare: number } }) {
  const status = () =>
    props.latency.samples === 0
      ? "样本不足"
      : props.latency.ttftP95 > 30 || props.latency.slowRate > 0.2
        ? "需关注"
        : "正常"
  return (
    <section class="uc-card uc-health">
      <div class="uc-card-head">
        <div>
          <div class="uc-card-title">时延与健康</div>
          <div class="uc-card-sub">最近范围 · 模型响应</div>
        </div>
        <span class="uc-health-badge" data-tone={status() === "正常" ? "ok" : "warn"}>
          {status()}
        </span>
      </div>
      <Show
        when={props.latency.samples > 0}
        fallback={<div class="uc-empty-line">完成更多请求后显示时延</div>}
      >
        <div class="uc-health-metrics">
          <div class="uc-hm">
            <b>{duration(props.latency.ttftP50)}</b>
            <span>首字 P50</span>
          </div>
          <div class="uc-hm" data-tone={props.latency.ttftP95 > 30 ? "warn" : undefined}>
            <b>{duration(props.latency.ttftP95)}</b>
            <span>首字 P95</span>
          </div>
          <div class="uc-hm">
            <b>{props.latency.tokensPerSecond.toFixed(1)}</b>
            <span>输出 tok/s</span>
          </div>
        </div>
        <div class="uc-health-note">
          <i />
          <span>
            <b>{percent(props.latency.slowRate * 100, 1)}</b> 的请求超过 30 秒，P95 总时延 {duration(props.latency.totalP95)}（{compact(
              props.latency.samples,
            )} 个样本）。
            {props.insight
              ? ` ${props.insight.model} 占 ${percent(props.insight.costShare * 100, 1)} 费用，但只占 ${percent(
                  props.insight.tokenShare * 100,
                  1,
                )} Token。`
              : ""}
          </span>
        </div>
      </Show>
    </section>
  )
}

function SkeletonDashboard() {
  return (
    <>
      <div class="uc-kpis">
        <For each={[0, 1, 2, 3]}>
          {() => (
            <div class="uc-kpi uc-skeleton">
              <span class="uc-sk-line" style={{ width: "38%" }} />
              <span class="uc-sk-line uc-sk-value" style={{ width: "58%" }} />
              <span class="uc-sk-line" style={{ width: "72%" }} />
            </div>
          )}
        </For>
      </div>
      <div class="uc-body">
        <div class="uc-left">
          <div class="uc-card uc-skeleton-card uc-sk-trend">
            <span class="uc-sk-line" style={{ width: "28%" }} />
            <div class="uc-sk-chart" />
          </div>
          <div class="uc-card uc-skeleton-card uc-sk-models">
            <span class="uc-sk-line" style={{ width: "24%" }} />
            <For each={[0, 1, 2, 3]}>
              {() => <span class="uc-sk-line uc-sk-row" />}
            </For>
          </div>
        </div>
        <div class="uc-right">
          <For each={[0, 1, 2]}>
            {(index) => (
              <div classList={{ "uc-card uc-skeleton-card uc-sk-side": true, "uc-sk-short": index > 0 }}>
                <span class="uc-sk-line" style={{ width: "38%" }} />
                <span class="uc-sk-line" style={{ width: "72%" }} />
                <span class="uc-sk-line" style={{ width: "54%" }} />
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  )
}

function LatencyTab(props: { latency: Snapshot["latency"]; models: readonly LatencyModelRow[]; usage?: readonly ModelRow[] }) {
  const sorted = createMemo(() => [...props.models].filter((model) => model.samples > 0).sort((a, b) => b.ttftP95 - a.ttftP95))
  const maxP95 = createMemo(() => Math.max(1, ...sorted().map((model) => model.ttftP95)))
  const slowest = createMemo(() => {
    const pool = sorted().filter((model) => model.samples >= 20)
    const list = pool.length > 0 ? pool : sorted()
    return list.reduce((best, model) => (model.slowRate > best.slowRate ? model : best), list[0])
  })
  const status = () =>
    props.latency.samples === 0
      ? "样本不足"
      : props.latency.ttftP95 > 30 || props.latency.slowRate > 0.2
        ? "需关注"
        : "正常"
  return (
    <>
      <div class="uc-kpis uc-kpis-latency">
        <div class="uc-kpi">
          <div class="uc-kpi-label"><i />首字 P50</div>
          <div class="uc-kpi-value">{duration(props.latency.ttftP50)}</div>
          <div class="uc-kpi-sub">从请求开始到第一个流式事件</div>
        </div>
        <div class="uc-kpi">
          <div class="uc-kpi-label"><i data-tone="amber" />首字 P95</div>
          <div class="uc-kpi-value" data-tone={props.latency.ttftP95 > 30 ? "warn" : undefined}>
            {duration(props.latency.ttftP95)}
          </div>
          <div class="uc-kpi-sub">慢请求的主要来源</div>
        </div>
        <div class="uc-kpi">
          <div class="uc-kpi-label"><i data-tone="blue" />总时延 P95</div>
          <div class="uc-kpi-value">{duration(props.latency.totalP95)}</div>
          <div class="uc-kpi-sub">请求开始到完成</div>
        </div>
        <div class="uc-kpi">
          <div class="uc-kpi-label"><i data-tone="teal" />输出速度</div>
          <div class="uc-kpi-value">{props.latency.tokensPerSecond.toFixed(1)}<span class="uc-unit">tok/s</span></div>
          <div class="uc-kpi-sub">按总时延估算</div>
        </div>
        <div class="uc-kpi">
          <div class="uc-kpi-label"><i data-tone="amber" />慢请求</div>
          <div class="uc-kpi-value">{percent(props.latency.slowRate * 100, 1)}</div>
          <div class="uc-kpi-sub">超过 30 秒 · {compact(props.latency.samples)} 个样本</div>
        </div>
      </div>

      <div class="uc-detail-grid uc-latency-top">
        <section class="uc-card">
          <div class="uc-card-head">
            <div>
              <div class="uc-card-title">首字 P95 · 按模型</div>
              <div class="uc-card-sub">越长越慢 · 前 8 个模型</div>
            </div>
            <span class="uc-health-badge" data-tone={status() === "正常" ? "ok" : "warn"}>{status()}</span>
          </div>
          <Show when={sorted().length > 0} fallback={<div class="uc-empty-line">当前范围还没有时延样本</div>}>
            <div class="uc-lat-bars">
              <For each={sorted().slice(0, 8)}>
                {(model) => (
                  <div class="uc-lat-row">
                    <span class="uc-lat-name" title={`${providerName(model.providerID)} / ${model.modelID}`}>
                      {shortModel(model.modelID)}
                      <small>{providerName(model.providerID)}</small>
                    </span>
                    <span class="uc-lat-track"><i style={{ width: `${Math.max(3, (model.ttftP95 / maxP95()) * 100)}%` }} /></span>
                    <b>{duration(model.ttftP95)}</b>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
        <section class="uc-card">
          <div class="uc-card-head">
            <div>
              <div class="uc-card-title">慢请求与吞吐</div>
              <div class="uc-card-sub">已完成的 assistant 消息</div>
            </div>
          </div>
          <div class="uc-lat-health">
            <div class="uc-lat-stat"><b>{percent(props.latency.slowRate * 100, 1)}</b><span>慢请求比例</span></div>
            <div class="uc-lat-stat"><b>{props.latency.tokensPerSecond.toFixed(1)}</b><span>输出 tok/s</span></div>
            <div class="uc-lat-stat"><b>{compact(props.latency.samples)}</b><span>有效样本</span></div>
            <div class="uc-lat-stat"><b>{duration(props.latency.totalP95)}</b><span>总时延 P95</span></div>
          </div>
          <Show when={slowest()}>
            {(model) => (
              <div class="uc-lat-insight">
                慢请求最多：<b>{shortModel(model().modelID)}</b> {percent(model().slowRate * 100, 1)}（{compact(model().samples)} 个样本）
              </div>
            )}
          </Show>
          <div class="uc-detail-note">
            首字时延取 <code>time.streamed - time.created</code>，总时延取 <code>time.completed - time.created</code>。样本来自本机数据库，不包含进行中的请求。
          </div>
        </section>
      </div>

      <ModelEfficiency latencyModels={sorted()} usage={props.usage} />

      <section class="uc-card">
        <div class="uc-card-head">
          <div>
            <div class="uc-card-title">按模型明细</div>
            <div class="uc-card-sub">按首字 P95 从慢到快排序 · 前 10 个模型</div>
          </div>
        </div>
        <Show when={sorted().length > 0} fallback={<div class="uc-empty-line">当前范围还没有时延样本</div>}>
          <div class="uc-lat-table">
            <div class="uc-lat-head">
              <span>模型</span><span>样本</span><span>首字 P50</span><span>首字 P95</span><span>总时延 P95</span><span>慢请求</span><span>tok/s</span>
            </div>
            <For each={sorted().slice(0, 10)}>
              {(model) => (
                <div class="uc-lat-table-row">
                  <span class="uc-lat-model">
                    <i>{modelInitial(model.modelID)}</i>
                    <span><b title={model.modelID}>{shortModel(model.modelID)}</b><small>{providerName(model.providerID)}</small></span>
                  </span>
                  <span>{compact(model.samples)}</span>
                  <span>{duration(model.ttftP50)}</span>
                  <span>{duration(model.ttftP95)}</span>
                  <span>{duration(model.totalP95)}</span>
                  <span>{percent(model.slowRate * 100, 1)}</span>
                  <span>{model.tokensPerSecond.toFixed(1)}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </>
  )
}

/**
 * 模型效率对比（0.5）：横轴单请求平均成本、纵轴首字 P95，气泡大小 = 有效
 * Token 用量。数据只含有时延样本且有成本记录的模型；样本 < 10 的模型不画
 * （分位数不可信）。气泡位置手绘在归一化坐标里，不引图表库。
 */
function ModelEfficiency(props: { latencyModels: readonly LatencyModelRow[]; usage?: readonly ModelRow[] }) {
  const rows = createMemo(() => {
    const usage = new Map(props.usage?.map((row) => [`${row.providerID}:${row.modelID}`, row]) ?? [])
    return props.latencyModels
      .map((model) => {
        const costRow = usage.get(`${model.providerID}:${model.modelID}`)
        const tokens = (costRow?.input ?? 0) + (costRow?.output ?? 0)
        return {
          providerID: model.providerID,
          modelID: model.modelID,
          samples: model.samples,
          ttftP95: model.ttftP95,
          /** 单请求平均成本（估算）；无成本记录时为 0。 */
          costPerRequest: costRow && model.samples > 0 ? costRow.cost / model.samples : 0,
          tokens,
        }
      })
      .filter((row) => row.samples >= 10)
  })
  const maxCost = createMemo(() => Math.max(1e-9, ...rows().map((row) => row.costPerRequest)))
  const maxTtft = createMemo(() => Math.max(1e-9, ...rows().map((row) => row.ttftP95)))
  const maxTokens = createMemo(() => Math.max(1e-9, ...rows().map((row) => row.tokens)))
  /** 有任何成本记录才画横轴为成本的版本；否则退化为纯时延对比（没有成本轴）。 */
  const hasCost = createMemo(() => rows().some((row) => row.costPerRequest > 0))
  type ScatterRow = ReturnType<typeof rows>[number]
  const position = (row: ScatterRow) => ({
    x: hasCost() ? 8 + (row.costPerRequest / maxCost()) * 84 : 8 + (row.tokens / maxTokens()) * 84,
    y: 8 + (row.ttftP95 / maxTtft()) * 84,
    r: 3 + Math.sqrt(row.tokens / maxTokens()) * 9,
  })
  return (
    <Show when={rows().length >= 2} fallback={null}>
      <section class="uc-card">
        <div class="uc-card-head">
          <div>
            <div class="uc-card-title">模型效率对比</div>
            <div class="uc-card-sub">
              {hasCost()
                ? "横轴单请求成本（越左越省）· 纵轴首字 P95（越低越快）· 气泡 = 用量 · 样本 ≥ 10"
                : "横轴有效 Token 用量（费用未记录）· 纵轴首字 P95（越低越快）· 样本 ≥ 10"}
            </div>
          </div>
          <span class="uc-health-badge" data-tone="ok">{rows().length} 个模型</span>
        </div>
        <div class="uc-scatter">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <line x1="50" y1="4" x2="50" y2="96" stroke="var(--uc-border)" stroke-width="0.4" stroke-dasharray="2 2" />
            <line x1="4" y1="50" x2="96" y2="50" stroke="var(--uc-border)" stroke-width="0.4" stroke-dasharray="2 2" />
          </svg>
          <For each={rows()}>
            {(row) => {
              const pos = position(row)
              return (
                <button
                  type="button"
                  class="uc-scatter-dot"
                  style={{
                    left: `${pos.x}%`,
                    top: `${pos.y}%`,
                    width: `${pos.r * 2}%`,
                    // 气泡用固定纵横比：宽度按容器，高度按同一像素半径换算
                    height: `${pos.r * 2}%`,
                  }}
                  title={`${shortModel(row.modelID)}\n样本 ${compact(row.samples)} · 首字 P95 ${duration(row.ttftP95)}\n单请求成本 ${row.costPerRequest > 0 ? `$${row.costPerRequest.toFixed(4)}` : "未记录"}\n有效 Token ${compact(row.tokens)}`}
                />
              )
            }}
          </For>
        </div>
        <div class="uc-scatter-labels">
          <span>{hasCost() ? "← 成本低" : "← 用量小"}</span>
          <span>{hasCost() ? "成本高 →" : "用量大 →"}</span>
        </div>
        <div class="uc-scatter-labels uc-scatter-v">
          <span>↑ 慢</span>
          <span>快 ↓</span>
        </div>
        <div class="uc-attr-note">
          左下角理想：又快又省（或用量视角下少用）。右上角值得检查：又慢又贵（或用量集中）。分位数对样本量敏感，样本 ≥ 10 才纳入。
        </div>
      </section>
    </Show>
  )
}

function SessionsTab(props: {
  ctx: Context
  sessions: readonly SessionRow[]
  projects: readonly ProjectRow[]
  /** 当前统计范围的人类可读名称，用于说明搜索覆盖的会话集合。 */
  rangeLabel: string
  selected?: SessionRow
  onSelect: (session: SessionRow) => void
  onClose: () => void
  /** 从总览钻取过来时预置的模型筛选（只初始化一次）。 */
  initialModel?: string
}) {
  const [query, setQuery] = createSignal("")
  /** 组合筛选：项目 / 模型 / 日期。与搜索词叠加生效。 */
  const [projectFilter, setProjectFilter] = createSignal("all")
  const [modelFilter, setModelFilter] = createSignal(props.initialModel ?? "all")
  const [dayFilter, setDayFilter] = createSignal("all")
  /** 一次只渲染一部分行：500 行 DOM 一次性挂上会拖慢首次切到本页签的速度。 */
  const [visibleCount, setVisibleCount] = createSignal(80)
  let listScroll = 0
  const projectName = (id: string) => props.projects.find((project) => project.id === id)?.name ?? "未命名项目"

  /** 会话最后活动日期（本地时区），供日期筛选。 */
  const dayOf = (session: SessionRow) => {
    const date = new Date(session.timeUpdated)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  }
  /** 筛选选项从数据里来，保持与统计范围一致。 */
  const modelOptions = createMemo(() => {
    const seen = new Map<string, string>()
    for (const session of props.sessions) {
      if (!seen.has(session.modelID)) seen.set(session.modelID, session.providerID)
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })
  const dayOptions = createMemo(() => [...new Set(props.sessions.map(dayOf))].sort().reverse())
  const filtersActive = createMemo(
    () => projectFilter() !== "all" || modelFilter() !== "all" || dayFilter() !== "all" || Boolean(query().trim()),
  )

  const filtered = createMemo(() => {
    const value = query().trim().toLowerCase()
    return props.sessions.filter((session) => {
      if (projectFilter() !== "all" && session.projectID !== projectFilter()) return false
      if (modelFilter() !== "all" && session.modelID !== modelFilter()) return false
      if (dayFilter() !== "all" && dayOf(session) !== dayFilter()) return false
      if (!value) return true
      return [session.title, session.modelID, session.providerID, projectName(session.projectID)]
        .join(" ")
        .toLowerCase()
        .includes(value)
    })
  })
  const visibleSessions = createMemo(() => filtered().slice(0, visibleCount()))
  // 搜索词、筛选或数据集变化后回到首批；副作用放在 createEffect 而不是 memo 里。
  createEffect(() => {
    void filtered()
    setVisibleCount(80)
  })

  function clearFilters() {
    setQuery("")
    setProjectFilter("all")
    setModelFilter("all")
    setDayFilter("all")
  }

  function openSession(session: SessionRow, event: MouseEvent | KeyboardEvent) {
    const list = (event.currentTarget as HTMLElement | null)?.closest(".uc-session-list")
    listScroll = list instanceof HTMLElement ? list.scrollTop : 0
    props.onSelect(session)
  }

  function exportCsv() {
    const rows = filtered()
    if (rows.length === 0) return
    const csv = [
      ["会话", "项目", "供应商", "模型", "输入", "输出", "缓存读取", "费用", "最后活动"],
      ...rows.map((session) => [
        session.title,
        projectName(session.projectID),
        providerName(session.providerID),
        session.modelID,
        session.input,
        session.output,
        session.cacheRead,
        session.cost,
        new Date(session.timeUpdated).toISOString(),
      ]),
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\n")
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `opencode-usage-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <Show
      when={props.selected}
      fallback={
        <section class="uc-card uc-sessions-page">
      <div class="uc-card-head">
        <div>
          <div class="uc-card-title">会话明细</div>
          <div class="uc-card-sub">
            按最后活动时间排序 · 搜索仅覆盖已载入的 {props.sessions.length} 条（统计范围：{props.rangeLabel}）· 点击会话查看完整历史
          </div>
        </div>
        <button
          type="button"
          class="uc-export"
          title={`导出当前筛选命中的 ${filtered().length} 条会话（CSV，含会话标题 / 项目 / 模型 / Token / 费用，不含提示词与回复）`}
          onClick={exportCsv}
        >
          导出 CSV
        </button>
      </div>
      <div class="uc-sessions-tools">
        <label class="uc-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2 14 14" />
          </svg>
          <input
            id="uc-session-search"
            name="uc-session-search"
            aria-label="搜索会话"
            placeholder="搜索会话、模型或项目"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <select
          class="uc-filter-select"
          data-active={projectFilter() !== "all" ? "true" : undefined}
          aria-label="按项目筛选"
          value={projectFilter()}
          onChange={(event) => setProjectFilter(event.currentTarget.value)}
        >
          <option value="all">全部项目</option>
          <For each={props.projects.filter((project) => props.sessions.some((session) => session.projectID === project.id))}>
            {(project) => <option value={project.id}>{project.name}</option>}
          </For>
        </select>
        <select
          class="uc-filter-select"
          data-active={modelFilter() !== "all" ? "true" : undefined}
          aria-label="按模型筛选"
          value={modelFilter()}
          onChange={(event) => setModelFilter(event.currentTarget.value)}
        >
          <option value="all">全部模型</option>
          <For each={modelOptions()}>
            {([modelID]) => <option value={modelID}>{shortModel(modelID)}</option>}
          </For>
        </select>
        <select
          class="uc-filter-select"
          data-active={dayFilter() !== "all" ? "true" : undefined}
          aria-label="按日期筛选"
          value={dayFilter()}
          onChange={(event) => setDayFilter(event.currentTarget.value)}
        >
          <option value="all">全部日期</option>
          <For each={dayOptions()}>
            {(day) => <option value={day}>{day}</option>}
          </For>
        </select>
        <Show when={filtersActive()}>
          <button type="button" class="uc-text-button" onClick={clearFilters}>
            清空筛选
          </button>
        </Show>
        <span class="uc-sessions-count">显示 {filtered().length} / {props.sessions.length} 条</span>
      </div>
      <Show when={filtered().length > 0} fallback={<div class="uc-empty-line">没有匹配的会话</div>}>
        <div class="uc-session-head">
          <span>会话</span><span>项目</span><span>模型</span><span>Token</span><span>费用</span><span>最近活动</span>
        </div>
        <div
          class="uc-session-list"
          ref={(element) => {
            queueMicrotask(() => {
              element.scrollTop = listScroll
            })
          }}
        >
          <For each={visibleSessions()}>
            {(session) => (
              <div
                class="uc-session-row"
                role="button"
                tabIndex={0}
                onClick={(event) => openSession(session, event)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    openSession(session, event)
                  }
                }}
              >
                <span class="uc-session-title" title={session.title}>{session.title}</span>
                <span class="uc-session-project" title={projectName(session.projectID)}>{projectName(session.projectID)}</span>
                <span class="uc-session-model" title={`${providerName(session.providerID)} / ${session.modelID}`}>
                  <i>{modelInitial(session.modelID)}</i>
                  {shortModel(session.modelID)}
                </span>
                <span>{compact(session.input + session.output)}</span>
                <span>
                  {session.cost > 0 ? (
                    money(session.cost)
                  ) : (
                    /* $0 有多种可能：订阅内调用、免费模型或价格未记录——不给结论，只提示悬停说明。 */
                    <span class="uc-zero" title="$0：可能是订阅内调用、免费模型，或该请求未记录价格。可在回放里看单次请求的计费说明。">$0</span>
                  )}
                </span>
                <span class="uc-session-time">
                  {relativeTime(session.timeUpdated)}
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                    <path d="M4.5 2.5 8 6l-3.5 3.5" />
                  </svg>
                </span>
              </div>
            )}
          </For>
        </div>
        <Show when={filtered().length > visibleSessions().length}>
          <button
            type="button"
            class="uc-session-more"
            onClick={() => setVisibleCount((count) => count + 120)}
          >
            显示更多（还有 {filtered().length - visibleSessions().length} 条）
          </button>
        </Show>
      </Show>
        </section>
      }
    >
      {(session) => (
        <SessionDetailView
          ctx={props.ctx}
          session={session()}
          projectName={projectName(session().projectID)}
          onBack={props.onClose}
        />
      )}
    </Show>
  )
}

const CSS = `
.uc-root {
  --uc-strong: var(--color-v2-text-text-contrast, var(--color-text-strong, currentColor));
  --uc-muted: var(--color-v2-text-text-muted, var(--color-text-weak, color-mix(in srgb, currentColor 58%, transparent)));
  --uc-faint: var(--color-v2-text-text-faint, color-mix(in srgb, currentColor 42%, transparent));
  --uc-border: var(--color-v2-border-border-base, var(--color-border-weak-base, color-mix(in srgb, currentColor 12%, transparent)));
  --uc-card: var(--color-v2-background-bg-base, var(--color-surface-base, #fff));
  --uc-layer: var(--color-v2-background-bg-layer-01, #fafafa);
  --uc-layer-2: var(--color-v2-background-bg-layer-02, #f2f2f2);
  --uc-accent: #6d4aff;
  --uc-blue: #3b82f6;
  --uc-teal: #0ea5a4;
  --uc-amber: #b45309;
  --uc-red: #d92d20;
  --uc-green: #0f7b4f;
  --uc-purple: #7c3aed;
  --uc-orange: #c2410c;
  --uc-grid: color-mix(in srgb, var(--uc-muted) 17%, transparent);
  --uc-track: color-mix(in srgb, var(--uc-muted) 13%, transparent);
  --uc-bar: color-mix(in srgb, var(--uc-accent) 24%, var(--uc-card));
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
  padding: 4px 0 36px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--uc-strong);
  font-size: 12px;
}
.uc-root *, .uc-root *::before, .uc-root *::after { box-sizing: border-box; }
.uc-root button, .uc-root select { font: inherit; }

/* hero */
.uc-hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 22px;
  min-height: 112px;
  padding: 16px 20px;
  border: 1px solid var(--uc-border);
  border-radius: 14px;
  overflow: hidden;
  background:
    radial-gradient(120% 190% at 0% 0%, color-mix(in srgb, var(--uc-accent) 14%, transparent) 0%, transparent 55%),
    linear-gradient(115deg,
      color-mix(in srgb, var(--uc-accent) 4%, var(--uc-card)) 0%,
      color-mix(in srgb, var(--uc-accent) 3%, var(--uc-card)) 52%,
      color-mix(in srgb, var(--uc-blue) 3%, var(--uc-card)) 100%);
}
.uc-hero::after {
  content: "";
  position: absolute;
  right: 210px;
  bottom: -60px;
  width: 440px;
  height: 160px;
  background: radial-gradient(ellipse at center, color-mix(in srgb, var(--uc-accent) 11%, transparent), transparent 68%);
  pointer-events: none;
}
.uc-hero-copy { min-width: 0; position: relative; z-index: 1; }
.uc-kicker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  color: var(--uc-accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.13em;
}
.uc-kicker svg { width: 13px; height: 13px; }
.uc-root h1 {
  margin: 0;
  font-size: 21px;
  font-weight: 680;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--uc-strong);
}
.uc-sub { margin: 4px 0 0; color: var(--uc-muted); font-size: 11.5px; line-height: 1.5; }
.uc-hero-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
  color: var(--uc-faint);
  font-size: 10.5px;
  flex-wrap: wrap;
}
.uc-hero-meta b { color: var(--uc-muted); font-weight: 620; }
.uc-sep { width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: 0.55; }
.uc-hero-tools {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex: 0 0 auto;
}
.uc-tool-row { display: flex; align-items: center; gap: 8px; }
.uc-tool-row-bottom { gap: 10px; }
.uc-seg {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--uc-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--uc-card) 74%, transparent);
}
.uc-seg button {
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--uc-muted);
  font-size: 10.5px;
  font-weight: 560;
  cursor: pointer;
  white-space: nowrap;
}
.uc-seg button.uc-seg-on {
  background: var(--uc-card);
  color: var(--uc-accent);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.10), 0 0 0 0.5px color-mix(in srgb, var(--uc-accent) 24%, transparent);
}
.uc-scope { display: flex; align-items: center; gap: 6px; color: var(--uc-faint); font-size: 10px; }
.uc-scope select {
  height: 28px;
  max-width: 170px;
  padding: 0 8px;
  border: 1px solid var(--uc-border);
  border-radius: 7px;
  background: var(--uc-card);
  color: var(--uc-strong);
  font-size: 10.5px;
  outline: none;
}
.uc-sync { color: var(--uc-faint); font-size: 9.8px; white-space: nowrap; }
.uc-sync b { color: var(--uc-green); font-weight: 620; }

/* tabs */
.uc-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 35px;
  border-bottom: 1px solid var(--uc-border);
}
.uc-tab {
  position: relative;
  height: 35px;
  padding: 0 11px;
  border: 0;
  background: transparent;
  color: var(--uc-muted);
  font: inherit;
  font-size: 11.5px;
  font-weight: 560;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
.uc-tab[data-active="true"] { color: var(--uc-strong); font-weight: 650; }
.uc-tab[data-active="true"]::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--uc-accent);
}
.uc-tab-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--uc-red); }
.uc-tab-dot[data-tone="warn"] { background: var(--uc-amber); }
.uc-tabs-scope { margin-left: auto; color: var(--uc-faint); font-size: 9.8px; padding-right: 2px; }
.uc-spacer { flex: 1; }

/* notices */
.uc-alert {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 38px;
  padding: 6px 12px;
  border: 1px solid color-mix(in srgb, var(--uc-amber) 24%, transparent);
  border-radius: 9px;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--uc-amber) 11%, transparent),
    color-mix(in srgb, var(--uc-amber) 4%, transparent));
  color: color-mix(in srgb, var(--uc-amber) 82%, var(--uc-strong));
  font-size: 11px;
}
/* 数据库不可用等错误级告警：红色，不提供冷却关闭（状态会变） */
.uc-alert[data-tone="danger"] {
  border-color: color-mix(in srgb, var(--uc-red) 26%, transparent);
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--uc-red) 9%, transparent),
    color-mix(in srgb, var(--uc-red) 3%, transparent));
  color: color-mix(in srgb, var(--uc-red) 85%, var(--uc-strong));
}
.uc-alert[data-tone="danger"] .uc-alert-icon { background: color-mix(in srgb, var(--uc-red) 13%, transparent); color: var(--uc-red); }
.uc-alert-icon {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  border-radius: 5px;
  background: color-mix(in srgb, var(--uc-amber) 13%, transparent);
  display: grid;
  place-items: center;
}
.uc-alert b { font-weight: 680; }
.uc-alert-detail { opacity: 0.8; }
.uc-alert-link {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--uc-amber) 90%, var(--uc-strong));
  font-size: 10.5px;
  font-weight: 620;
  white-space: nowrap;
  cursor: pointer;
}
.uc-alert-link span { margin-left: 3px; }
.uc-alert-close {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.uc-alert-close:hover { opacity: 1; background: color-mix(in srgb, currentColor 10%, transparent); }
.uc-alert-close svg { width: 10px; height: 10px; }
.uc-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid var(--uc-border);
  border-radius: 9px;
  background: var(--uc-layer);
  color: var(--uc-muted);
  font-size: 11px;
}
.uc-notice[data-tone="error"] { border-color: color-mix(in srgb, var(--uc-red) 26%, transparent); color: var(--uc-red); background: color-mix(in srgb, var(--uc-red) 6%, var(--uc-card)); }
.uc-text-button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--uc-accent);
  font-size: 10.5px;
  font-weight: 620;
  cursor: pointer;
  white-space: nowrap;
}

/* kpi */
.uc-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.uc-kpi {
  position: relative;
  min-height: 94px;
  padding: 12px 14px;
  border: 1px solid var(--uc-border);
  border-radius: 11px;
  background: var(--uc-card);
  overflow: hidden;
}
.uc-kpi-label { display: flex; align-items: center; gap: 5px; color: var(--uc-muted); font-size: 10.5px; font-weight: 560; }
.uc-kpi-label i { width: 5px; height: 5px; border-radius: 50%; background: var(--uc-accent); }
.uc-kpi-label i[data-tone="amber"] { background: var(--uc-amber); }
.uc-kpi-label i[data-tone="teal"] { background: var(--uc-teal); }
.uc-kpi-label i[data-tone="blue"] { background: var(--uc-blue); }
.uc-kpi-value {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 3px;
  font-size: 23px;
  font-weight: 680;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.uc-delta {
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 9.5px;
  font-weight: 680;
  font-variant-numeric: tabular-nums;
}
.uc-delta[data-tone="up"] { color: var(--uc-green); background: color-mix(in srgb, var(--uc-green) 9%, transparent); }
.uc-delta[data-tone="warn"] { color: var(--uc-amber); background: color-mix(in srgb, var(--uc-amber) 9%, transparent); }
.uc-delta[data-tone="down"] { color: var(--uc-faint); background: var(--uc-layer-2); }
.uc-kpi-sub { margin-top: 5px; color: var(--uc-faint); font-size: 9.9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uc-spark { position: absolute; right: 11px; bottom: 9px; width: 64px; height: 26px; opacity: 0.9; }
.uc-spark path:last-child { fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.uc-spark-area { stroke: none; opacity: 0.15; }

/* layout */
.uc-body { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 12px; align-items: start; }
.uc-left, .uc-right { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.uc-card {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--uc-border);
  border-radius: 12px;
  background: var(--uc-card);
  display: flex;
  flex-direction: column;
}
.uc-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.uc-card-title { font-size: 12px; font-weight: 660; letter-spacing: -0.01em; }
.uc-card-sub { margin-top: 2px; color: var(--uc-faint); font-size: 10px; }
.uc-card-link {
  border: 0;
  background: transparent;
  padding: 2px 0;
  color: var(--uc-accent);
  font: inherit;
  font-size: 10px;
  font-weight: 620;
  white-space: nowrap;
  cursor: pointer;
}
.uc-card-link:hover span { transform: translateX(1px); }
.uc-card-link span { display: inline-block; margin-left: 2px; transition: transform 0.12s ease; }
.uc-card-link[data-tone="warn"] { color: var(--uc-amber); }
.uc-card-link:focus-visible { outline: 2px solid color-mix(in srgb, var(--uc-accent) 45%, transparent); outline-offset: 2px; border-radius: 4px; }
.uc-legend { display: flex; align-items: center; gap: 5px; color: var(--uc-muted); font-size: 9.8px; }
.uc-legend i { width: 7px; height: 7px; border-radius: 2px; background: var(--uc-accent); }

/* trend */
.uc-trend { min-height: 318px; }
.uc-trend-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 205px; gap: 16px; }
.uc-chart-wrap { min-width: 0; display: flex; flex-direction: column; }
.uc-chart { height: 212px; min-height: 160px; }
.uc-chart svg { width: 100%; height: 100%; display: block; overflow: visible; }
.uc-chart-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--uc-faint); font-size: 9.8px; padding-top: 3px; }
.uc-chart-foot b { color: var(--uc-muted); font-weight: 620; }
.uc-cost-side { border-left: 1px solid var(--uc-border); padding-left: 16px; min-width: 0; display: flex; flex-direction: column; }
.uc-side-title { color: var(--uc-muted); font-size: 10px; font-weight: 620; }
.uc-cost { display: flex; flex-direction: column; gap: 8px; margin-top: 5px; }
.uc-donut { position: relative; width: 92px; height: 92px; }
.uc-donut svg { width: 92px; height: 92px; }
.uc-donut-center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
.uc-donut-center b { font-size: 16px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.uc-donut-center span { color: var(--uc-faint); font-size: 10px; margin-top: 1px; }
.uc-cost-legend { display: flex; flex-direction: column; gap: 5px; }
.uc-cost-item { display: flex; align-items: center; gap: 6px; font-size: 9.6px; color: var(--uc-muted); min-width: 0; }
.uc-cost-item i { width: 6px; height: 6px; border-radius: 2px; flex: 0 0 auto; }
.uc-cost-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-cost-item b { color: var(--uc-strong); font-weight: 620; font-variant-numeric: tabular-nums; }
.uc-cost-note {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px dashed var(--uc-border);
  color: var(--uc-faint);
  font-size: 10px;
  line-height: 1.5;
}
.uc-cost-note b { color: var(--uc-amber); font-weight: 660; }

/* model table */
.uc-models { min-height: 254px; }
.uc-model-head, .uc-model-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px 70px 52px 54px;
  align-items: center;
  gap: 6px;
}
.uc-model-head {
  color: var(--uc-faint);
  font-size: 10px;
  letter-spacing: 0.02em;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--uc-border);
}
.uc-model-head > span:nth-child(n+2), .uc-model-row > span:nth-child(n+2) { text-align: right; }
.uc-model-list { display: flex; flex-direction: column; }
/* 模型行可点击（0.5/1.0 钻取）：hover 提示 + 键盘焦点环 */
.uc-model-row { min-height: 38px; border-bottom: 1px solid color-mix(in srgb, var(--uc-border) 65%, transparent); font-size: 10.6px; font-variant-numeric: tabular-nums; cursor: pointer; }
.uc-model-row:hover { background: color-mix(in srgb, var(--uc-accent) 4%, transparent); }
.uc-model-row:focus-visible { outline: 2px solid color-mix(in srgb, var(--uc-accent) 45%, transparent); outline-offset: -2px; border-radius: 5px; }
.uc-model-row:last-child { border-bottom: 0; }
.uc-model-name { display: flex; align-items: center; gap: 7px; min-width: 0; }
.uc-model-icon {
  width: 23px;
  height: 23px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: color-mix(in srgb, var(--uc-accent) 11%, transparent);
  color: var(--uc-accent);
  font-size: 10px;
  font-weight: 750;
}
.uc-model-text { min-width: 0; display: block; }
.uc-model-title { display: block; font-size: 10.8px; font-weight: 620; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uc-model-provider { display: block; color: var(--uc-faint); font-size: 10px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uc-share { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.uc-share-bar { width: 34px; height: 3px; border-radius: 99px; background: var(--uc-track); overflow: hidden; }
.uc-share-bar i { display: block; height: 100%; border-radius: 99px; background: var(--uc-accent); }
.uc-zero { color: var(--uc-faint); }
.uc-model-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--uc-border); padding-top: 6px; color: var(--uc-faint); font-size: 10px; margin-top: auto; }
.uc-model-foot b { color: var(--uc-muted); font-weight: 620; }
.uc-model-more {
  border: 0;
  background: transparent;
  padding: 2px 0;
  color: var(--uc-accent);
  font: inherit;
  font-size: 10px;
  font-weight: 620;
  cursor: pointer;
  white-space: nowrap;
}
.uc-model-more:hover { text-decoration: underline; }

/* quota */
.uc-quota { min-height: 238px; }
.uc-badge { height: 17px; padding: 0 6px; border-radius: 4px; display: inline-flex; align-items: center; font-size: 9.5px; font-weight: 650; }
.uc-badge-muted { color: var(--uc-faint); background: var(--uc-layer-2); }
.uc-live { height: 17px; padding: 0 6px; border-radius: 4px; background: color-mix(in srgb, var(--uc-green) 9%, transparent); color: var(--uc-green); font-size: 9.5px; font-weight: 650; display: inline-flex; align-items: center; gap: 4px; }
.uc-live i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.uc-quota-top { display: flex; align-items: center; gap: 16px; flex: 1; min-height: 0; }
.uc-quota-donut { position: relative; width: 96px; height: 96px; flex: 0 0 auto; }
.uc-quota-donut svg { width: 96px; height: 96px; }
.uc-quota-center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
.uc-quota-center b { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.uc-quota-center span { color: var(--uc-faint); font-size: 10px; margin-top: 1px; }
.uc-meters { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
.uc-quota-provider { display: flex; flex-direction: column; gap: 6px; }
.uc-quota-provider + .uc-quota-provider { border-top: 1px dashed var(--uc-border); padding-top: 8px; }
.uc-quota-provider-head { display: flex; align-items: baseline; gap: 6px; color: var(--uc-strong); font-size: 9.8px; font-weight: 650; }
.uc-quota-provider-head small { color: var(--uc-faint); font-size: 9.5px; font-weight: 500; }
.uc-quota-ring-owner { color: var(--uc-muted); font-size: 9.8px; font-weight: 600; margin-bottom: 6px; }
.uc-quota-notes { display: flex; flex-direction: column; gap: 6px; min-height: 130px; justify-content: center; }
.uc-meter-row { min-width: 0; }
.uc-meter-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: var(--uc-muted); font-size: 9.5px; }
.uc-meter-top span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-meter-top small { color: var(--uc-faint); font-size: 9.5px; margin-left: 5px; }
.uc-meter-top b { color: var(--uc-strong); font-size: 10.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.uc-meter { height: 4px; border-radius: 99px; background: var(--uc-track); overflow: hidden; margin-top: 4px; }
.uc-meter i { display: block; height: 100%; border-radius: 99px; }
.uc-quota-note { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--uc-border); padding-top: 8px; margin-top: 8px; color: var(--uc-faint); font-size: 10px; }
.uc-quota-note i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 10%, transparent); flex: 0 0 auto; }
.uc-quota-note[data-tone="danger"] { color: var(--uc-red); font-weight: 560; }
.uc-quota-error {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 130px;
  color: var(--uc-muted);
  font-size: 10.5px;
}
.uc-integrations .uc-quota-error { min-height: 0; border: 1px dashed color-mix(in srgb, var(--uc-red) 35%, var(--uc-border)); border-radius: 9px; padding: 10px 12px; }
.uc-quota-error > span { flex: 1; }

/* expiry */
.uc-expiry { min-height: 156px; }
.uc-exp-list { display: flex; flex-direction: column; justify-content: space-evenly; flex: 1; min-height: 0; }
.uc-exp-row { display: flex; align-items: center; gap: 8px; font-size: 10px; min-height: 32px; }
.uc-exp-icon {
  width: 21px;
  height: 21px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: color-mix(in srgb, var(--uc-accent) 9%, transparent);
  color: var(--uc-accent);
  font-size: 10px;
  font-weight: 750;
}
.uc-exp-name { flex: 1; min-width: 0; }
.uc-exp-name b { display: block; font-size: 10.5px; font-weight: 620; }
.uc-exp-name span { display: block; color: var(--uc-faint); font-size: 9.5px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-exp-tag { font-size: 10px; font-weight: 620; font-variant-numeric: tabular-nums; padding: 2px 5px; border-radius: 4px; white-space: nowrap; }
.uc-exp-tag[data-tone="ok"] { color: var(--uc-green); background: color-mix(in srgb, var(--uc-green) 8%, transparent); }
.uc-exp-tag[data-tone="warn"] { color: var(--uc-amber); background: color-mix(in srgb, var(--uc-amber) 9%, transparent); }
.uc-exp-tag[data-tone="danger"] { color: var(--uc-red); background: color-mix(in srgb, var(--uc-red) 8%, transparent); }
.uc-exp-tag[data-tone="none"] { color: var(--uc-faint); background: var(--uc-layer-2); }

/* health */
.uc-health { min-height: 162px; }
.uc-health-badge { height: 17px; padding: 0 6px; border-radius: 4px; display: inline-flex; align-items: center; font-size: 9.5px; font-weight: 650; }
.uc-health-badge[data-tone="ok"] { color: var(--uc-green); background: color-mix(in srgb, var(--uc-green) 8%, transparent); }
.uc-health-badge[data-tone="warn"] { color: var(--uc-amber); background: color-mix(in srgb, var(--uc-amber) 9%, transparent); }
.uc-health-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 2px; }
.uc-hm { min-width: 0; padding: 7px 0 6px; border-radius: 7px; background: var(--uc-layer); border: 1px solid var(--uc-border); text-align: center; }
.uc-hm b { display: block; font-size: 14.5px; font-weight: 680; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.uc-hm span { display: block; color: var(--uc-faint); font-size: 9.5px; margin-top: 2px; }
.uc-hm[data-tone="warn"] b { color: var(--uc-amber); }
.uc-health-note { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--uc-border); color: var(--uc-muted); font-size: 10px; line-height: 1.45; display: flex; align-items: flex-start; gap: 5px; }
.uc-health-note i { width: 5px; height: 5px; border-radius: 50%; background: var(--uc-amber); margin-top: 4px; flex: 0 0 auto; }
.uc-health-note b { color: var(--uc-amber); font-weight: 650; }

/* sessions */
.uc-sessions-page { min-height: 420px; }
.uc-sessions-tools { display: flex; align-items: center; gap: 10px; margin: 2px 0 10px; flex-wrap: wrap; }
.uc-filter-select {
  height: 28px;
  max-width: 150px;
  padding: 0 6px;
  border: 1px solid var(--uc-border);
  border-radius: 6px;
  background: var(--uc-card);
  color: var(--uc-muted);
  font: inherit;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uc-filter-select[data-active="true"] { border-color: color-mix(in srgb, var(--uc-accent) 45%, var(--uc-border)); color: var(--uc-strong); }
.uc-search { position: relative; flex: 1; min-width: 200px; max-width: 420px; }
.uc-search svg { position: absolute; left: 9px; top: 50%; transform: translateY(-50%); width: 13px; height: 13px; color: var(--uc-faint); }
.uc-search input {
  width: 100%;
  height: 30px;
  padding: 0 10px 0 28px;
  border: 1px solid var(--uc-border);
  border-radius: 7px;
  background: var(--uc-layer);
  color: var(--uc-strong);
  font: inherit;
  font-size: 10.5px;
  outline: none;
}
.uc-search input::placeholder { color: var(--uc-faint); }
.uc-sessions-count { color: var(--uc-faint); font-size: 9.5px; }
.uc-export {
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--uc-border);
  border-radius: 6px;
  background: var(--uc-card);
  color: var(--uc-muted);
  font: inherit;
  font-size: 10px;
  font-weight: 560;
  cursor: pointer;
  white-space: nowrap;
}
.uc-session-head, .uc-session-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) 110px 150px 64px 54px 88px;
  align-items: center;
  gap: 8px;
}
.uc-session-head { color: var(--uc-faint); font-size: 10px; padding-bottom: 5px; border-bottom: 1px solid var(--uc-border); }
.uc-session-list { max-height: 540px; overflow: auto; overscroll-behavior: contain; }
.uc-session-head > span:nth-child(n+4), .uc-session-row > span:nth-child(n+4) { text-align: right; }
.uc-session-row { min-height: 34px; border-bottom: 1px solid color-mix(in srgb, var(--uc-border) 60%, transparent); font-size: 10.3px; font-variant-numeric: tabular-nums; cursor: pointer; }
.uc-session-row:last-child { border-bottom: 0; }
.uc-session-row:hover { background: color-mix(in srgb, var(--uc-accent) 4%, transparent); }
.uc-session-row:focus-visible { outline: 2px solid color-mix(in srgb, var(--uc-accent) 45%, transparent); outline-offset: -2px; border-radius: 5px; }
.uc-session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-strong); font-weight: 540; }
.uc-session-project { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-faint); font-size: 9.5px; }
.uc-session-model { display: flex; align-items: center; gap: 5px; min-width: 0; color: var(--uc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-session-model i { width: 18px; height: 18px; border-radius: 5px; display: grid; place-items: center; flex: 0 0 auto; background: color-mix(in srgb, var(--uc-accent) 9%, transparent); color: var(--uc-accent); font-size: 8px; font-weight: 750; font-style: normal; }
.uc-session-time { color: var(--uc-faint); display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.uc-session-time svg { width: 10px; height: 10px; opacity: 0; transform: translateX(-2px); transition: opacity 0.12s ease, transform 0.12s ease; }
.uc-session-row:hover .uc-session-time svg, .uc-session-row:focus-visible .uc-session-time svg { opacity: 1; transform: none; }
.uc-session-more {
  margin-top: 8px;
  height: 30px;
  padding: 0 12px;
  border: 1px dashed var(--uc-border);
  border-radius: 7px;
  background: transparent;
  color: var(--uc-muted);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
.uc-session-more:hover { color: var(--uc-strong); border-color: color-mix(in srgb, var(--uc-accent) 40%, var(--uc-border)); }

/* detail tabs */
.uc-detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr);
  gap: 12px;
  align-items: start;
}
.uc-detail-note { margin-top: 12px; padding-top: 9px; border-top: 1px dashed var(--uc-border); color: var(--uc-faint); font-size: 10px; line-height: 1.5; }
.uc-kpis-latency { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.uc-kpi-value[data-tone="warn"] { color: var(--uc-amber); }
.uc-unit { color: var(--uc-faint); font-size: 10px; font-weight: 520; letter-spacing: 0; }
.uc-latency-top { grid-template-columns: minmax(0, 1.3fr) minmax(280px, 0.7fr); align-items: stretch; }
.uc-latency-top > .uc-card { display: flex; flex-direction: column; }
.uc-lat-bars { display: flex; flex-direction: column; gap: 9px; margin-top: 4px; }
.uc-lat-row { display: grid; grid-template-columns: minmax(120px, 190px) minmax(0, 1fr) 58px; align-items: center; gap: 10px; }
.uc-lat-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 560; }
.uc-lat-name small { display: block; color: var(--uc-faint); font-size: 9.5px; font-weight: 400; margin-top: 1px; }
.uc-lat-track { height: 7px; border-radius: 99px; background: var(--uc-track); overflow: hidden; }
.uc-lat-track i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--uc-accent), #9b83ff); }
.uc-lat-row b { font-size: 10px; font-weight: 620; text-align: right; font-variant-numeric: tabular-nums; }
.uc-lat-health { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.uc-lat-stat { padding: 11px 9px; border: 1px solid var(--uc-border); border-radius: 8px; background: var(--uc-layer); }
.uc-lat-stat b { display: block; font-size: 17px; font-weight: 680; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.uc-lat-stat span { display: block; margin-top: 2px; color: var(--uc-faint); font-size: 9.5px; }
.uc-lat-insight { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--uc-border); color: var(--uc-muted); font-size: 10px; line-height: 1.45; }
.uc-lat-insight b { color: var(--uc-amber); font-weight: 650; }
.uc-lat-table { overflow-x: auto; }
.uc-lat-head, .uc-lat-table-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.6fr) 54px 68px 68px 72px 58px 54px;
  gap: 8px;
  align-items: center;
  min-width: 680px;
}
.uc-lat-head { color: var(--uc-faint); font-size: 10px; padding-bottom: 5px; border-bottom: 1px solid var(--uc-border); }
.uc-lat-head > span:nth-child(n+2), .uc-lat-table-row > span:nth-child(n+2) { text-align: right; }
.uc-lat-table-row { min-height: 38px; border-bottom: 1px solid color-mix(in srgb, var(--uc-border) 60%, transparent); font-size: 10px; font-variant-numeric: tabular-nums; }
.uc-lat-table-row:last-child { border-bottom: 0; }
.uc-lat-model { display: flex; align-items: center; gap: 6px; min-width: 0; }
.uc-lat-model i { width: 20px; height: 20px; border-radius: 5px; display: grid; place-items: center; flex: 0 0 auto; background: color-mix(in srgb, var(--uc-accent) 9%, transparent); color: var(--uc-accent); font-size: 8px; font-weight: 750; font-style: normal; }
.uc-lat-model span { min-width: 0; }
.uc-lat-model b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 600; }
.uc-lat-model small { display: block; color: var(--uc-faint); font-size: 9.5px; }

/* loading + skeleton */
.uc-first-load { display: flex; flex-direction: column; gap: 12px; }
.uc-loading-note { display: flex; align-items: center; gap: 8px; color: var(--uc-faint); font-size: 10.5px; }
.uc-skeleton { min-height: 94px; display: flex; flex-direction: column; gap: 10px; }
.uc-skeleton-card { min-height: 190px; gap: 12px; }
.uc-sk-line {
  display: block;
  height: 10px;
  border-radius: 6px;
  background: linear-gradient(90deg,
    var(--uc-track) 0%,
    color-mix(in srgb, var(--uc-faint) 16%, var(--uc-track)) 50%,
    var(--uc-track) 100%);
  background-size: 200% 100%;
  animation: uc-shimmer 1.2s linear infinite;
}
.uc-sk-value { height: 21px; margin-top: 1px; }
.uc-sk-chart { height: 178px; border-radius: 8px; background: var(--uc-track); opacity: 0.65; animation: uc-shimmer 1.2s linear infinite; background-size: 200% 100%; }
.uc-sk-row { height: 32px; margin-top: 0; }
.uc-sk-trend { min-height: 318px; }
.uc-sk-models { min-height: 254px; }
.uc-sk-side { min-height: 190px; display: flex; flex-direction: column; gap: 10px; }
.uc-sk-short { min-height: 150px; }
.uc-updating { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; color: var(--uc-accent); font-size: 9.5px; }
.uc-updating i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: uc-pulse 1s ease-in-out infinite; }
@keyframes uc-shimmer { to { background-position: -200% 0; } }
@keyframes uc-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .uc-sk-line, .uc-sk-chart, .uc-updating i, .uc-spinner { animation: none; }
}

/* states */
.uc-empty-line { color: var(--uc-faint); font-size: 10px; padding: 12px 0; }
.uc-empty-chart { display: grid; place-items: center; min-height: 120px; color: var(--uc-faint); font-size: 10.5px; }
.uc-loading { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 300px; color: var(--uc-faint); font-size: 11px; }
.uc-spinner { width: 16px; height: 16px; border: 2px solid var(--uc-track); border-top-color: var(--uc-accent); border-radius: 50%; animation: uc-spin 0.8s linear infinite; }
@keyframes uc-spin { to { transform: rotate(360deg); } }

.uc-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--uc-faint); font-size: 10px; padding-top: 2px; }
.uc-foot b { color: var(--uc-muted); font-weight: 620; }
.uc-foot-links { display: flex; align-items: center; gap: 12px; }
.uc-foot-error { color: var(--uc-red); }
/* 指标口径说明（P0）：页脚展开，逐条解释统计口径，不弹窗打断 */
.uc-glossary { border: 1px dashed var(--uc-border); border-radius: 10px; background: var(--uc-layer); padding: 10px 12px; margin-top: 8px; }
.uc-glossary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; }
.uc-glossary-grid > div { display: flex; flex-direction: column; gap: 2px; font-size: 9.8px; line-height: 1.5; }
.uc-glossary-grid b { color: var(--uc-muted); font-weight: 650; }
.uc-glossary-grid span { color: var(--uc-faint); }
@media (max-width: 760px) {
  .uc-glossary-grid { grid-template-columns: 1fr; }
}

/* 成本归因卡（0.5）：agent / 项目两列占比 */
.uc-attribution { grid-column: 1 / -1; }
.uc-attr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
.uc-attr-col-title { color: var(--uc-faint); font-size: 10px; font-weight: 650; padding-bottom: 4px; border-bottom: 1px solid var(--uc-border); }
.uc-attr-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr) 62px;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  font-size: 10.3px;
  font-variant-numeric: tabular-nums;
}
.uc-attr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-muted); font-weight: 560; }
.uc-attr-row .uc-share { min-width: 0; }
.uc-attr-value { text-align: right; color: var(--uc-strong); font-weight: 620; }
.uc-attr-note { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--uc-border); color: var(--uc-faint); font-size: 9.5px; line-height: 1.5; }
/* 费用异常提示（0.5）：嵌在费用 KPI 的说明行里 */
.uc-anomaly { display: block; margin-top: 3px; color: var(--uc-amber); font-weight: 600; cursor: help; }
@media (max-width: 760px) {
  .uc-attr-grid { grid-template-columns: 1fr; }
}

/* 模型效率散点（0.5）：归一化坐标 + 气泡 */
.uc-scatter {
  position: relative;
  height: 220px;
  margin: 8px 0 2px;
  border-left: 1px solid var(--uc-border);
  border-bottom: 1px solid var(--uc-border);
  background:
    linear-gradient(to right, transparent 99.5%, var(--uc-border) 100%),
    linear-gradient(to top, transparent 99.5%, var(--uc-border) 100%);
}
.uc-scatter > svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.uc-scatter-dot {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--uc-accent) 55%, transparent);
  background: color-mix(in srgb, var(--uc-accent) 18%, transparent);
  padding: 0;
  cursor: default;
  transition: background 0.12s ease;
}
.uc-scatter-dot:hover { background: color-mix(in srgb, var(--uc-accent) 35%, transparent); }
.uc-scatter-labels { display: flex; justify-content: space-between; color: var(--uc-faint); font-size: 9px; }
.uc-scatter-v { width: auto; position: absolute; right: -2px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: space-between; }

/* embedded dialog */
.uc-root[data-embedded="true"] {
  max-width: none;
  padding: 0 0 4px;
}
.uc-root[data-embedded="true"] .uc-tabs {
  position: sticky;
  top: 0;
  z-index: 5;
  background: color-mix(in srgb, var(--uc-card) 94%, transparent);
  backdrop-filter: blur(8px);
}
.uc-root[data-embedded="true"] .uc-hero { min-height: 98px; }
.uc-dialog-footer { display: flex; align-items: center; gap: 6px; width: 100%; flex-wrap: wrap; }
.uc-footer-note { flex: 1; color: var(--uc-faint); font-size: 10px; }
[data-component="dialog-v2"][data-size="x-large"]:has(.uc-root[data-embedded="true"]) [data-slot="dialog-container"] {
  width: min(100vw - 48px, 1200px);
  height: min(100vh - 80px, 840px);
  min-width: min(100vw - 48px, 760px);
  min-height: min(100vh - 80px, 520px);
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  resize: both;
}

@media (max-width: 1000px) {
  .uc-body { grid-template-columns: 1fr; }
  .uc-right { display: grid; grid-template-columns: 1fr 1fr; align-items: stretch; }
  .uc-right > section { min-width: 0; }
  .uc-health { grid-column: 1 / -1; }
  .uc-detail-grid, .uc-latency-top { grid-template-columns: 1fr; }
  .uc-kpis-latency { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .uc-kpis { grid-template-columns: 1fr 1fr; }
  .uc-hero { flex-direction: column; align-items: flex-start; }
  .uc-hero-tools { align-items: flex-start; width: 100%; }
  .uc-tool-row-bottom { flex-wrap: wrap; }
  .uc-trend-body { grid-template-columns: 1fr; }
  .uc-cost-side { border-left: 0; border-top: 1px solid var(--uc-border); padding-left: 0; padding-top: 10px; }
  .uc-right { grid-template-columns: 1fr; }
  .uc-health { grid-column: auto; }
  .uc-kpis-latency { grid-template-columns: 1fr 1fr; }
  .uc-tabs-scope { display: none; }
  .uc-session-head, .uc-session-row { grid-template-columns: minmax(0, 1.6fr) 64px 54px 76px; }
  .uc-session-head > span:nth-child(2), .uc-session-row > span:nth-child(2),
  .uc-session-head > span:nth-child(3), .uc-session-row > span:nth-child(3) { display: none; }
  .uc-model-head, .uc-model-row { grid-template-columns: minmax(0, 1fr) 72px 64px 46px; }
  .uc-model-head > span:nth-child(4), .uc-model-row > span:nth-child(4) { display: none; }
}

/* integrations: 凭据与登录页（卡片网格，渐变光晕视觉） */
.uc-integrations { display: flex; flex-direction: column; gap: 10px; }
.uc-int-quota-tag { margin-left: auto; }
.uc-int-quota { display: flex; flex-direction: column; gap: 8px; }
.uc-int-quota-note { color: var(--uc-faint); font-size: 9.5px; padding: 2px 0 6px; }
.uc-int-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(238px, 1fr));
  gap: 8px;
  align-items: start;
}
.uc-int-card {
  --int-glow: color-mix(in srgb, var(--uc-accent) 60%, transparent);
  position: relative;
  border: 1px solid var(--uc-border);
  border-radius: 12px;
  background: linear-gradient(165deg, color-mix(in srgb, var(--int-glow) 5%, var(--uc-card)) 0%, var(--uc-card) 46%);
  overflow: hidden;
  min-width: 0;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.uc-int-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: linear-gradient(90deg, transparent 8%, var(--int-glow) 50%, transparent 92%);
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.uc-int-card:hover { transform: translateY(-1px); box-shadow: 0 4px 16px color-mix(in srgb, var(--int-glow) 13%, transparent); }
.uc-int-card:hover::before { opacity: 0.75; }
.uc-int-card[data-signed="true"] { --int-glow: var(--uc-green); border-color: color-mix(in srgb, var(--uc-green) 26%, var(--uc-border)); }
.uc-int-card[data-signed="true"]::after {
  content: "";
  position: absolute;
  top: -48px;
  right: -48px;
  width: 110px;
  height: 110px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--uc-green) 14%, transparent) 0%, transparent 70%);
  pointer-events: none;
}
.uc-int-card[data-open="true"] { border-color: color-mix(in srgb, var(--int-glow) 42%, var(--uc-border)); box-shadow: 0 4px 20px color-mix(in srgb, var(--int-glow) 13%, transparent); }
.uc-int-head {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  padding: 10px 12px 8px;
  background: transparent;
  border: 0;
  color: inherit;
  text-align: left;
  cursor: pointer;
  position: relative;
  z-index: 1;
}
.uc-int-head:hover { background: transparent; }
.uc-int-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.uc-int-disclosure { width: 12px; height: 12px; color: var(--uc-faint); flex: 0 0 auto; transition: transform 0.15s ease; }
.uc-int-card[data-open="true"] .uc-int-disclosure, .uc-mp-group[data-open="true"] .uc-int-disclosure { transform: rotate(90deg); }
.uc-int-icon {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: linear-gradient(140deg, color-mix(in srgb, var(--int-glow) 24%, transparent), color-mix(in srgb, var(--int-glow) 8%, transparent));
  color: color-mix(in srgb, var(--int-glow) 80%, var(--uc-strong));
  font-size: 11px;
  font-weight: 780;
  letter-spacing: -0.02em;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--int-glow) 18%, transparent);
}
.uc-int-name { flex: 1; min-width: 0; }
.uc-int-name b { display: block; font-size: 11.4px; font-weight: 680; letter-spacing: -0.015em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-int-name > span { display: block; color: var(--uc-faint); font-size: 10px; margin-top: 1.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 头部并排放凭据时效 + 额度概要两个标签，额度标签压住伸缩名区，不换行 */
.uc-int-top .uc-exp-tag { flex: 0 0 auto; }
.uc-int-top .uc-int-quota-tag { max-width: 46%; overflow: hidden; text-overflow: ellipsis; }
.uc-int-more { display: flex; align-items: center; gap: 4px; color: var(--uc-faint); font-size: 10px; font-weight: 620; }
.uc-int-card[data-open="true"] .uc-int-more { color: var(--int-glow); }
.uc-int-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.uc-int-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  border: 1px solid color-mix(in srgb, var(--int-glow) 16%, var(--uc-border));
  background: color-mix(in srgb, var(--int-glow) 5%, var(--uc-layer));
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 9.5px;
  font-weight: 560;
  color: var(--uc-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uc-int-chip i { width: 5.5px; height: 5.5px; border-radius: 50%; background: var(--uc-track); flex: 0 0 auto; }
.uc-int-chip[data-active="true"] { border-color: color-mix(in srgb, var(--uc-green) 32%, var(--uc-border)); color: var(--uc-strong); }
.uc-int-chip[data-active="true"] i { background: var(--uc-green); box-shadow: 0 0 5px color-mix(in srgb, var(--uc-green) 55%, transparent); }
.uc-int-card[data-open="true"] .uc-int-body { border-top: 1px solid var(--uc-border); }
.uc-int-body { padding: 9px 12px 11px; display: flex; flex-direction: column; gap: 7px; position: relative; z-index: 1; }
.uc-int-section-title { color: var(--uc-faint); font-size: 9.5px; font-weight: 720; letter-spacing: 0.09em; text-transform: uppercase; }
.uc-int-methods { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.uc-method {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 23px;
  padding: 0 8px;
  border: 1px solid var(--uc-border);
  border-radius: 7px;
  background: var(--uc-card);
  color: var(--uc-muted);
  font: inherit;
  font-size: 10px;
  font-weight: 580;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.uc-method:hover:not(:disabled) { border-color: color-mix(in srgb, var(--int-glow) 45%, var(--uc-border)); color: var(--uc-strong); background: color-mix(in srgb, var(--int-glow) 5%, var(--uc-card)); }
.uc-method:disabled { opacity: 0.55; cursor: default; }
.uc-method[data-kind="oauth"] { color: color-mix(in srgb, var(--int-glow) 76%, var(--uc-strong)); border-color: color-mix(in srgb, var(--int-glow) 24%, var(--uc-border)); }
.uc-method[data-kind="command"] { border-style: dashed; }
.uc-method .uc-method-label { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-method-on {
  font-size: 8px;
  font-weight: 720;
  color: var(--uc-green);
  background: color-mix(in srgb, var(--uc-green) 9%, transparent);
  border-radius: 4px;
  padding: 1px 4px;
}
.uc-int-env { color: var(--uc-faint); font-size: 9.5px; border: 1px dashed var(--uc-border); border-radius: 7px; padding: 2px 7px; display: inline-flex; align-items: center; height: 23px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-int-provider { display: flex; align-items: center; gap: 8px; color: var(--uc-faint); font-size: 9.5px; padding-top: 6px; border-top: 1px dashed var(--uc-border); }
.uc-int-pkg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.8; }
.uc-cred-row { display: flex; align-items: center; gap: 7px; padding: 5px 0; }
.uc-cred-row + .uc-cred-row { border-top: 1px solid color-mix(in srgb, var(--uc-border) 55%, transparent); }
.uc-cred-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--uc-track); flex: 0 0 auto; }
.uc-cred-dot[data-active="true"] { background: var(--uc-green); box-shadow: 0 0 6px color-mix(in srgb, var(--uc-green) 55%, transparent); }
.uc-cred-main { flex: 1; min-width: 0; }
.uc-cred-main b { display: block; font-size: 10.2px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-cred-main span { display: block; color: var(--uc-faint); font-size: 9.5px; margin-top: 1px; }

/* OAuth 登录流程条 */
.uc-flow {
  border: 1px solid color-mix(in srgb, var(--uc-accent) 30%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--uc-accent) 4%, var(--uc-card));
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.uc-flow[data-state="failed"], .uc-flow[data-state="expired"] { border-color: color-mix(in srgb, var(--uc-red) 30%, transparent); background: color-mix(in srgb, var(--uc-red) 4%, var(--uc-card)); }
.uc-flow[data-state="complete"] { border-color: color-mix(in srgb, var(--uc-green) 30%, transparent); background: color-mix(in srgb, var(--uc-green) 4%, var(--uc-card)); }
.uc-flow-head { display: flex; align-items: center; gap: 8px; }
.uc-flow-head b { font-size: 11px; font-weight: 650; }
.uc-flow-method { color: var(--uc-faint); font-size: 10px; }
.uc-flow-spinner { width: 11px; height: 11px; border-width: 1.6px; }
.uc-flow-head .uc-text-button { margin-left: auto; }
.uc-flow-body { color: var(--uc-muted); font-size: 10.2px; line-height: 1.5; }
.uc-flow-body .uc-text-button { margin-left: 6px; }
.uc-flow-result { font-weight: 560; }
.uc-flow-foot { color: var(--uc-faint); font-size: 10px; }

/* models: 模型浏览页（常用区 + 家族聚合卡片，provider 主题色） */
.uc-models-page { display: flex; flex-direction: column; gap: 10px; }
.uc-recent {
  border: 1px solid color-mix(in srgb, var(--uc-accent) 24%, var(--uc-border));
  border-radius: 12px;
  background:
    radial-gradient(120% 170% at 0% 0%, color-mix(in srgb, var(--uc-accent) 9%, transparent) 0%, transparent 55%),
    var(--uc-card);
  padding: 0 13px;
}
.uc-recent-head { padding: 9px 0; width: 100%; }
.uc-recent-head .uc-int-section-title { color: color-mix(in srgb, var(--uc-accent) 80%, var(--uc-strong)); }
.uc-recent-note { color: var(--uc-faint); font-size: 10px; }
.uc-recent-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 7px; padding: 2px 0 12px; }
.uc-recent-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--uc-border);
  border-radius: 9px;
  background: var(--uc-layer);
  padding: 8px 10px 8px 13px;
  overflow: hidden;
  min-width: 0;
}
.uc-recent-bar {
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--mp-accent, var(--uc-accent)), color-mix(in srgb, var(--mp-accent, var(--uc-accent)) 30%, transparent));
}
.uc-recent-main { flex: 1; min-width: 0; }
.uc-recent-main b { display: block; font-size: 10.8px; font-weight: 660; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-recent-main span { display: block; color: var(--uc-faint); font-size: 10px; margin-top: 1px; }
.uc-recent-stats { text-align: right; flex: 0 0 auto; }
.uc-recent-stats b { display: block; font-size: 11.5px; font-weight: 720; color: var(--mp-accent, var(--uc-accent)); font-variant-numeric: tabular-nums; }
.uc-recent-stats span { display: block; color: var(--uc-faint); font-size: 9.5px; }
.uc-mp-groups { display: flex; flex-direction: column; gap: 8px; }
.uc-mp-group, .uc-agents {
  --mp-glow: color-mix(in srgb, var(--mp-accent, var(--uc-accent)) 60%, transparent);
  position: relative;
  border: 1px solid color-mix(in srgb, var(--mp-glow) 20%, var(--uc-border));
  border-radius: 12px;
  background: linear-gradient(168deg, color-mix(in srgb, var(--mp-glow) 4%, var(--uc-card)) 0%, var(--uc-card) 40%);
  overflow: hidden;
}
.uc-agents { --mp-accent: #8e8e93; border-style: dashed; opacity: 0.92; }
.uc-agents .uc-int-icon-agent { background: var(--uc-layer-2); color: var(--uc-faint); box-shadow: none; }
.uc-agents[data-open="true"] { opacity: 1; }
.uc-mp-head { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 12px; background: transparent; border: 0; color: inherit; text-align: left; cursor: pointer; position: relative; z-index: 1; }
.uc-mp-head:hover { background: color-mix(in srgb, var(--mp-glow) 4%, transparent); }
.uc-mp-count { margin-left: auto; color: var(--uc-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.uc-mp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 7px;
  padding: 9px 12px 12px;
}
.uc-mp-card {
  position: relative;
  border: 1px solid color-mix(in srgb, var(--mp-glow) 14%, var(--uc-border));
  border-radius: 9px;
  background: var(--uc-card);
  padding: 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  transition: border-color 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease;
}
.uc-mp-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--mp-glow) 40%, var(--uc-border)); box-shadow: 0 3px 12px color-mix(in srgb, var(--mp-glow) 12%, transparent); }
.uc-mp-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 2.5px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--mp-glow), transparent);
  opacity: 0.55;
}
.uc-mp-card[data-expensive="true"]::before { background: linear-gradient(180deg, var(--uc-amber), transparent); }
.uc-mp-card[data-hidden="true"] { opacity: 0.5; }
.uc-mp-card[data-hidden="true"] .uc-mp-card-name { text-decoration: line-through; color: var(--uc-faint); }
.uc-mp-card-agent { border-style: dashed; background: var(--uc-layer); }
.uc-mp-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 4px; }
.uc-mp-card-name {
  font-size: 10.6px;
  font-weight: 680;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.uc-mp-card-full { color: var(--uc-faint); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-mp-card-stats { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--uc-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.uc-mp-card-stats > span { display: inline-flex; align-items: center; gap: 4px; }
.uc-mp-card[data-expensive="true"] .uc-mp-card-stats span:nth-child(2) { color: var(--uc-amber); font-weight: 640; }
.uc-mp-usage { color: var(--uc-green) !important; font-weight: 640; }
.uc-mp-ico {
  font-style: normal;
  width: 13px;
  height: 13px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--mp-glow) 13%, transparent);
  color: color-mix(in srgb, var(--mp-glow) 85%, var(--uc-strong));
  font-size: 7.6px;
  font-weight: 740;
  flex: 0 0 auto;
}
.uc-mp-ico-use { background: color-mix(in srgb, var(--uc-green) 12%, transparent); color: var(--uc-green); }
.uc-mp-card[data-expensive="true"] .uc-mp-ico:nth-of-type(2) { background: color-mix(in srgb, var(--uc-amber) 13%, transparent); color: var(--uc-amber); }
.uc-mp-caps { display: flex; flex-wrap: wrap; gap: 3px; }
.uc-mp-caps em { font-style: normal; color: var(--uc-muted); background: var(--uc-layer-2); border-radius: 4px; padding: 1px 5px; font-size: 9.5px; }
.uc-mp-card .ui-icon-button { height: 20px; width: 20px; }
.uc-mp-variants-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--mp-glow) 75%, var(--uc-strong));
  font: inherit;
  font-size: 10px;
  font-weight: 640;
  cursor: pointer;
  padding: 1px 0;
}
.uc-mp-variants-toggle .uc-int-disclosure { width: 10px; height: 10px; }
.uc-mp-card[data-variant-open="true"] .uc-mp-variants-toggle .uc-int-disclosure { transform: rotate(90deg); }
.uc-mp-variant-list { display: flex; flex-direction: column; border-top: 1px dashed color-mix(in srgb, var(--mp-glow) 22%, var(--uc-border)); padding-top: 4px; }
.uc-mp-variant { display: grid; grid-template-columns: minmax(0, 1fr) 44px 74px; gap: 6px; align-items: center; font-size: 10px; padding: 2.5px 0; }
.uc-mp-variant + .uc-mp-variant { border-top: 1px solid color-mix(in srgb, var(--uc-border) 45%, transparent); }
.uc-mp-variant b { font-weight: 600; color: var(--uc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-mp-variant span { color: var(--uc-faint); font-variant-numeric: tabular-nums; text-align: right; }

/* 模型列表（provider 展开后的管理视图） */
.uc-mp-listview {
  padding: 2px 12px 10px;
}
.uc-mp-lv-row {
  display: grid;
  grid-template-columns: minmax(0, 2.4fr) 56px 88px 72px 26px;
  gap: 12px;
  align-items: center;
  padding: 6.5px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--uc-border) 55%, transparent);
  min-width: 0;
}
.uc-mp-lv-row:last-child { border-bottom: 0; }
.uc-mp-lv-head {
  color: var(--uc-faint);
  font-size: 9.5px;
  font-weight: 720;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--uc-border);
}
.uc-mp-lv-row[data-hidden="true"] { opacity: 0.55; }
.uc-mp-lv-row[data-hidden="true"] .uc-mp-lv-name b { text-decoration: line-through; color: var(--uc-faint); }
.uc-mp-lv-name { min-width: 0; }
.uc-mp-lv-name b { display: block; font-size: 10.6px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-mp-lv-name span { display: block; color: var(--uc-faint); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-mp-lv-num { color: var(--uc-muted); font-size: 9.6px; font-variant-numeric: tabular-nums; }
.uc-mp-lv-num[data-expensive="true"] { color: var(--uc-amber); font-weight: 640; }
@media (max-width: 760px) {
  .uc-mp-lv-row { grid-template-columns: minmax(0, 2fr) 52px 74px 26px; }
  .uc-mp-lv-num:nth-child(4) { display: none; }
}
`

/** 总览页签的全部面板。keep-alive 容器要求每个页签是独立组件，这里承接原有的 JSX。 */
function OverviewPanels(props: {
  snapshot: Snapshot
  quota?: Quota
  credentials: readonly CredentialRow[]
  insight?: { model: string; costShare: number; tokenShare: number }
  cacheHit: number
  tokens: number
  totals?: Snapshot["totals"]
  rangeLabel: string
  models: readonly ModelRow[]
  topModels: readonly ModelRow[]
  restModels: readonly ModelRow[]
  restTokens: number
  restCost: number
  delta: (read: (point: SeriesPoint) => number) => number | undefined
  onRetryQuota: () => void
  /** 「模型分布 → 全部 N 个」跳转模型页签。 */
  onOpenModels: () => void
  /** 总览右栏「凭据有效期」卡片的跳转目标。 */
  onOpenQuota: () => void
  /** 模型分布行 → 会话列表（按该模型预筛选）。 */
  onOpenSessions: (modelID: string) => void
}) {
  /** 0.5 成本归因：agent 与项目的用量排序（费用优先，零费用按 token）。 */
  const agentRows = createMemo(() =>
    [...props.snapshot.agents].sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output)),
  )
  const projectRows = createMemo(() => {
    const nameOf = (id: string) => props.snapshot.projects.find((project) => project.id === id)?.name ?? id
    return props.snapshot.projectUsage
      .map((row) => ({ ...row, name: nameOf(row.projectID) }))
      .sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output))
  })
  /**
   * 费用异常检测（0.5）：最后一天（今天，未结束）的费用对照之前完整天的
   * 日均基线。倍数 ≥ 3 且基线 > $0.01 才报——避免小基数误报。显示依据。
   */
  const costAnomaly = createMemo(() => {
    const points = props.snapshot.series ?? []
    if (points.length < 4) return undefined
    const complete = points.slice(0, -1)
    const baseline = complete.reduce((sum, point) => sum + point.cost, 0) / complete.length
    const today = points[points.length - 1]!.cost
    if (baseline < 0.01) return undefined
    const ratio = today / baseline
    if (ratio < 3) return undefined
    return { today, baseline, ratio, days: complete.length }
  })
  // 趋势图最多绘制最近 30 个数据点：范围更大时必须写明，不能让图和标题各说各的。
  const trendScopeNote = () => {
    const count = props.snapshot.series?.length ?? 0
    if (count > 30) return `${props.rangeLabel}中，图示为最近 30 天`
    return props.rangeLabel
  }
  return (
    <>
        <div class="uc-kpis">
          <div class="uc-kpi">
            <div class="uc-kpi-label"><i />输入输出 Token</div>
            <div class="uc-kpi-value">
              {compact(props.tokens)}
              <Show when={props.delta((point) => point.input + point.output)}>
                {(value) => (
                  <span class="uc-delta" title="与上一个等长周期对比" data-tone={value() >= 0 ? "up" : "down"}>
                    {value() >= 0 ? "↑" : "↓"} {Math.abs(value()).toFixed(1)}%
                  </span>
                )}
              </Show>
            </div>
            <div class="uc-kpi-sub">
              不含缓存读写 · 输入 {compact(props.totals?.tokens.input ?? 0)} · 输出 {compact(props.totals?.tokens.output ?? 0)}
            </div>
            <Sparkline
              values={(props.snapshot.series ?? []).map((point) => point.input + point.output)}
              color="var(--uc-accent)"
            />
          </div>
          <div class="uc-kpi">
            <div class="uc-kpi-label"><i data-tone="amber" />估算费用</div>
            <div class="uc-kpi-value">
              {money(props.totals?.cost ?? 0)}
              <Show when={props.delta((point) => point.cost)}>
                {(value) => (
                  <span
                    class="uc-delta"
                    title="与上一个等长周期对比 · 费用下降为好消息"
                    data-tone={value() > 0 ? "warn" : "down"}
                  >
                    {value() >= 0 ? "↑" : "↓"} {Math.abs(value()).toFixed(0)}%
                  </span>
                )}
              </Show>
            </div>
            <div class="uc-kpi-sub">
              按量计费 · 不含订阅内调用与未记录价格的请求
              <Show when={costAnomaly()}>
                {(value) => (
                  <span
                    class="uc-anomaly"
                    title={`今天 $${value().today.toFixed(2)}，此前 ${value().days} 天日均 $${value().baseline.toFixed(2)}，为基线的 ${value().ratio.toFixed(1)} 倍。`}
                  >
                    ⚠ 今天 ${value().today.toFixed(2)}，是此前 {value().days} 天日均（${value().baseline.toFixed(2)}）的{" "}
                    {value().ratio.toFixed(1)} 倍
                  </span>
                )}
              </Show>
            </div>
            <Sparkline values={(props.snapshot.series ?? []).map((point) => point.cost)} color="var(--uc-amber)" />
          </div>
          <div class="uc-kpi">
            <div class="uc-kpi-label"><i data-tone="teal" />请求数</div>
            <div class="uc-kpi-value">
              {compact(props.totals?.requests ?? 0)}
              <Show when={props.delta((point) => point.requests)}>
                {(value) => (
                  <span class="uc-delta" title="与上一个等长周期对比" data-tone={value() >= 0 ? "up" : "down"}>
                    {value() >= 0 ? "↑" : "↓"} {Math.abs(value()).toFixed(1)}%
                  </span>
                )}
              </Show>
            </div>
            <div class="uc-kpi-sub">
              日均 {compact((props.totals?.requests ?? 0) / Math.max(1, props.snapshot.series.length))} · 活跃 {props.totals?.activeDays ?? 0} 天
            </div>
            <Sparkline values={(props.snapshot.series ?? []).map((point) => point.requests)} color="var(--uc-teal)" />
          </div>
          <div class="uc-kpi">
            <div class="uc-kpi-label"><i data-tone="blue" />缓存命中率</div>
            <div class="uc-kpi-value">
              {percent(props.cacheHit, 1)}
              <Show when={cacheDeltaOf(props.snapshot.series)}>
                {(value) => (
                  <span class="uc-delta" title="与上一个等长周期对比" data-tone={value() >= 0 ? "up" : "down"}>
                    {value() >= 0 ? "↑" : "↓"} {Math.abs(value()).toFixed(1)}pt
                  </span>
                )}
              </Show>
            </div>
            <div class="uc-kpi-sub">缓存读取 {compact(props.totals?.tokens.cacheRead ?? 0)} tokens</div>
            <Sparkline
              values={(props.snapshot.series ?? []).map((point) =>
                point.cacheRead + point.input > 0 ? (point.cacheRead / (point.cacheRead + point.input)) * 100 : 0,
              )}
              color="var(--uc-blue)"
            />
          </div>
        </div>

        <div class="uc-body">
          <div class="uc-left">
            <section class="uc-card uc-trend">
              <div class="uc-card-head">
                <div>
                  <div class="uc-card-title">Token 趋势</div>
                  <div class="uc-card-sub">
                    输入 + 输出，不含缓存读写 · {trendScopeNote()}
                  </div>
                </div>
                <div class="uc-legend"><i />输入输出 Token</div>
              </div>
              <div class="uc-trend-body">
                <div class="uc-chart-wrap">
                  <TrendChart points={props.snapshot.series} />
                  <div class="uc-chart-foot">
                    <span>
                      缓存读取 <b>{compact(props.totals?.tokens.cacheRead ?? 0)}</b> · 命中率{" "}
                      <b>{percent(props.cacheHit, 1)}</b>
                    </span>
                    <span>峰值 <b>{compact(Math.max(0, ...props.snapshot.series.map((point) => point.input + point.output)))}</b></span>
                  </div>
                </div>
                <div class="uc-cost-side">
                  <div class="uc-side-title">费用构成</div>
                  <CostDonut models={props.models} total={props.totals?.cost ?? 0} />
                  <Show when={props.insight}>
                    {(value) => (
                      <div class="uc-cost-note">
                        <b>{percent(value().costShare * 100, 1)}</b> 的费用来自 {value().model}，但它只占{" "}
                        <b>{percent(value().tokenShare * 100, 1)}</b> 的有效 Token。
                      </div>
                    )}
                  </Show>
                </div>
              </div>
            </section>

            <section class="uc-card uc-models">
              <div class="uc-card-head">
                <div>
                  <div class="uc-card-title">模型分布</div>
                  <div class="uc-card-sub">按有效 Token 排序 · 共 {props.models.length} 个</div>
                </div>
                <button type="button" class="uc-card-link" onClick={props.onOpenModels} title="打开「模型」页签查看全部模型的上下文、价格与用量">
                  全部 {props.models.length} 个 <span>→</span>
                </button>
              </div>
              <div class="uc-model-head">
                <span>模型</span>
                <span>占比</span>
                <span>Token</span>
                <span>请求</span>
                <span>费用</span>
              </div>
              <Show when={props.topModels.length > 0} fallback={<div class="uc-empty-line">当前范围还没有模型调用</div>}>
                <div class="uc-model-list">
                  <For each={props.topModels}>
                    {(model) => (
                      <div
                        class="uc-model-row"
                        role="button"
                        tabIndex={0}
                        title={`查看使用 ${shortModel(model.modelID)} 的会话`}
                        onClick={() => props.onOpenSessions(model.modelID)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            props.onOpenSessions(model.modelID)
                          }
                        }}
                      >
                        <div class="uc-model-name">
                          <span class="uc-model-icon">{modelInitial(model.modelID)}</span>
                          <span class="uc-model-text">
                            <span class="uc-model-title" title={model.modelID}>{shortModel(model.modelID)}</span>
                            <span class="uc-model-provider">{providerName(model.providerID)}</span>
                          </span>
                        </div>
                        <span class="uc-share">
                          <span class="uc-share-bar">
                            <i style={{ width: `${Math.max(2, (sumTokens(model) / Math.max(1, props.tokens)) * 100)}%` }} />
                          </span>
                          {percent((sumTokens(model) / Math.max(1, props.tokens)) * 100, 1)}
                        </span>
                        <span>{compact(sumTokens(model))}</span>
                        <span>{compact(model.requests)}</span>
                        <span>
                          {model.cost > 0 ? (
                            money(model.cost)
                          ) : (
                            <span class="uc-zero" title="$0：可能是订阅内调用、免费模型，或该模型未记录价格。">$0</span>
                          )}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
                <div class="uc-model-foot">
                  <Show when={props.restModels.length > 0}>
                    <span>其他 {props.restModels.length} 个模型 · <b>{compact(props.restTokens)}</b> tokens</span>
                    <button type="button" class="uc-model-more" onClick={props.onOpenModels}>
                      查看全部 →
                    </button>
                  </Show>
                </div>
              </Show>
            </section>

            <AttributionCard agents={agentRows()} projects={projectRows()} tokens={props.tokens} />
          </div>

          <div class="uc-right">
            <QuotaCard quota={props.quota} onRetry={props.onRetryQuota} />
            <ExpiryCard credentials={props.credentials} onOpenQuota={props.onOpenQuota} />
            <HealthCard latency={props.snapshot.latency} insight={props.insight} />
          </div>
        </div>
    </>
  )
}

/** 缓存命中率的等长周期对比（上一个完整周期 vs 当前完整周期），与 KPI 的 delta 口径一致。 */
function cacheDeltaOf(points: readonly SeriesPoint[]): number | undefined {
  // 最近一个点通常是“今天”，还没结束，不参与比较。
  const complete = points.slice(0, -1)
  if (complete.length < 2) return undefined
  const half = Math.floor(complete.length / 2)
  if (half < 1) return undefined
  const calc = (list: readonly SeriesPoint[]) => {
    const input = list.reduce((sum, point) => sum + point.input, 0)
    const cache = list.reduce((sum, point) => sum + point.cacheRead, 0)
    return cache + input > 0 ? (cache / (cache + input)) * 100 : 0
  }
  return calc(complete.slice(complete.length - half)) - calc(complete.slice(0, half))
}

/**
 * 成本归因卡（0.5）：钱和 Token 花在哪个 agent、哪个项目上。两列并排，
 * 行内占比条按费用（全为 0 时按有效 Token）计算。
 */
function AttributionCard(props: {
  agents: readonly (AgentRow & { name?: string })[]
  projects: readonly (ProjectUsageRow & { name: string })[]
  tokens: number
}) {
  const hasData = () => props.agents.length > 1 || props.projects.length > 1
  const share = (cost: number, tokenCount: number, all: readonly { cost: number }[]) => {
    const totalCost = all.reduce((sum, row) => sum + row.cost, 0)
    if (totalCost > 0) return totalCost > 0 ? (cost / totalCost) * 100 : 0
    // 全部为 $0（订阅内调用）：按有效 Token 占比
    const totalTokens = all.reduce((sum, row) => {
      const r = row as unknown as { input?: number; output?: number }
      return sum + (r.input ?? 0) + (r.output ?? 0)
    }, 0)
    return totalTokens > 0 ? ((tokenCount / totalTokens) * 100) : 0
  }
  const agentBase = () => props.agents.map((a) => ({ cost: a.cost }))
  const projectBase = () => props.projects.map((p) => ({ cost: p.cost }))
  return (
    <Show when={hasData()} fallback={null}>
      <section class="uc-card uc-attribution">
        <div class="uc-card-head">
          <div>
            <div class="uc-card-title">成本归因</div>
            <div class="uc-card-sub">按 agent 与项目拆分 · 条形为占比</div>
          </div>
        </div>
        <div class="uc-attr-grid">
          <div class="uc-attr-col">
            <div class="uc-attr-col-title">Agent</div>
            <For each={props.agents.slice(0, 6)}>
              {(row) => {
                const tokenCount = row.input + row.output
                const pct = share(row.cost, tokenCount, agentBase())
                return (
                  <div class="uc-attr-row" title={`${row.agent} · ${compact(tokenCount)} 有效 Token · ${money(row.cost)}`}>
                    <span class="uc-attr-name">{row.agent}</span>
                    <span class="uc-share">
                      <span class="uc-share-bar"><i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></span>
                    </span>
                    <span class="uc-attr-value">
                      {row.cost > 0 ? money(row.cost) : <span class="uc-zero">$0</span>}
                    </span>
                  </div>
                )
              }}
            </For>
          </div>
          <div class="uc-attr-col">
            <div class="uc-attr-col-title">项目</div>
            <For each={props.projects.slice(0, 6)}>
              {(row) => {
                const tokenCount = row.input + row.output
                const pct = share(row.cost, tokenCount, projectBase())
                return (
                  <div class="uc-attr-row" title={`${row.name} · ${compact(tokenCount)} 有效 Token · ${money(row.cost)}`}>
                    <span class="uc-attr-name" title={row.name}>{row.name}</span>
                    <span class="uc-share">
                      <span class="uc-share-bar"><i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></span>
                    </span>
                    <span class="uc-attr-value">
                      {row.cost > 0 ? money(row.cost) : <span class="uc-zero">$0</span>}
                    </span>
                  </div>
                )
              }}
            </For>
          </div>
        </div>
        <div class="uc-attr-note">
          费用为本地估算；全部为 $0 时条形按有效 Token 占比显示。Agent 由每次模型请求自带（build / explore / general 等）。
        </div>
      </section>
    </Show>
  )
}

export function UsagePage(props: { ctx: Context; embedded?: boolean }) {
  const api = props.ctx.client.rpc(Usage)
  const ui = props.ctx.ui
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [quota, setQuota] = createSignal<Quota>()
  const [range, setRange] = createSignal<RangeKind>("30d")
  const [scope, setScope] = createSignal("all")
  const [currentID, setCurrentID] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal("")
  const [tab, setTab] = createSignal<Tab>("overview")
  /**
   * 页签切换不卸载：访问过的页签保留挂载、仅隐藏。会话搜索词、回放展开状态、
   * 模型页的展开/筛选都因此保留，切回来也不再重放挂载成本。
   */
  const [visited, setVisited] = createSignal<ReadonlySet<Tab>>(new Set<Tab>(["overview"]))
  const [detailSession, setDetailSession] = createSignal<SessionRow>()
  /** 总览模型行钻取：预置的会话模型筛选。null = 用户手动改过，不再覆盖。 */
  const [drillModel, setDrillModel] = createSignal<string | null>(null)
  const [remoteModels, setRemoteModels] = createSignal<import("@opencode/client/promise").ModelInfo[]>([])
  const [providerNames, setProviderNames] = createSignal(new Map<string, string>())
  /** 模型页签首次打开才拉 host 的模型/provider 目录，首屏不背这两次 RPC。 */
  const [hostDataDone, setHostDataDone] = createSignal(false)
  /** 目录拉取状态：只有成功才算完成，失败保留错误并允许就地重试。 */
  const [hostDataError, setHostDataError] = createSignal("")
  const [hostDataLoading, setHostDataLoading] = createSignal(false)
  /** providerID:modelID → 最近 30 天真实请求，供模型页的「常用」区。声明顺序必须在 modelUsage 之前：esbuild 压缩后 const 无提升。 */
  const usageModels = () => snapshot()?.models ?? []
  const modelUsage = createMemo(() => {
    const map = new Map<string, { requests: number; cost: number }>()
    for (const row of usageModels()) {
      map.set(`${row.providerID}:${row.modelID}`, { requests: row.requests, cost: row.cost })
    }
    return map
  })
  let request = 0
  let quotaRequest = 0
  let timer: number | undefined
  let lastEventRefresh = 0

  const projects = createMemo(() => snapshot()?.projects ?? [])
  const currentProject = createMemo(() => projects().find((project) => project.id === currentID()))
  const projectID = () =>
    scope() === "all"
      ? undefined
      : scope() === "current"
        ? (currentID() ?? projects()[0]?.id)
        : scope()

  const cacheKey = () => viewKey(range(), projectID())

  function hydrate(nextRange: RangeKind, nextScope: string): boolean {
    const nextID =
      nextScope === "all" ? undefined : nextScope === "current" ? (currentID() ?? projects()[0]?.id) : nextScope
    const cached = VIEW_CACHE.get(viewKey(nextRange, nextID))
    if (!cached) return false
    setSnapshot(cached.snapshot)
    if (cached.quota) setQuota(cached.quota)
    setLoading(false)
    return true
  }

  function remember(next: Snapshot, nextQuota: Quota | undefined) {
    const key = cacheKey()
    VIEW_CACHE.delete(key)
    VIEW_CACHE.set(key, { snapshot: next, quota: nextQuota, at: Date.now() })
    if (VIEW_CACHE.size > VIEW_CACHE_LIMIT) {
      const oldest = VIEW_CACHE.keys().next().value
      if (oldest) VIEW_CACHE.delete(oldest)
    }
  }

  /**
   * Quota goes through a remote endpoint with an 8s timeout. It must never
   * block the local database snapshot from painting; the two run independently.
   */
  async function loadQuota(force = false) {
    const id = ++quotaRequest
    try {
      const next = await api.quota({ force })
      if (id !== quotaRequest) return
      setQuota(next)
      const current = snapshot()
      if (current && VIEW_CACHE.get(cacheKey())?.snapshot === current) remember(current, next)
    } catch {
      if (id !== quotaRequest) return
      const next: Quota = {
        available: false,
        error: "额度接口暂不可用",
        providers: [],
      }
      setQuota(next)
      const current = snapshot()
      if (current && VIEW_CACHE.get(cacheKey())?.snapshot === current) remember(current, next)
    }
  }

  async function load(force = false, quiet = false, refreshQuota = force) {
    const id = ++request
    if (!quiet) setRefreshing(true)
    if (!snapshot()) setLoading(true)
    setError("")
    const bounds = rangeBounds(range())
    // Usage events refresh the DB frequently; do not bypass the quota cache
    // for each one or the remote endpoint becomes the bottleneck.
    void loadQuota(refreshQuota)
    try {
      const next = await api.snapshot({ ...bounds, projectID: projectID(), force })
      if (id !== request) return
      setSnapshot(next)
      remember(next, quota())
    } catch (cause) {
      if (id !== request) return
      setError(readableError(cause))
    } finally {
      if (id === request) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }

  function schedule() {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      // Streaming can emit several usage events close together. Coalesce them
      // and refresh at most once every 15 seconds; manual refresh stays forced.
      const force = Date.now() - lastEventRefresh > 15_000
      lastEventRefresh = Date.now()
      void load(force, true, false)
    }, 1800)
  }

  onMount(() => {
    // Paint a cached view immediately, then revalidate in the background.
    hydrate("30d", "all")
    // The default scope is "all projects", so loading the snapshot does not
    // need to wait for the host location RPC.
    void load(false)
    void (async () => {
      try {
        const location = await props.ctx.client.location.get()
        setCurrentID(location.project.id)
        // If the user picked "current project" before the host responded,
        // refresh once with the now-known project id.
        if (scope() === "current") void load(false)
      } catch {
        // Keep "全部项目" usable even when the host has no active location.
      }
    })()
  })

  onMount(() => {
    // 凭据页签的数据在该页签首次挂载时自行拉取；模型目录延迟到用户点开「模型」页签。
  })

  onMount(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const _event of props.ctx.client.event.subscribe({
          types: [
            "session.usage.updated",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
          ],
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break
          schedule()
        }
      } catch {
        // Realtime is an enhancement; polling below keeps the page current.
      }
    })()
    const interval = window.setInterval(() => void load(false, true), 60_000)
    onCleanup(() => {
      controller.abort()
      window.clearInterval(interval)
      if (timer) window.clearTimeout(timer)
    })
  })

  /** 拉取模型/provider 目录；只有成功才标记完成，失败保留错误供就地重试。 */
  async function loadHostData() {
    if (hostDataLoading()) return
    setHostDataLoading(true)
    try {
      const [modelList, providerList] = await Promise.all([
        props.ctx.client.model.list(),
        props.ctx.client.provider.list(),
      ])
      setRemoteModels(modelList.data)
      setProviderNames(new Map(providerList.data.map((provider) => [provider.id, provider.name])))
      setHostDataDone(true)
      setHostDataError("")
    } catch (cause) {
      setHostDataError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setHostDataLoading(false)
    }
  }

  /** 切页签：记录访问过，首次进「模型」页签时才拉 host 的模型目录。 */
  function openTab(next: Tab) {
    if (tab() === next) return
    setVisited((prev) => {
      if (prev.has(next)) return prev
      const nextSet = new Set(prev)
      nextSet.add(next)
      return nextSet
    })
    setTab(next)
    if (next === "models" && !hostDataDone()) void loadHostData()
  }

  /** 钻取：总览模型行 → 会话列表（按该模型预筛选）。再次钻取覆盖上次预置。 */
  function openSessions(modelID: string) {
    setDetailSession(undefined)
    setDrillModel(modelID)
    openTab("sessions")
  }

  const totals = () => snapshot()?.totals
  const tokens = () => {
    const value = totals()?.tokens
    return value ? value.input + value.output : 0
  }
  const cacheHit = () => {
    const value = totals()?.tokens
    if (!value) return 0
    const base = value.cacheRead + value.input
    return base > 0 ? (value.cacheRead / base) * 100 : 0
  }
  const sessions = () => snapshot()?.sessions ?? []
  const models = () => snapshot()?.models ?? []
  const latencyModels = () => snapshot()?.latencyModels ?? []
  const credentials = () => snapshot()?.credentials ?? []
  const costModels = createMemo(() => [...models()].sort((a, b) => b.cost - a.cost))
  const topModels = createMemo(() => [...models()].sort((a, b) => sumTokens(b) - sumTokens(a)).slice(0, 4))
  const restModels = createMemo(() => models().slice().sort((a, b) => sumTokens(b) - sumTokens(a)).slice(4))
  const restTokens = createMemo(() => restModels().reduce((sum, model) => sum + sumTokens(model), 0))
  const restCost = createMemo(() => restModels().reduce((sum, model) => sum + model.cost, 0))
  const maxCostModel = createMemo(() => costModels().find((model) => model.cost > 0))
  const tokenShare = (model: ModelRow) => (tokens() > 0 ? sumTokens(model) / tokens() : 0)

  // 增减幅度与“上一个等长完整周期”比较，而不是把所选区间切成不等长的两半。
  // 奇数天不再偏向后半段；最后一个数据点（可能是未结束的今天）不参与基期比较。
  const halves = <T,>(values: readonly T[], read: (value: T) => number): { first: number; second: number } | undefined => {
    if (values.length < 3) return undefined
    // 最近一个点通常是“今天”，还没结束，不作为比较对象。
    const complete = values.slice(0, -1)
    if (complete.length < 2) return undefined
    const half = Math.floor(complete.length / 2)
    if (half < 1) return undefined
    const current = complete.slice(complete.length - half)
    const previous = complete.slice(complete.length - half * 2, complete.length - half)
    if (previous.length < half) return undefined
    const first = previous.reduce((sum, value) => sum + read(value), 0)
    const second = current.reduce((sum, value) => sum + read(value), 0)
    if (!Number.isFinite(first) || first <= 0) return undefined
    return { first, second }
  }
  const delta = (read: (point: SeriesPoint) => number) => {
    const value = halves(snapshot()?.series ?? [], read)
    if (!value || value.first <= 0) return undefined
    return ((value.second - value.first) / value.first) * 100
  }
  const insight = () => {
    const model = maxCostModel()
    if (!model || totals()?.cost === 0) return undefined
    return {
      model: model.modelID,
      costShare: totals()?.cost ? model.cost / totals()!.cost : 0,
      tokenShare: tokenShare(model),
    }
  }

  /** 告警冷却：关闭后 15 分钟内同一标题不再弹出（数据仍会在页签红点上提示）。 */
  const ALERT_COOLDOWN_MS = 15 * 60_000
  const [alertCooldown, setAlertCooldown] = createSignal<Record<string, number>>({})
  const [glossaryOpen, setGlossaryOpen] = createSignal(false)
  const alertCandidate = createMemo<Alert | undefined>(() => {
    const current = quota()
    if (current?.available) {
      // Warn on whichever provider window is closest to exhaustion.
      const hot = current.providers
        .flatMap((provider) => provider.meters.map((meter) => ({ provider, meter })))
        .filter((entry) => entry.meter.percent >= 90)
        .sort((a, b) => b.meter.percent - a.meter.percent)[0]
      if (hot) {
        return {
          title: `${hot.provider.name} ${hot.meter.label}仅剩 ${Math.max(0, Math.round(100 - hot.meter.percent))}%`,
          detail: `${hot.provider.name} ${hot.meter.label}已用 ${percent(hot.meter.percent)}${hot.meter.resetsAt ? `，${resetLabel(hot.meter.resetsAt)}` : ""}。`,
          action: "查看额度",
          target: "uc-quota",
        }
      }
    }
    const expiring = credentials().find((credential) => credential.expires && credential.expires - Date.now() < 14 * 86_400_000)
    if (expiring?.expires) {
      const tag = expiryLabel(expiring.expires)
      return {
        title: `${expiring.provider} 凭据${tag.text === "已过期" ? "已过期" : "即将过期"}`,
        detail: `${expiring.type === "oauth" ? "OAuth" : "API Key"} ${tag.text === "已过期" ? "已经过期" : `${tag.text}后到期`}，建议提前重新登录。`,
        action: "查看凭据",
        target: "uc-expiry",
      }
    }
    return undefined
  })
  /** 候选告警在冷却期内则不展示；冷却计时用信号包裹让 memo 随刷新重算。 */
  const alert = createMemo<Alert | undefined>(() => {
    const candidate = alertCandidate()
    if (!candidate) return undefined
    const cooledUntil = alertCooldown()[candidate.title]
    if (cooledUntil && Date.now() < cooledUntil) return undefined
    return candidate
  })

  function openTarget(target: string) {
    // 合并后的「凭据与额度」页签按供应商展示卡片，没有独立锚点；切页签即可。
    if (target === "uc-quota" || target === "uc-expiry") openTab("integrations")
  }


  const rangeLabel = () => RANGES.find((item) => item.id === range())?.label ?? "30 天"
  const scopeLabel = () => {
    if (scope() === "all") return "全部项目"
    if (scope() === "current") return currentProject()?.name ?? "当前项目"
    return projects().find((project) => project.id === scope())?.name ?? "项目"
  }

  return (
    <div class="uc-root" data-embedded={props.embedded ? "true" : undefined}>
      <style>{CSS}</style>
      <section class="uc-hero">
        <div class="uc-hero-copy">
          <div class="uc-kicker">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M2.5 12.5V9.2M6.2 12.5V6.4M9.9 12.5V8.1M13.6 12.5V3.5" />
            </svg>
            USAGE MONITOR
          </div>
          <Show when={!props.embedded}>
            <h1>用量中心</h1>
          </Show>
          <p class="uc-sub">把每一次模型调用都算清楚：Token、费用、时延与订阅额度。</p>
          <div class="uc-hero-meta">
            <Show when={snapshot()} fallback={<span>正在读取本机用量…</span>}>
              <span>
                本范围 <b>{totals()?.sessions ?? 0}</b> 个会话
              </span>
              <span class="uc-sep" />
              <span>
                <b>{models().length}</b> 个模型
              </span>
              <span class="uc-sep" />
              <span>数据仅存本机</span>
              <span class="uc-sep" />
              <span>{rangeLabel()} · {scopeLabel()}</span>
            </Show>
          </div>
        </div>
        <div class="uc-hero-tools">
          <div class="uc-tool-row">
            <div class="uc-seg" role="group" aria-label="时间范围">
              <For each={RANGES}>
                {(item) => (
                  <button
                    type="button"
                    classList={{ "uc-seg-on": range() === item.id }}
                    onClick={() => {
                      if (range() === item.id) return
                      setDetailSession(undefined)
                      setRange(item.id)
                      if (!hydrate(item.id, scope())) {
                        setSnapshot(undefined)
                        setLoading(true)
                      }
                      void load(false)
                    }}
                  >
                    {item.label}
                  </button>
                )}
              </For>
            </div>
            <ui.Button
              variant="ghost"
              size="small"
              icon="refresh"
              busy={refreshing()}
              onClick={() => void load(true)}
            >
              刷新
            </ui.Button>
          </div>
          <div class="uc-tool-row uc-tool-row-bottom">
            <label class="uc-scope">
              <span>范围</span>
              <select
                id="uc-scope"
                name="uc-scope"
                aria-label="统计范围"
                value={scope()}
                onChange={(event) => {
                  {
                    const value = event.currentTarget.value
                    setDetailSession(undefined)
                    setScope(value)
                    if (!hydrate(range(), value)) {
                      setSnapshot(undefined)
                      setLoading(true)
                    }
                    void load(false)
                  }
                }}
              >
                <option value="all">全部项目</option>
                <option value="current">当前项目</option>
                <For each={projects()}>
                  {(project) => (
                    <option value={project.id}>
                      {project.name}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <span class="uc-sync">
              更新于 <b>{snapshot() ? new Date(snapshot()!.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—"}</b>
              {" · "}60 秒自动刷新
            </span>
          </div>
        </div>
      </section>

      <nav
        class="uc-tabs"
        role="tablist"
        aria-label="用量页面"
        onKeyDown={(event) => {
          // 方向键在页签间移动（tablist 惯例）；Home/End 跳到首尾。
          const ids = TABS.map((item) => item.id)
          const index = ids.indexOf(tab())
          if (index < 0) return
          let next = -1
          if (event.key === "ArrowRight") next = (index + 1) % ids.length
          else if (event.key === "ArrowLeft") next = (index - 1 + ids.length) % ids.length
          else if (event.key === "Home") next = 0
          else if (event.key === "End") next = ids.length - 1
          if (next < 0) return
          event.preventDefault()
          openTab(ids[next]!)
          document.querySelector<HTMLButtonElement>(`.uc-tab[data-active="true"]`)?.focus()
        }}
      >
        <For each={TABS}>
          {(item) => {
            const quotaAlert = () => item.id === "integrations" && Boolean(alert())
            const latencyAlert = () => item.id === "latency" && (snapshot()?.latency.ttftP95 ?? 0) > 30
            return (
              <button
                type="button"
                class="uc-tab"
                role="tab"
                tabIndex={tab() === item.id ? 0 : -1}
                data-active={tab() === item.id ? "true" : undefined}
                aria-selected={tab() === item.id}
                title={tabHint(item.id, quotaAlert(), latencyAlert())}
                onClick={() => openTab(item.id)}
              >
                {item.label}
                <Show when={quotaAlert()}>
                  <span class="uc-tab-dot" title="某项订阅额度已用 ≥90%" />
                </Show>
                <Show when={latencyAlert()}>
                  <span class="uc-tab-dot" data-tone="warn" title="首字 P95 超过 30 秒" />
                </Show>
              </button>
            )
          }}
        </For>
        <span class="uc-spacer" />
        <span class="uc-tabs-scope">
          <Show when={refreshing() && snapshot()}>
            <span class="uc-updating"><i />更新中</span>
          </Show>
          {rangeLabel()} · {scopeLabel()}
        </span>
      </nav>

      <Show when={snapshot() && !snapshot()!.database.ok}>
        <div class="uc-alert" data-tone="danger">
          <span class="uc-alert-icon">
            <ui.Icon name="circle-exclamation" size="small" />
          </span>
          <span>
            <b>本机数据库读取受限</b>
            <span class="uc-alert-detail"> · {snapshot()!.database.error}</span>
          </span>
        </div>
      </Show>

      <Show when={alert()}>
        {(item) => (
          <div class="uc-alert">
            <span class="uc-alert-icon">
              <ui.Icon name="warning" size="small" />
            </span>
            <span>
              <b>{item().title}</b>
              <span class="uc-alert-detail"> · {item().detail}</span>
            </span>
            <button type="button" class="uc-alert-link" onClick={() => openTarget(item().target)}>
              {item().action} <span>→</span>
            </button>
            <button
              type="button"
              class="uc-alert-close"
              aria-label="关闭提醒"
              title="15 分钟内不再提醒；额度或凭据状态变化时会重新提示"
              onClick={() => {
                setAlertCooldown((prev) => ({ ...prev, [item().title]: Date.now() + ALERT_COOLDOWN_MS }))
              }}
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <div class="uc-notice" data-tone="error">
          <ui.Icon name="circle-exclamation" size="small" />
          <span>{error()}</span>
          <button type="button" class="uc-text-button" onClick={() => void load(true)}>
            重试
          </button>
        </div>
      </Show>

      <Show
        when={snapshot()}
        fallback={
          error() ? (
            <div class="uc-empty-line">暂时无法读取本机用量。请重试，或检查 OpenCode 数据库是否存在。</div>
          ) : (
            <div class="uc-first-load">
              <div class="uc-loading-note">
                <span class="uc-spinner" />
                <span>{loading() ? "首次读取本机用量，通常不到 1 秒…" : "没有可用数据"}</span>
              </div>
              <SkeletonDashboard />
            </div>
          )
        }
      >
        {/* keep-alive 页签容器：访问过的页签保留在 DOM 里用 display 隐藏，状态不丢 */}
        <For each={TABS}>
          {(item) => (
            <div style={{ display: tab() === item.id ? undefined : "none" }} data-tab-body={item.id}>
              <Show when={visited().has(item.id)}>
                <Switch>
                  <Match when={item.id === "overview"}>
                    <OverviewPanels
                      snapshot={snapshot()!}
                      quota={quota()}
                      credentials={credentials()}
                      insight={insight()}
                      cacheHit={cacheHit()}
                      tokens={tokens()}
                      totals={totals()}
                      rangeLabel={rangeLabel()}
                      models={models()}
                      topModels={topModels()}
                      restModels={restModels()}
                      restTokens={restTokens()}
                      restCost={restCost()}
                      delta={delta}
                      onRetryQuota={() => void loadQuota(true)}
                      onOpenModels={() => openTab("models")}
                      onOpenQuota={() => openTab("integrations")}
                      onOpenSessions={openSessions}
                    />
                  </Match>
                  <Match when={item.id === "latency"}>
                    <LatencyTab latency={snapshot()!.latency} models={latencyModels()} usage={models()} />
                  </Match>
                  <Match when={item.id === "sessions"}>
                    <SessionsTab
                      ctx={props.ctx}
                      sessions={sessions()}
                      projects={projects()}
                      rangeLabel={rangeLabel()}
                      selected={detailSession()}
                      onSelect={setDetailSession}
                      onClose={() => setDetailSession(undefined)}
                      initialModel={drillModel() ?? undefined}
                    />
                  </Match>
                  <Match when={item.id === "integrations"}>
                    <IntegrationsPage
                      ctx={props.ctx}
                      quota={quota()}
                      serverCredentials={credentials()}
                      onRetryQuota={() => void loadQuota(true)}
                      onCredentialsChanged={() => void load(true, true, false)}
                    />
                  </Match>
                  <Match when={item.id === "models"}>
                    <Show
                      when={!hostDataError()}
                      fallback={
                        <section class="uc-card">
                          <div class="uc-quota-error">
                            <span>模型目录加载失败：{hostDataError()}</span>
                            <button
                              type="button"
                              class="uc-text-button"
                              disabled={hostDataLoading()}
                              onClick={() => void loadHostData()}
                            >
                              {hostDataLoading() ? "正在重试…" : "重试"}
                            </button>
                          </div>
                        </section>
                      }
                    >
                      <ModelsExplorer
                        ctx={props.ctx}
                        models={remoteModels()}
                        providerNames={providerNames()}
                        usage={modelUsage()}
                      />
                    </Show>
                  </Match>
                </Switch>
              </Show>
            </div>
          )}
        </For>
      </Show>

      <Show when={!props.embedded}>
      <footer class="uc-foot">
        <span>
          数据来自本机 OpenCode 数据库 · 只读
          <Show when={snapshot()}>
            <span> · 最后同步 <b>{dateText(snapshot()!.generatedAt)}</b></span>
          </Show>
          <Show when={snapshot() && !snapshot()!.database.ok}>
            <span class="uc-foot-error"> · {snapshot()!.database.error}</span>
          </Show>
        </span>
        <span class="uc-foot-links">
          <button type="button" class="uc-text-button" onClick={() => setGlossaryOpen(!glossaryOpen())}>
            {glossaryOpen() ? "收起口径说明" : "指标口径"}
          </button>
          <span>⌘⌥U 打开</span>
          <span>本地优先 · 不上传会话内容</span>
        </span>
      </footer>
      <Show when={glossaryOpen()}>
        <div class="uc-glossary">
          <div class="uc-glossary-grid">
            <div><b>有效 Token</b><span>input + output，不含缓存读写；缓存读取单独展示，避免淹没真实用量。</span></div>
            <div><b>缓存命中率</b><span>cache.read ÷ (cache.read + input)，衡量重复上下文的复用程度。</span></div>
            <div><b>费用</b><span>消息记录的估算价 × Token 数；订阅内调用可能记为 $0，不代表没有成本。</span></div>
            <div><b>首字时延</b><span>请求开始到第一个流式事件（time.streamed − time.created）。</span></div>
            <div><b>慢请求</b><span>总时延超过 30 秒的请求占比；阈值固定，用于跨模型粗略对比。</span></div>
            <div><b>输出速度</b><span>输出 Token ÷ 总时延；受思考长度影响，仅作参考。</span></div>
          </div>
        </div>
      </Show>
      </Show>
    </div>
  )
}

/** Standalone x-large dialog opened from the titlebar pill and the ⌥U shortcut. */
export function UsageDialog(props: { ctx: Context; onClose: () => void }) {
  const ui = props.ctx.ui
  const openSettings = () => {
    props.onClose()
    // Let the dialog unmount before the host swaps in the Settings view.
    window.setTimeout(() => props.ctx.layout.settings("usage-center"), 0)
  }
  return (
    <ui.Dialog
      title="用量中心"
      size="x-large"
      footer={
        <div class="uc-dialog-footer">
          <span class="uc-footer-note">拖动右下角可调整大小</span>
          <ui.Button size="small" variant="ghost" icon="settings-gear" onClick={openSettings}>
            在设置中打开
          </ui.Button>
          <ui.Button size="small" onClick={props.onClose}>关闭</ui.Button>
        </div>
      }
    >
      <UsagePage ctx={props.ctx} embedded />
    </ui.Dialog>
  )
}
