import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import { Usage } from "../contract"
import type { SessionDetail, SessionRequest, SessionRow, SessionToolCall, SessionTurn } from "../contract"
import {
  compact,
  csvCell,
  dateText,
  duration,
  modelInitial,
  money,
  percent,
  providerName,
  readableError,
  shortModel,
} from "./format"

type CachedDetail = { value: SessionDetail; at: number }

const DETAIL_CACHE = new Map<string, CachedDetail>()
const DETAIL_CACHE_LIMIT = 4
const DETAIL_FRESH_MS = 120_000

function remember(detail: SessionDetail) {
  DETAIL_CACHE.delete(detail.id)
  DETAIL_CACHE.set(detail.id, { value: detail, at: Date.now() })
  while (DETAIL_CACHE.size > DETAIL_CACHE_LIMIT) {
    const oldest = DETAIL_CACHE.keys().next().value
    if (oldest) DETAIL_CACHE.delete(oldest)
  }
}

/** 写会话详情缓存（TASK-16.1：请求协调器与 16m 测试共用）。 */
export function rememberDetail(detail: SessionDetail) {
  remember(detail)
}

/** 读会话详情缓存（只读探针，供测试断言会话隔离与旧响应未写入）。 */
export function readDetailCache(sessionID: string): CachedDetail | undefined {
  return DETAIL_CACHE.get(sessionID)
}

/**
 * 会话级缓存失效（TASK-08）：Revert / 删除会话后，已加载回合可能包含被
 * 删除的消息。由页面层在收到对应事件时调用——指定 ID 只清该会话（普通
 * 打开、翻页、刷新不动其他会话缓存），省略 ID 清空全部（保守兜底）。
 * 清掉后重新打开会走网络请求，服务端汇总缓存可用 force 跳过 60s TTL。
 */
export function invalidateDetailCache(sessionID?: string) {
  if (sessionID === undefined) {
    DETAIL_CACHE.clear()
    return
  }
  DETAIL_CACHE.delete(sessionID)
}

/** Revert 过的脏会话（模块级单例，与 DETAIL_CACHE 同生命周期）。详情页打开时消费并移除。 */
const revertDirtySessions = new Set<string>()

/** 页面层收到 Revert 事件时标记：下次打开该会话强制走网络刷新两级缓存。 */
export function markSessionReverted(sessionID: string) {
  revertDirtySessions.add(sessionID)
}

/**
 * 详情页打开时消费脏标记（TASK-16.3：组件与测试共用同一生产路径）。
 * 返回是否曾被标记；消费一次即移除，避免之后每次打开都强制走网络。
 */
export function consumeRevertedMarker(sessionID: string): boolean {
  return revertDirtySessions.delete(sessionID)
}

/**
 * loadMore 游标进展判定（TASK-14 收尾提取，供测试直连）：服务端响应相对
 * 当前分页状态是否有进展。空页与「首回合 index ≥ 游标」都判为无进展——
 * 后者意味着服务端没有取到更早回合，重试只会请求同一页（无限加载）。
 */
export function loadMoreProgress(
  response: { turns: readonly SessionTurn[] },
  nextBefore: number,
): { progress: boolean; reason: "ok" | "empty" | "stalled" } {
  if (!response.turns.length) return { progress: false, reason: "empty" }
  if (response.turns[0]!.index >= nextBefore) return { progress: false, reason: "stalled" }
  return { progress: true, reason: "ok" }
}

/**
 * loadMore 响应归并（TASK-14 收尾提取，供测试直连）：给定当前详情与服务端
 * 返回页，计算下一页详情。无进展（空页/游标未前进）保留当前回合不动，
 * 只终止分页——异常响应不得污染已加载集合。有进展则合并新页并前移游标。
 */
export function applyLoadMoreResult(current: SessionDetail, next: SessionDetail): SessionDetail {
  const progress = loadMoreProgress(next, current.nextBefore)
  if (!progress.progress) return { ...current, hasMore: false, nextBefore: 0 }
  return withTurns(next, mergeTurns(next.turns, current.turns))
}

/**
 * loadMore 入口守卫（TASK-14 收尾提取，供测试直连）：删除状态、无更早回合、
 * 加载中、刷新中、其他请求在途——任一成立都不得发请求。
 */
export function canLoadMore(state: {
  sessionGone: boolean
  hasMore: boolean
  loadingMore: boolean
  refreshing: boolean
  inFlight: number
}): boolean {
  return (
    !state.sessionGone &&
    state.hasMore &&
    !state.loadingMore &&
    !state.refreshing &&
    state.inFlight === 0
  )
}

/** Merge two turn pages; later arguments win when a turn index overlaps. 导出供 15k 数据流回归。 */
export function mergeTurns(first: readonly SessionTurn[], second: readonly SessionTurn[]): SessionTurn[] {
  const map = new Map<number, SessionTurn>()
  for (const turn of first) map.set(turn.index, turn)
  for (const turn of second) map.set(turn.index, turn)
  return [...map.values()].sort((a, b) => a.index - b.index)
}

/** Keep loaded older pages when a refresh only returns the latest page. 导出供 15k 数据流回归。 */
export function withTurns(detail: SessionDetail, turns: SessionTurn[]): SessionDetail {
  const hasMore = turns.length > 0 && turns[0]!.index > 1
  return { ...detail, turns, hasMore, nextBefore: hasMore ? turns[0]!.index : 0 }
}

/** 会话详情请求入参（与 wire 契约同形，测试注入同一形状）。 */
export type DetailRequestInput = { sessionID: string; force?: boolean; beforeTurn?: number }

/**
 * 响应提交判定结果（TASK-16.1）。测试与文档共用同一份词汇：
 * `ok` 属于最新一代且仍是当前会话；`stale` 更新一代请求已发出；
 * `gone` 会话已删除；`switched` 请求发起后当前会话已切换；
 * `mismatch` 响应 id 与请求会话不一致（防串写缓存）；`error` 请求失败；
 * `skipped` 入口守卫拦下、未发出请求（仅 loadMore）。
 */
export type DetailRejectReason = "ok" | "stale" | "gone" | "switched" | "mismatch" | "error" | "skipped"

export type DetailLoadOutcome = { committed: boolean; reason: DetailRejectReason }

/**
 * 会话详情请求协调器（TASK-16.1 建立，TASK-16.2 纳入 loadMore）：首次加载、
 * 刷新、Revert 强刷、加载更早回合都经由这里。
 *
 * 为什么要有它：实例级的 `request` 计数只能区分「本实例的第几代请求」，分不清
 * 会话。一旦详情页在同一个实例里切换 `props.session`（Solid 的 Show 在 when
 * 仍为真时不重建 children），旧会话的响应就可能落到新会话的视图或缓存上。
 * 这里用「会话 id + 响应 id」双重校验把「旧响应不得覆盖新会话、不得串写缓存」
 * 变成显式判定，提交与缓存写入共用同一个结果。
 *
 * loadMore 与 load 共用主 `generation`（刷新 / Revert / 删除会令旧分页作废），
 * 另有独立的 `moreGeneration` 区分分页请求自身的新旧：即便守卫状态被旧生命
 * 周期提前复位，旧分页也不会重复追加或清掉新请求的 loadingMore。
 *
 * 测试用 Deferred 直接驱动本函数（与组件同一实现），精确控制返回顺序。
 */
export function createDetailLoader(options: {
  /** 真实 RPC；测试注入可控 Promise。load 与 loadMore 共用，入参同 wire 契约。 */
  fetch: (input: DetailRequestInput) => Promise<SessionDetail>
  /** 当前会话 id（组件传 `props.session.id` 访问器，不是固定值）。 */
  currentSessionID: () => string
  /** 会话已删除：置位后既不发请求，也不接收响应。 */
  isGone: () => boolean
  /** 当前详情，用于保留已加载的更早分页。 */
  getDetail: () => SessionDetail | undefined
  /** 提交详情（组件传 `setDetail`）。 */
  setDetail: (detail: SessionDetail) => void
  setRefreshing: (value: boolean) => void
  isRefreshing: () => boolean
  setLoadingMore: (value: boolean) => void
  isLoadingMore: () => boolean
  setError: (message: string) => void
  describeError: (cause: unknown) => string
  /** 写前端缓存（组件传 `rememberDetail`）。 */
  remember: (detail: SessionDetail) => void
}) {
  let generation = 0
  let inFlight = 0
  let moreGeneration = 0

  /** 响应能否落到当前视图（不看载荷内容）。 */
  function checkpoint(ticket: { generation: number; sessionID: string }): DetailRejectReason {
    if (ticket.generation !== generation) return "stale"
    if (options.isGone()) return "gone"
    if (ticket.sessionID !== options.currentSessionID()) return "switched"
    return "ok"
  }

  /** 提交响应：判定通过才写入视图与缓存。 */
  function commit(ticket: { generation: number; sessionID: string }, next: SessionDetail): DetailRejectReason {
    const reason = checkpoint(ticket)
    if (reason !== "ok") return reason
    // 响应必须属于发起请求的会话，否则 remember 会按载荷 id 写进别的缓存槽。
    if (next.id !== ticket.sessionID) return "mismatch"
    const previous = options.getDetail()
    const previousTurns = previous?.id === next.id ? previous.turns : []
    // 保留已加载的更早分页，替换最新一页覆盖的范围（Revert 后消失的回合会被丢弃）。
    const firstIncoming = next.turns[0]?.index ?? Number.POSITIVE_INFINITY
    const olderTurns = previousTurns.filter((turn) => turn.index < firstIncoming)
    const merged = next.turns.length === 0 ? next : withTurns(next, mergeTurns(olderTurns, next.turns))
    options.setDetail(merged)
    options.remember(merged)
    return "ok"
  }

  type MoreTicket = { generation: number; moreGeneration: number; sessionID: string }

  /** 分页响应能否落到当前视图：主代 + 分页代 + 删除 + 会话切换。 */
  function checkpointMore(ticket: MoreTicket): DetailRejectReason {
    if (ticket.generation !== generation) return "stale"
    if (ticket.moreGeneration !== moreGeneration) return "stale"
    if (options.isGone()) return "gone"
    if (ticket.sessionID !== options.currentSessionID()) return "switched"
    return "ok"
  }

  /** 提交分页：判定通过才按最新详情合并、写视图与缓存。 */
  function commitMore(ticket: MoreTicket, next: SessionDetail): DetailRejectReason {
    const reason = checkpointMore(ticket)
    if (reason !== "ok") return reason
    // 响应必须属于发起请求的会话，否则 remember 会按载荷 id 写进别的缓存槽。
    if (next.id !== ticket.sessionID) return "mismatch"
    // 以提交时刻的详情为基线：不用发起时的快照覆盖较新结果。
    const current = options.getDetail()
    if (!current || current.id !== ticket.sessionID) return "switched"
    const merged = applyLoadMoreResult(current, next)
    options.setDetail(merged)
    options.remember(merged)
    return "ok"
  }

  return {
    /** 最新一代请求编号（协调器内部与测试探针共用）。 */
    get generation() {
      return generation
    },
    get inFlight() {
      return inFlight
    },
    /** 会话切换：所有在途响应作废，且不再写入缓存。 */
    invalidate() {
      generation += 1
    },
    /**
     * 会话已删除（TASK-16.3）：作废在途响应，并收尾它们的加载态。
     * 删除后 load/loadMore 会短路、不会再有新请求；在途请求也不再是最新代，
     * 其 finally 不会清 refreshing —— 不在这里复位就会永久停在「刷新中…」。
     */
    cancelForGone() {
      generation += 1
      options.setRefreshing(false)
      options.setLoadingMore(false)
    },
    async load(force = false, quiet = false): Promise<DetailLoadOutcome> {
      if (options.isGone()) return { committed: false, reason: "gone" }
      const ticket = { generation: ++generation, sessionID: options.currentSessionID() }
      inFlight += 1
      if (!quiet) options.setRefreshing(true)
      options.setError("")
      try {
        const next = await options.fetch({ sessionID: ticket.sessionID, force })
        const reason = commit(ticket, next)
        return { committed: reason === "ok", reason }
      } catch (cause) {
        const reason = checkpoint(ticket)
        if (reason === "ok") options.setError(options.describeError(cause))
        return { committed: false, reason: reason === "ok" ? "error" : reason }
      } finally {
        inFlight = Math.max(0, inFlight - 1)
        // 只有最新一代能结束加载态：旧请求晚返回不得清掉新请求的 refreshing。
        if (ticket.generation === generation) options.setRefreshing(false)
      }
    },
    /**
     * 加载更早回合（TASK-16.2）：入口守卫沿用 canLoadMore（删除 / 无更早 /
     * 加载中 / 刷新中 / 其他请求在途），响应身份用「主代 + 分页代 + 会话 +
     * 响应 id」判定；只有最新且匹配的分页才合并并写缓存。
     */
    async loadMore(): Promise<DetailLoadOutcome> {
      if (options.isGone()) return { committed: false, reason: "gone" }
      const current = options.getDetail()
      if (
        !current ||
        !canLoadMore({
          sessionGone: options.isGone(),
          hasMore: current.hasMore,
          loadingMore: options.isLoadingMore(),
          refreshing: options.isRefreshing(),
          inFlight,
        })
      )
        return { committed: false, reason: "skipped" }
      const ticket = {
        generation,
        moreGeneration: ++moreGeneration,
        sessionID: options.currentSessionID(),
      }
      options.setLoadingMore(true)
      options.setError("")
      try {
        const next = await options.fetch({ sessionID: ticket.sessionID, beforeTurn: current.nextBefore })
        const reason = commitMore(ticket, next)
        return { committed: reason === "ok", reason }
      } catch (cause) {
        // 过期 / 已删除 / 已切换的请求失败不得把错误写到当前视图。
        const reason = checkpointMore(ticket)
        if (reason === "ok") options.setError(options.describeError(cause))
        return { committed: false, reason: reason === "ok" ? "error" : reason }
      } finally {
        // 只有最新一代分页能结束 loadingMore；旧请求晚返回不得清掉新请求的状态。
        if (ticket.moreGeneration === moreGeneration) options.setLoadingMore(false)
      }
    },
  }
}

import { cacheHitRate, effectiveTokens } from "./metrics"

// 「有效 Token」与缓存命中率统一走 gui/metrics.ts（口径单一来源）。

/** 全字段 Token 视觉足迹（可视化堆叠条与柱状图的分母，含缓存读写与推理）。 */
function fullTokenFootprint(tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }): number {
  return tokens.cacheRead + tokens.input + tokens.cacheWrite + tokens.output + tokens.reasoning
}

function cacheTone(value: number): "ok" | "warn" | "low" {
  if (value >= 0.7) return "ok"
  if (value >= 0.3) return "warn"
  return "low"
}

function previewLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? ""
  if (!line) return "（无文本）"
  return line.length > 150 ? `${line.slice(0, 149)}…` : line
}

const SEARCH_INDEX = new WeakMap<SessionTurn, string>()

/** Build the lowercased search blob once per turn, not on every keystroke. */
function turnSearchText(turn: SessionTurn): string {
  const cached = SEARCH_INDEX.get(turn)
  if (cached !== undefined) return cached
  const parts: string[] = [turn.prompt, ...turn.files, ...turn.agents]
  for (const request of turn.requests) {
    parts.push(
      request.modelID,
      request.providerID,
      request.agent,
      request.text,
      request.reasoning,
      request.error,
    )
    for (const tool of request.tools) {
      parts.push(tool.name, tool.summary, tool.input, tool.output, tool.error)
    }
  }
  const value = parts.join("\n").toLowerCase()
  SEARCH_INDEX.set(turn, value)
  return value
}

function matchesTurn(turn: SessionTurn, query: string): boolean {
  return turnSearchText(turn).includes(query)
}

/**
 * 搜索范围（TASK-15）：只在传入的回合集合内过滤——生产调用方传入
 * detail().turns（当前已加载回合），因此搜索永远不会触达未加载历史。
 * 搜索索引以回合对象为 WeakMap 键：刷新/翻页产生的新对象自动重新索引，
 * 旧对象随 GC 回收，不会把上一次的内容带进新结果。
 */
export function filterTurnsByQuery(turns: readonly SessionTurn[], query: string): readonly SessionTurn[] {
  const value = query.trim().toLowerCase()
  if (!value) return turns
  return turns.filter((turn) => matchesTurn(turn, value))
}

/** CSV 表头（TASK-15：字段与列顺序是导出契约的一部分，抽为常量供测试断言）。 */
export const CSV_HEADER = [
  "回合",
  "时间",
  "请求序号",
  "模型",
  "供应商",
  "Agent",
  "输入",
  "缓存读取",
  "缓存写入",
  "输出",
  "推理",
  "费用",
  "首字秒",
  "总时延秒",
  "工具数",
  "工具错误",
  "结束原因",
  "提示词",
] as const

/**
 * CSV 导出数据构建（TASK-15）：只接收调用方给出的回合（生产为
 * visibleTurns()，即已加载且匹配搜索的回合），不读取别的数据源、不发请求。
 * 字段顺序、空回合补零、提示词压成单行并截断 300 字、csvCell 转义均保持原样。
 */
export function buildCsvRows(turns: readonly SessionTurn[]): unknown[][] {
  const lines: unknown[][] = [[...CSV_HEADER]]
  for (const turn of turns) {
    const prompt = turn.prompt.replace(/\s+/g, " ").slice(0, 300)
    if (turn.requests.length === 0) {
      lines.push([turn.index, new Date(turn.time).toISOString(), "", "", "", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, "", prompt])
      continue
    }
    turn.requests.forEach((request, index) => {
      lines.push([
        turn.index,
        new Date(request.time).toISOString(),
        index + 1,
        request.modelID,
        request.providerID,
        request.agent,
        request.tokens.input,
        request.tokens.cacheRead,
        request.tokens.cacheWrite,
        request.tokens.output,
        request.tokens.reasoning,
        request.cost,
        request.ttft,
        request.total,
        request.tools.length,
        request.tools.filter((tool) => tool.status === "error" || tool.error).length,
        request.finish,
        prompt,
      ])
    })
  }
  return lines
}

/** 完整 CSV 文本（含 Excel 兼容 BOM）。组件下载与测试共用这一份实现。 */
export function buildCsvText(turns: readonly SessionTurn[]): string {
  return "\ufeff" + buildCsvRows(turns).map((line) => line.map(csvCell).join(",")).join("\n")
}

/** 脱敏导出的请求行：只留数字与元数据。 */
function stripRequest(request: SessionRequest) {
  return {
    time: new Date(request.time).toISOString(),
    agent: request.agent,
    provider: request.providerID,
    model: request.modelID,
    finish: request.finish,
    cost: request.cost,
    tokens: request.tokens,
    ttftSeconds: request.ttft,
    totalSeconds: request.total,
    toolCount: request.tools.length,
    toolErrors: request.tools.filter((tool) => tool.status === "error" || tool.error).length,
  }
}

/**
 * JSON 导出载荷（TASK-15）：只序列化调用方给出的回合（生产为
 * visibleTurns()），不触发任何读取。脱敏只影响返回的新对象——回合、
 * 请求、工具对象均不修改，页面当前数据与后续导出不受影响。
 * 结构与字段名保持 1.0 契约：Session → Turn → Request → Tool。
 */
export function buildJsonPayload(current: SessionDetail, turns: readonly SessionTurn[], full: boolean) {
  const exportedTurns = turns.map((turn) => {
    const base = {
      index: turn.index,
      time: new Date(turn.time).toISOString(),
      cost: turn.cost,
      tokens: turn.tokens,
      toolCount: turn.toolCount,
      errorCount: turn.errorCount,
      durationSeconds: turn.duration,
      ttftSeconds: turn.ttft,
      cacheHit: turn.cacheHit,
    }
    // 脱敏模式同时剥离附件名（files 可能含文件路径）；agents 是通用
    // agent 类型名（build / explore），非用户标识，保留。
    if (!full) return { ...base, agents: turn.agents, requests: turn.requests.map(stripRequest) }
    return {
      ...base,
      files: turn.files,
      agents: turn.agents,
      prompt: turn.prompt,
      promptTruncated: turn.promptTruncated,
      requests: turn.requests.map((request) => ({
        id: request.id,
        time: new Date(request.time).toISOString(),
        agent: request.agent,
        provider: request.providerID,
        model: request.modelID,
        variant: request.variant || undefined,
        finish: request.finish,
        cost: request.cost,
        tokens: request.tokens,
        ttftSeconds: request.ttft,
        totalSeconds: request.total,
        error: request.error || undefined,
        text: request.text,
        reasoning: request.reasoning || undefined,
        tools: request.tools.map((tool) => ({
          name: tool.name,
          status: tool.status,
          durationSeconds: tool.duration,
          input: tool.input,
          output: tool.output,
          error: tool.error || undefined,
          exitCode: tool.exitCode,
        })),
      })),
    }
  })
  return {
    exportedAt: new Date().toISOString(),
    sanitized: !full,
    note: full
      ? "完整导出：包含提示词、回复、工具输出与附件名，请勿外发。"
      : "内容脱敏导出：去除提示词、回复、思考、工具内容与附件名；仍保留会话标题、项目、模型、时间等元数据。",
    session: {
      id: current.id,
      title: current.title,
      project: current.projectName,
      directory: full ? current.directory : undefined,
      provider: current.providerID,
      model: current.modelID,
      timeCreated: new Date(current.timeCreated).toISOString(),
      timeUpdated: new Date(current.timeUpdated).toISOString(),
      cost: current.cost,
      tokens: current.tokens,
      totalTurns: current.totalTurns,
      requestCount: current.requestCount,
      toolCount: current.toolCount,
      errorCount: current.errorCount,
      ttftP50: current.ttftP50,
      ttftP95: current.ttftP95,
      totalP95: current.totalP95,
      slowRate: current.slowRate,
      cacheHit: current.cacheHit,
    },
    /** 只包含已加载的回合；长会话可在界面继续加载后再导出。 */
    turns: exportedTurns,
  }
}

function statusLabel(status: string): string {
  if (status === "completed") return "完成"
  if (status === "error") return "失败"
  if (status === "running") return "运行中"
  return status || "未知"
}

function PageBar(props: { turn: SessionTurn }) {
  const total = () => fullTokenFootprint(props.turn.tokens)
  const width = (value: number) => `${Math.max(0, (value / Math.max(1, total())) * 100)}%`
  return (
    <span class="uc-turn-bar" title={`缓存 ${compact(props.turn.tokens.cacheRead)} · 输入 ${compact(props.turn.tokens.input)} · 输出 ${compact(props.turn.tokens.output)}`}>
      <i class="cache" style={{ width: width(props.turn.tokens.cacheRead) }} />
      <i class="input" style={{ width: width(props.turn.tokens.input) }} />
      <i class="write" style={{ width: width(props.turn.tokens.cacheWrite) }} />
      <i class="output" style={{ width: width(props.turn.tokens.output + props.turn.tokens.reasoning) }} />
    </span>
  )
}

function CacheBar(props: { tokens: SessionDetail["tokens"] }) {
  const total = () => fullTokenFootprint(props.tokens)
  const width = (value: number) => `${Math.max(0, (value / Math.max(1, total())) * 100)}%`
  return (
    <div class="uc-sd-cachebar">
      <span class="cache" style={{ width: width(props.tokens.cacheRead) }} title={`缓存读取 ${compact(props.tokens.cacheRead)}`} />
      <span class="input" style={{ width: width(props.tokens.input) }} title={`未缓存输入 ${compact(props.tokens.input)}`} />
      <span class="write" style={{ width: width(props.tokens.cacheWrite) }} title={`缓存写入 ${compact(props.tokens.cacheWrite)}`} />
      <span class="output" style={{ width: width(props.tokens.output + props.tokens.reasoning) }} title={`输出 + 推理 ${compact(props.tokens.output + props.tokens.reasoning)}`} />
    </div>
  )
}

/** 统一的长内容块：pre + 右上角复制按钮。截断状态由调用方标注。 */
function CopyBlock(props: { text: string; class?: string; label?: string }) {
  const [copied, setCopied] = createSignal(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默失败（宿主可能未授权）
    }
  }
  return (
    <div class="uc-copy" data-with-label={props.label ? "true" : undefined}>
      <Show when={props.label}>
        <span class="uc-copy-label">{props.label}</span>
      </Show>
      <button type="button" class="uc-copy-btn" onClick={() => void copy()} title="复制完整内容">
        {copied() ? "已复制" : "复制"}
      </button>
      <pre class={props.class ?? "uc-pre"}>{props.text || "（空）"}</pre>
    </div>
  )
}

function ToolCall(props: { tool: SessionToolCall }) {
  const tone = () => (props.tool.status === "error" || props.tool.error ? "danger" : props.tool.status === "running" ? "warn" : "ok")
  return (
    <details class="uc-tool" classList={{ "uc-tool-error": tone() === "danger" }}>
      <summary class="uc-tool-head">
        <span class="uc-tool-state" data-tone={tone()} />
        <span class="uc-tool-name">{props.tool.name}</span>
        <span class="uc-tool-summary">{props.tool.summary || "（无输入摘要）"}</span>
        <span class="uc-tool-duration">{duration(props.tool.duration)}</span>
        <span class="uc-tool-status" data-tone={tone()}>{statusLabel(props.tool.status)}</span>
        <svg class="uc-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <path d="M4.5 2.5 8 6l-3.5 3.5" />
        </svg>
      </summary>
      <div class="uc-tool-body">
        <div class="uc-tool-label">输入</div>
        <CopyBlock text={props.tool.input} />
        <Show when={props.tool.output}>
          <div class="uc-tool-label">
            输出
            <Show when={props.tool.outputTruncated}>
              <span class="uc-tool-cut">已截断 · 复制的仍是预览内容，完整内容在本机数据库</span>
            </Show>
          </div>
          <CopyBlock text={props.tool.output} class="uc-pre uc-pre-output" />
        </Show>
        <Show when={props.tool.error}>
          <div class="uc-tool-label uc-danger">错误</div>
          <CopyBlock text={props.tool.error} class="uc-pre uc-pre-error" />
        </Show>
        <Show when={typeof props.tool.exitCode === "number"}>
          <div class="uc-tool-foot">退出码 {props.tool.exitCode}</div>
        </Show>
      </div>
    </details>
  )
}

function RequestCard(props: { request: SessionRequest; index: number; initialOpen?: boolean }) {
  const hit = () => cacheHitRate(props.request.tokens)
  const tone = () => cacheTone(hit())
  const total = () => effectiveTokens(props.request.tokens)
  return (
    <details class="uc-req" open={props.initialOpen}>
      <summary class="uc-req-head">
        <span class="uc-req-order">请求 {props.index}</span>
        <span class="uc-req-model" title={`${providerName(props.request.providerID)} / ${props.request.modelID}`}>
          <i>{modelInitial(props.request.modelID)}</i>
          <span>{shortModel(props.request.modelID)}</span>
          <Show when={props.request.variant}>
            <em>{props.request.variant}</em>
          </Show>
        </span>
        <span class="uc-req-agent">{props.request.agent}</span>
        <Show when={props.request.tools.length > 0}>
          <span class="uc-req-tools">{props.request.tools.length} 工具</span>
        </Show>
        <span class="uc-req-lat">TTFT {duration(props.request.ttft)} · {duration(props.request.total)}</span>
        <span class="uc-req-tokens">{compact(total())} token</span>
        <span class="uc-req-cache" data-tone={tone()}>{percent(hit() * 100, 1)}</span>
        <span class="uc-req-cost">{money(props.request.cost)}</span>
        <svg class="uc-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <path d="M4.5 2.5 8 6l-3.5 3.5" />
        </svg>
      </summary>
      <div class="uc-req-body">
        <div class="uc-req-metrics">
          <span><b>{compact(props.request.tokens.input)}</b><small>输入</small></span>
          <span><b>{compact(props.request.tokens.cacheRead)}</b><small>缓存读取</small></span>
          <span><b>{compact(props.request.tokens.cacheWrite)}</b><small>缓存写入</small></span>
          <span><b>{compact(props.request.tokens.output)}</b><small>输出</small></span>
          <span><b>{compact(props.request.tokens.reasoning)}</b><small>推理</small></span>
          <span><b>{props.request.finish || "—"}</b><small>结束原因</small></span>
          <span><b>{duration(props.request.ttft)}</b><small>首字延迟</small></span>
          <span><b>{duration(props.request.total)}</b><small>总时延</small></span>
        </div>
        <div class="uc-req-cachebar">
          <CacheBar tokens={props.request.tokens} />
          <span class="uc-req-cache-note">
            缓存命中 <b data-tone={tone()}>{percent(hit() * 100, 1)}</b> · 本请求 {compact(total())} token
          </span>
        </div>
        <Show when={props.request.error}>
          <div class="uc-req-error">
            <b>请求失败</b>
            <span>{props.request.error}</span>
          </div>
        </Show>
        <Show when={props.request.reasoning}>
          <details class="uc-reasoning">
            <summary>
              思考过程
              <span>{compact(props.request.reasoning.length)} 字</span>
              <Show when={props.request.reasoningTruncated}>
                <em>已截断</em>
              </Show>
            </summary>
            <CopyBlock text={props.request.reasoning} class="uc-pre uc-pre-reasoning" />
          </details>
        </Show>
        <Show when={props.request.text}>
          <div class="uc-req-text">
            <div class="uc-req-text-head">回复</div>
            <div class="uc-req-text-body">{props.request.text}</div>
            <Show when={props.request.textTruncated}>
              <div class="uc-note">回复过长，仅显示预览；完整内容保留在本机数据库。</div>
            </Show>
          </div>
        </Show>
        <Show when={props.request.tools.length > 0}>
          <div class="uc-tools">
            <div class="uc-tools-head">
              工具调用 <b>{props.request.tools.length}</b>
            </div>
            <For each={props.request.tools}>{(tool) => <ToolCall tool={tool} />}</For>
          </div>
        </Show>
      </div>
    </details>
  )
}

/**
 * 成本瀑布（0.5）：按回合显示估算费用柱状。费用全 0（订阅内调用）时按
 * 有效 Token 显示并明确标注。点击柱子展开对应回合，定位高消耗回合。
 */
function CostWaterfall(props: {
  turns: readonly SessionTurn[]
  totalCost: number
  totalTurns: number
  onLocate: (index: number) => void
}) {
  const byCost = createMemo(() => props.turns.reduce((sum, turn) => sum + turn.cost, 0) > 0)
  const loadedCost = createMemo(() => props.turns.reduce((sum, turn) => sum + turn.cost, 0))
  const partial = createMemo(() => props.turns.length < props.totalTurns)
  const metricOf = (turn: SessionTurn) =>
    byCost() ? turn.cost : effectiveTokens(turn.tokens)
  const max = createMemo(() => Math.max(1e-9, ...props.turns.map(metricOf)))
  const top = createMemo(() => {
    const sorted = [...props.turns].sort((a, b) => metricOf(b) - metricOf(a))
    return sorted[0]
  })
  return (
    <Show when={props.turns.length > 1} fallback={null}>
      <div class="uc-sd-panel">
        <div class="uc-sd-panel-title">
          费用瀑布
          <span>
            {partial()
              ? `已加载 ${props.turns.length}/${props.totalTurns} 回合 · ${byCost() ? money(loadedCost()) : "全部 $0"}`
              : byCost()
                ? `${money(props.totalCost)} 总费用`
                : `全部 $0 · 按 Token 显示`}
          </span>
        </div>
        <div class="uc-sd-strip uc-cost-strip">
          <For each={props.turns}>
            {(turn) => {
              const value = metricOf(turn)
              const isTop = top()?.index === turn.index && value > 0
              return (
                <span
                  class="uc-sd-strip-col uc-cost-col"
                  data-tone={isTop ? "amber" : undefined}
                  style={{ height: `${Math.max(6, (value / max()) * 100)}%` }}
                  role="button"
                  tabIndex={0}
                  title={`回合 #${turn.index} · ${byCost() ? money(turn.cost) : `${compact(effectiveTokens(turn.tokens))} 有效 Token`}${turn.requests.length ? ` · ${turn.requests.length} 请求` : ""} · 点击展开`}
                  onClick={() => props.onLocate(turn.index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      props.onLocate(turn.index)
                    }
                  }}
                />
              )
            }}
          </For>
        </div>
        <div class="uc-sd-strip-note">
          {byCost()
            ? `柱高为回合费用 · 最高回合 #${top()?.index}（${money(top()?.cost ?? 0)}）· 点击展开该回合`
            : "柱高为回合有效 Token（费用未记录，订阅内调用可能为 $0）· 点击展开该回合"}
          <Show when={partial()}>
            <span> · 图表仅覆盖已加载回合，向下加载更早回合后自动刷新</span>
          </Show>
        </div>
      </div>
    </Show>
  )
}

function DetailSkeleton() {  return (
    <div class="uc-sd-skeleton">
      <div class="uc-sd-kpis">
        <For each={[0, 1, 2, 3, 4, 5]}>
          {() => (
            <div class="uc-sd-kpi uc-skeleton">
              <span class="uc-sk-line" style={{ width: "42%" }} />
              <span class="uc-sk-line uc-sk-value" style={{ width: "62%" }} />
            </div>
          )}
        </For>
      </div>
      <div class="uc-sd-skeleton-card uc-skeleton">
        <span class="uc-sk-line" style={{ width: "30%" }} />
        <span class="uc-sk-line" style={{ width: "82%" }} />
        <span class="uc-sk-line" style={{ width: "66%" }} />
        <span class="uc-sk-line" style={{ width: "74%" }} />
      </div>
      <div class="uc-sd-skeleton-card uc-skeleton">
        <span class="uc-sk-line" style={{ width: "24%" }} />
        <span class="uc-sk-line" style={{ width: "90%" }} />
        <span class="uc-sk-line" style={{ width: "58%" }} />
      </div>
    </div>
  )
}

/**
 * 详情页 Revert / 删除事件的处理分支（TASK-11）：纯函数，供组件订阅循环与
 * 行为测试共用。返回应执行的动作——调用方负责实际执行（失效缓存/强制刷新/
 * 置删除状态）。其他 sessionID 的事件返回空动作，不得刷新当前详情。
 */
export function handleDetailEvent(
  kind: string,
  eventSession: string | undefined,
  ownSessionID: string,
): { invalidate: boolean; forceReload: boolean; markGone: boolean } {
  if (eventSession !== ownSessionID) return { invalidate: false, forceReload: false, markGone: false }
  if (kind === "session.deleted") {
    // 会话已删除：清缓存 + 标记状态，不再请求（组件保持打开，显示「会话已删除」）。
    return { invalidate: true, forceReload: false, markGone: true }
  }
  // committed：回合被截断，已加载内容与汇总都可能过期 → 清缓存 + 强制刷新。
  // cleared：清除 Revert 标记（未截断回合），数据未变 → 不刷新，避免重复请求。
  if (kind === "session.revert.committed") return { invalidate: true, forceReload: true, markGone: false }
  return { invalidate: false, forceReload: false, markGone: false }
}

/**
 * 页面级事件决策（TASK-16.3）：从 page.tsx 订阅循环最小提取，组件与测试共用。
 * cleared 只表示 Revert 标记被清除、回合未被截断，数据未变——不得失效缓存
 * 或标脏，否则下次打开详情会被强制 force 刷新（不必要的详情重载）。
 */
export type PageEventAction = {
  /** 失效缓存；sessionID 缺省时按既有保守兜底全清。 */
  invalidate?: { sessionID?: string }
  /** 标记该会话下次打开强制走网络。 */
  reverted?: string
}

export function handlePageEvent(
  kind: string,
  data?: { sessionID?: string; id?: string },
): PageEventAction {
  if (kind === "session.revert.committed") {
    const sessionID = data?.sessionID
    return sessionID ? { invalidate: { sessionID }, reverted: sessionID } : {}
  }
  if (kind === "session.deleted") {
    // 既有语义：id 优先；两者都缺省时 invalidateDetailCache(undefined) 全清兜底。
    return { invalidate: { sessionID: data?.id ?? data?.sessionID } }
  }
  // session.revert.cleared 与其它事件：数据未变，不失效、不标脏、不重载。
  return {}
}

/**
 * 详情页事件订阅循环（TASK-13 提取供测试）：消费 revert/deleted 事件流，
 * 按 handleDetailEvent 的决策执行动作。返回退出函数——组件 onCleanup 与
 * 测试的模拟卸载都调用它；退出后消费循环终止，不再拉取事件。
 */
export function consumeDetailEvents(
  events: AsyncIterable<{ type: string; data?: { sessionID?: string; id?: string } }>,
  signal: AbortSignal,
  sessionID: string,
  actions: {
    invalidate: () => void
    markGone: () => void
    forceReload: () => void
  },
): Promise<void> {
  return (async () => {
    try {
      for await (const event of events) {
        if (signal.aborted) break
        const data = event.data
        const action = handleDetailEvent(event.type, data?.sessionID ?? data?.id, sessionID)
        if (action.invalidate) actions.invalidate()
        if (action.markGone) {
          actions.markGone()
          // 会话已删除（TASK-13）：后续事件对本详情页无意义，停止消费。
          // revert 等事件不会再有语义，也避免误触 forceReload。
          break
        }
        if (action.forceReload) actions.forceReload()
      }
    } catch {
      // 事件订阅失败时靠手动刷新兜底
    }
  })()
}

export function SessionDetailView(props: {
  ctx: Context
  session: SessionRow
  projectName?: string
  onBack: () => void
}) {
  const api = props.ctx.client.rpc(Usage)
  // Revert 过的会话：缓存里的回合可能包含已删除消息，视为未缓存，
  // 首次加载用 force 跳过服务端汇总 TTL。
  const wasReverted = consumeRevertedMarker(props.session.id)
  const cachedEntry = wasReverted ? undefined : DETAIL_CACHE.get(props.session.id)
  const cached = cachedEntry?.value
  const cachedFresh = Boolean(cachedEntry && Date.now() - cachedEntry.at < DETAIL_FRESH_MS)
  const [detail, setDetail] = createSignal<SessionDetail | undefined>(cached)
  const [refreshing, setRefreshing] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [error, setError] = createSignal("")
  const [query, setQuery] = createSignal("")
  /** 所属会话被删除（TASK-10）：置位后 UI 显示明确状态，不再请求。 */
  const [sessionGone, setSessionGone] = createSignal(false)
  /** JSON 导出的脱敏开关：开启时剥掉提示词、回复、思考与工具内容，只留结构化数字。 */
  const [sanitizeExport, setSanitizeExport] = createSignal(true)
  const [openTurns, setOpenTurns] = createSignal<Set<number>>(new Set())
  // 请求协调（TASK-16.1 建立，TASK-16.2 纳入 loadMore）：首次加载 / 刷新 /
  // Revert 强刷 / 加载更早回合共用；会话切换或删除时 invalidate 让在途响应
  // 作废，响应 id 与会话不一致时拒绝提交（不写缓存）。
  const loader = createDetailLoader({
    fetch: (input) => api.sessionDetail(input),
    currentSessionID: () => props.session.id,
    isGone: () => sessionGone(),
    getDetail: () => detail(),
    setDetail: (next) => setDetail(next),
    setRefreshing,
    isRefreshing: () => refreshing(),
    setLoadingMore,
    isLoadingMore: () => loadingMore(),
    setError,
    describeError: readableError,
    remember: rememberDetail,
  })

  const title = () => detail()?.title || props.session.title
  const projectLabel = () => detail()?.projectName || props.projectName || props.session.projectID || "项目"
  const totalTokens = () => {
    const tokens = detail()?.tokens
    return tokens ? effectiveTokens(tokens) : 0
  }
  const allRequests = createMemo(() => detail()?.turns.flatMap((turn) => turn.requests) ?? [])
  const visibleTurns = createMemo(() => filterTurnsByQuery(detail()?.turns ?? [], query()))
  createEffect(() => {
    if (!query().trim()) return
    const matches = visibleTurns()
    // Open the first few hits so a content search is visible without extra clicks.
    setOpenTurns(new Set(matches.slice(0, 3).map((turn) => turn.index)))
  })
  const throughput = createMemo(() => {
    const rows = allRequests()
    const seconds = rows.reduce((sum, row) => sum + row.total, 0)
    const output = rows.reduce((sum, row) => sum + row.tokens.output, 0)
    return seconds > 0 ? output / seconds : 0
  })
  const toolStats = createMemo(() => {
    const map = new Map<string, { name: string; count: number; errors: number; duration: number }>()
    for (const request of allRequests()) {
      for (const tool of request.tools) {
        const entry = map.get(tool.name) ?? { name: tool.name, count: 0, errors: 0, duration: 0 }
        entry.count += 1
        entry.duration += tool.duration
        if (tool.status === "error" || tool.error) entry.errors += 1
        map.set(tool.name, entry)
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 6)
  })
  const maxToolCount = createMemo(() => Math.max(1, ...toolStats().map((tool) => tool.count)))

  function toggleTurn(index: number) {
    setOpenTurns((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function toggleAll(open: boolean) {
    if (!open) {
      setOpenTurns(new Set<number>())
      return
    }
    setOpenTurns(new Set(visibleTurns().map((turn) => turn.index)))
  }

  function setTurnRequests(turnIndex: number, open: boolean, event: MouseEvent) {
    const clicked = event.currentTarget as HTMLElement | null
    const root = clicked?.closest(`[data-uc-turn="${turnIndex}"]`)
    root?.querySelectorAll<HTMLDetailsElement>(".uc-req").forEach((element) => {
      element.open = open
    })
  }

  function exportCsv() {
    const rows = visibleTurns()
    if (rows.length === 0) return
    const csv = buildCsvText(rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `opencode-session-${props.session.id.slice(-8)}-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /**
   * 结构化 JSON 导出（1.0）：保留 Session → Turn → Request → Tool 层次。
   * 脱敏模式剥掉 prompt / text / reasoning / tool input-output-error，只留
   * 数字与元数据；完整模式保留全部内容并提醒文件含会话正文。
   */
  function exportJson(full: boolean) {
    const current = detail()
    if (!current) return
    const body = JSON.stringify(buildJsonPayload(current, visibleTurns(), full), null, 2)
    const blob = new Blob([body], { type: "application/json;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `opencode-session-${props.session.id.slice(-8)}-${new Date().toISOString().slice(0, 10)}${full ? "" : "-sanitized"}.json`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // 加载更早回合（TASK-16.2）统一走 loader.loadMore()：入口守卫、请求身份
  // 判定、归并、缓存写入与状态恢复都在协调器内，按钮与测试调用同一入口。

  // Revert / 删除事件订阅（TASK-10）：必须在缓存判断之前建立——cachedFresh
  // 命中时跳过初始请求是缓存优化，但事件订阅不能跟着跳过，否则缓存展示期间
  // 发生的 Revert 无人感知，旧回合会一直停留到手动刷新。
  const eventsController = new AbortController()
  onMount(() => {
    void consumeDetailEvents(
      props.ctx.client.event.subscribe({
        types: ["session.revert.committed", "session.revert.cleared", "session.deleted"],
        signal: eventsController.signal,
      }),
      eventsController.signal,
      props.session.id,
      {
        invalidate: () => invalidateDetailCache(props.session.id),
        markGone: () => {
          setSessionGone(true)
          // 作废在途响应并收尾加载态（TASK-13 建立，TASK-16.3 补状态收尾）：
          // 否则删除事件到达后，先前的 load/loadMore 响应仍会 setDetail
          // + remember，把已删除会话的数据重新写进前端缓存；在途请求的
          // refreshing 也会因为不再是最新代而永远无法恢复。
          loader.cancelForGone()
        },
        forceReload: () => void loader.load(true),
      },
    )
    onCleanup(() => eventsController.abort())
  })

  onMount(() => {
    // Fresh cache paints instantly and avoids resetting expanded requests.
    // Stale cache still paints instantly, then revalidates in the background.
    // Revert 过的会话强制走网络（force 跳过服务端汇总 TTL）。
    if (cachedFresh) return
    void loader.load(wasReverted, Boolean(cached))
  })

  return (
    <section class="uc-card uc-sessions-page uc-sd">
      <style>{DETAIL_CSS}</style>
      <div class="uc-sd-head">
        <button type="button" class="uc-sd-back" onClick={props.onBack}>
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <path d="M7.5 2.5 4 6l3.5 3.5" />
          </svg>
          返回
        </button>
        <div class="uc-sd-title">
          <b title={title()}>{title()}</b>
          <span title={detail()?.directory}>
            {projectLabel()} · 完整历史（不受统计时间范围限制） · {dateText(detail()?.timeCreated || props.session.timeCreated)} ·{" "}
            {providerName(detail()?.providerID || props.session.providerID)} /{" "}
            {shortModel(detail()?.modelID || props.session.modelID)}
          </span>
        </div>
        <div class="uc-sd-actions">
          <Show when={detail()}>
            <button
              type="button"
              class="uc-sd-mini"
              title={query() ? "导出当前搜索匹配的已加载回合" : "导出已加载的回合"}
              onClick={exportCsv}
            >
              导出 CSV
            </button>
            <button
              type="button"
              class="uc-sd-mini"
              title={sanitizeExport() ? "内容脱敏导出：不含提示词 / 回复 / 工具内容 / 附件名，保留元数据" : "完整导出：保留全部内容，含提示词与工具输出"}
              onClick={() => exportJson(!sanitizeExport())}
            >
              导出 JSON
            </button>
            <button
              type="button"
              class="uc-sd-mini"
              data-tone={sanitizeExport() ? undefined : "warn"}
              title={sanitizeExport() ? "当前脱敏导出：点击切换为完整内容" : "当前完整导出：点击切换为脱敏"}
              onClick={() => setSanitizeExport(!sanitizeExport())}
            >
              {sanitizeExport() ? "脱敏 开" : "脱敏 关"}
            </button>
            <button type="button" class="uc-sd-mini" onClick={() => toggleAll(true)}>全部展开</button>
            <button type="button" class="uc-sd-mini" onClick={() => toggleAll(false)}>全部收起</button>
          </Show>
          <button type="button" class="uc-export" onClick={() => void loader.load(true)} disabled={refreshing()}>
            {refreshing() ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      <Show when={sessionGone()}>
        <div class="uc-sd-error" data-gone="true">
          <b>会话已删除</b>
          <span>该会话已被删除，展示的内容不再更新。返回会话列表查看其他会话。</span>
        </div>
      </Show>
      <Show when={error()}>
        <div class="uc-sd-error">
          <b>会话数据加载失败</b>
          <span>{error()}</span>
          <button type="button" class="uc-sd-mini" onClick={() => void loader.load(true)}>重试</button>
        </div>
      </Show>

      <Show
        when={detail()}
        fallback={
          error() ? (
            <div class="uc-sd-empty">
              <b>暂时无法读取会话</b>
              <span>请重试，或完全重启 OpenCode 后再打开。</span>
            </div>
          ) : (
            <DetailSkeleton />
          )
        }
      >
        {(value) => (
          <Show
            when={value().found}
            fallback={
              <div class="uc-sd-empty">
                <b>找不到这个会话</b>
                <span>它可能已被删除，或还没有写入本机数据库。</span>
              </div>
            }
          >
            <div class="uc-sd-kpis">
              <div class="uc-sd-kpi">
                <span>回合</span>
                <b>{value().totalTurns}</b>
                <small>{value().promptCount} 个用户提问</small>
              </div>
              <div class="uc-sd-kpi">
                <span>请求</span>
                <b>{value().requestCount}</b>
                <small>模型调用</small>
              </div>
              <div class="uc-sd-kpi">
                <span>工具</span>
                <b>{value().toolCount}</b>
                <small classList={{ "uc-danger": value().errorCount > 0 }}>
                  {value().errorCount > 0 ? `${value().errorCount} 个异常` : "全部完成"}
                </small>
              </div>
              <div class="uc-sd-kpi">
                <span>缓存命中</span>
                <b>{percent(value().cacheHit * 100, 1)}</b>
                <small>读取 {compact(value().tokens.cacheRead)}</small>
              </div>
              <div class="uc-sd-kpi">
                <span>Token</span>
                <b>{compact(totalTokens())}</b>
                <small>输入 + 输出</small>
              </div>
              <div class="uc-sd-kpi">
                <span>费用</span>
                <b>{money(value().cost)}</b>
                <small>本地估算</small>
              </div>
            </div>

            <div class="uc-sd-analysis">
              <div class="uc-sd-panel">
                <div class="uc-sd-panel-title">
                  缓存构成
                  <span>{percent(value().cacheHit * 100, 1)} 命中</span>
                </div>
                <CacheBar tokens={value().tokens} />
                <div class="uc-sd-legend">
                  <span><i class="cache" />缓存读取 <b>{compact(value().tokens.cacheRead)}</b></span>
                  <span><i class="input" />输入 <b>{compact(value().tokens.input)}</b></span>
                  <span><i class="write" />缓存写入 <b>{compact(value().tokens.cacheWrite)}</b></span>
                  <span><i class="output" />输出 + 推理 <b>{compact(value().tokens.output + value().tokens.reasoning)}</b></span>
                </div>
              </div>
              <div class="uc-sd-panel">
                <div class="uc-sd-panel-title">响应时延</div>
                <div class="uc-sd-latency">
                  <span><b>{duration(value().ttftP50)}</b><small>首字 P50</small></span>
                  <span><b>{duration(value().ttftP95)}</b><small>首字 P95</small></span>
                  <span><b>{duration(value().totalP50)}</b><small>总时延 P50</small></span>
                  <span><b>{duration(value().totalP95)}</b><small>总时延 P95</small></span>
                  <span><b>{throughput().toFixed(1)}</b><small>输出 tok/s</small></span>
                  <span><b>{percent(value().slowRate * 100, 1)}</b><small>慢请求</small></span>
                </div>
              </div>
              <div class="uc-sd-panel">
                <div class="uc-sd-panel-title">
                  回合节奏
                  <span>{value().turns.length} / {value().totalTurns} 个回合</span>
                </div>
                <div class="uc-sd-strip">
                  <For each={value().turns}>
                    {(turn) => {
                      // 回合总 Token（可视化分母）：全字段之和，与 PageBar/CacheBar 堆叠口径一致
                      const tokens = fullTokenFootprint(turn.tokens)
                      const max = Math.max(1, ...value().turns.map((row) => fullTokenFootprint(row.tokens)))
                      return (
                        <span
                          class="uc-sd-strip-col"
                          data-tone={cacheTone(turn.cacheHit)}
                          style={{ height: `${Math.max(8, (tokens / max) * 100)}%` }}
                          title={`回合 #${turn.index} · ${compact(tokens)} token · 缓存 ${percent(turn.cacheHit * 100, 1)}`}
                        />
                      )
                    }}
                  </For>
                </div>
                <div class="uc-sd-strip-note">按时间顺序 · 柱高为 Token · 绿色命中高，红色命中低</div>
              </div>
              <CostWaterfall
                turns={value().turns}
                totalCost={value().cost}
                totalTurns={value().totalTurns}
                onLocate={toggleTurn}
              />
              <div class="uc-sd-panel">
                <div class="uc-sd-panel-title">
                  工具分布
                  <span>
                    {value().turns.length < value().totalTurns
                      ? `已加载 ${value().turns.length} 回合`
                      : `${value().toolCount} 次调用`}
                  </span>
                </div>
                <Show
                  when={toolStats().length > 0}
                  fallback={<div class="uc-sd-strip-note">本会话没有工具调用</div>}
                >
                  <div class="uc-toolstats">
                    <For each={toolStats()}>
                      {(tool) => (
                        <div
                          class="uc-toolstat"
                          title={`${tool.name} · ${tool.count} 次 · 平均 ${duration(tool.duration / Math.max(1, tool.count))}`}
                        >
                          <span class="uc-toolstat-name" title={tool.name}>{tool.name}</span>
                          <span class="uc-toolstat-bar">
                            <i style={{ width: `${(tool.count / maxToolCount()) * 100}%` }} />
                          </span>
                          <span class="uc-toolstat-count">
                            {tool.count}
                            <Show when={tool.errors > 0}>
                              <em> / {tool.errors} 失败</em>
                            </Show>
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>

            <Show when={value().hasMore}>
              <button type="button" class="uc-sd-more" onClick={() => void loader.loadMore()} disabled={loadingMore() || sessionGone()}>
                {loadingMore() ? "正在读取更早的回合…" : `加载更早的 ${value().nextBefore - 1} 个回合`}
              </button>
            </Show>

            <div class="uc-sd-filter">
              <label class="uc-search">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                  <circle cx="7" cy="7" r="4.2" />
                  <path d="M10.2 10.2 14 14" />
                </svg>
                <input
                  id="uc-session-detail-search"
                  name="uc-session-detail-search"
                  aria-label="搜索已加载回合"
                  placeholder="搜索已加载回合、提示词、模型、工具或输出"
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
              <Show when={query()}>
                <button type="button" class="uc-sd-mini" onClick={() => setQuery("")}>清除</button>
                <span class="uc-sd-filter-note">
                  匹配 {visibleTurns().length} / 已加载 {value().turns.length} 个回合
                </span>
              </Show>
            </div>

            <Show
              when={visibleTurns().length > 0}
              fallback={
                <div class="uc-sd-empty">
                  <b>{query() ? "没有匹配的回合" : "这个会话还没有可回放的回合"}</b>
                  <span>
                    {query()
                      ? "试试模型名、工具名或提示词里的关键词。"
                      : "可能只有会话元数据，消息还没有写入本机数据库。"}
                  </span>
                </div>
              }
            >
            <div class="uc-sd-timeline">
              <For each={visibleTurns()}>
                {(turn) => (
                  <article
                    class="uc-turn"
                    classList={{ "uc-turn-open": openTurns().has(turn.index) }}
                    data-uc-turn={turn.index}
                  >
                    <span class="uc-turn-rail" aria-hidden="true">
                      <i class="uc-turn-node" data-tone={turn.errorCount > 0 ? "danger" : cacheTone(turn.cacheHit)} />
                    </span>
                    <button
                      type="button"
                      class="uc-turn-head"
                      aria-expanded={openTurns().has(turn.index)}
                      onClick={() => toggleTurn(turn.index)}
                    >
                      <span class="uc-turn-order">#{turn.index}</span>
                      <span class="uc-turn-time">{dateText(turn.time)}</span>
                      <span class="uc-turn-main">
                        <span class="uc-turn-preview">{previewLine(turn.prompt)}</span>
                        <span class="uc-turn-meta">
                          {turn.requests.length} 请求 · {turn.toolCount} 工具 ·{" "}
                          {compact(effectiveTokens(turn.tokens))} token · 缓存 {percent(turn.cacheHit * 100, 1)}
                          <Show when={turn.ttft > 0}>
                            {" · "}平均首字 {duration(turn.ttft)}
                          </Show>
                          <Show when={turn.errorCount > 0}>
                            <em class="uc-turn-error">{turn.errorCount} 错误</em>
                          </Show>
                        </span>
                      </span>
                      <PageBar turn={turn} />
                      <span class="uc-turn-duration">{duration(turn.duration)}</span>
                      <span class="uc-turn-cost">{money(turn.cost)}</span>
                      <svg class="uc-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                        <path d="M4.5 2.5 8 6l-3.5 3.5" />
                      </svg>
                    </button>
                    <Show when={openTurns().has(turn.index)}>
                      <div class="uc-turn-body">
                        <div class="uc-prompt">
                          <div class="uc-prompt-head">
                            <span class="uc-prompt-label">用户</span>
                            <span>{dateText(turn.time)}</span>
                          </div>
                          <div class="uc-prompt-text">{turn.prompt || "（无文本）"}</div>
                          <Show when={turn.promptTruncated}>
                            <div class="uc-note">提示词过长，仅显示预览；完整内容保留在本机数据库。</div>
                          </Show>
                          <Show when={turn.files.length > 0 || turn.agents.length > 0}>
                            <div class="uc-prompt-tags">
                              <For each={turn.files}>{(file) => <span class="uc-tag file">{file}</span>}</For>
                              <For each={turn.agents}>{(agent) => <span class="uc-tag agent">{agent}</span>}</For>
                            </div>
                          </Show>
                        </div>
                        <Show when={turn.requests.length > 1}>
                          <div class="uc-turn-actions">
                            <span>{turn.requests.length} 次模型请求</span>
                            <button
                              type="button"
                              class="uc-sd-mini"
                              onClick={(event) => setTurnRequests(turn.index, true, event)}
                            >
                              展开全部请求
                            </button>
                            <button
                              type="button"
                              class="uc-sd-mini"
                              onClick={(event) => setTurnRequests(turn.index, false, event)}
                            >
                              收起请求
                            </button>
                          </div>
                        </Show>
                        <For each={turn.requests}>
                          {(request, index) => (
                            <RequestCard
                              request={request}
                              index={index() + 1}
                              initialOpen={turn.index === 1 && index() === 0}
                            />
                          )}
                        </For>
                      </div>
                    </Show>
                  </article>
                )}
              </For>
            </div>
            </Show>
          </Show>
        )}
      </Show>
    </section>
  )
}

const DETAIL_CSS = `
.uc-sd { display: flex; flex-direction: column; gap: 10px; min-height: 460px; container-type: inline-size; }
.uc-sd-head { display: flex; align-items: center; gap: 10px; padding-bottom: 9px; border-bottom: 1px solid var(--uc-border); }
.uc-sd-back, .uc-sd-mini, .uc-sd-more {
  border: 1px solid var(--uc-border);
  border-radius: 6px;
  background: var(--uc-card);
  color: var(--uc-muted);
  font: inherit;
  font-size: 10px;
  font-weight: 560;
  height: 27px;
  padding: 0 8px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.uc-sd-back:hover, .uc-sd-mini:hover, .uc-sd-more:hover { background: var(--uc-layer-2); color: var(--uc-strong); }
.uc-sd-back svg { width: 11px; height: 11px; }
.uc-sd-title { flex: 1; min-width: 0; }
.uc-sd-title b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-strong); font-size: 12.5px; font-weight: 650; }
.uc-sd-title span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-faint); font-size: 9.5px; margin-top: 2px; }
.uc-sd-actions { display: flex; align-items: center; justify-content: flex-end; gap: 5px; flex: 0 1 auto; flex-wrap: wrap; }
.uc-sd-actions .uc-export { height: 27px; }
.uc-sd-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 7px; }
.uc-sd-kpi { min-width: 0; padding: 8px 9px 7px; border: 1px solid var(--uc-border); border-radius: 9px; background: var(--uc-card); display: flex; flex-direction: column; gap: 2px; }
.uc-sd-kpi > span { color: var(--uc-faint); font-size: 10px; }
.uc-sd-kpi b { color: var(--uc-strong); font-size: 16px; font-weight: 680; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
.uc-sd-kpi small { color: var(--uc-faint); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-sd-kpi small.uc-danger { color: var(--uc-red); }
.uc-sd-analysis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 7px; }
.uc-sd-panel { min-width: 0; padding: 9px 10px 8px; border: 1px solid var(--uc-border); border-radius: 9px; background: var(--uc-layer); display: flex; flex-direction: column; gap: 7px; }
.uc-sd-panel-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--uc-muted); font-size: 9.5px; font-weight: 620; }
.uc-sd-panel-title span { color: var(--uc-faint); font-weight: 500; font-size: 9.5px; }
.uc-sd-cachebar, .uc-req-cachebar > .uc-sd-cachebar { display: flex; width: 100%; height: 10px; border-radius: 999px; overflow: hidden; background: var(--uc-track); }
.uc-sd-cachebar span, .uc-req-cachebar .uc-sd-cachebar span { display: block; height: 100%; min-width: 0; }
.uc-sd-cachebar .cache, .uc-req-cachebar .cache { background: var(--uc-green); }
.uc-sd-cachebar .input, .uc-req-cachebar .input { background: var(--uc-blue); }
.uc-sd-cachebar .write, .uc-req-cachebar .write { background: #8b5cf6; }
.uc-sd-cachebar .output, .uc-req-cachebar .output { background: #f59e0b; }
.uc-sd-legend { display: flex; flex-wrap: wrap; gap: 5px 10px; color: var(--uc-faint); font-size: 9.5px; }
.uc-sd-legend span { display: inline-flex; align-items: center; gap: 4px; }
.uc-sd-legend i { width: 6px; height: 6px; border-radius: 2px; display: inline-block; }
.uc-sd-legend i.cache { background: var(--uc-green); }
.uc-sd-legend i.input { background: var(--uc-blue); }
.uc-sd-legend i.write { background: #8b5cf6; }
.uc-sd-legend i.output { background: #f59e0b; }
.uc-sd-legend b { color: var(--uc-muted); font-weight: 620; font-variant-numeric: tabular-nums; }
.uc-sd-latency { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.uc-sd-latency span { min-width: 0; padding: 5px 3px; border-radius: 6px; background: var(--uc-card); text-align: center; }
.uc-sd-latency b { display: block; color: var(--uc-strong); font-size: 11.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.uc-sd-latency small { display: block; color: var(--uc-faint); font-size: 8px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uc-sd-strip { display: flex; align-items: flex-end; gap: 2px; height: 44px; padding: 2px 0; }
.uc-sd-strip-col { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; background: var(--uc-green); opacity: 0.85; }
.uc-sd-strip-col[data-tone="warn"] { background: var(--uc-amber); }
.uc-sd-strip-col[data-tone="low"] { background: var(--uc-red); }
/* 费用瀑布（0.5）：可点击的回合费用柱 */
.uc-cost-col { background: color-mix(in srgb, var(--uc-accent) 68%, var(--uc-card)); cursor: pointer; transition: opacity 0.12s ease; }
.uc-cost-col:hover, .uc-cost-col:focus-visible { opacity: 1; outline: 1px solid color-mix(in srgb, var(--uc-accent) 55%, transparent); }
.uc-cost-col[data-tone="amber"] { background: var(--uc-amber); }
.uc-sd-strip-note { color: var(--uc-faint); font-size: 9.5px; }
.uc-toolstats { display: flex; flex-direction: column; gap: 3px; }
.uc-toolstat { display: grid; grid-template-columns: minmax(54px, 88px) minmax(0, 1fr) auto; align-items: center; gap: 6px; font-size: 9.5px; }
.uc-toolstat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.uc-toolstat-bar { height: 3px; border-radius: 999px; background: var(--uc-track); overflow: hidden; }
.uc-toolstat-bar i { display: block; height: 100%; border-radius: inherit; background: color-mix(in srgb, var(--uc-accent) 68%, var(--uc-card)); }
.uc-toolstat-count { color: var(--uc-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.uc-toolstat-count em { font-style: normal; color: var(--uc-red); }
.uc-sd-filter { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.uc-sd-filter .uc-search { max-width: 440px; }
.uc-sd-filter-note { color: var(--uc-faint); font-size: 10px; }
.uc-sd-more { align-self: center; height: 28px; }
.uc-sd-more:disabled { opacity: 0.55; }
.uc-sd-timeline { position: relative; display: flex; flex-direction: column; gap: 6px; padding-left: 26px; }
.uc-sd-timeline::before {
  content: "";
  position: absolute;
  left: 8px;
  top: 14px;
  bottom: 14px;
  width: 1.5px;
  border-radius: 2px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--uc-accent) 30%, transparent), color-mix(in srgb, var(--uc-border) 80%, transparent));
}
.uc-turn { position: relative; border: 1px solid var(--uc-border); border-radius: 10px; background: var(--uc-card); overflow: hidden; }
.uc-turn-rail {
  position: absolute;
  left: -25px;
  top: 0;
  bottom: 0;
  width: 25px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15px;
  pointer-events: none;
}
.uc-turn-node {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--uc-green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-green) 16%, transparent);
}
.uc-turn-node[data-tone="warn"] { background: var(--uc-amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-amber) 16%, transparent); }
.uc-turn-node[data-tone="low"] { background: var(--uc-red); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-red) 16%, transparent); }
.uc-turn-node[data-tone="danger"] { background: var(--uc-red); box-shadow: 0 0 0 3px color-mix(in srgb, var(--uc-red) 20%, transparent); }
.uc-turn-open > .uc-turn-rail .uc-turn-node { box-shadow: 0 0 0 4px color-mix(in srgb, var(--uc-accent) 22%, transparent); }
.uc-turn-head { width: 100%; display: flex; align-items: center; gap: 9px; padding: 8px 10px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
.uc-turn-head:hover { background: color-mix(in srgb, var(--uc-accent) 4%, transparent); }
.uc-turn-order { flex: 0 0 auto; min-width: 24px; color: var(--uc-accent); font-size: 10px; font-weight: 720; font-variant-numeric: tabular-nums; }
.uc-turn-time { flex: 0 0 auto; color: var(--uc-faint); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.uc-turn-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.uc-turn-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-strong); font-size: 10.5px; font-weight: 560; }
.uc-turn-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-faint); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.uc-turn-meta em { font-style: normal; margin-left: 6px; color: var(--uc-red); }
.uc-turn-bar { flex: 0 0 72px; height: 5px; display: flex; overflow: hidden; border-radius: 999px; background: var(--uc-track); }
.uc-turn-bar i { display: block; height: 100%; }
.uc-turn-bar i.cache { background: var(--uc-green); }
.uc-turn-bar i.input { background: var(--uc-blue); }
.uc-turn-bar i.write { background: #8b5cf6; }
.uc-turn-bar i.output { background: #f59e0b; }
.uc-turn-duration { flex: 0 0 54px; text-align: right; color: var(--uc-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.uc-turn-cost { flex: 0 0 44px; text-align: right; color: var(--uc-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.uc-chevron { width: 11px; height: 11px; flex: 0 0 auto; color: var(--uc-faint); transition: transform 0.15s ease; }
.uc-turn-open > .uc-turn-head .uc-chevron { transform: rotate(90deg); }
.uc-turn-body { border-top: 1px solid var(--uc-border); padding: 9px 10px 11px; display: flex; flex-direction: column; gap: 8px; background: color-mix(in srgb, var(--uc-layer) 40%, transparent); }
.uc-prompt { border-left: 2px solid var(--uc-accent); padding: 1px 0 2px 9px; }
.uc-prompt-head { display: flex; align-items: center; gap: 7px; color: var(--uc-faint); font-size: 9.5px; }
.uc-prompt-label { color: var(--uc-accent); font-weight: 700; }
.uc-prompt-text { margin-top: 3px; white-space: pre-wrap; word-break: break-word; color: var(--uc-strong); font-size: 10.2px; line-height: 1.5; max-height: 260px; overflow: auto; }
.uc-prompt-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.uc-tag { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1px 5px; border-radius: 4px; font-size: 9.5px; background: var(--uc-layer-2); color: var(--uc-faint); }
.uc-tag.file { color: var(--uc-blue); background: color-mix(in srgb, var(--uc-blue) 8%, transparent); }
.uc-tag.agent { color: var(--uc-accent); background: color-mix(in srgb, var(--uc-accent) 8%, transparent); }
.uc-note { margin-top: 4px; color: var(--uc-faint); font-size: 9.5px; }
.uc-req { border: 1px solid var(--uc-border); border-radius: 8px; background: var(--uc-card); overflow: hidden; }
.uc-req[open] { border-color: color-mix(in srgb, var(--uc-accent) 18%, var(--uc-border)); }
.uc-req > summary { list-style: none; }
.uc-req > summary::-webkit-details-marker { display: none; }
.uc-req-head { display: flex; align-items: center; gap: 8px; min-height: 31px; padding: 5px 9px; cursor: pointer; color: inherit; font-size: 10px; font-variant-numeric: tabular-nums; }
.uc-req-head:hover { background: color-mix(in srgb, var(--uc-accent) 4%, transparent); }
.uc-req[open] > .uc-req-head .uc-chevron { transform: rotate(90deg); }
.uc-req-order { flex: 0 0 auto; color: var(--uc-accent); font-weight: 680; }
.uc-req-model { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; overflow: hidden; color: var(--uc-muted); white-space: nowrap; }
.uc-req-model i { width: 16px; height: 16px; border-radius: 4px; display: grid; place-items: center; flex: 0 0 auto; background: color-mix(in srgb, var(--uc-accent) 9%, transparent); color: var(--uc-accent); font-size: 7.5px; font-weight: 750; font-style: normal; }
.uc-req-model span { overflow: hidden; text-overflow: ellipsis; }
.uc-req-model em { flex: 0 0 auto; font-style: normal; font-size: 8px; color: var(--uc-faint); background: var(--uc-layer-2); padding: 0 3px; border-radius: 3px; }
.uc-req-agent { flex: 0 0 auto; color: var(--uc-faint); font-size: 9.5px; }
.uc-req-tools { flex: 0 0 auto; color: var(--uc-faint); font-size: 9.5px; }
.uc-turn-actions { display: flex; align-items: center; gap: 6px; margin-top: -2px; }
.uc-turn-actions > span { flex: 1; color: var(--uc-faint); font-size: 9.5px; }
.uc-turn-actions .uc-sd-mini { height: 23px; font-size: 9.5px; }
.uc-req-lat { flex: 0 0 auto; color: var(--uc-faint); font-size: 9.5px; }
.uc-req-tokens { flex: 0 0 auto; color: var(--uc-muted); }
.uc-req-cache { flex: 0 0 48px; text-align: right; font-weight: 640; }
.uc-req-cache[data-tone="ok"], .uc-req-cache-note b[data-tone="ok"] { color: var(--uc-green); }
.uc-req-cache[data-tone="warn"], .uc-req-cache-note b[data-tone="warn"] { color: var(--uc-amber); }
.uc-req-cache[data-tone="low"], .uc-req-cache-note b[data-tone="low"] { color: var(--uc-red); }
.uc-req-cost { flex: 0 0 44px; text-align: right; color: var(--uc-faint); }
.uc-req-body { border-top: 1px solid var(--uc-border); padding: 8px 9px 10px; display: flex; flex-direction: column; gap: 8px; }
.uc-req-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); gap: 4px; }
.uc-req-metrics > span { min-width: 0; padding: 5px 4px; border-radius: 6px; background: var(--uc-layer); text-align: center; }
.uc-req-metrics b { display: block; color: var(--uc-strong); font-size: 10.5px; font-weight: 640; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uc-req-metrics small { display: block; color: var(--uc-faint); font-size: 8px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uc-req-cachebar { display: flex; align-items: center; gap: 9px; }
.uc-req-cachebar > .uc-sd-cachebar { flex: 1; height: 8px; }
.uc-req-cache-note { flex: 0 0 auto; color: var(--uc-faint); font-size: 9.5px; white-space: nowrap; }
.uc-req-cache-note b { font-weight: 650; }
.uc-req-error { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; border-radius: 6px; background: color-mix(in srgb, var(--uc-red) 7%, transparent); color: var(--uc-red); font-size: 10px; line-height: 1.4; }
.uc-req-error b { flex: 0 0 auto; }
.uc-reasoning { border: 1px dashed var(--uc-border); border-radius: 7px; background: var(--uc-layer); }
.uc-reasoning > summary { padding: 5px 8px; color: var(--uc-faint); font-size: 9.5px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.uc-reasoning > summary span { color: var(--uc-muted); font-variant-numeric: tabular-nums; }
.uc-reasoning > summary em { font-style: normal; color: var(--uc-amber); }
.uc-reasoning[open] > summary { border-bottom: 1px dashed var(--uc-border); }
.uc-pre-reasoning { border: 0; border-radius: 0 0 7px 7px; }
.uc-req-text { display: flex; flex-direction: column; gap: 3px; }
.uc-req-text-head { color: var(--uc-faint); font-size: 9.5px; }
.uc-req-text-body { white-space: pre-wrap; word-break: break-word; color: var(--uc-strong); font-size: 10.2px; line-height: 1.55; max-height: 360px; overflow: auto; padding: 7px 9px; border-radius: 7px; background: var(--uc-card); border: 1px solid var(--uc-border); }
.uc-tools { display: flex; flex-direction: column; gap: 4px; }
.uc-tools-head { display: flex; align-items: center; gap: 5px; color: var(--uc-faint); font-size: 9.5px; }
.uc-tools-head b { color: var(--uc-muted); font-weight: 650; }
.uc-tool { border: 1px solid var(--uc-border); border-radius: 6px; background: var(--uc-card); overflow: hidden; }
.uc-tool-error { border-color: color-mix(in srgb, var(--uc-red) 24%, var(--uc-border)); }
.uc-tool > summary { list-style: none; }
.uc-tool > summary::-webkit-details-marker { display: none; }
.uc-tool-head { display: flex; align-items: center; gap: 6px; min-height: 26px; padding: 4px 7px; font-size: 9.5px; font-variant-numeric: tabular-nums; cursor: pointer; }
.uc-tool-head:hover { background: color-mix(in srgb, var(--uc-accent) 4%, transparent); }
.uc-tool[open] > .uc-tool-head .uc-chevron { transform: rotate(90deg); }
.uc-tool-state { width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto; background: var(--uc-green); }
.uc-tool-state[data-tone="warn"] { background: var(--uc-amber); }
.uc-tool-state[data-tone="danger"] { background: var(--uc-red); }
.uc-tool-name { flex: 0 0 auto; color: var(--uc-strong); font-weight: 640; }
.uc-tool-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--uc-faint); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.uc-tool-duration { flex: 0 0 auto; color: var(--uc-faint); }
.uc-tool-status { flex: 0 0 auto; padding: 1px 4px; border-radius: 3px; font-size: 8px; font-weight: 620; color: var(--uc-green); background: color-mix(in srgb, var(--uc-green) 8%, transparent); }
.uc-tool-status[data-tone="warn"] { color: var(--uc-amber); background: color-mix(in srgb, var(--uc-amber) 9%, transparent); }
.uc-tool-status[data-tone="danger"] { color: var(--uc-red); background: color-mix(in srgb, var(--uc-red) 8%, transparent); }
.uc-tool-body { border-top: 1px solid var(--uc-border); padding: 7px; display: flex; flex-direction: column; gap: 4px; }
.uc-tool-label { color: var(--uc-faint); font-size: 9.5px; display: flex; align-items: center; gap: 5px; }
.uc-tool-label.uc-danger { color: var(--uc-red); }
.uc-tool-cut { color: var(--uc-amber); font-size: 8px; }
.uc-pre { margin: 0; padding: 6px 7px; border: 1px solid var(--uc-border); border-radius: 5px; background: var(--uc-layer); color: var(--uc-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.uc-pre-output { max-height: 300px; }
/* 统一复制块（P0）：长内容折叠 + 一键复制，复制的是预览内容并明确标注 */
.uc-copy { position: relative; }
.uc-copy-btn {
  position: absolute;
  top: 5px;
  right: 5px;
  z-index: 1;
  height: 20px;
  padding: 0 7px;
  border: 1px solid var(--uc-border);
  border-radius: 4px;
  background: var(--uc-card);
  color: var(--uc-faint);
  font: inherit;
  font-size: 9px;
  font-weight: 560;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.uc-copy:hover .uc-copy-btn, .uc-copy-btn:focus-visible { opacity: 1; }
.uc-copy-btn:hover { color: var(--uc-strong); border-color: color-mix(in srgb, var(--uc-accent) 40%, var(--uc-border)); }
.uc-copy-label {
  display: block;
  margin-bottom: 3px;
  color: var(--uc-faint);
  font-size: 9px;
  font-weight: 600;
}
.uc-pre-error { color: var(--uc-red); background: color-mix(in srgb, var(--uc-red) 5%, var(--uc-layer)); }
.uc-tool-foot { color: var(--uc-faint); font-size: 10px; }
.uc-sd-error { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--uc-red) 24%, var(--uc-border)); border-radius: 8px; background: color-mix(in srgb, var(--uc-red) 6%, transparent); color: var(--uc-red); font-size: 9.5px; }
.uc-sd-error b { flex: 0 0 auto; }
.uc-sd-error span { flex: 1; min-width: 0; }
.uc-sd-empty { padding: 30px 10px; text-align: center; color: var(--uc-faint); font-size: 10px; display: flex; flex-direction: column; gap: 4px; }
.uc-sd-empty b { color: var(--uc-muted); font-size: 12px; }
.uc-sd-skeleton { display: flex; flex-direction: column; gap: 9px; }
.uc-sd-skeleton-card { border: 1px solid var(--uc-border); border-radius: 9px; background: var(--uc-card); padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 130px; }
.uc-sd-skeleton-card.uc-skeleton { min-height: 130px; }
.uc-sd .uc-skeleton { border: 1px solid var(--uc-border); background: var(--uc-card); }
@container (max-width: 900px) {
  .uc-sd-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .uc-req-lat, .uc-req-agent { display: none; }
  .uc-turn-bar { display: none; }
  .uc-turn-time { display: none; }
  .uc-sd-timeline { padding-left: 20px; }
  .uc-turn-rail { left: -19px; width: 19px; }
}
@media (max-width: 900px) {
  .uc-sd-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .uc-req-lat, .uc-req-agent { display: none; }
  .uc-turn-bar { display: none; }
}
`
