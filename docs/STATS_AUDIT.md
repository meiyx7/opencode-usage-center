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
