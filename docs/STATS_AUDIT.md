# 核心统计指标口径审计表

> 统计口径统一批次（任务 1）交付物。审计范围：`src/server/store.ts`（唯一后端聚合源）、
> `src/gui/page.tsx`、`src/gui/session-detail.tsx`、`src/gui/format.ts`（前端展示层）、
> `src/contract.ts`（wire 契约）。数据语义结论全部经真实 DB（63k+ 消息）验证。

## 1. Token 统计

| 指标 | 当前计算位置 | 当前计算方式 | 是否冲突 | 建议统一方式 |
|---|---|---|---|---|
| Input Tokens | `store.ts aggregateDay` (L697)；`sessionRequest` (L1591) | `$.tokens.input`，缺失按 0 | 否 | 后端单源，前端只展示 |
| Output Tokens | 同上 (L698) | `$.tokens.output`，缺失按 0 | 否 | 同上 |
| Reasoning Tokens | 同上 (L699) | `$.tokens.reasoning`，独立字段 | **口径决策点 R1** | 保持独立字段；是否计入「有效 Token」待确认 |
| Cache Read | 同上 (L700) | `$.tokens.cache.read`，独立字段，不入总量 | 否 | 保持独立（4.6B 级缓存读不能淹没真实输入） |
| Cache Write | 同上 (L701) | `$.tokens.cache.write`，独立字段 | 否 | 同上 |
| 有效 Token（KPI） | 前端 4 处重复：`page.tsx sumTokens` (L67)、`tokens()` (L2768)、`session-detail.tsx tokenCount` (L47)、`AttributionCard share` (L2477) | 一律 `input + output` | 否（值一致）**但实现重复** | 收敛到 `gui/metrics.ts` 单一函数（任务 2 已做） |
| Total Tokens | 无「全字段相加」的总量指标 | 契约中 `TokenTotals` 是分字段结构 | 否 | 保持分字段；避免制造歧义总量 |

**R1（reasoning 口径，需确认后才改）**：真实 DB 证实 `reasoning` **不包含**在 `output` 里
（存在 output=0 且 reasoning=64000 的行；reasoning 总量为 output 的 166%）。
当前「有效 Token = input + output」**不计入 reasoning**——思考密集型模型的真实输出被低估。
 UI 仅在会话详情堆叠条中以「输出 + 推理」并列展示。若要改为 `input + output + reasoning`，
影响所有 Token KPI、趋势图、模型占比，属用户可见口径变更，**等待确认，本批未动**。

**字段缺失统一性**：125 行 assistant 消息缺整个 `tokens` 对象 → `num()` 全部按 0，
与缺单字段行为一致。无「按模型不同处理」的差异。

## 2. Cost 统计

| 指标 | 当前计算位置 | 当前计算方式 | 是否冲突 | 建议统一方式 |
|---|---|---|---|---|
| Total Cost | `aggregateDay` (L696) `cost += rowCost` | 直接读 OpenCode 记录值 `$.cost`，**不自算** | 否 | 保持读取优先 |
| Session Cost | `aggregateDay sessions` (L724)；会话详情 `Σ request.cost` (L1522) | 两条独立路径，同一数据源同一加法 | 否（对账断言已加） | 一致性测试覆盖 |
| Project Cost | `snapshot` 内从 `total.sessions` 按 `sessionProject` 归组 (L1278-1294) | 每会话唯一归入一个项目桶 | 否 | 对账：Σ 项目 = 总费用（测试断言） |
| Model Cost | `aggregateDay models` 按 `providerID\0modelID` (L735) | 每行唯一归入一个模型桶 | 否 | 对账：Σ 模型 = 总费用（测试断言） |
| Agent Cost | `aggregateDay agents` (L704) | 每行唯一归入一个 agent 桶 | 否 | 对账：Σ agent = 总费用（测试断言） |
| 0 与缺失的区分 | 均落为 0 | 真实 DB：cost 缺失 125 行、=0 58555 行（订阅内）、>0 4592 行 | **口径决策点 C1** | 保持现状 + UI 已有「$0 可能是订阅内调用」说明 |
| 汇总精度 | float64 累加 | 50k 会话规模测试中相对误差 < 1e-12 | 否 | 保持 float64；断言用 1e-6 容差 |

**C1（0 与缺失）**：区分二者需要在 wire 契约中增加「样本数」或「缺失计数」字段，
属于数据结构变更。当前 UI 已通过 `$0` 角标说明覆盖歧义。**记录，等待确认，本批未动**。

## 3. 请求与会话统计

| 指标 | 定义（已统一） | 计算位置 | 备注 |
|---|---|---|---|
| Request | 一条 assistant 消息 = 一次模型调用 | `aggregateDay` (L694-695) | user 行不计 requests |
| Prompt | 一条 user 消息 | `aggregateDay` (L683-686) | |
| Turn | 一条 user 消息 + 其后全部 assistant 请求（会话详情分页单位） | `sessionDetail` (L1447-1486) | 仅会话详情使用 |
| Session 数 | 范围聚合内出现过的不同 sessionID 数 | `Object.keys(total.sessions).length` (L1306) | 只有 user 消息、无 assistant 的空会话不计入（口径备注） |
| Session 列表 | `session_v2.time_updated` 落在范围内，按最后活动排序，**LIMIT 500** | `snapshot` (L1236-1244) | 列表 cost/token 取范围内聚合值（`usage` map），非 `session_v2` 生命周期总列——与 totals 同口径 |
| activeDays | series 中 requests > 0 的天数 | (L1268、1308) | |

## 4. 时间与性能指标

| 指标 | 定义 | 无效数据处理 | 备注 |
|---|---|---|---|
| 首字时延 ttft | `time.streamed − time.created`（秒） | 缺 streamed → ttft=0 → 剔出样本（真实 DB 33449 行） | `latencyStats`：`total ≥ 0.05s` 才算可用样本 |
| 总时延 total | `time.completed − time.created`（秒） | 缺 completed（13 行）→ total=0 → 剔出 | |
| P50/P95 | nearest-rank（`sorted[floor(n·p)]`） | — | 确定性、无插值 |
| 慢请求 slowRate | total > 30s 占比 | — | 阈值固定 |
| 输出速度 | Σoutput ÷ Σtotal（可用样本） | — | |
| 会话时长 | 末请求完成 − 首条 user 消息时间 | `max(0, …)` | |
| 日界 | 本地日历日，DST 安全 `[from, to)` | — | 上一批已修 |

## 5. 归因规则审计

| 维度 | 规则（现状，均已验证一致） | 结论 |
|---|---|---|
| 项目 | `sessionProject`：sessionID → projectID，单会话单桶；无项目 → 空串桶（UI 显示「未命名项目」）；跨天会话跨日聚合时首见项目优先 | 无重复归因；对账 Σ 项目 = 总费用 ✅ |
| 模型 | key = `providerID\0modelID`：**同 modelID 不同 provider 分行**（真实 DB 有 7 个同名模型跨 2-3 个 provider），unknown 单独成桶 | 无错误合并 ✅。备注：Sessions 页模型筛选按 modelID（跨 provider 合并筛选），与模型列表分行口径不同但符合钻取语义——**记录不改** |
| Agent | `$.agent` 缺失 → `unknown` 桶保留；每行只归一个 agent | 对账 ✅ |
| 未知/缺失数据 | 缺 model/provider（0 行）→ `unknown`；缺 agent（0 行）→ `unknown`；缺项目 → 空桶；缺 tokens/cost → 0 | 无静默丢弃 ✅ |

**已发现的展示层不一致（任务 2/4 修复项）**：会话详情中 CacheBar 的 token 堆叠含
cacheWrite，而「回合 Token 柱状图」(session-detail.tsx L863) 漏加 cacheWrite——同一页面
两个图对「回合总 Token」口径不同。已统一到 `gui/metrics.ts`。

## 6. 跨页面对账结论

| 关系 | 结论 |
|---|---|
| Overview / Analytics(时延) / Sessions / Accounts 的总量 | 四个页签消费**同一个** snapshot 对象（单次 `api.snapshot`），数值天然一致 ✅ |
| Session 列表行 cost vs Session Replay cost | 同数据源（`$.cost`）两条独立路径；Replay 是**完整历史**、列表行是**范围内聚合**——跨范围边界的会话二者不同**属设计**且有 UI 文案说明（「完整历史（不受统计时间范围限制）」） |
| Accounts（额度）与本地统计 | 完全隔离：`quota()` 走 Provider 独立接口（Go/Trae/Qoder），meters 单位为 credits/percent/usd，**不与本地 $ 汇总相加**，卡片独立展示 ✅ |
| 订阅额度 vs 实际消费 | UI 文案明确「按量计费 · 不含订阅内调用与未记录价格的请求」✅ |

## 7. 时间范围与过滤规则

| 项 | 现状 | 结论 |
|---|---|---|
| 默认范围 | `format.ts rangeBounds`：today=本地日历日、7d/30d=滚动窗口、all=0→now；全部页签共用 | 统一 ✅ |
| 页面级过滤 | Sessions 页的项目/模型/日期筛选与搜索**只过滤 500 条列表**，不影响 totals；文案已说明 | 统一 ✅ |
| 分页 | 渲染分页（visibleCount），不影响汇总 | ✅ |
| 缓存键 | 前端 `VIEW_CACHE` 键 = range+scope；后端快照缓存键 = from/to/project | 范围变化正确区分 ✅ |

## 8. 本批依据审计结论执行的改动

1. **任务 2**：新增 `src/gui/metrics.ts`——「有效 Token」与「缓存命中率」两个重复计算
   的公式的单一来源；前端 5 处调用点收敛；回合柱状图漏 cacheWrite 一并修复。
2. **任务 6**：`check-synthetic.ts` 新增对账场景——Σ模型=Σagent=Σ项目=总费用、
   Token 对账、会话列表行 vs 会话详情（同一会话跨路径 cost/token 相等）、
   跨 provider 同名模型不合并、unknown 桶保留；15b 单会话单模型最小用例、
   15c 无 model 字段消息进 unknown 模型桶、15d 分页 Replay 各页之和 = 整会话。
3. **任务 3/4/5**：审计确认现有实现已满足要求，无代码改动，本文档即审计结论。
4. **任务 7**：改动后复跑 `test:scale` 与 `test:data` 对比基线（见执行报告）。

### 8.1 审计后追加修复（24b5570）

补测试缺口时发现**真实产品 bug：跨数据库磁盘缓存污染**——逐日缓存文件按
`<scope>/<date>.json` 命名，两个不同数据库（换机器、重建 DB、测试临时库）
读同一 scope/日期会互相拿到对方的聚合；消息数与 time_updated 总和恰好一致时
指纹校验也无法察觉。修复：缓存目录嵌入数据库身份（路径 sha1 前 12 位 + 文件大小），
重建后的同路径库也会得到独立目录。

**等待确认的口径决策（本批未动）**：R1（reasoning 是否计入有效 Token）、
C1（$0 与缺失 cost 的区分）、Sessions 页模型筛选是否改为 provider+modelID 精确匹配。
