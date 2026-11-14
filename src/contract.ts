import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

/** Aggregated token counters. Cache is split out so a 4.6B cache read never hides the real input volume. */
export const TokenTotals = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
})

export const Range = Schema.Struct({
  from: Schema.Number,
  to: Schema.Number,
})

export const SeriesPoint = Schema.Struct({
  /** Local date, `YYYY-MM-DD`. */
  date: Schema.String,
  requests: Schema.Number,
  cost: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
})

export const ModelRow = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  requests: Schema.Number,
  cost: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
})

export const Latency = Schema.Struct({
  /** Number of completed assistant messages with usable timestamps. */
  samples: Schema.Number,
  /** First streamed event minus request start, in seconds. */
  ttftP50: Schema.Number,
  ttftP95: Schema.Number,
  /** Request start to completion, in seconds. */
  totalP50: Schema.Number,
  totalP95: Schema.Number,
  /** Fraction of requests slower than 30 seconds, 0..1. */
  slowRate: Schema.Number,
  /** Output tokens divided by total request seconds. */
  tokensPerSecond: Schema.Number,
  maxTotal: Schema.Number,
})

export const LatencyModelRow = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  samples: Schema.Number,
  ttftP50: Schema.Number,
  ttftP95: Schema.Number,
  totalP50: Schema.Number,
  totalP95: Schema.Number,
  slowRate: Schema.Number,
  tokensPerSecond: Schema.Number,
})

export const ProjectRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  directory: Schema.String,
  lastActive: Schema.Number,
})

/**
 * 成本归因行（0.5）：按 agent（build / explore / general…）聚合的用量。
 * 与 ModelRow 同构，方便复用渲染；agent 为 `unknown` 时表示消息未标注。
 */
export const AgentRow = Schema.Struct({
  agent: Schema.String,
  requests: Schema.Number,
  cost: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
})

export const SessionRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  projectID: Schema.String,
  modelID: Schema.String,
  providerID: Schema.String,
  cost: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})

/** 项目维度的成本归因行（0.5）：projectID 关联 ProjectRow 取显示名。 */
export const ProjectUsageRow = Schema.Struct({
  projectID: Schema.String,
  requests: Schema.Number,
  cost: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
})

export const SessionToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** `completed`, `error` or `running`. */
  status: Schema.String,
  /** Tool execution time in seconds. */
  duration: Schema.Number,
  /** One-line input preview for the collapsed row. */
  summary: Schema.String,
  /** Truncated JSON input, enough to inspect the call without loading huge payloads. */
  input: Schema.String,
  /** Truncated tool output; may be empty for tools that only mutate state. */
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  error: Schema.String,
  exitCode: Schema.optional(Schema.Number),
})

export const SessionRequest = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
  /** Request start, milliseconds since epoch. */
  time: Schema.Number,
  agent: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.String,
  finish: Schema.String,
  cost: Schema.Number,
  tokens: TokenTotals,
  /** Time to first streamed byte, in seconds. */
  ttft: Schema.Number,
  /** Request start to completion, in seconds. */
  total: Schema.Number,
  error: Schema.String,
  text: Schema.String,
  textTruncated: Schema.Boolean,
  reasoning: Schema.String,
  reasoningTruncated: Schema.Boolean,
  tools: Schema.Array(SessionToolCall),
})

export const SessionTurn = Schema.Struct({
  /** 1-based prompt order inside the session. */
  index: Schema.Number,
  seq: Schema.Number,
  time: Schema.Number,
  prompt: Schema.String,
  promptTruncated: Schema.Boolean,
  files: Schema.Array(Schema.String),
  agents: Schema.Array(Schema.String),
  requests: Schema.Array(SessionRequest),
  cost: Schema.Number,
  tokens: TokenTotals,
  toolCount: Schema.Number,
  errorCount: Schema.Number,
  /** Prompt start to the last request completion, in seconds. */
  duration: Schema.Number,
  /** Average time to first token across this turn's requests. */
  ttft: Schema.Number,
  /** Cache reads divided by cache reads plus uncached input, 0..1. */
  cacheHit: Schema.Number,
})

export const SessionDetail = Schema.Struct({
  found: Schema.Boolean,
  id: Schema.String,
  title: Schema.String,
  projectID: Schema.String,
  projectName: Schema.String,
  directory: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  agent: Schema.String,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
  cost: Schema.Number,
  tokens: TokenTotals,
  turns: Schema.Array(SessionTurn),
  totalTurns: Schema.Number,
  hasMore: Schema.Boolean,
  /** Pass as `beforeTurn` to load the previous page; 0 when there is no more. */
  nextBefore: Schema.Number,
  promptCount: Schema.Number,
  requestCount: Schema.Number,
  toolCount: Schema.Number,
  errorCount: Schema.Number,
  ttftP50: Schema.Number,
  ttftP95: Schema.Number,
  totalP50: Schema.Number,
  totalP95: Schema.Number,
  slowRate: Schema.Number,
  cacheHit: Schema.Number,
  generatedAt: Schema.Number,
})

export const SessionDetailInput = Schema.Struct({
  sessionID: Schema.String,
  /** Load only turns before this 1-based index. Omit for the latest page. */
  beforeTurn: Schema.optional(Schema.Number),
  /** Page size in turns; defaults to 60. */
  limit: Schema.optional(Schema.Number),
  force: Schema.optional(Schema.Boolean),
})

export const CredentialRow = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  /** Credential `integration_id`, e.g. `opencode-go`; matches the quota provider id. */
  integrationID: Schema.String,
  /** `oauth`, `key` or `external`. */
  type: Schema.String,
  /** Milliseconds since epoch; absent for keys without an expiry. */
  expires: Schema.optional(Schema.Number),
  active: Schema.Boolean,
})

/**
 * One quota window. Providers differ wildly: OpenCode Go has three windows
 * (rolling / weekly / monthly), Trae has one credit pool, Qoder has a plan
 * allowance plus an add-on pool. The GUI renders whatever meters arrive, so a
 * new provider only has to build meters rather than reshape the schema.
 */
export const Meter = Schema.Struct({
  /** Stable within a provider: `rolling`, `weekly`, `monthly`, `credits`, `addOnQuota`. */
  id: Schema.String,
  label: Schema.String,
  /** Used share, 0–100. */
  percent: Schema.Number,
  /** Absolute amount consumed, when the provider exposes it. */
  used: Schema.optional(Schema.Number),
  /** Absolute allowance, when the provider exposes it. */
  limit: Schema.optional(Schema.Number),
  /** `credits`, `usd`, `requests`, `percent`. */
  unit: Schema.optional(Schema.String),
  /** Milliseconds since epoch. Absent when the provider exposes no reset. */
  resetsAt: Schema.optional(Schema.Number),
  /** Provider-reported throttle / exhaustion. */
  limited: Schema.optional(Schema.Boolean),
})

export const QuotaProvider = Schema.Struct({
  /** Credential `integration_id`: `opencode-go`, `trae-cn`, `trae-cn-ent`, `qoder`. */
  id: Schema.String,
  /** Display name. */
  name: Schema.String,
  /** `zen/go`, `trae`, `qoder`, `none`. */
  source: Schema.String,
  available: Schema.Boolean,
  /** Empty on success. */
  error: Schema.String,
  /** Plan label as the provider names it: `Credits`, `Free`, `personal_standard`. */
  plan: Schema.optional(Schema.String),
  /** Shown in place of meters when the account exposes no numbers (e.g. enterprise tenants). */
  note: Schema.optional(Schema.String),
  meters: Schema.Array(Meter),
})

export const Quota = Schema.Struct({
  /** True when at least one provider returned live data. */
  available: Schema.Boolean,
  /** Empty when any provider is live; otherwise why nothing could be read. */
  error: Schema.String,
  providers: Schema.Array(QuotaProvider),
})

export const DatabaseInfo = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  ok: Schema.Boolean,
  error: Schema.String,
})

export const Snapshot = Schema.Struct({
  generatedAt: Schema.Number,
  range: Range,
  database: DatabaseInfo,
  /** Aggregation sample sizes, so the UI can say "样本不足" instead of faking precision. */
  samples: Schema.Struct({
    /** Completed assistant messages with usable latency timestamps. */
    latency: Schema.Number,
    /** Sessions included in the range aggregate. */
    sessions: Schema.Number,
    /** Day buckets the series covers; below the full range means the DB has less history. */
    days: Schema.Number,
    /** The requested range exceeded the safety cap and was clipped. */
    truncated: Schema.Boolean,
  }),
  totals: Schema.Struct({
    requests: Schema.Number,
    sessions: Schema.Number,
    prompts: Schema.Number,
    activeDays: Schema.Number,
    cost: Schema.Number,
    tokens: TokenTotals,
  }),
  series: Schema.Array(SeriesPoint),
  models: Schema.Array(ModelRow),
  latency: Latency,
  latencyModels: Schema.Array(LatencyModelRow),
  projects: Schema.Array(ProjectRow),
  sessions: Schema.Array(SessionRow),
  credentials: Schema.Array(CredentialRow),
  /** 0.5 成本归因：按 agent 与按项目的用量聚合（范围同 totals）。 */
  agents: Schema.Array(AgentRow),
  projectUsage: Schema.Array(ProjectUsageRow),
})

export const SnapshotInput = Schema.Struct({
  from: Schema.Number,
  to: Schema.Number,
  /** Filter to one project. Omit for all projects. */
  projectID: Schema.optional(Schema.String),
  /** Skip the short server-side cache. */
  force: Schema.optional(Schema.Boolean),
})

export const QuotaInput = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
})

/** The server half of the plugin. The GUI calls these methods through `ctx.client.rpc(Usage)`. */
const portableInput = Schema.toStandardSchemaV1(SnapshotInput)
const portableSnapshot = Schema.toStandardSchemaV1(Snapshot)
const portableQuotaInput = Schema.toStandardSchemaV1(QuotaInput)
const portableQuota = Schema.toStandardSchemaV1(Quota)
const portableSessionDetailInput = Schema.toStandardSchemaV1(SessionDetailInput)
const portableSessionDetail = Schema.toStandardSchemaV1(SessionDetail)

export const Usage = Rpc.define({
  id: "usage-center",
  methods: {
    snapshot: { input: portableInput, output: portableSnapshot },
    quota: { input: portableQuotaInput, output: portableQuota },
    sessionDetail: { input: portableSessionDetailInput, output: portableSessionDetail },
  },
  events: {},
})

export type Snapshot = typeof Snapshot.Type
export type SnapshotInput = typeof SnapshotInput.Type
export type Meter = typeof Meter.Type
export type QuotaProvider = typeof QuotaProvider.Type
export type Quota = typeof Quota.Type
export type TokenTotals = typeof TokenTotals.Type
export type SeriesPoint = typeof SeriesPoint.Type
export type ModelRow = typeof ModelRow.Type
export type Latency = typeof Latency.Type
export type LatencyModelRow = typeof LatencyModelRow.Type
export type ProjectRow = typeof ProjectRow.Type
export type AgentRow = typeof AgentRow.Type
export type ProjectUsageRow = typeof ProjectUsageRow.Type
export type SessionRow = typeof SessionRow.Type
export type SessionToolCall = typeof SessionToolCall.Type
export type SessionRequest = typeof SessionRequest.Type
export type SessionTurn = typeof SessionTurn.Type
export type SessionDetail = typeof SessionDetail.Type
export type SessionDetailInput = typeof SessionDetailInput.Type
export type CredentialRow = typeof CredentialRow.Type
