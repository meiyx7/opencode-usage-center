# TASK-16.4 组件卸载、请求取消与缓存生命周期

基线：`51078a55a51ae61919ce4cd8920521730083d289`（`main` = `origin/main`，工作区干净）。
本轮只做 16.4，不碰 16.5 / TASK-17。本文 §1–§3 是执行前审查与测试设计，
实施结果在实施后追加（§4 起）。

## 1. 执行前现状审查

### 1.1 五个检查点

| 检查点 | 现状 |
| --- | --- |
| `SessionDetailView` 创建 / 清理 / 卸载 | 组件作用域每实例创建 signals 与一个 `createDetailLoader`；`page.tsx` 用 `<Show when={props.selected}>` 承载，返回列表时 `selected` 变 `undefined` → 组件销毁。`onMount`(1056) 建事件订阅 `consumeDetailEvents(...)`，并在**该 onMount 回调内部**注册 `onCleanup(() => eventsController.abort())`；另一个 `onMount`(1080) 触发首次 `loader.load(...)`。**卸载只 abort 事件订阅，没有任何通知协调器的动作** |
| `createDetailLoader` 请求协调 | `generation`（`load` / `invalidate` / `cancelForGone` 递增）、`moreGeneration`、`inFlight`；`checkpoint` = `stale → gone → switched`，`commit` 判定通过才 `setDetail` + `remember`；`checkpointMore` 多一层分页代判定；`finally` 分别只由最新代 / 最新分页代清 `refreshing` / `loadingMore`。**没有 disposed 概念** |
| `DETAIL_CACHE` 读写 / TTL / LRU / 失效 | 模块级 `Map<string, {value, at}>`，`DETAIL_CACHE_LIMIT=4`、`DETAIL_FRESH_MS=120_000`；`remember` 用 `delete + set` 把命中项移到末尾，超容量删 `keys().next().value`（最旧）；组件 `cachedFresh` 用 `Date.now() - cachedEntry.at < DETAIL_FRESH_MS` 判断；`invalidateDetailCache(id?)` 指定删 / 全清；`readDetailCache` 是只读探针。写缓存只在 `commit` / `commitMore` 判定通过之后 |
| `onCleanup` 与 AbortController | `eventsController.signal` 同时传给 `client.event.subscribe({signal})` 与 `consumeDetailEvents`；卸载时 abort，事件消费循环停止。**请求侧没有 signal**：`fetch: (input) => api.sessionDetail(input)`，`src/contract.ts` 的 `SessionDetailInput` 只有 `sessionID / beforeTurn / limit / force`，无 `AbortSignal` 字段 |
| 当前测试能否模拟卸载后迟到响应 | 16m / 16n / 16p 都有 Deferred harness，16p-e2 验证的是**事件消费循环** abort；没有任何用例把「卸载」作用到请求协调器。若在现有代码上模拟卸载（什么都不做）再让首屏 Deferred 返回，`checkpoint` 会判 `ok` → `setDetail` + `remember`。缓存容量 4 / LRU 淘汰 / `at` 时间戳也没有自动化断言（15i 测的是服务端 60s 汇总 TTL，不是前端 `DETAIL_CACHE`） |

### 1.2 卸载后的真实缺陷（可复现推演）

组件卸载不改变 `generation`、`sessionID`、`isGone()` 中任何一项，也不改变载荷 id：
迟到响应在现有代码里仍是「最新、本会话、未删除」。

| ID | 缺陷 | 后果 |
| --- | --- | --- |
| D1 | 卸载后首屏 / refresh 成功响应判 `ok` | `setDetail` 写已销毁组件的信号，并按会话 id 写模块级 `DETAIL_CACHE`（真实副作用） |
| D2 | 卸载后 loadMore 成功响应判 `ok` | `applyLoadMoreResult` 追加回合、改写 `hasMore` / `nextBefore`，并写缓存 |
| D3 | 卸载后请求失败 | `catch` 里 `checkpoint` 判 `ok` → `setError` 更新错误态 |
| D4 | 迟到请求的 `finally` | 仍会清 `refreshing` / `loadingMore`（卸载后的状态写入），`inFlight` 也跟着变 |
| D5 | 卸载后若事件流在 abort 生效前到达 | Revert 的 `forceReload` 会调 `loader.load(true)` → 卸载后仍发新请求并可能写缓存 |
| D6 | 前端缓存 TTL / LRU / 容量无自动化回归 | 策略本身正确，但 16.1–16.3 只验证了「隔离与失效」，没验证 `at`、容量 4、淘汰顺序 |

### 1.3 请求取消能力判断（TASK-16.4.3）

**底层不支持真正取消**：`Usage.sessionDetail` 的 wire 入参 schema 只有
`sessionID / beforeTurn / limit / force`，`client.rpc(Usage)` 调用没有
`AbortSignal` 参数或取消句柄。因此**不伪造取消成功**、不引入新依赖、不把
取消包装成业务错误。本轮采用**逻辑失效**：协调器内的 `disposed` 标志 +
`generation` 递增，保留全部既有 generation / 会话 / gone / id 校验，迟到响应
一律走「不提交、不写缓存、不更新状态」路径。

- 每个组件实例自有协调器，`dispose()` 只作用于本实例，**不会取消其他会话或其他组件的请求**。
- `dispose()` 不清缓存：有效缓存必须能继续复用（打开别的会话 / 重新打开同一会话）。
- 卸载时刻一次性复位 `refreshing` / `loadingMore`（避免 loading 状态遗留）；
  此后任何迟到响应或事件都不得再写入任何状态信号。
- 新增判定原因 `disposed`，与 `gone`（会话删除）区分，不写 `error`。

### 1.4 无法自动化的真实路径

1. Solid 真实 `onCleanup` 触发时机与组件销毁（不挂载 DOM、不新增依赖）：测试
   直接调用协调器 `dispose()`，与组件 `onCleanup` 回调是同一个生产入口。
2. 真实 RPC 网络时序：Deferred 替代。
3. 组件级 `cachedFresh` 的渲染决策：本轮把 TTL 判断提为 `isDetailCacheFresh`，
   组件与测试共用同一函数，但**不挂载组件**，因此不验证 `<Show>` 分支渲染。
4. 事件订阅 abort 后上游迭代器的挂起行为（16.3 已记录）。

## 2. 最小修复方案

- `src/gui/session-detail.tsx`：
  - `DetailRejectReason` 增加 `disposed`。
  - `createDetailLoader` 增加 `let disposed = false` 与幂等 `dispose()`：
    置位、`generation += 1`、一次性复位两个加载态；**不发请求、不清缓存**。
  - `checkpoint` / `checkpointMore` 首判 `disposed`；`load()` / `loadMore()`
    入口短路；`catch` 因 checkpoint 非 `ok` 不写 `error`；两处 `finally`
    在 `disposed` 时跳过状态写入（`inFlight` 内部计数仍递减，它不是状态信号）。
  - `cancelForGone()` 在 `disposed` 时早退，不触碰状态。
  - 组件顶层新增 `onCleanup(() => loader.dispose())`；**保留**现有
    `onMount` 内的 `onCleanup(() => eventsController.abort())`，不改动事件订阅结构。
  - 新增导出 `isDetailCacheFresh(sessionID)`（把组件里那一行 TTL 判断提为
    共用函数），组件 `cachedFresh` 改调它；**常量、容量、LRU 顺序、失效语义不变**。
- `scripts/check-synthetic.ts`：类型签名同步；`eventHarness` 增加状态写入计数
  与缓存写入计数探针（仍调用真实 `rememberDetail`）；新增 16q 用例组。
- 文档：本文 + `docs/STATS_AUDIT.md` §22。
- **不动**：服务端分页 SQL/协议、R1/C1/C2 口径、500 条限制、Schema/索引、
  搜索与 CSV/JSON 导出、脱敏、UI 结构与文案、缓存策略（TTL 120s / 容量 4 /
  LRU 顺序）、依赖、版本号、发布流程。

## 3. 测试设计（16q）

### 3.1 覆盖层级声明

**不是组件 E2E**：未挂载 SolidJS 组件，不新增依赖。测试驱动的是生产
`createDetailLoader`（含新增 `dispose()`）、生产 `consumeDetailEvents` 动作接线、
真实 `DETAIL_CACHE` 写入 / 读取 / 失效与 `isDetailCacheFresh`。组件卸载通过
调用与 `onCleanup` 相同的 `loader.dispose()` 表达，不是复刻逻辑。

复用 16m/16n/16p 的 `Deferred`、`detailOf` / `turnOf`、`eventHarness`、
`committedEvent` / `deletedEvent` 与真实缓存探针。给 `eventHarness` 增加
`writes`（`setDetail` / `setError` / `setRefreshing` / `setLoadingMore` 调用次数）
与 `cacheWrites`（`remember` 调用次数）探针，用于严格断言「卸载后零状态写入」——
只看最终布尔值无法检出「迟到响应又清了一次本已为 false 的状态」。

### 3.2 用例清单

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| 16q-a1/a2 | 首屏 / refresh 挂起 → `dispose()` → 成功迟到 | `reason: disposed`；无 `setDetail`、无 `remember`、无缓存写入；dispose 后写入计数不变；`inFlight` 正常归零 |
| 16q-a3 | 卸载前已提交一个请求，另一个旧请求卸载后迟到 | 旧请求不覆盖已提交详情与缓存；写入计数不变 |
| 16q-a4 | 请求失败迟到 | `reason` 非 `error`；`error` 状态与写入计数不变 |
| 16q-b1/b2/b3 | loadMore 挂起 → `dispose()` → 成功 / 失败迟到 | 不追加回合、不写缓存、`hasMore` / `nextBefore` 保持 dispose 前值；状态零写入 |
| 16q-b4 | 分页在途 → `dispose()` → 再 feed Revert/Delete 事件 | 迟到分页不追加；事件不再发起新请求；缓存只按事件语义失效，不被迟到响应写回 |
| 16q-c1/c2 | `dispose()` 幂等；dispose 后 `load` / `loadMore` 短路 | 重复 dispose 无额外状态写入；不再产生任何 fetch |
| 16q-c3 | 新实例不被旧实例迟到请求影响 | A dispose 后迟到，B 的详情、状态、缓存全部独立且正常 |
| 16q-d1 | 未卸载的正常请求 | 仍能提交并写缓存（防止保护过度） |
| 16q-d2/d3 | 请求失败不覆盖有效缓存；旧请求不覆盖新请求缓存 | 缓存值与最新有效结果一致 |
| 16q-d4 | 会话切换不串缓存 | A/B 各自分槽（16m 已有，本轮回归确认） |
| 16q-d5 | Revert 失效 + 强刷、Delete 清理 + 迟到保护 | 16p 保护不回退 |
| 16q-e1 | TTL / LRU / 容量 / 失效 | 容量 4、`delete+set` 命中项保活、最旧淘汰、`at` 新鲜且读不改、`isDetailCacheFresh` 三态（新鲜 / 过期 / 失效）、指定失效不动其它、全清 |

> TTL 过期态用「通过 `readDetailCache` 返回的条目引用把 `at` 回拨 121s」构造，
> 模拟时间流逝，不改生产代码、不修改断言结果；不引入 Date 打桩依赖。

### 3.3 mutation 计划

| # | 削弱项 | 预期检出用例 |
| --- | --- | --- |
| M1 | 去掉两个 checkpoint 的 `disposed` 判定 | 16q-a1 / b1（迟到响应提交并写缓存） |
| M2 | 去掉 `load()` 入口 disposed 短路 | 16q-c2（卸载后仍发请求） |
| M3 | 去掉 `loadMore()` 入口 disposed 短路 | 16q-c2 |
| M4 | 去掉 `finally` 的 `!disposed` 判定 | 16q-a1 / b1（写入计数变化） |
| M5 | 去掉 `dispose()` 的加载态一次性复位 | 16q-a1（loading 遗留） |
| M6 | 去掉 `cancelForGone()` 的 disposed 早退 | 16q-b4（卸载后事件仍写状态） |
| M7 | 去掉 `commit` 的缓存写入 | 16q-d1（正常请求不再写缓存） |
| M8 | 改变 `DETAIL_CACHE_LIMIT` | 16q-e1（容量回归） |
