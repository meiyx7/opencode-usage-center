# 核心统计指标口径审计表

> 统计口径统一批次（任务 1）交付物。审计范围：`src/server/store.ts`（唯一后端聚合源）、
> `src/gui/page.tsx`、`src/gui/session-detail.tsx`、`src/gui/format.ts`（前端展示层）、
> `src/contract.ts`（wire 契约）。数据语义结论全部经真实 DB（63k+ 消息）验证。

## 1. Token 统计

| 指标 | 当前计算位置 | 当前计算方式 | 是否冲突 | 建议统一方式 |
|---|---|---|---|---|
| Input Tokens | `store.ts aggregateDay` (L697)；`sessionRequest` (L1591) | `$.tokens.input`，缺失按 0 | 否 | 后端单源，前端只展示 |
| Output Tokens | 同上 (L698) | `$.tokens.output`，缺失按 0 | 否 | 同上 |
| Reasoning Tokens | 同上 (L699) | `$.tokens.reasoning`，独立字段 | 否（R1 已确认） | 保持独立字段，不计入「有效 Token」 |
| Cache Read | 同上 (L700) | `$.tokens.cache.read`，独立字段，不入总量 | 否 | 保持独立（4.6B 级缓存读不能淹没真实输入） |
| Cache Write | 同上 (L701) | `$.tokens.cache.write`，独立字段 | 否 | 同上 |
| 有效 Token（KPI） | 前端 4 处重复：`page.tsx sumTokens` (L67)、`tokens()` (L2768)、`session-detail.tsx tokenCount` (L47)、`AttributionCard share` (L2477) | 一律 `input + output` | 否（值一致）**但实现重复** | 收敛到 `gui/metrics.ts` 单一函数（任务 2 已做） |
| Total Tokens | 无「全字段相加」的总量指标 | 契约中 `TokenTotals` 是分字段结构 | 否 | 保持分字段；避免制造歧义总量 |

**R1（reasoning 口径，已确认现行规则）**：真实 DB 证实 `reasoning` **不包含**在 `output` 里
（存在 output=0 且 reasoning=64000 的行；reasoning 总量为 output 的 166%）。
**已确认：有效 Token = input + output，不计入 reasoning**——reasoning 独立字段保留，
UI 在会话详情堆叠条中以「输出 + 推理」并列展示，供需要时人工合并阅读。

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
| 0 与缺失的区分 | 均落为 0 | 真实 DB：cost 缺失 125 行、=0 58555 行（订阅内）、>0 4592 行 | 否（C1 已确认） | 保持现状 + UI 已有「$0 可能是订阅内调用」说明 |
| 汇总精度 | float64 累加 | 50k 会话规模测试中相对误差 < 1e-12 | 否 | 保持 float64；断言用 1e-6 容差 |

**C1（0 与缺失，已确认现行规则）**：**已确认：Cost 缺失与 Cost 为 0 均按 0 处理，
不做缺失推算**（不按模型单价反推）。区分二者需要 wire 契约增加「样本数」或
「缺失计数」字段，属数据结构变更，确认不实施。UI 已通过 `$0` 角标说明覆盖歧义。

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

## 8. 依据审计结论执行的改动

1. **任务 2**：新增 `src/gui/metrics.ts`——「有效 Token」与「缓存命中率」两个重复计算
   的公式的单一来源；前端全部调用点收敛（首轮 5 处、评审后含 TrendChart 等 10 处）；
   回合柱状图漏 cacheWrite 一并修复。
2. **任务 6**：`check-synthetic.ts` 对账场景——Σ模型=Σagent=Σ项目=总费用、
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

## 9. R1 / C1 / C2 统计口径（已确认的现行规则）

> 2026-11-15 产品侧确认，本节原「分析与推荐」中的开放问题已关闭。分析数据
> （真实 DB 证据、影响范围评估）保留作为口径依据。

### R1：Reasoning Token 不计入有效 Token（已确认）

**现行规则**：有效 Token = input + output；reasoning 是独立字段，不参与任何
汇总 KPI，仅在会话详情堆叠条中并列展示。

**口径依据**（真实 DB 验证）：OpenCode 消息的 tokens 对象中 `output` 与
`reasoning` 是**并列的独立字段**，reasoning 不包含在 output 里——证据：
- 35218 行含非零 reasoning；其中 reasoning > output 的有 17119 行（存在
  output=0 而 reasoning=64000 的极端样本），output > reasoning 的有 18022 行
- reasoning 总量是 output 总量的 166%，若已含在 output 内不可能超过 100%

**已评估不采用的方案**：计入 reasoning（input + output + reasoning）会让所有
Token KPI、趋势图、模型占比上升约 +37%（取决于模型构成），且该口径已用于多个
已发布版本的展示。确认维持现状；聚合时字段独立保留，未来如需重算可随时切换。

### C1：Cost 缺失与 Cost 为 0 均按 0 处理（已确认）

**现行规则**：两者都按 0 处理，不做缺失推算，不新增 missingCost 计数字段。

**口径依据**：真实 DB 分布：缺失 125 行（0.2%）、=0 58555 行（92%）、
>0 4592 行（7%）。二者语义不同（=0 是订阅内/免费调用，缺失是老版本未写或
计费未完成），但缺失按 0 不会让总额偏大（宁小不大），符合「缓存永不偏大」
的既有原则。UI 已通过 `$0` 角标说明覆盖歧义。

**已评估不采用的方案**：在 Snapshot.samples 或 ModelRow 里加 `missingCost`
计数（wire 契约新字段）+ UI 提示「N 条请求未记录费用」。确认不实施——
0.2% 的缺失占比不值得一次契约变更。

### C2：Sessions 模型筛选按 modelID 匹配（已确认）

**现行规则**：Sessions 页模型筛选下拉只按 `modelID` 匹配
（`session.modelID !== modelFilter()`），不精确到 Provider。

**口径依据**：模型统计按 `providerID\0modelID` 分行，但 Sessions 筛选改组合键
会改变下拉交互与钻取语义（同名模型跨 Provider 会被一起筛出——真实 DB 有
7 个同名模型跨 2-3 个 Provider，如 deepseek-v4.1-flash 同名 3 个 Provider、
11543 条消息）。确认接受这一近似：筛选行为保持简单，模型页的精确归因
（provider+model 分行）不受影响。

**已评估不采用的方案**：筛选标识改为 `providerID:modelID` 组合并显示 provider
名（SessionRow 已携带两个字段，纯前端改动）。确认不实施。

## 10. 评审任务遗留修复记录

- **性能测试内存测量**（评审一轮任务 1）：改子进程隔离 + 平台单位换算 +
  基线/峰值/增量三项报告；发现并绕过 Bun `-e` 长脚本静默不执行的坑（改独立 worker 文件）。
- **独立预期值对账**（评审一轮任务 1）：数据构造时独立累计 7 个 token/cost 分量与
  三维度费用，子进程内与统计结果对账。
- **DST 多时区**（评审一轮任务 2）：纽约/伦敦 DST 缝隙 + 上海普通日期 + 月末年末对，
  旧实现敏感度验证通过（NY 与 London 各漏 1 条/多 1 条）。
- **前端公式收敛**（评审一轮任务 4）：metrics.ts 扩展 pointTokens/sessionTokens/
  agentTokens/projectUsageTokens/pointCacheHit，page.tsx 全部 10 处内联公式收敛；
  「有效 Token」口径说明文字（glossary）不属于公式，保留原文。
- **R1/C1/C2 分析**（评审一轮任务 6）：见 §9；2026-11-15 产品侧已确认三项
  均维持现状口径，分析中的推荐项（reasoning 计入、missingCost 计数、provider
  精确筛选）确认不实施。

## 11. 评审二轮修复记录（08a88fa 复审意见）

- **维度逐 Key 对账**（二轮 P0）：一轮实现在 `expected` 里用 `Map` 存维度预期，
  `JSON.stringify` 序列化为 `{}`，且 worker 未读取——三维度对账当时只验证了
  「Σ维度 = 总额」的自洽，不能证明每笔费用归属正确。修复：预期值改普通对象
  （cost 与有效 Token 各一份），worker 对模型（键含 provider）、agent、项目
  三维度逐 Key 比较，双向检查多余/缺失 Key；并做了敏感度验证（把模型键故意
  降级为 modelID-only 时对账立即失败，报多余+缺失）。
- **内存高水位差**（二轮 P1）：统计阶段增量改为「统计前 maxRSS − 全部统计
  步骤结束后 maxRSS」，不再与当前 RSS 相减（运行时启动峰值会污染旧口径）。
  报告四项：启动基线 RSS、基线高水位、统计后高水位、统计阶段增量。
- **数据库身份键增强**（二轮 P1）：dbCacheKey 从 `path:size` 升级为
  `path:dev:ino:size`——同路径重建出恰好同大小的库时旧键会碰撞。新增 11c
  回归：重建库用同一 seedMain 造（600 条消息、等长字符串、相同时间戳，
  mtime/指纹/大小全部与旧库一致，只换 cost 值），断言重建库读到自己的
  $54 而不是旧库的 $6；敏感度验证：退回 size-only 键时测试失败（读到 $15.98
  的脏混合值）。mtime 不参与身份键：每次写库都会变，会打穿缓存。
- **前端公式彻底收敛**（二轮 P1）：AttributionCard `share()` 的 Token 分母改走
  `effectiveTokens`；`cacheDeltaOf` 周期命中率改「先累计 input/cacheRead 再调
  `cacheHitRate`」；`pointCacheHit` 委托 `cacheHitRate`，不再各自实现公式。
- **规模测试命令**（二轮 P1）：`npm run test:scale -- medium` 实际会把 medium
  追加在 base 后面（argv[2] 仍是 base）。新增独立脚本 `test:scale:medium` /
  `test:scale:large` / `test:scale:all`，CI 注释同步更正。

## 13. 第二批：会话回放真分页（阶段 A 服务端实现）

- **汇总与回合页分离**（TASK-01）：`sessionDetail` 拆为两条独立数据路径——
  `buildSessionSummary`（全会话 KPI：cost、五 Token 分量、请求数、回合数、
  工具数、错误数、TTFT/总时延 P50/P95、慢请求比例、缓存命中率）与
  `buildTurnPage`（按 seq 游标只读取、解析当前页消息）。汇总走轻量 SQL 聚合
  （`json_extract` 提取 assistant data 顶层标量 + `json_valid` 守门单条坏 JSON
  按 0 计入 + `COALESCE` 保持 num() 缺失即 0 语义）；分位数对 SQL 提取出的
  样本数组沿用原 `percentile`（精确口径，未改近似）。工具数/工具错误数嵌套在
  content 数组内，SQLite 不可靠数嵌套数组，退化为 JS 轻量计数（只读状态字段，
  不构建 SessionRequest/SessionToolCall 对象）。
- **seq 游标真分页**（TASK-02）：游标是 1-based 回合序号（`beforeTurn`，RPC
  契约不变）。服务端把它翻译为消息 seq 开区间上界：`beforeTurn ≤ totalTurns`
  取该回合起始 seq；省略/超出取 `MAX(seq)+1`。页起点由 user 边界探测
  （倒序取 limit+1 个 `(session_id,type,seq)` 索引查询）得出，本页消息才解析
  正文。回合全局序号 = 游标前回合总数 − 页内回合数 + 1（头部合成回合占
  index 1，保持「会话开始」行为与旧终止语义：合成回合页 hasMore=false）。
  真实库索引核查：`PRAGMA index_list` 确认 OpenCode 已有
  `session_message_session_seq_idx` 与 `session_message_session_type_seq_idx`，
  全部页查询 `EXPLAIN QUERY PLAN` 均为 SEARCH/COVERING（未创建任何索引——
  插件只读）。合成测试库 schema 补齐同款复合索引。
- **服务端缓存瘦身**（TASK-03）：`sessionCache` 从缓存完整 SessionDetail
  （全部回合正文/思考/工具输出）改为只缓存 SessionSummary（轻量 KPI 对象），
  LRU 4 个 + TTL 60s + force 刷新语义保留；回合页每次请求现读现建，缓存命中
  时仍返回正确汇总。Revert 后旧回合不再驻留缓存（缓存对象不含回合）。
- **对账验证**：新旧实现在真实库 444 个会话全字段逐一对账（found/title/cost/
  五 Token 分量/回合数/提问数/请求数/工具数/错误数/四个分位数/慢请求率/缓存
  命中率/模型/agent/时间戳/全部回合摘要）完全一致；首例发现的 errorCount 口径
  差（旧=请求错误+工具错误，新 SQL 只数请求错误）已修复（补工具错误计数）。
- **真分页证据**（TASK-05E 前置）：`buildTurnPage` 将单页读取消息数暴露到
  `globalThis.__ucPageReads`（生产无消费者）；合成测试 15e 构造 220 回合复杂
  会话（头部合成回合/一 user 多 assistant/工具错误/缺 cost/坏 JSON/尾部无回复
  user），断言单页读取 ≤ 130 行、页链排序后序号连续 1..totalTurns、Σ页 cost =
  汇总 cost、缓存命中/force 刷新行为。敏感度验证：把页查询退化为全会话读取
  （模拟旧实现）时 4 处断言立即失败。
- **阶段 A 复审修正**（4 项，2026-11-15 复审意见）：
  1. 坏 JSON 请求数（P1）：requestCount 原取 `aggRows.length`，json_valid 过滤
     让坏 JSON 行少算——旧实现 parseJSON 失败仍构造全 0 请求计入。改为独立
     `COUNT(*)` assistant 总数；费用/Token/时延聚合保持 json_valid 过滤（坏行
     贡献 0，语义一致）。敏感度：误用过滤行数时 15e 断言失败。
  2. 页大小边界（P1）：头部合成回合 + 恰好 limit 个 user 边界会让页装下
     limit+1 个回合。修正为覆盖到头会超限时把头部让位给下一页（pageStartSeq
     抬到第 limit 个边界），与旧实现尾部切片行为一致（61 回合会话首页装
     index 2..61，终止页只剩合成回合 index 1）。新增 15f：59/60/61 user 边界 ×
     有/无头部合成回合，6 用例全断言每页 ≤ 60、序号连续无重复、nextBefore
     合法。敏感度：去掉让位逻辑时边界断言立即失败。
  3. 覆盖索引（P2）：边界探测查询去掉未使用的 `time_created` 列——该列不在
     复合索引中，会退化为非覆盖扫描。修正后全部 6 条页查询 EXPLAIN QUERY
     PLAN：3 个 COVERING INDEX + 2 个 SEARCH（session_seq / session_type_seq）。
  4. 万回合长会话（P2 → 提前）：15g 构造 10,000 回合（20,000 消息）：
     首屏 17ms 只读取 120 行（旧实现需全读 20,000 行），全链 167 页每页读取
     ≤ 120 行，Σ页 cost = 汇总 = 独立预期（1e-9）。
- **Revert 后汇总刷新机制说明**：汇总缓存 TTL 60 秒 + 前端「刷新」按钮
  force=true + onMount 重载。Revert 删消息后最多 60 秒内汇总自动过期重算；
  用户手动刷新立即生效。与旧实现（缓存完整详情同样 60s TTL）行为一致，
  且新实现的缓存不含回合正文，旧回合不可能从缓存复读。

## 14. 阶段 A 收尾（复审第二批意见，TASK-06～09）

- **工具统计 SQL 化**（TASK-06）：`buildSessionSummary` 的工具数/工具错误数
  从「JS 读全部 assistant data 逐条解析」改为单条 SQL——`json_each` 展开
  content 数组，`json_type` 守门（坏 JSON / content 缺失 / 非数组 / 空数组
  一律按 0），`state.status='error' OR state.error IS NOT NULL` 与旧 JS 口径
  一致。SQLite 内部仍解析 JSON（全会话统计扫描必要的结构化数据，可接受），
  但正文/思考/工具输入输出不再传入 JS。同一 DB 快照（`.backup` 含 WAL）下
  新旧实现 1759 请求逐字段一致（真实活跃会话——此前 444 会话对比出现
  差异是因为两次导出之间库被写入，非口径漂移）。
- **分阶段读取量探针**（TASK-07）：`parseJSON` 增加 `__ucReadProbe`（JSON.parse
  次数 + 字节数）、分页计数器扩展 bodyBytes（本页传给 JS 的 data 总字节）、
  `__ucSummaryProbe` 记录汇总结构化扫描行数。15g 升级：每条 assistant 带
  ~6KB 正文/思考/工具内容，10,000 回合断言——汇总阶段正文传入 JS 恒 0 字节、
  首屏 JSON 解析 120 次 0.4MB（全会话 ~7.4MB 的 5%）、汇总结构化扫描 40,000 行
  （aggRows 10,000 + json_each 展开 30,000，如实记录——SQLite 需要扫描才能
  聚合，但正文不进 JS）。
- **Revert 缓存失效**（TASK-08）：SDK 事件核查确认存在
  `session.revert.committed` / `session.revert.cleared` / `session.deleted`
  （payload 带 sessionID），无 message 级删除事件——能力边界：消息级 Revert
  通过 revert.committed 覆盖。实现最小方案：session-detail.tsx 导出
  `invalidateDetailCache(id?)`（清前端 DETAIL_CACHE 对应会话，普通打开/翻页/
  刷新不动其他会话）与 `markSessionReverted(id)`（脏标记单例）；page.tsx
  事件订阅新增三个类型，命中即失效+标记；详情页打开时消费脏标记——视为
  未缓存 + 首次 load force=true 跳过服务端汇总 TTL。TTL 保留为兜底。
- **查询计划自动化回归**（TASK-09）：15h 在含真实 schema 复合索引的 fixture
  上对 7 条核心 SQL 断言 EXPLAIN QUERY PLAN——命中预期索引（SEARCH/COVERING）、
  无 `SCAN session_message`、无 `USE TEMP B-TREE`，共 21 条断言进 CI。索引
  缺失的兼容性：断言针对 fixture（与真实库结构一致），插件运行时不创建/
  修改索引，真实库退化时插件仍可用。敏感度验证：从 fixture 移除复合索引
  → 18 处断言立即失败。

## 15. 阶段 A 最终补丁（TASK-10～12）

- **Revert 事件订阅提前返回修复**（TASK-10）：订阅从 onMount 的 `cachedFresh`
  早退之后移到之前——缓存命中跳过初始请求是优化，但事件订阅不能跟着跳过，
  否则缓存展示期间的 Revert 无人感知。新增 `session.deleted` 处理：失效对应
  缓存 + `sessionGone` 信号（UI 显示「会话已删除」，load 短路不再请求，组件
  保持打开由用户手动退出）；`revert.committed` → 失效 + force 刷新；
  `revert.cleared` → 不动作（未截断回合，数据未变，避免重复请求）。事件
  分支提取为导出纯函数 `handleDetailEvent`（TASK-11 测试共用），AbortController
  + onCleanup 清理保留。
- **前端事件行为测试**（TASK-11）：15j 验证 `handleDetailEvent` 全部分支
  （committed → 失效+刷新；cleared → 均不动作；deleted → 失效+标记删除；
  其他 sessionID → 全部不动作），以及订阅生命周期（mock 事件源 + abort 后
  消费循环退出 = 组件卸载清理语义）。断言有效性用故意失败注入验证。
- **工具统计 SQL 共用**（TASK-12）：`SESSION_PAGE_SQLS.toolStats` 提取，
  生产查询与 15h EXPLAIN 引用同一份文本。全部 8 条核心查询的索引断言
  统一要求 `SEARCH ... USING INDEX`（不再只匹配索引名）；工具聚合需回表读
  data 参与 json_extract → 非 COVERING（如实断言 SEARCH），`SCAN je` 是
  json_each 虚拟表展开，由「无全表扫描」正则区分。敏感度：移除复合索引
  → 16 处断言失败；错误谓词退化为 IS NOT NULL → errorCount 断言失败。

## 16. 阶段 A 最终补丁二（TASK-13：删除事件竞态收口）

- **in-flight 请求失效**：`session.deleted` 到达时（markGone 动作）递增
  `request` 计数——先前已发出的 load/loadMore 响应回来后 `id !== request`
  判定失效，不再 setDetail/remember，已删除会话的数据不会重新写进前端缓存。
- **`loadMore` 收口**：入口加 `sessionGone()` 判断；响应返回后同样二次检查；
  「加载更早」按钮在删除状态下 disabled。
- **消费循环终止**：`consumeDetailEvents`（从组件 onMount 提取的导出函数，
  供测试直连）在 markGone 后 break——删除后的会话不会再有 revert 语义，
  也杜绝误触 forceReload。
- **15j 补强**：从「分支返回值」升级为「动作计数」——完整事件序列
  （cleared → committed → 他会话 committed → deleted → 后续 committed）验证
  invalidate=2 / forceReload=1 / markGone=1；无限事件源 + 卸载 abort 验证
  消费终止。敏感度：移除 markGone-break → 计数断言立即失败。

## 17. 阶段 B 第一轮（TASK-14：前端分页数据流核查与适配）

- **核查结论**：首屏/加载更多均只处理服务端返回页（无全量解析路径）；
  `mergeTurns` 以 index 为键合并（后者胜出）+ 升序输出——重复回合天然去重、
  顺序不反转；`openTurns` 展开状态以全局稳定 index 为键，加载更多后保留；
  搜索（`visibleTurns`）与导出（CSV/JSON）同源已加载回合；文案已标明
  「匹配 X / 已加载 Y」。
- **游标无进展防护**（本轮唯一代码修正）：loadMore 响应的首回合 index
  ≥ 本页游标（nextBefore）时，说明没有取到更早回合——再合并会原样返回，
  用户重试仍请求同一页（无限加载）。判定无进展直接终止分页
  （hasMore=false, nextBefore=0），并**保留 current 回合数据不动**：
  无进展意味着新页没有可信的更早数据，不执行 merge，避免异常响应污染
  已加载集合（回合对象保持原引用）。
- **loadMore 调用链提取**（复审收尾）：`canLoadMore`（入口守卫）、
  `loadMoreProgress`（游标判定）、`applyLoadMoreResult`（响应归并）三个
  导出函数被组件 loadMore 与 15k 测试共用——测试驱动的是生产代码路径，
  不是复刻逻辑。
- **15k 数据流回归**：`mergeTurns`/`withTurns` 纯函数覆盖合并去重
  （重叠 index 后者胜出）、升序输出、hasMore/nextBefore 语义；
  `loadMoreProgress` 四场景直测（正常下一页 / 空页 / 游标持平 /
  游标倒退）；最小合成回合页覆盖无进展保留引用与有进展合并；
  220 回合 fixture 走完整调用链——首屏 60 回合后连续三次 loadMore
  （canLoadMore 守卫 → beforeTurn 请求 → 归并），断言请求次数、每页
  仅追加、游标前移、四页合计 220、序号连续 1..220、cost 全量对账；
  到达终点后守卫拒绝再次请求，重复页响应终止分页且不额外请求。
  10k 长会话规模验证明确留在 TASK-17 性能验收（原注释误写 10k，已更正）。

## 12. 评审三轮收尾记录（509c6ba 复审意见）

- **RSS 单位换算**（三轮 P1-1）：`process.memoryUsage.rss()` 本身返回 bytes，
  一轮实现误让它再过一遍 `toBytes`，Linux 下重复 ×1024（CI 日志出现 48284MB
  的假基线）。修复：`rssNow()` 直接返回 rss()，仅 `maxRSS` 走平台换算。
  新增 4 条内存单位断言（bytes 量级上界、高水位单调不减、增量非负）；
  敏感度验证：模拟 Linux 重复换算形态时断言立即失败（baselineRss 越界 +
  stageDelta 异常），exit 1。
- **生成数据时间边界**（三轮 P1-2）：会话起点分布 `[now-span, now]`、消息
  正向偏移最多 ≈6.1 小时，起点贴近当前时刻的消息会落在未来。真实种子下
  实测：Medium 1 条、Large 7 条未来消息（Base 0）——当前未失配是因为
  store 对「今天」聚合整个本地日桶，未来但同日的消息侥幸仍被计入；跨过
  本地午夜就会与全量累计的 expected 失配。修复：起点整体回退安全边界
  （最大偏移 + 36 小时天界余量），保证所有消息 ≤ 昨天；生成期加自检，
  任何未来消息直接抛错。三档数据仍可复现（边界不含随机量）。
- **缓存身份键移除 size**（三轮 P1-3，评估后实施）：size 参与身份让 DB 随
  正常写入增长时 key 不断漂移——真实库已复现（一天内出现孤儿目录
  `fca152fd6d7e-all`、30 个逐日缓存文件作废重算）。身份键改为
  `path:dev:ino`：重建识别交给 inode，内容修改交给逐日指纹，size 不再
  提供增量信息。11c 回归的构造（同大小 + 同指纹 + 不同 inode）恰好成为
  新键的最强验证；敏感度验证：退化为 path-only（无 inode）时 11c 失败
  （读到 $15.98 脏混合值）。mtime 继续排除（每次写库都变，会打穿缓存）。

## 18. 阶段 B 第二轮（TASK-15：搜索与导出范围核查）

- **搜索范围（TASK-15.1）**：`visibleTurns` 已改为调用导出的
  `filterTurnsByQuery(detail().turns, query)`——搜索只在当前已加载回合内
  过滤，不存在全量历史读取路径；loadMore 更新 `detail()` 后，新增回合自动
  进入搜索范围；清空/空白关键词返回全部已加载回合。匹配字段覆盖提示词、
  附件名、Agent、模型/供应商、回复、思考、工具名/摘要/输入/输出/错误，
  大小写不敏感、中文与特殊字符按字面匹配。
- **搜索索引生命周期**：索引仍是 `WeakMap<SessionTurn, string>`，以回合
  对象为键。刷新/翻页/重新加载产生新对象即重新建索引，旧对象随 GC 回收；
  15l 用同 index、不同内容的两个对象验证「旧关键词不再命中、新关键词
  命中」，排除旧缓存串味。
- **CSV 范围（TASK-15.2）**：`exportCsv` 与测试共用 `buildCsvRows` /
  `buildCsvText`，数据源唯一为 `visibleTurns()`（已加载 + 当前搜索条件）。
  字段、列顺序（`CSV_HEADER`）、UTF-8 BOM、LF 行尾、`csvCell` 引号转义与
  公式注入防护均保持原样；无搜索导出全部已加载回合，有搜索只导出命中项。
- **JSON 范围与脱敏（TASK-15.3）**：`exportJson` 与测试共用
  `buildJsonPayload(current, visibleTurns(), full)`，与 CSV 同源。默认脱敏
  保持不变：剥离 prompt / text / reasoning / 工具 input-output-error 与
  附件名，保留 model/provider/agent/计数/Token/时延等元数据；完整模式保留
  全部内容。脱敏通过新建对象实现，15l 对导出前后的回合对象做 JSON 快照
  全等断言，确认页面数据与后续导出不被污染。
- **15l 自动化回归（TASK-15.4）**：纯函数覆盖 13 个搜索字段、空/空白/
  无匹配/清空、索引生命周期、CSV 表头与转义、JSON 脱敏/完整/不变性；
  220 回合真实分页 fixture（60/页）覆盖首屏 60、第二页 120、第三页 180、
  第四页 220 的搜索与导出数量、标记跨页进入范围、连续加载后序号 1..220
  不重不漏、终点 CSV/JSON 与回合逐项一致；搜索与导出调用前后
  `__ucPageReads.messages` 不变，证明不会隐式触发历史分页读取。
- **UI 文案**：搜索框 aria-label / placeholder 明确为「搜索已加载回合」；
  结果提示保持「匹配 X / 已加载 Y 个回合」，不暗示全会话搜索。CSV 按钮
  title 已按「当前搜索匹配的已加载回合 / 已加载的回合」区分。
- **敏感度验证**：搜索条件被忽略 → 搜索与导出断言失败；脱敏分支恒走完整
  模式 → 脱敏断言失败；JSON 忽略传入回合改用 `current.turns` → 过滤导出
  失败；`stripRequest` 删除原请求 text → 回合快照不变性失败；CSV 忽略传入
  回合 → CSV 行数与内容断言失败。恢复后全绿。
- **未改动**：服务端分页算法、统计口径（R1/C1/C2）、Schema/索引、会话
  列表 500 条限制、搜索匹配规则、脱敏规则、导出格式/字段、依赖与版本号。

## 19. 阶段 B 第三轮（TASK-16.1：首次加载与会话切换）

- **现状结论**：当前 UI 上切换会话必然经过 `undefined`（`Show when={props.selected}`
  只在列表与详情之间切换），`SessionDetailView` 会被销毁重建，A 的旧响应落在
  A 自己的信号与 A 的缓存 key 上——**未发现可复现的串会话缺陷**。但代码依赖
  两个未防护的隐含假设：`Show` 在条件仍为真时不重建 children（同一实例
  `props.session` 变化时会带着旧 `detail` 去加载新会话），以及服务端响应
  一定属于请求的会话（`remember` 以载荷 id 为缓存 key）。
- **加固**：`load` / 刷新 / 重试 / Revert 强刷提取到导出的
  `createDetailLoader`（组件与 16m 测试共用同一实现）。提交前依次判定
  `stale`（更新一代已发出）→ `gone`（已删除）→ `switched`（发起请求的会话
  已不是当前会话）→ `mismatch`（响应 id 与请求会话不一致）；只有全部通过
  才 `setDetail` + `remember`，因此「旧响应覆盖新会话」「旧响应串写别会话
  缓存」在结构上不可能发生。结束加载态只允许最新一代请求执行，旧请求晚返回
  不会清掉新请求的 `refreshing`。
- **缓存探针**：导出 `rememberDetail` / `readDetailCache`，供测试断言缓存
  写入与隔离（`DETAIL_CACHE` 仍最多 4 条、仍按会话 id 分槽，容量与淘汰策略
  未变）。
- **16m 自动化回归**（Deferred 精确控制返回顺序，驱动上述生产路径）：
  - a：两个实例（重建路径）A 挂起、B 先回、A 后回 → B 视图只提交一次且不被
    覆盖；A/B 缓存各自为自身载荷，无第三会话 key；两者加载态都恢复。
  - b：同一实例 `props.session` A→B 后 A 才返回 → 判 `switched`，不提交、
    不写任何缓存。
  - c：切换后 B 先回、A 后回 → A 判 `stale`，B 保持，只写入 B 缓存。
  - d：响应 id 与请求会话不一致 → 判 `mismatch`，不提交，A/B 缓存都为空
    （证明不会按载荷 id 串写）。
  - f：A 在途时切到 B 并发起 B 请求，A 先回 → 不提交、不清 B 的
    `refreshing`；B 回来后正常恢复。
- **覆盖层级**：未挂载 SolidJS 组件（不新增依赖），测试驱动的是组件实际调用
  的请求协调、提交判定与缓存写入路径，不是组件 E2E，也不是独立 helper 的
  返回值复刻。真实 `Show` 重建时机与真实 RPC 时序仍不在自动化范围内。
- **敏感度验证**：去掉会话一致性判定 → 16m-b 判 `ok` 并提交/写缓存；
  去掉响应 id 判定 → 16m-d 提交并把 B 载荷写入 B 缓存；去掉 generation 判定
  → 16m-c 旧响应不再判 `stale`；去掉缓存写入 → 16m-a/16m-c 隔离断言拿不到
  数据；`finally` 无条件清 `refreshing` → 16m-f 加载态被旧请求清掉。恢复后
  全绿。
- **未改动**：服务端分页算法、R1/C1/C2 口径、会话列表 500 条限制、Schema/
  索引、搜索与导出行为、UI 结构、依赖与版本号。`loadMore` 的并发/重复页/
  失败恢复留到 TASK-16.2，Revert/Delete 事件竞态留到 TASK-16.3。

## 20. 阶段 B 第四轮（TASK-16.2：刷新与加载更多并发）

- **现状结论**：16.1 把 `load` / 刷新收进 `createDetailLoader`（generation +
  会话 + 响应 id 判定，只有最新代能收尾），`loadMore` 仍是组件内联：只读取
  `loader.generation` 且**不递增**，响应回来只判 `id !== generation` 与
  `sessionGone()`，`catch` 无条件写 `error`、`finally` 无条件清 `loadingMore`，
  `rememberDetail(merged)` 按载荷 id 分槽。执行前审计列出 7 类竞态
  （`docs/TASK16_ASYNC.md` §4.2 D1–D7）：同实例切换时旧分页追加到新会话并按
  A 的 id 写缓存；响应 id 串包写错缓存槽；过期/删除/切换后的失败污染新视图；
  旧分页清掉新请求 `loadingMore`；两次分页之间无请求身份隔离；发起时快照
  覆盖较新结果；卸载后仍写缓存（留 16.4）。正常分页判定本身未发现缺陷。
- **加固**：`loadMore()` 纳入 `createDetailLoader`，组件按钮与 16n 测试调用
  同一入口。ticket 记录主 `generation` + 独立 `moreGeneration` + 请求会话；
  `checkpointMore` 依次判 `stale`（主代 / 分页代）→ `gone` → `switched`，
  `commitMore` 再校验响应 id 与当前 detail 归属会话，通过后按**提交时刻的最新
  detail** 走生产 `applyLoadMoreResult` 并写视图 / 缓存。`catch` 只在该请求仍
  是最新且属于当前会话时写 `error`；`finally` 只由最新分页代清 `loadingMore`。
  入口守卫仍是 `canLoadMore`（删除 / 无更早 / 加载中 / 刷新中 / 其他请求在途），
  新增 reason `skipped` 表示守卫拦下、未发请求；`isRefreshing` /
  `isLoadingMore` / `setLoadingMore` 由组件信号注入，UI、文案与游标语义未变。
- **16n 自动化回归**（Deferred 精确控制返回顺序，113 条断言语句，驱动上述
  生产路径）：
  - `a`：同一会话连续刷新，#1 晚于 #2 返回 → #1 判 `stale`，视图与缓存只留
    #2，提交次数 1，加载态恢复。
  - `b` / `m`：loadMore 在途同实例切到 B（未发新请求）→ 判 `switched`，A
    分页不追加、A/B 缓存都不写；重建路径下 A 分页只落 A 实例与 A 缓存，
    B 视图只提交一次，无第三会话 key。
  - `c` / `d`：连续两次 loadMore → 第二次判 `skipped`、只发一请求；
    loadMore 与刷新并发 → 刷新提交、旧分页判 `stale`、游标不被旧页推进，
    `loadingMore` / `refreshing` 均恢复。
  - `e` / `f` / `g` / `l`：重复页、空页、游标倒退页一律保留已有回合对象、
    终止分页（`hasMore=false` / `nextBefore=0`）、守卫拒绝后续请求；连续两页
    正常加载时 157–162 无重复无乱序、游标单调前移。
  - `h` / `i` / `j`：loadMore 失败后 `loadingMore` 恢复、已有数据与缓存不变、
    重试成功且只追加一次；连续刷新中旧刷新失败不写错误、不破坏新刷新；
    过期 loadMore 失败判 `stale` 且错误态保持为空。
  - `k`：loadMore 响应 id 与会话不一致 → 判 `mismatch`，不提交、不写 B 缓存。
  - `o1` / `o2`：构造两次 loadMore 生命周期交叠，旧分页先回 / 晚回均判
    `stale`，只追加一次、提交次数 2；旧请求不得清掉新请求的 `loadingMore`。
- **缓存隔离与失效验证**：所有 16n 用例开始时 `invalidateDetailCache()` 清空
  模块级 `DETAIL_CACHE`；断言均读真实 `readDetailCache`。切换 / 过期 / 响应
  id 不匹配 / 失败路径下缓存条目不被创建或不被改写；正常与无进展路径下缓存
  回合数与视图逐项一致；`m` 验证 A、B 各自缓存分槽且无第三 key。缓存容量
  （4 条）与淘汰策略未改，本轮未做容量压力验证。
- **覆盖层级**：未挂载 SolidJS 组件（不新增依赖）。测试驱动的是组件实际调用
  的 `createDetailLoader.load()` / `.loadMore()`、入口守卫、归并函数与真实缓存
  写入，不是组件 E2E，也不是独立 helper 的返回值复刻。真实 `Show` 重建 /
  卸载时机、真实 RPC 时序、按钮 `disabled` 的 DOM 表现不在自动化范围内。
- **敏感度验证**（逐项削弱生产判定 → 对应用例失败 → 全部恢复后重跑全绿）：
  | 削弱项 | 检出用例 | 失败断言数 |
  | --- | --- | --- |
  | 去掉会话一致性判定 | 16n-b | 4 |
  | 去掉响应 id 判定 | 16n-k | 4 |
  | 去掉主 `generation` 判定 | 16n-d | 7 |
  | 去掉 `moreGeneration` 判定 | 16n-o1 / o2 | 6 |
  | `catch` 无条件 `setError` | 16n-j | 2 |
  | `finally` 无条件清 `loadingMore` | 16n-o1 | 1 |
  | 去掉 `commitMore` 缓存写入 | 16n-m / c / l / h | 6 |
- **本地全套验收**（本轮代码，全部通过）：`typecheck` ✓；`build` ✓
  （vite 220.35 kB / esbuild 74.2 kB）；`test:plugin` wire ✓；`test:synthetic` ✓
  （10000 回合首屏 339ms、全链 167 页 55223ms、单页最大读取 120 行）；
  三档规模回归 ✓（base 冷 76ms / 峰值 74MB，medium 430ms / 165MB，
  large 1613ms / 402MB，独立预期值与三维度对账全部一致）。
- **未改动**：服务端分页算法、R1/C1/C2 统计口径、会话列表 500 条限制、
  Schema/索引、搜索与导出行为、UI 结构与文案、`canLoadMore` 守卫语义、
  `loadMoreProgress` / `applyLoadMoreResult` 判定实现、缓存容量、依赖、版本号、
  发布流程。
- **尚未覆盖**：卸载后响应写入缓存（D7，留 16.4）；Revert / Delete /
  cleared 事件竞态（留 16.3）；缓存淘汰压力与长会话 10,000 回合性能
  （留 TASK-17）。

## 21. 阶段 B 第五轮（TASK-16.3：Revert / Delete / cleared 事件竞态）

- **现状结论**：三层生产路径分别是页面级订阅（`page.tsx` 内联循环）、详情页
  事件决策与消费（`handleDetailEvent` / `consumeDetailEvents`）、请求协调器
  （`createDetailLoader`）与模块级 `DETAIL_CACHE` / 脏标记。执行前审计
  （`docs/TASK16_3_BRIEF.md` §1）列出 6 项发现，其中两项是真实缺陷：
  **D1** `page.tsx:2715` 把 `session.revert.cleared` 与 `committed` 混同处理，
  同样清缓存 + 标脏，与 `handleDetailEvent`、15j 断言及本文 §15 的既有语义
  「cleared 数据未变、不失效、不刷新」冲突，会导致下次打开详情被强制
  `force=true` 走网络；**D2** 删除时 `markGone` 只调 `loader.invalidate()`
  递增 generation，而 `load()` 的 `finally` 只清最新代的 `refreshing`，删除后
  旧请求不再属于最新代 → `refreshing` 永久停在 true。其余 D3–D6 为现状正确
  或覆盖缺口（详见简报）。
- **最小修复**：新增导出 `handlePageEvent`（页面级事件决策，cleared 返回空动作，
  `deleted` 保留 `id ?? sessionID` 与缺省全清兜底）、`consumeRevertedMarker`
  （组件打开详情与测试共用脏标记消费）、`createDetailLoader.cancelForGone()`
  （作废在途 + 复位 `refreshing` / `loadingMore`）；`page.tsx` 订阅循环改调
  `handlePageEvent`，组件删除动作改调 `cancelForGone()`。`schedule()` 列表
  刷新与 checkpoint 判定顺序（删除后仍判 `stale`）保持原样。
- **16p 自动化回归**（138 条断言语句，Deferred 固定事件/响应顺序）：把真实
  `consumeDetailEvents` 的动作接到真实 `createDetailLoader` 与真实
  `DETAIL_CACHE`／脏标记上，覆盖 Revert×首屏（事件前/后返回）、Revert×loadMore
  （含强刷后新游标与无重复追加）、Revert×refresh 双顺序与三请求交错、
  Delete×首屏/refresh/loadMore（短路、无 setDetail、无缓存写入、状态即时恢复）、
  消费循环停止与 abort、cleared 页面级与详情页级语义、他会话事件隔离。
  `npm run test:synthetic` 零失败。
- **测试基础设施修复**：M2 首次 mutation 出现 `exit=0 / 0 failures` 假绿——
  削弱短路后删除后主动触发的 load 会挂在永不 resolve 的 Deferred 上，Bun
  静默退出。已在 `deleteCase` 加兜底 resolve，修复后基线全绿、M2 检出 3 条失败。
- **缓存验证**：每个用例起始清空真实缓存；Revert 立即失效，过期/删除/cleared
  路径不创建也不改写条目，有效结果与视图逐项一致，他会话事件只作用于自身 ID。
- **敏感度验证**：10 项（M1–M10，含 generation 判定、删除短路、状态复位、
  markGone-break、cleared 语义、invalidate 动作、缓存写入、双层删除保护联合）
  全部被对应用例检出（1–24 条失败断言不等），逐项恢复后重跑全绿。
- **覆盖层级**：未挂载 SolidJS 组件，不新增依赖；驱动的是生产事件处理、请求
  协调与真实缓存写入路径，**不是组件 E2E**。详见简报 §4.7。
- **本地全套验收**：typecheck ✓ / build ✓ / test:plugin wire ✓ / test:synthetic ✓ /
  scale base·medium·large ✓（冷 71 / 380 / 1532 ms，峰值 75 / 165 / 404 MB）。
- **未改动**：服务端分页与 SQL、R1/C1/C2 口径、500 条限制、Schema/索引、
  搜索与 CSV/JSON 导出、脱敏规则、UI 结构与文案、`canLoadMore` 守卫与游标
  判定、缓存容量、依赖、版本号、发布流程。
- **尚未覆盖**：卸载后响应写入缓存（留 16.4）；真实 Solid 生命周期与 SDK
  网络时序；`schedule()` 列表刷新与 DOM 表现；缓存淘汰压力与 10,000 回合
  性能（留 TASK-17）。

## 22. 阶段 B 第六轮（TASK-16.4：卸载、请求逻辑失效与缓存生命周期）

- **现状结论**：`SessionDetailView` 卸载时只在 `onMount` 内 `onCleanup(() =>
  eventsController.abort())`，**没有任何通知请求协调器的动作**；卸载不改变
  `generation` / `sessionID` / `isGone()` / 载荷 id 中任何一项，因此迟到首屏、
  refresh、loadMore 响应仍会判 `ok` → `setDetail` + `remember`，写模块级
  `DETAIL_CACHE`、更新 `error`、在 `finally` 继续写 `refreshing` / `loadingMore`；
  卸载后到达的 Revert 事件还能通过 `forceReload` 发出新请求。前端缓存容量
  （4）、TTL（120s）、LRU 顺序本身正确，但没有自动化回归。详见
  `docs/TASK16_4_BRIEF.md` §1。
- **取消能力判断**：`Usage.sessionDetail` 的 wire 入参只有 `sessionID /
  beforeTurn / limit / force`，**没有 AbortSignal**。本轮不伪造取消、不新增依赖，
  采用逻辑失效：`createDetailLoader` 增加 `disposed` 与幂等 `dispose()`，
  置位 + `generation += 1`，两个 checkpoint 首判、两个入口短路、两处 `finally`
  静默、`cancelForGone()` 早退；保留全部既有 generation/会话/gone/id 校验。
  每实例自有协调器，不清缓存、不影响其它实例，逻辑失效不作为业务错误展示。
- **最小改动**：组件顶层新增 `onCleanup(() => loader.dispose())`（事件订阅的
  abort 原样保留）；新增导出 `isDetailCacheFresh`（组件 `cachedFresh` 改调它，
  TTL 常量与容量不变）。生产代码只改 `src/gui/session-detail.tsx` 一个文件。
- **16q 自动化回归**（85 条断言，Deferred 驱动真实协调器与真实缓存）：
  卸载后首屏 / refresh / loadMore 的成功与失败迟到、卸载后 Revert/Delete 事件、
  dispose 幂等与短路、新旧实例隔离、正常请求与缓存复用、失败/旧请求/会话切换
  的缓存保护、Revert/Delete 不回退、TTL/LRU/容量/失效三态。`eventHarness` 增加
  `writes` / `cacheWrites` 计数探针，严格断言「卸载后零状态与缓存写入」。
- **测试稳健性**：16q-c2 预防性加兜底 resolve 与 `hasMore=true` fixture，避免
  16.3 出现过的「削弱短路 → 挂在未 resolve Deferred 上静默假绿」；验证脚本
  改为每项结束立即恢复源码。
- **敏感度验证**：9 项（M1–M9）全部检出（1–37 条失败断言不等），含联合
  M9 验证「disposed 判定 + generation 递增」双层保护缺一不可；逐项恢复后全绿。
- **覆盖层级**：未挂载 SolidJS 组件，不新增依赖；驱动生产协调器生命周期、
  事件动作接线与真实缓存，**不是组件 E2E**。
- **本地全套验收**：typecheck ✓ / build ✓ / test:plugin wire ✓ / test:synthetic ✓ /
  scale base·medium·large ✓（冷 72 / 373 / 1482 ms，峰值 74 / 166 / 413 MB）。
- **未改动**：服务端分页 SQL 与协议、R1/C1/C2 口径、500 条限制、Schema/索引、
  搜索与 CSV/JSON 导出、脱敏、UI 结构与文案、缓存策略（TTL 120s / 容量 4 /
  LRU 顺序 / 失效语义）、依赖、版本号、发布流程。
- **尚未覆盖**：Solid 真实 `onCleanup` 触发与 `<Show>` 重建、组件级
  `cachedFresh` 渲染分支、事件订阅 abort 后上游迭代器挂起、真实 RPC 时序与
  DOM 表现；缓存淘汰压力与 10,000 回合性能留 TASK-17。

## 23. 阶段 B 收尾（TASK-16.5：整体集成验收）

- **性质**：基线 `5e1d129` 只读验收，**无生产代码改动**；仅修正 README 一处
  与实现不符的性能描述（原称「一次数据库扫描」，实际 `snapshot` 按天聚合、
  历史天复用落盘聚合、只有当天现算、分批合并）。完整交付报告见
  `docs/TASK16_5_ACCEPTANCE.md`。
- **链路审计**：源码实读确认服务端 `sessionDetail` = `buildSessionSummary`
  （全会话标量聚合 + 60s / 4 条 LRU 缓存）与 `buildTurnPage`（seq 游标 +
  user 边界探测 + 本页消息读取）分离；前端首屏 / loadMore / 搜索 / 导出 /
  事件 / dispose 全部收敛到 `createDetailLoader` 与 `DETAIL_CACHE`。未发现
  「假分页」全量读取残留路径；`invalidate()` / `generation` getter 为无生产
  调用者的防御性 API，按 P3 记录不重构。
- **口径与对账**：R1（有效 Token = input + output，不含 reasoning）、C1（cost
  缺失/0 均按 0）、C2（Sessions 按 `modelID` 精确匹配）均与源码一致；15b–15l
  覆盖 Σ 页 = Σ 全会话、六类 Token、请求/回合/工具/错误数、TTFT/P50/P95/
  慢请求、一 user 多 assistant、合成头回合、无 assistant 回合、seq 不连续、
  坏 JSON、Revert 截断、空页/重复页/游标无进展。无公式或异常策略变更。
- **集成回归**：16m/16n/16p/16q 覆盖会话切换、乱序刷新、分页与刷新交错、
  Revert/Delete/cleared、卸载 dispose、实例隔离、缓存复用；前端缓存 4 条 /
  120s / LRU 与服务端 4 条 / 60s / 默认 60 回合均保持。
- **自动化**：typecheck / build / plugin wire / synthetic / scale base·medium·
  large 全部通过（base 冷 69ms、medium 362ms、large 1449ms；峰值 74 / 165 /
  400 MB）。核查测试隔离（pid + random 临时目录、用例起始清缓存）、Deferred
  假绿防护（16p/16q 兜底 resolve + `synthetic ok` 证明 main 执行到底）、
  mutation 临时改动已恢复（工作区干净、常量与判定复核）、生产函数直连证据与
  非组件 E2E 的覆盖声明。
- **文档核对**：README 一处修正；`STATS_AUDIT.md` §9 / §19–§22、三份 TASK-16
  任务记录与实现一致；历史范围声明、历史行号、`metrics.ts` 的「待确认」措辞、
  ROADMAP 未收录阶段 B 等按 P3 记录，不改写审计链、不扩展文档体系。
- **结论**：无 P0 / P1，唯一 P2 已修复；统计口径不变、分页链路完整、缓存与
  请求生命周期无回归、CI 等价本地全套全绿。**建议关闭第二批**（待独立复审），
  随后进入 TASK-17 长会话性能专项。

## 24. TASK-17.1 / 17.2：10,000 回合长会话性能基线与瓶颈分析（只读）

- **基线**：`aa2f14b9d02d1d28ebd9cf8ff68bd19ec1f88848`。新增只读测量工具
  `scripts/check-perf.ts`（`src/` 零改动），原始数据 `docs/perf/TASK17_1_raw.json`，
  报告 `docs/TASK17_1_BASELINE.md` 与 `docs/TASK17_2_BOTTLENECK.md`。父进程构造
  一次与 15g 逐字一致的 fixture（10,000 回合 / 20,000 消息 / 216.2MB DB），
  3 个独立子进程复用同一 DB 文件，天然冷缓存；SQL 计时用运行时包裹
  `bun:sqlite` 的 Statement（WeakSet 防重复包裹），解析量用生产 globalThis 探针。
- **三次重复（min / 中位数 / max）**：冷首屏 280.98 / **288.46** / 295.17 ms，
  热首屏 1.06 / **1.23** / 1.28 ms；冷首屏 SQL 274.63 / **281.83** / 288.26 ms；
  首屏 120 行 / 120 次 JSON 解析 / 462,180 字节；汇总扫描 40,000 行、正文 0 字节；
  回合对象构建 0.59 ms；`wire()` 0.50 ms / 1.11MB。
- **冷首屏成本归因**：`summary.toolStats`（json_each 展开 30,000 元素）175.50 ms
  + `summary.scalars`（10,000 行 × 11 json_extract）104.62 ms = 99.4%，
  分页 SQL <1ms；JS 聚合 6.63 ms。冷−热 287.18 ms 即 `buildSessionSummary` 成本，
  被 `sessionCache`（4 条 / 60s）隔离。
- **两条全链对照（本轮核心结论）**：复现 CI 的 `force-every-page` 链 47.22 /
  **47.88** / 48.27 s，167 页每页重算汇总（`summary.scalars` / `toolStats` 各 167 次）；
  生产语义 `summary-cache` 链 0.560 / **0.562** / 0.565 s，两条汇总 SQL 各 1 次。
  相差 **85×**。CI 的 403ms / 67.3s 与本机 288ms / 47.88s 比值同为 1.40× / 1.41×，
  确认为同路径机器差异，不是退化证据。任务书 67.3s 是 15g 夹具每页
  `force:true` 的测量口径产物，生产 `loadMore()` 从不带 force。
- **分层（`cache` 链）**：服务端 SQL 411.9 ms（汇总 282.0 + 翻页 129.9）、
  服务端 JS 52.7 ms、RPC `wire()` 66.8 ms、前端 `applyLoadMoreResult` 26.8 ms
  （单页 max 1.16 ms）。逐页 p50 1.072 ms、p95 1.295 ms，首末页 286.14 / 0.596 ms，
  无随游标恶化。`force` 链逐页 p50 281.44 ms、p95 288.53 ms，平坦。
- **正确性**：3 次运行 16 项断言全绿、零失败；两条链均 167 页 / 10,000 回合 /
  无缺失无重复 / Σ页 cost = 10.00 / 单页 ≤130 行；全链 JSON 解析恰好 20,000 次
  / 73.5MB，无重复解析；7 条关键查询在 216MB 真实库上全部命中索引，无表扫描、
  无临时排序。
- **前端与内存**：全量 10,000 回合搜索首次 103.96 ms（建 WeakMap 索引）/ 命中后
  8.28 ms；全部展开 0.47 ms、折叠 ~0.0002 ms；CSV 17.67 ms / 1.30MB；
  JSON 导出 6.09 ms / **172.6MB** 字符串。Bun 进程峰值 RSS 中位数 1,212MB
  （启动 99 → 链后 706 → 搜索后 943 → CSV 后 966 → JSON 导出后 1,212），
  由搜索索引与导出大字符串 + GC 时机共同构成，非浏览器堆快照。
- **瓶颈判定**：没有需要改生产代码的可重复瓶颈。被数据否决的候选：重复 JSON
  解析（本就无重复）、`mergeTurns` 全量 Map/排序（单页 max 1.4ms）、汇总
  `ORDER BY seq`（索引已满足、无 TEMP B-TREE）、汇总 SQL 下推/预聚合（需改
  schema 或统计口径，且每会话每 60s 至多 1 次）、虚拟列表/新依赖（禁止）。
  唯一建议 O-1 是修正 15g 测试夹具的 `force:true` 测量口径（非生产代码），
  预期本机 synthetic 从 ~48s 降到 ~1s；O-4 流式导出/索引瘦身会改变导出或
  搜索语义，与禁止事项冲突，按 P2 记录不改。
- **覆盖层级**：生产服务端分页/汇总 SQL、`UsageStore.sessionDetail`、生产 RPC
  `wire()` 同形序列化、生产前端合并/搜索/导出纯函数与真实 fixture。**未挂载
  SolidJS、无 DOM**：不是组件 E2E，渲染 / 真实 IPC 传输 / 浏览器反序列化 /
  DOM 布局重排未测量，报告中一律标注「未测量」。
- **本阶段动作**：只新增测量脚本与两份报告 + 本审计章节，不改生产代码；
  TASK-17.3 是否实施（仅 O-1）等待独立复审确认。
