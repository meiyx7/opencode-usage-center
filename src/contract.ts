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

export const CredentialRow = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  /** `oauth`, `key` or `external`. */
  type: Schema.String,
  /** Milliseconds since epoch; absent for keys without an expiry. */
  expires: Schema.optional(Schema.Number),
  active: Schema.Boolean,
})

export const Bucket = Schema.Struct({
  percent: Schema.Number,
  limited: Schema.Boolean,
  resetsAt: Schema.Number,
})

export const Quota = Schema.Struct({
  available: Schema.Boolean,
  /** `zen/go`, `console` or `none`. */
  source: Schema.String,
  /** Empty on success. */
  error: Schema.String,
  workspace: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.String),
      usageURL: Schema.optional(Schema.String),
    }),
  ),
  rolling: Schema.optional(Bucket),
  weekly: Schema.optional(Bucket),
  monthly: Schema.optional(Bucket),
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
  totals: Schema.Struct({
    requests: Schema.Number,
    sessions: Schema.Number,
    prompts: Schema.Number,
    activeDays: Schema.Number,
    streak: Schema.Number,
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

export const Usage = Rpc.define({
  id: "usage-center",
  methods: {
    snapshot: { input: portableInput, output: portableSnapshot },
    quota: { input: portableQuotaInput, output: portableQuota },
  },
  events: {},
})

export type Snapshot = typeof Snapshot.Type
export type SnapshotInput = typeof SnapshotInput.Type
export type Quota = typeof Quota.Type
export type TokenTotals = typeof TokenTotals.Type
export type SeriesPoint = typeof SeriesPoint.Type
export type ModelRow = typeof ModelRow.Type
export type Latency = typeof Latency.Type
export type LatencyModelRow = typeof LatencyModelRow.Type
export type ProjectRow = typeof ProjectRow.Type
export type SessionRow = typeof SessionRow.Type
export type CredentialRow = typeof CredentialRow.Type
