# TASK-16 请求并发与会话切换稳定性

基线：`f99a265`（main，工作区干净，无 tag）。本轮只做 **TASK-16.1（首次加载与会话切换）**，
不碰 TASK-16.2–16.5，不碰 TASK-17。

## 1. 现状分析（执行前核查）

### 1.1 请求生命周期

| 位置 | 现状 |
| --- | --- |
| `src/gui/session-detail.tsx` `SessionDetailView` | 每个组件实例自带 `detail` / `refreshing` / `loadingMore` / `error` / `sessionGone` 信号，以及实例级计数器 `request`、`loadInFlight` |
| `load(force, quiet)` | 入口 `if (sessionGone()) return`；`const id = ++request`；`await api.sessionDetail(...)` 后 `if (id !== request) return`；再判 `sessionGone()`；合并更早分页后 `setDetail` + `remember` |
| `loadMore()` | 守卫 `canLoadMore({ sessionGone, hasMore, loadingMore, refreshing, inFlight })`；`const id = request`；响应后同样 `id !== request` / `sessionGone` 双重判定，再走 `applyLoadMoreResult` |
| `markGone`（删除事件） | `setSessionGone(true)` + `request += 1`，使在途 `load`/`loadMore` 结果作废且不写缓存 |
| 缓存 | 模块级 `DETAIL_CACHE`（最多 4 条），`remember(detail)` 以 `detail.id` 为 key；`invalidateDetailCache(id)` 单删 / 全清 |
| 事件订阅 | `onMount` 建立 `subscribe` → `consumeDetailEvents`，`onCleanup` abort；`revert.committed` → 失效缓存 + 强制刷新，`deleted` → 失效 + markGone + 停止消费 |

### 1.2 会话切换的实际路径

`page.tsx` 用 `<Show when={props.selected}>` 承载详情页，`props.selected` 来自 `detailSession()`，
只有「列表点进去 / 返回置空」两条路径。因此在**当前 UI** 上切会话会经过 `undefined`，
`SessionDetailView` 被销毁重建，A 的旧响应只会落在 A 自己的信号与 A 的缓存 key 上。

但这条安全性依赖两个**隐含假设**，代码里没有防护：

1. `Show` 的 `when` 从真值 A 直接变成真值 B 时，children 不会重建（Solid 语义），而
   `props.session` 是响应式 prop。一旦将来出现「详情页内直接切换会话」的入口，
   同一个实例会带着 A 的 `detail` 信号去加载 B，`request` 计数器无法区分会话。
2. 服务端响应被视为「一定属于请求的会话」。`remember(merged)` 以响应载荷的
   `merged.id` 为 key，若响应 id 与请求会话不一致，就会把数据写进**另一会话的缓存槽**。

现有代码对同实例的「新请求覆盖旧响应」是有效的（`id !== request`）。本轮把上面两个
隐含假设变成显式判定，并把请求协调 / 提交判定 / 缓存写入提取为组件实际使用的生产路径，
以便用可控异步驱动。

### 1.3 本轮不做

- `loadMore` 的并发/重复页/失败恢复（TASK-16.2）。
- Revert/Delete/cleared 的事件竞态（TASK-16.3）。
- 卸载后请求返回、失败重试、缓存生命周期（TASK-16.4）。
- 完整自动化回归汇总（TASK-16.5）。

## 2. 测试设计（TASK-16.1）

### 2.1 覆盖层级声明

**不是组件 E2E。** 不新增依赖，因此不挂载 SolidJS 组件（无 DOM 测试环境）。
测试驱动的是组件**实际调用**的生产代码：`createDetailLoader`（本轮从组件提取的
请求协调器）+ 真实的 `DETAIL_CACHE` 写入函数。组件的 `load` / 刷新按钮 / 首次加载
`onMount` 全部经由该协调器，测试与生产共用同一实现，不是复刻逻辑。

无法自动化的部分：Solid `Show` 的真实重建时机、真实 RPC 网络时序、浏览器下载行为。

### 2.2 可控异步机制

`Deferred`：手写 `{ promise, resolve, reject }`，由测试精确决定响应返回顺序，
不依赖 `setTimeout` / 随机延迟，结果可重复。每个用例独立 Deferred，用例间无共享状态。

### 2.3 用例清单

| ID | 场景 | 断言重点 |
| --- | --- | --- |
| 16m-a | A 首次加载挂起，切到 B（重建路径，两个实例） | B 先返回后 A 晚返回，B 的 detail 不被覆盖；A、B 缓存各自隔离，无第三 key |
| 16m-b | 同一实例 props 从 A 切到 B，B 尚未发请求，A 就返回 | 不提交（`switched`）、不写缓存、B 视图为空 |
| 16m-c | 同一实例切换后 B 请求先返回，A 再返回 | B 保持、A 判 `stale`/`switched`、不覆盖 |
| 16m-d | 响应 id 与请求会话不一致（服务端串包） | 判 `mismatch`，不提交、不写该 id 的缓存 |
| 16m-e | 切换期间重发请求，旧请求晚返回 | 旧请求判 `stale`，只有最新一代提交 |
| 16m-f | A 在途时切到 B 并发起 B 请求，A 先返回 | A 不得清掉 B 的 `refreshing`（加载态不被旧请求踩） |
| 16m-g | A 的响应晚于 B，且 B 已提交 | 缓存 `A` 为 A 的载荷、`B` 为 B 的载荷，`C` 不存在 |

### 2.4 敏感度（mutation）计划

- 去掉会话一致性判定 → 16m-b/16m-c 失败。
- 去掉响应 id 判定 → 16m-d 失败（串写缓存）。
- 去掉 generation 判定 → 16m-e 失败（旧响应覆盖新结果）。
- 去掉缓存写入 → 16m-a/16m-g 失败（隔离断言拿不到数据）。
- `finally` 里无条件清 `refreshing` → 16m-f 失败。

恢复后全绿，逐项记录抓到的断言。

## 3. 本轮改动范围

- `src/gui/session-detail.tsx`：提取 `createDetailLoader`（生产共用），
  `load`/`loadMore`/`markGone`/`onMount` 改为经由它；导出 `rememberDetail` /
  `readDetailCache` 供测试断言缓存写入。
- `scripts/check-synthetic.ts`：新增 16m 用例（Deferred 驱动）。
- 文档：本文 + `docs/STATS_AUDIT.md`。
- 不动：服务端分页、R1/C1/C2 口径、500 条限制、Schema/索引、搜索与导出、
  UI 结构、依赖、版本号。
