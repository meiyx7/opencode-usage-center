# TASK-16.3 Revert / Delete / cleared 事件与在途请求竞态

基线：`14ce9ca3edeb2e251ded63b776d76bc5ee3159cd`（`main` = `origin/main`，工作区干净）。
本轮只做 16.3，不碰 16.4 / TASK-17。本文先给执行前现状与测试设计（§1–§3），
实施与验收结果在实施后追加（§4 起）。

> 命名说明：任务里的 `session.cleared` 在本代码库对应的实际事件类型是
> `session.revert.cleared`（SDK 三个事件之一，见 `STATS_AUDIT.md` §14）。
> 本文统称 cleared，测试按生产实际字符串驱动。

## 1. 现状分析（执行前核查）

### 1.1 三层生产路径

| 层 | 实现 | 事件/请求动作 |
| --- | --- | --- |
| 页面级订阅 `page.tsx` `onMount` (2695–2737) | 内联 async IIFE for-await，订阅 7 类事件 | `revert.committed` **或** `revert.cleared` → `invalidateDetailCache(sessionID)` + `markSessionReverted(sessionID)`；`session.deleted` → `invalidateDetailCache(id ?? sessionID)`；所有事件末尾 `schedule()` 刷新列表 |
| 详情页事件决策 `session-detail.tsx` `handleDetailEvent` (819) | 导出纯函数，按 `eventSession === ownSessionID` 过滤 | `deleted` → `{invalidate, markGone}`；`revert.committed` → `{invalidate, forceReload}`；**cleared → 全 false**（未截断回合，数据未变） |
| 详情页消费循环 `consumeDetailEvents` (840) | 导出，`for await` + `signal.aborted` 检查 | 依次 `invalidate()` → `markGone()` 后 **break** → `forceReload()`；catch 静默兜底 |
| 组件接线 `SessionDetailView` (1009–1031) | `AbortController` + `onMount` 订阅，`onCleanup` abort | `invalidate` → `invalidateDetailCache(id)`；`markGone` → `setSessionGone(true)` + `loader.invalidate()`；`forceReload` → `void loader.load(true)` |
| 请求协调器 `createDetailLoader` (154) | `load` / `loadMore` 共用主 `generation`，分页另有 `moreGeneration` | `checkpoint` → `commit`（判定通过才 `setDetail` + `remember`）；`finally` 仅最新代清 `refreshing`，`loadMore.finally` 仅最新分页代清 `loadingMore` |
| 缓存 | 模块级 `DETAIL_CACHE`（4 条，按会话 id 分槽） | `rememberDetail` / `invalidateDetailCache(id?)` / `readDetailCache`（16.1 加的只读探针） |
| 脏标记 | 模块级 `revertDirtySessions: Set<string>` | `markSessionReverted(id)` 写；组件打开时 `revertDirtySessions.delete(id)` 消费 → 视为未缓存 + 首次 `load(force=true)` |

### 1.2 Revert / Delete / cleared 的既有语义

| 事件 | 页面层（`page.tsx`） | 详情页（`handleDetailEvent`） | 审计文档记录的语义 |
| --- | --- | --- | --- |
| `session.revert.committed` | 清该会话缓存 + 标脏；列表刷新 | 清缓存 + **立即强刷**当前打开的详情 | 回合被截断，已加载内容与汇总都可能过期 |
| `session.deleted` | 清该会话缓存（无 id 时全清）；列表刷新 | 清缓存 + 标记 `sessionGone` + 停止消费 | 组件保持打开显示「会话已删除」，load 短路 |
| `session.revert.cleared` | 清该会话缓存 + 标脏；列表刷新 | **不动作** | `STATS_AUDIT.md` §15：「未截断回合，数据未变，避免重复请求」；15j 断言「不失效缓存、不刷新」 |

`session.deleted` 的迟到响应作废依赖 `markGone` 里的 `loader.invalidate()`（主 generation
递增），`load()` 入口 `isGone()` 短路，`loadMore()` 入口 `isGone()` 短路 + 守卫里的
`sessionGone` 维度。UI 删除提示是 `<Show when={sessionGone()}>`，删除后无代码复位它。

### 1.3 发现的差异与缺陷

| ID | 发现 | 性质 |
| --- | --- | --- |
| D1 | `page.tsx:2715` 把 `revert.cleared` 与 `revert.committed` 混在同一分支，同样执行 `invalidateDetailCache` + `markSessionReverted`。与 `handleDetailEvent` 的既有语义、15j 断言、审计文档 §15 全部冲突；实际后果是 cleared 后缓存被清、下次打开详情被强制 `force=true` 走网络，即任务禁止的「不必要的缓存失效 / 详情重载」 | **真实语义不一致，需最小修复** |
| D2 | 删除时 `markGone` 只调 `loader.invalidate()`（generation +1）。`load()` 的 `finally` 只在 `ticket.generation === generation` 时清 `refreshing`，删除后旧请求不再是最新代 → **`refreshing` 永久停在 true**（按钮一直「刷新中…」、`canLoadMore` 的 refreshing 守卫恒真） | **真实状态缺陷，需最小修复** |
| D3 | `loadMore()` 的 `finally` 用独立 `moreGeneration` 判定，删除不会推进它 → `loadingMore` 能正常复位 | 现状正确，需测试固化 |
| D4 | 删除后旧响应判 `stale`（generation 递增）而非 `gone`；功能上不提交、不写缓存，但原因不可区分 | 现状可接受；本轮**不改判定顺序**，避免扩大范围，文档如实记录 |
| D5 | 页面级事件决策内联在 Solid 组件的 async IIFE 里，测试无法直连；15j 只测 `handleDetailEvent` 分支返回值与 `consumeDetailEvents` 的动作计数，**没有把事件动作接到真实协调器与真实缓存**，也没有 Deferred 控制「事件处理完成 → 旧请求才返回」的时序 | 覆盖缺口，需最小提取 + 端到端用例 |
| D6 | Revert 强刷的 `commit()` 会保留 `previous.turns` 中 `index < firstIncoming` 的「更早分页」。按服务端「截断末尾、index 越大越新」的语义，被截断回合 index 更大，会被该 filter 自动排除；但这一推论目前没有确定性用例 | 需测试固化，不预判为缺陷 |

### 1.4 当前无法自动化的真实路径

1. Solid 组件挂载 / `onMount` / `onCleanup` 的真实执行时机（不新增依赖、不挂 DOM）；
   用「真实导出函数 + 与组件同一份动作接线」替代，不是组件 E2E。
2. 真实 SDK 事件订阅的网络时序（用可控 AsyncIterable + Deferred 替代）。
3. 真实 `schedule()` 列表刷新、按钮 `disabled` 的 DOM 表现（只断言状态信号与缓存）。
4. 卸载后响应写入缓存（D7，按划分留 TASK-16.4）。

## 2. 需要补充的测试设计（16p）

### 2.1 覆盖层级声明

**不是组件 E2E，也不是独立纯函数复刻。** 16p 把三条生产路径接在同一个 harness 上：

- **事件处理生产路径**：真实 `consumeDetailEvents`（导出函数，组件 onMount 调用它）+
  真实 `handleDetailEvent`；页面级用新提取的 `handlePageEvent`（组件循环调用它）。
- **请求协调器生产路径**：真实 `createDetailLoader.load()` / `.loadMore()` /
  `.cancelForGone()`，组件按钮、强刷、删除动作都经同一入口。
- **真实缓存写入路径**：`invalidateDetailCache` / `rememberDetail` / `readDetailCache`
  直接作用于模块级 `DETAIL_CACHE`；脏标记用与组件同一份 `consumeRevertedMarker` 消费。

`fetch` 由 harness 记录每次入参并返回一个新的 Deferred，测试用 `requests[i].d.resolve/…`
精确决定任意请求的返回顺序；事件流用有限 async generator，`await consumeDetailEvents(...)`
作为「事件处理已完成」的确定同步点（强刷是 `void loader.load(true)`，此时已发出但仍在途）。
用例开始先 `invalidateDetailCache()` 清缓存，用例间不共享协调器与状态。

### 2.2 用例清单

| ID | 场景（对应任务项） | 关键断言 |
| --- | --- | --- |
| 16p-a1 | 16.3.1 首屏挂起 → committed 处理完 → 旧首屏晚返回 → 强刷返回 | 旧判 `stale`，不提交、不写过期缓存；强刷提交 Revert 后数据；视图/缓存都不含被截断回合；两状态恢复 |
| 16p-a2 | 16.3.1 首屏先返回并提交（Revert 前数据）→ committed → 强刷 | 强刷后视图不含被截断回合（验证 D6 推论）；缓存同步；`consumeRevertedMarker` 不因此被误触发 |
| 16p-b | 16.3.2 loadMore 挂起 → committed → 旧分页返回 → 强刷返回 → 继续 loadMore | 旧分页判 `stale`、不追加、不恢复旧游标/hasMore；后续 loadMore 用强刷后的新游标；无重复追加 |
| 16p-c1 | 16.3.3 refresh 挂起 → committed → 旧 refresh 与强刷按两种顺序返回 | 旧不覆盖新状态、不污染缓存、`refreshing` 不被旧请求清掉 |
| 16p-c2 | 16.3.3 loadMore 挂起 → committed → 又触发 refresh → 多个旧请求先后返回 | 只有最后有效请求提交；提交次数、缓存、游标、loading 状态全部一致 |
| 16p-d1/d2/d3 | 16.3.4 首屏 / refresh / loadMore 挂起时收到 deleted，处理完后旧请求返回 | `sessionGone` 保持；无 `setDetail`、无缓存写入；删除后 load/loadMore 短路（不再发请求）；`refreshing`/`loadingMore` 均恢复 |
| 16p-e1 | 16.3.5 deleted 后停止消费、重复 delete 无重复副作用 | 动作计数固定；缓存只失效一次；后续 committed 不触发强刷 |
| 16p-e2 | 16.3.5 abort 后停止消费循环 | 真实 `consumeDetailEvents` + 真实动作；abort 后到达的事件不产生动作 |
| 16p-f1 | 16.3.6 cleared 经详情页消费循环 | 无 invalidate / 无 forceReload / 无 markGone；缓存条目仍在；不发请求 |
| 16p-f2 | 16.3.6 `handlePageEvent` 页面级决策 | cleared → `{}`；committed → 指定 ID 失效 + 标脏；deleted → 失效；配合真实缓存与 `consumeRevertedMarker` 断言 |
| 16p-f3 | 16.3.6 cleared 不导致下次打开强制刷新 | `consumeRevertedMarker(id)` 在 cleared 后为 false；committed 后为 true 且消费一次后为 false |
| 16p-e3/f4 | 16.3.5/16.3.6 其他会话的 Revert/Delete/cleared | 当前会话缓存、状态、请求数、脏标记全部不受影响 |

### 2.3 mutation 计划（逐项削弱 → 对应用例失败 → 恢复）

| 削弱项 | 预期检出用例 |
| --- | --- |
| 去掉 `cancelForGone()` 的 generation 递增 | 16p-d1（旧请求提交并写缓存） |
| 去掉 `load()` / `loadMore()` 的 `isGone()` 短路 | 16p-d1（删除后仍发请求） |
| 去掉 `cancelForGone()` 的加载态复位 | 16p-d1（`refreshing` 卡 true） |
| 去掉详情页 `invalidate` 动作 | 16p-a1（旧缓存复活） |
| `handlePageEvent` 把 cleared 当 committed | 16p-f2 / f3 |
| 去掉 `consumeDetailEvents` 的 markGone-break | 16p-e1 |
| 去掉 `checkpoint` 的 generation 判定 | 16p-a1 / c1（旧响应覆盖新状态） |

## 3. 本轮改动范围与边界

- `src/gui/session-detail.tsx`：导出 `handlePageEvent`（页面级事件决策，最小提取）、
  `consumeRevertedMarker`（组件与测试共用脏标记消费）、`createDetailLoader.cancelForGone()`
  （作废在途 + 复位 loading 态）；组件删除动作改调 `cancelForGone()`，打开详情改调
  `consumeRevertedMarker()`。
- `src/gui/page.tsx`：事件循环改调 `handlePageEvent`，cleared 不再失效缓存 / 标脏。
  `schedule()` 列表刷新保留（既有实时性机制，不属于详情重载）。
- `scripts/check-synthetic.ts`：新增 16p 用例组，复用 16m/16n 的 Deferred、harness、
  请求记录与真实缓存探针。
- 文档：本文 + `docs/STATS_AUDIT.md` §21。
- **不动**：`checkpoint` / `checkpointMore` 判定顺序（D4）、服务端分页与 SQL、R1/C1/C2
  口径、500 条限制、Schema/索引、搜索与 CSV/JSON 导出、脱敏规则、UI 结构与文案、
  `canLoadMore` 守卫与游标判定、缓存容量、依赖、版本号、发布流程；不新增依赖。
