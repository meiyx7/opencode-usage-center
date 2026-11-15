# 第二批 · 阶段 B 整体验收报告（TASK-16.5）

**基线 SHA**：`5e1d129ebfb79ce9ca5ab46b9f2c573036fdc4ae`（`main` = `origin/main`，验收开始时工作区干净）。
**验收性质**：只读集成验收。本轮**没有生产代码改动**，仅修正 README 一处与实现不符的性能描述。
**结论**：**无 P0 / P1；第二批可以关闭**（待独立复审确认后正式关闭），进入 TASK-17 长会话性能专项。

---

## 1. 审计范围与基线

以当前 `main` 源码为准，不依赖历史提交说明。覆盖：

| 层 | 文件 / 入口 |
| --- | --- |
| 服务端 | `src/server/store.ts`（`UsageStore.sessionDetail`、`buildSessionSummary`、`buildTurnPage`、`seqOfTurnStart`、`SESSION_PAGE_SQLS`）、`src/contract.ts`（`Usage.sessionDetail` / `SessionDetailInput`） |
| 前端详情 | `src/gui/session-detail.tsx`（`createDetailLoader`、`withTurns` / `mergeTurns` / `loadMoreProgress` / `applyLoadMoreResult` / `canLoadMore`、`filterTurnsByQuery`、`buildCsvRows` / `buildCsvText` / `buildJsonPayload`、`handleDetailEvent` / `consumeDetailEvents` / `handlePageEvent`、`DETAIL_CACHE`） |
| 页面层 | `src/gui/page.tsx`（会话列表筛选、事件订阅循环、`SessionDetailView` 挂载） |
| 统计口径 | `src/gui/metrics.ts`、`docs/STATS_AUDIT.md` §9（R1 / C1 / C2） |
| 测试 | `scripts/check-synthetic.ts`（15b–15l、16m/16n/16p/16q）、`scripts/check-plugin.ts`、`scripts/check-scale.ts`、`.github/workflows/ci.yml` |
| 文档 | `README.md`、`docs/STATS_AUDIT.md`、`docs/TASK16_ASYNC.md`、`docs/TASK16_3_BRIEF.md`、`docs/TASK16_4_BRIEF.md`、`ROADMAP.md` |

## 2. 完整生产链路检查结果

调用关系（源码实读，非历史说明）：

```
SessionDetailView
  ├─ 打开：consumeRevertedMarker(id) → DETAIL_CACHE / isDetailCacheFresh(id)
  │        └─ onMount → loader.load(wasReverted, Boolean(cached))
  ├─ 刷新 / 重试 / Revert 强刷 → loader.load(true)
  ├─ 「加载更早」→ loader.loadMore() → api.sessionDetail({sessionID, beforeTurn})
  │        └─ applyLoadMoreResult → loadMoreProgress → mergeTurns → withTurns
  ├─ 搜索 → filterTurnsByQuery(detail()?.turns ?? [], query())
  ├─ 导出 → buildCsvText / buildJsonPayload(visibleTurns())
  ├─ 事件订阅 → consumeDetailEvents(handleDetailEvent)
  │     committed → invalidateDetailCache + loader.load(true)
  │     deleted   → invalidateDetailCache + setSessionGone + loader.cancelForGone()
  │     cleared   → 空动作
  └─ onCleanup → loader.dispose() ／ eventsController.abort()

页面 UsagePage → 事件循环 → handlePageEvent
                    committed → invalidateDetailCache + markSessionReverted
                    deleted   → invalidateDetailCache
                    cleared   → 空动作（schedule() 列表刷新保留）

api.sessionDetail → UsageStore.sessionDetail
  ├─ buildSessionSummary：全会话标量聚合（json_extract，不把正文传入 JS）
  │    └─ sessionCache（LRU 4 条 / TTL 60s；force 可跳过）
  └─ buildTurnPage：seq 游标 + user 边界探测 → 只读取本页消息（默认 60 回合）
```

| 检查项 | 结论 |
| --- | --- |
| 服务端 session summary | 汇总与回合页分离；`summaryScalars` 只取顶层标量，`json_valid` 守门；`requestCount` 单独 COUNT 保留坏 JSON 行；`toolStats` 用 `json_each` 在 SQL 内聚合，正文不进 JS |
| 服务端 turn 分页 | `beforeTurn` 是 1-based 回合序号开区间上界；`seqOfTurnStart` 把序号翻译成起始 seq（含头部合成回合特例）；页边界由 `userBoundaries` 倒序 `limit+1` 探测；`pageMessages` 是唯一读 `data` 本体的查询 |
| seq 游标与回合边界 | 游标全局序号由 `turnCountBefore + 头部合成` 推导；`hasMore = turns[0].index > 1`、`nextBefore = turns[0].index`；`beforeTurn=1` 的终止语义与前端 `loadMoreProgress` 对齐 |
| 前端首次加载 / loadMore | 首屏走 `loader.load()`；`loader.loadMore()` 统一处理守卫、请求身份、归并、缓存写入与状态收尾；组件内不再有第二份分页实现 |
| 回合合并 / 去重 / 展开 | `mergeTurns` 以 index 为键、后者胜出、升序；`withTurns` 重算 `hasMore` / `nextBefore`；展开状态 `openTurns` 以 turn.index 为键，搜索命中时展开前几个 |
| 搜索 / CSV / JSON 导出 | 唯一数据源 `visibleTurns()`（已加载回合 + 当前搜索条件）；导出不发请求、不改原回合对象；脱敏默认开启 |
| 请求协调器 | 主 `generation`（load / invalidate / cancelForGone / dispose 递增）+ 独立 `moreGeneration`；`checkpoint` / `checkpointMore` 判定 stale / gone / switched / mismatch / disposed 后才 `setDetail` + `remember` |
| Revert / Delete / cleared | 见上表；`handleDetailEvent`（详情页）与 `handlePageEvent`（页面层）职责不同、不是重复实现 |
| dispose / 卸载 | 组件顶层 `onCleanup(() => loader.dispose())`；`dispose()` 逻辑失效、幂等、不清缓存、只作用于本实例；事件订阅 abort 独立保留 |
| 两级缓存 | 前端 `DETAIL_CACHE`：4 条 / TTL 120s / `delete+set` LRU；服务端 `sessionCache`：4 条 / TTL 60s / 同构 LRU；`invalidateDetailCache(id?)` 指定删或全清 |

**重复实现 / 旧路径 / 无效分支**：

- 未发现「前端看起来分页、底层仍全量读取」的残留路径。`buildTurnPage` 中唯一的 `parseJSON(String(message.data))` 位于本页 `messageRows` 循环内；注释里的「旧实现」均为历史说明，不是可执行分支。
- `createDetailLoader.invalidate()` 与 `generation` getter 当前没有生产调用者（16.1 为「同实例原地切换」预留的防御性 API / 测试探针）。属冗余但无行为影响，**按 P3 记录，不重构**。
- 未发现失效的保护代码；`DetailRejectReason` 的每个 reason 都有可达路径（`gone` 由入口短路返回，旧请求因 generation 优先判 `stale` 的差异已在 16.3 记录）。

## 3. 统计与分页一致性对账

口径维持不变（源码与审计文档一致）：

| 口径 | 规则 | 实现 |
| --- | --- | --- |
| R1 | 有效 Token = Input + Output，**不含 Reasoning**，也不含 cache read/write | `src/gui/metrics.ts effectiveTokens = input + output`；`reasoning` 独立字段 |
| C1 | Cost 缺失与 0 均按 0，不推算 | `COALESCE(json_extract(...), 0)` / `num()`；15e fixture 含 73 个缺 cost 回合 + 坏 JSON 行 |
| C2 | Sessions 模型筛选按 `modelID` 精确匹配，不精确到 Provider | `page.tsx:818 session.modelID !== modelFilter()`（严格相等） |

对账结果（`npm run test:synthetic` 全部通过）：

| 对账项 | 证据 | 结果 |
| --- | --- | --- |
| 全会话汇总 Σ = 分页明细 Σ | 15d 逐页 `beforeTurn` 累加 cost / 回合数与 `fullDetail` 相等；15g 10,000 回合全链 167 页对账 | 一致 |
| Cost / Input / Output / Reasoning / CacheRead / CacheWrite | 15b 单会话单模型恒等、15e 独立预期值、15g 逐字段断言 | 一致 |
| 请求数 / 回合数 / 工具数 / 错误数 | 15e：220 回合、219 prompt、220 请求（含坏 JSON 行）、6 工具、2 工具错误；`state.error` 真值边界（""/false/0 不计错） | 一致 |
| TTFT / 总时延 / P50 / P95 / 慢请求比例 | `latencyStats(requests)` 保留原值算分位；`summaryScalars` 与 `sessionRequest` 用同一套 time 字段回退链 | 一致 |
| 一个 user 多 assistant | 15e i=9 双 assistant，同一回合合并、cost 0.01+0.02 | 覆盖 |
| 无 user 的 assistant 合成回合 | 15e 头部合成「（会话开始）」，`totalTurns` +1，`seqOfTurnStart` 特例 | 覆盖 |
| 无 assistant 的 user 回合 | 15e 尾部「最后一问没有回复」 | 覆盖 |
| seq 不连续 / JSON 损坏 / Revert 截断 | 15k/15l/15g fixture 用 `i*2+1` 奇数 seq、15e 有跳跃 seq 与 `{broken json`、15i 删除末尾消息后 `force` 重读 | 覆盖 |
| 空页 / 重复页 / 游标无进展 | 15k `loadMoreProgress` 四场景 + `applyLoadMoreResult` 保留原回合引用；16n-e/f/g 通过协调器重放 | 覆盖 |

**未改变任何统计公式或异常数据处理策略。**

## 4. 前端数据流集成回归

| 检查项 | 结果 |
| --- | --- |
| 首次打开只处理服务端首屏 | `onMount → loader.load()`，无额外分页读取；15k 首屏 60 回合且 `hasMore` 正确 |
| loadMore 只处理新增页 | `applyLoadMoreResult` 以 `nextBefore` 判进展；无进展返回 `{...current, hasMore:false, nextBefore:0}`，回合对象引用保持不变 |
| 多页加载不重不漏 | 15k 220 回合序号 `1..220` 连续、无重复；15l 四页后搜索/导出与回合逐项一致 |
| 刷新保留未被覆盖的更早回合 | `commit()` 的 `olderTurns = previous.turns.filter(index < firstIncoming)`；16p-a2 验证 Revert 强刷不会把已截断回合拼回 |
| Revert 后已截断回合不复活 | 16p-a1/a2/b、16q-d5 |
| 删除后不再加载、不再写缓存 | 16p-d1/d2/d3、16q-d5 |
| 搜索 / 导出范围 = 当前已加载回合 | 15l：`visibleTurns()` 是唯一数据源，导出前后 `__ucPageReads.messages` 不变；加载更多后范围随之扩展 |
| 展开状态 / 游标 / hasMore 一致 | `openTurns` 按 index；`withTurns` 统一重算游标与 hasMore；15k/16n 断言游标单调前移 |
| 「假分页」旧路径 | **未发现**：15g 单页最大读取 120 行、汇总阶段正文传入 JS 恒 0 字节、15h 查询计划命中索引 |

## 5. 请求生命周期与缓存集成回归

| 场景 | 覆盖用例 | 结论 |
| --- | --- | --- |
| A 会话请求中切换到 B | 16m-a/b/c/d/f、16n-b/m | 旧响应不覆盖 B 的 detail、不写 B 缓存，A/B 各自分槽 |
| 多次刷新、响应乱序 | 16n-a、16p-c1/c2 | 旧判 `stale`，只保留最新有效结果，`refreshing` 正确恢复 |
| loadMore 与 refresh 交错 | 16n-d、16p-c2 | 旧分页不追加、不推进游标，两状态均恢复 |
| Revert 与 loadMore 交错 | 16p-b | 旧分页不复活历史回合；后续分页使用强刷后新游标 |
| Delete 与首屏 / refresh / loadMore 交错 | 16p-d1/d2/d3 | 无 `setDetail`、无缓存写入、删除后短路、状态即时恢复 |
| cleared 不误触发详情缓存失效 | 16p-f1/f2/f3 | 页面级与详情页级均不失效、不标脏、不刷新 |
| 卸载后迟到请求 | 16q-a1–a4 / b1–b3 | `disposed`，零 `setDetail`、零 `remember`、零状态写入 |
| dispose 后不能再发起请求 / 旧实例不影响新实例 / 有效缓存复用 | 16q-c1/c2/c3、16q-d1/e1 | 短路、幂等、实例隔离、正常请求仍写缓存 |

缓存策略实测保持不变：前端 `DETAIL_CACHE_LIMIT = 4`、`DETAIL_FRESH_MS = 120_000`，`remember` 用 `delete+set` 保活命中项、超容量删最旧（16q-e1 验证：写 5 个淘汰 q1、重写 q2 后再写 q6 淘汰 q3、`at` 新鲜且读不改、指定失效不动其它、全清）；服务端 `DETAIL_CACHE_LIMIT = 4`、`DETAIL_CACHE_MS = 60_000`、`DETAIL_PAGE = 60`。

## 6. 自动化测试结果

本地执行（等价于 CI 工作流全部步骤）：

| 步骤 | 结果 | 关键数据 |
| --- | --- | --- |
| `npm run typecheck` | ✓ | `tsc --noEmit` 无错误 |
| `npm run build` | ✓ | vite 220.83 kB / esbuild 74.2 kB |
| `npm run test:plugin` | ✓ | `wire ok` |
| `npm run test:synthetic` | ✓ | `synthetic ok`；10,000 回合首屏 285ms、全链 167 页 46709ms、单页最大读取 120 行 |
| `npm run test:scale` | ✓ | base 冷 69ms / 峰值 74MB |
| `npm run test:scale:medium` | ✓ | medium 冷 362ms / 峰值 165MB |
| `npm run test:scale:large` | ✓ | large 冷 1449ms / 峰值 400MB；独立预期值与三维度对账全部一致 |

测试质量核查：

- **驱动生产函数**：`UsageStore` / `SESSION_PAGE_SQLS` / `store.sessionDetail` 直接驱动服务端；`front.mergeTurns` / `withTurns` / `loadMoreProgress` / `applyLoadMoreResult` / `canLoadMore` / `filterTurnsByQuery` / `buildCsvRows` / `buildJsonPayload`、`detailModule.handleDetailEvent` / `consumeDetailEvents`、`requestModule.createDetailLoader` / `handlePageEvent` / `isDetailCacheFresh` / `rememberDetail` / `readDetailCache` 均为组件实际调用的导出函数，不是复制实现。
- **不依赖历史遗留状态**：所有 fixture DB 用 `pid + random` 命名并 `rmSync` 清理；`XDG_CACHE_HOME` 按 pid 隔离；`check-scale.ts` 用 pid 目录并在开头递归清理；16m/16n/16p/16q 每个用例起始 `invalidateDetailCache()` 清空模块级缓存。
- **Deferred 不会假绿**：`npm run test:synthetic` 输出末尾的 `synthetic ok` 证明 `main()` 执行到底、所有 `await` 都已 settle；16.3 曾出现的「削弱短路 → 挂在未 resolve Deferred 上静默退出」已在 16p `deleteCase` 与 16q `c2` 加兜底 resolve 修复。16p-e2 有一个不被 `await` 的孤立 Deferred（事件强刷触发的请求未 resolve），不承载断言、不构成假绿，按 P3 记录。
- **mutation 临时源码修改均已恢复**：验收开始时 `git status` 干净 = 源码与 HEAD 一致；复核 `createDetailLoader` 中 `if (disposed)` 判定、`DETAIL_CACHE_LIMIT = 4` / `DETAIL_FRESH_MS = 120_000` / `DETAIL_PAGE = 60` 均为原值。
- **覆盖层级如实记录**：16m/16n/16p/16q 均声明「未挂载 SolidJS 组件，覆盖生产请求协调 / 事件处理 / 状态与真实缓存写入，不是组件 E2E」；15k/15l 是生产纯函数 + 真实服务端分页 fixture 的数据流回归，同样不是 UI 端到端。

## 7. 文档核对结果

| 文档 | 结论 |
| --- | --- |
| `README.md` | 发现一处与实现不符：性能条目称「把总量、趋势、模型、时延合并成一次数据库扫描」，实际 `snapshot` 是按天聚合（历史天复用落盘聚合、只有当天现算、分批合并）。**已做一处最小修正**（仅该行）。其余核对一致：默认 60 回合、2 分钟详情缓存、最多 4 个会话、500 条列表上限、会话内搜索 / CSV / JSON 导出、实时事件与 60 秒兜底、有效 Token 与缓存命中率公式 |
| `docs/STATS_AUDIT.md` | §9 R1/C1/C2 与源码一致；§19–§22 各轮记录与提交对应，未发现与实现矛盾的描述；§1 审计表格里的源码行号是当时快照，现已漂移（P3） |
| `docs/TASK16_ASYNC.md` | 16.1 / 16.2 的现状分析、测试设计与执行结果与实现一致；§3 / §6.5 中「留 16.3 / 16.4」是当时的范围声明，已由后两份 BRIEF 与 §21/§22 覆盖，保留历史记录不改写（P3） |
| `docs/TASK16_3_BRIEF.md` / `docs/TASK16_4_BRIEF.md` | 与当前实现一致；16.4 §4.1「唯一生产文件 `session-detail.tsx`」与 diff 相符 |
| `ROADMAP.md` | README 引用其为「完整版本历史」，但未收录第二批阶段 B 的任务条目（P3，不扩展文档体系） |
| 源码注释 | `src/gui/metrics.ts` 的「reasoning 是否计入待确认，见审计表 R1，当前不计」措辞过期（R1 已确认），结论本身正确（P3） |

## 8. 遗留问题及优先级

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P0 | 无 | — |
| P1 | 无 | — |
| P2 | README「一次数据库扫描」与实际逐日聚合不符 | **已最小修复**（1 行，无代码改动） |
| P3 | `metrics.ts` 中 R1「待确认」措辞过期（结论正确） | 记录，不在本轮改注释 |
| P3 | README「有效 Token」未显式列出 reasoning 排除项；「单会话解析约 30 毫秒」未标注规模（10,000 回合首屏约 0.3 秒） | 记录，表述不完整但无错误 |
| P3 | `createDetailLoader.invalidate()` 与 `generation` getter 当前无生产调用者 | 记录，属防御性 API / 探针，不重构 |
| P3 | `TASK16_ASYNC.md` 的历史范围声明、`STATS_AUDIT.md` §1 的历史行号、`ROADMAP.md` 未收录阶段 B | 记录，不改写历史审计链、不扩展文档体系 |
| P3 | 16p-e2 存在不被 `await` 的孤立 Deferred | 记录，不承载断言、不造成假绿 |
| P3 | 删除事件 payload 缺 `id` / `sessionID` 时页面层全清缓存（既有保守兜底）；事件订阅 abort 后迭代器结束依赖上游 `signal` | 16.3 / 16.4 已记录，保持既有语义 |

以上 P3 均不影响本批次验收：不改变统计口径、分页链路、缓存策略或请求生命周期行为。

## 9. 最终结论

- 整体回归**无 P0 / P1**；唯一 P2 是一处文档描述，已最小修正。
- R1 / C1 / C2 统计口径不变；全会话汇总与分页明细对账一致；异常数据处理策略不变。
- 服务端真分页与前端分页链路完整，未发现全量读取旧路径；搜索 / 导出范围始终是当前已加载回合。
- 请求生命周期（generation / moreGeneration / disposed）、事件处理、两级缓存的交叉回归全部通过；缓存 TTL / 容量 / LRU / 失效语义保持。
- Typecheck、Build、Plugin Wire、Synthetic、Scale base / medium / large 全部通过。
- **建议关闭第二批**（待独立复审确认），随后进入 TASK-17：10,000 回合长会话性能专项。
