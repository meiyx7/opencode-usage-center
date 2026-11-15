# TASK-16 请求并发与会话切换稳定性

基线：`f99a265`（main，工作区干净，无 tag）。16.1 已完成于 `e036ff4`（`main` 与
`origin/main` 同步）。本文 §1–§3 是 16.1 的执行前分析与测试设计，§4 起为
**TASK-16.2（刷新与加载更多并发）**。本轮只做 16.2，不碰 16.3–16.5，不碰 TASK-17。

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
| 16m-a | A 首次加载挂起，切到 B（重建路径，两个实例） | B 先返回后 A 晚返回，B 的 detail 不被覆盖；A、B 缓存各自隔离，无第三 key；两者加载态恢复 |
| 16m-b | 同一实例 props 从 A 切到 B，B 尚未发请求，A 就返回 | 判 `switched`，不提交、不写任何缓存 |
| 16m-c | 同一实例切换后 B 请求先返回，A 再返回 | A 判 `stale`，B 保持，只写入 B 缓存 |
| 16m-d | 响应 id 与请求会话不一致（服务端串包） | 判 `mismatch`，不提交，A/B 缓存都为空 |
| 16m-f | A 在途时切到 B 并发起 B 请求，A 先返回 | 不提交、不清 B 的 `refreshing`；B 回来后正常恢复 |

> 原计划的「切换期间重发请求」由 16m-c 的 generation 判定覆盖（同一会话内
> 的刷新乱序属 TASK-16.2）；「缓存隔离」并入 16m-a / 16m-c。

### 2.4 敏感度（mutation）计划

- 去掉会话一致性判定 → 16m-b 失败。
- 去掉响应 id 判定 → 16m-d 失败（串写缓存）。
- 去掉 generation 判定 → 16m-c 失败（旧响应不再判 `stale`）。
- 去掉缓存写入 → 16m-a/16m-c 失败（隔离断言拿不到数据）。
- `finally` 里无条件清 `refreshing` → 16m-f 失败。

实际执行结果记录在 `docs/STATS_AUDIT.md` §19；每项恢复后重跑全绿。

## 3. 本轮改动范围

- `src/gui/session-detail.tsx`：提取 `createDetailLoader`（生产共用），
  `load`/`loadMore`/`markGone`/`onMount` 改为经由它；导出 `rememberDetail` /
  `readDetailCache` 供测试断言缓存写入。
- `scripts/check-synthetic.ts`：新增 16m 用例（Deferred 驱动）。
- 文档：本文 + `docs/STATS_AUDIT.md`。
- 不动：服务端分页、R1/C1/C2 口径、500 条限制、Schema/索引、搜索与导出、
  UI 结构、依赖、版本号。

---

## 4. TASK-16.2 现状分析（执行前核查，`e036ff4`）

### 4.1 两条请求路径的判定能力对比

| 路径 | 请求身份 | 响应回来后的判定 | 状态收尾 | 缓存写入 |
| --- | --- | --- | --- | --- |
| `loader.load()`（首次加载 / 刷新 / 重试 / Revert 强刷） | `{generation: ++generation, sessionID}` | `stale` → `gone` → `switched` → `mismatch`（响应 id） | 仅最新代清 `refreshing` | 仅 `commit` 判定通过后 `setDetail` + `remember` |
| `loadMore()`（组件内联，未走协调器） | `const id = loader.generation`（**只读取，不递增**） | 仅 `id !== generation`、`sessionGone()` | `catch` 无条件 `setError`；`finally` 无条件 `setLoadingMore(false)` | `applyLoadMoreResult(current, next)` → `setDetail` + `rememberDetail`，按**载荷 id** 分槽 |

`loadMore` 入口守卫沿用 `canLoadMore({ sessionGone, hasMore, loadingMore, refreshing,
inFlight: loader.inFlight })`；`inFlight` 只统计 `load()`，loadMore 自身不改变它，
因此 loadMore 在途时刷新按钮仍可触发（刷新会递增 `generation`，令旧分页作废）。
这一条是**既有语义，本轮保持不变**。

### 4.2 真实缺陷与风险（按可复现性排序）

| ID | 问题 | 触发路径 | 后果 |
| --- | --- | --- | --- |
| D1 | `loadMore` 无会话一致性判定 | 同一实例 `props.session` A→B 且未发新请求（16.1 指出的 `Show` 隐含假设）；`generation` 不变、`sessionGone` 为 false | 旧 A 分页被 `setDetail(merged)` 写回 B 的视图，并按 A 的 id 写缓存 |
| D2 | `loadMore` 无响应 id 判定 | 服务端返回 `next.id` 与请求会话不一致 | `rememberDetail(merged)` 按载荷 id 串写别的会话缓存槽；16.1 已修 `load`，此处未修 |
| D3 | `catch` 无 checkpoint | loadMore 在途时点刷新 / 收到 Revert / 会话被删除，随后旧请求失败 | 旧请求把 `error` 写到新视图，覆盖最新请求刚清空的错误态；失败不破坏有效数据的要求被破坏 |
| D4 | `finally` 无请求身份 | 两个 loadMore 生命周期交叠（外部提前复位 `loadingMore` 即可构造） | 旧请求清掉新请求的 `loadingMore`，按钮提前可点 → 重复请求 / 重复追加 |
| D5 | 没有「loadMore 代」概念 | 两次 loadMore 之间，主 `generation` 只由 `load`/`invalidate` 推进 | 守卫 `loadingMore()` 是唯一屏障，且是外部信号而非请求身份；一旦屏障失效，两个响应都会提交 |
| D6 | 用发起时快照 `current` 合并 | 同代内 detail 被其它路径改写 | 旧快照覆盖较新结果（现由 `generation` 间接挡住，但结构上无防护） |
| D7 | 卸载后响应仍写入 | `onCleanup` 只 abort 事件订阅，无卸载标志 | 视图信号写入无 DOM 影响，但**模块级 `DETAIL_CACHE` 写入是真实副作用**。按任务划分留 TASK-16.4，本轮不改 |

正常分页语义本身（`applyLoadMoreResult` 的重复页 / 空页 / 游标无进展判定、15k 已验证）
没有发现缺陷，本轮只补「这些响应在并发下能否被正确丢弃或提交」的覆盖，不改判定实现。

### 4.3 当前无法被自动化测试覆盖的真实异步路径

1. **Solid `Show` 的真实重建 / 卸载时机**：无 DOM 与测试渲染器，且不新增依赖；
   用「两个独立协调器实例」模拟重建路径、「同一实例改 `currentSessionID()`」模拟
   原地切换，覆盖的是协调器判定，不是框架行为。
2. **真实 RPC 时序**：用 Deferred 精确控制返回顺序替代，不依赖 `setTimeout`。
3. **按钮 `disabled` 的 DOM 表现**：只断言 `loadingMore` / `refreshing` 信号值。
4. **卸载后写入**：真实存在（见 D7），按任务划分留 16.4。

## 5. TASK-16.2 测试设计

### 5.1 覆盖层级声明

**不是组件 E2E。** 不挂载 SolidJS 组件，不新增依赖。测试驱动的是组件**实际调用**
的生产路径：`createDetailLoader`（本轮把 `loadMore` 也接入，组件首次加载 / 刷新 /
重试 / Revert 强刷 / 加载更早回合全部经由它）、`canLoadMore` 入口守卫、
`applyLoadMoreResult` 归并，以及真实的 `DETAIL_CACHE` 写入 / 读取 / 失效函数。
断言对象是协调器的视图提交、状态信号与缓存副作用，不是独立 helper 的返回值复刻。

### 5.2 可控异步机制

沿用 16m 的手写 `Deferred<T>` 与 `harness`（`fetch` 注入、状态记录）。新增
`reject` 能力用于失败路径。每个用例独立 Deferred，用例开始先
`invalidateDetailCache()`，用例间不共享缓存与协调器状态；返回顺序由测试的
`resolve` / `reject` 调用顺序决定，结果可重复。

### 5.3 用例清单（16n）

| ID | 场景 | 关键断言 |
| --- | --- | --- |
| 16n-a | 同一会话连续两次刷新，#1 晚于 #2 返回 | #1 判 `stale`；视图与缓存只保留 #2；#1 返回时 #2 的 `refreshing` 仍为 true，#2 完成后恢复 |
| 16n-b | loadMore 在途，同一实例切到 B（未发新请求） | 判 `switched`；A 分页不追加；A/B 缓存都不写 |
| 16n-m | 重建路径：A 实例 loadMore 挂起，切到 B 实例；B 先回、A 后回 | B 视图无 A 分页；A 只写 A 缓存、B 只写 B 缓存，互不污染 |
| 16n-c | 连续触发两次 loadMore | 第 2 次被守卫拦下（`skipped`）、请求数 1；#1 返回只追加一次 |
| 16n-d | loadMore 与 refresh 同时触发（loadMore 先在途） | refresh 提交；loadMore 判 `stale` 不追加、不推进游标；`loadingMore` / `refreshing` 均恢复 |
| 16n-e | loadMore 返回重复页（首回合 index == 游标） | `hasMore=false`、`nextBefore=0`、回合数与对象引用不变；缓存与视图一致 |
| 16n-f | loadMore 返回空页 | 已加载回合不丢，终止分页 |
| 16n-g | loadMore 返回游标倒退页（index > 游标） | 同 e，异常页不合并 |
| 16n-l | 连续两页正常有进展的 loadMore | 游标单调前移、无重复 index、缓存回合数与视图一致 |
| 16n-h | loadMore 失败后重试 | `error` 有值、`loadingMore=false`、detail 与缓存保持失败前有效数据；再次 loadMore 成功且只追加一次 |
| 16n-i | 连续刷新中 #1 失败、#2 成功 | #1 失败不写 `error`、不破坏 #2 数据；`refreshing` 正确恢复 |
| 16n-j | 过期 loadMore 失败（refresh 已发起） | 不 `setError`，错误态保持空 |
| 16n-k | loadMore 响应 id 与请求会话不一致 | 判 `mismatch`；不提交、不写别的会话缓存 |
| 16n-o1 / 16n-o2 | 构造两次 loadMore 生命周期交叠（外部提前复位 `loadingMore`），分别让 #1 先回 / #2 先回 | 旧分页一律判 `stale`、不重复追加；#1 先回时不得清掉 #2 的 `loadingMore`；游标只由 #2 推进 |

> 16n-o 只为验证「响应身份兜底」：守卫语义与生产代码不变，测试显式复位的是
> 状态信号（模拟旧生命周期提前清状态），不是让生产绕过守卫。

### 5.4 敏感度（mutation）计划

- 去掉 `loadMore` 会话一致性判定 → 16n-b 提交 A 分页并写缓存。
- 去掉响应 id 判定 → 16n-k 提交并串写缓存。
- 去掉主 `generation` 判定 → 16n-d 旧分页覆盖刷新结果。
- 去掉 `moreGeneration` 判定 → 16n-o 重复追加。
- `catch` 无条件 `setError` → 16n-j / 16n-i 失败。
- `finally` 无条件清 `loadingMore` → 16n-o 失败。
- 去掉缓存写入 → 16n-m / 16n-e 隔离与一致性断言失败。

每项恢复后重跑全套，结果记入 `docs/STATS_AUDIT.md` §20。

### 5.5 本轮改动范围与边界

- `src/gui/session-detail.tsx`：`createDetailLoader` 增加 `loadMore()` 生产路径；
  组件 `loadMore` 改为调用它；新增 `isLoadingMore` / `isRefreshing` / `setLoadingMore`
  注入项；`DetailRejectReason` 增加 `skipped`（守卫拦下、未发请求）。
- `scripts/check-synthetic.ts`：新增 16n 用例组（复用 16m 的 Deferred / harness）。
- 文档：本文 §4–§5 + `docs/STATS_AUDIT.md` §20。
- **不动**：服务端分页算法、R1/C1/C2 统计口径、会话列表 500 条限制、Schema/索引、
  搜索与导出、UI 结构与文案、既有 loadMore 守卫语义与游标判定、依赖、版本号、发布流程。

---

## 6. TASK-16.2 执行结果

### 6.1 变更文件清单（相对 16.1 完成态 `e036ff4`）

| 文件 | 改动 |
| --- | --- |
| `src/gui/session-detail.tsx` | 协调器新增 `loadMore()`（`MoreTicket` / `checkpointMore` / `commitMore`、独立 `moreGeneration`）；options 增加 `isRefreshing` / `isLoadingMore` / `setLoadingMore`；`DetailRejectReason` 增加 `skipped`；组件删除内联 `loadMore()`，按钮改调 `loader.loadMore()`；注释同步。约 +90 / −44 行 |
| `scripts/check-synthetic.ts` | `Deferred` 增加 `reject`；手写类型签名与 harness 状态同步新入口；新增 16n 用例组（113 条断言语句，含参数化复用）。约 +349 / −7 行 |
| `docs/TASK16_ASYNC.md` | 本文 §4（现状分析）、§5（测试设计）、§6（执行结果） |
| `docs/STATS_AUDIT.md` | §20 阶段 B 第四轮审计记录 |

未改动：服务端分页、R1/C1/C2 口径、500 条限制、Schema/索引、搜索与导出、
UI 结构与文案、`canLoadMore` 守卫语义、游标判定实现、缓存容量、依赖、版本号。

### 6.2 关键竞态测试清单及结果

全部用例由 Deferred 固定返回顺序，驱动生产 `createDetailLoader` 与真实缓存，
`npm run test:synthetic` **通过**（无失败断言）。

| 用例 | 覆盖竞态 | 结果 |
| --- | --- | --- |
| 16n-a | 连续刷新、旧响应晚于新响应 | `stale`，视图/缓存只留新刷新，提交 1 次，加载态恢复 |
| 16n-b | loadMore 在途同实例切换会话 | `switched`，旧分页不追加，A/B 缓存都不写 |
| 16n-m | 重建路径 A/B 两个实例 | A 只写 A 缓存，B 视图只提交 1 次，无第三会话 key |
| 16n-c | 连续两次 loadMore | 第二次 `skipped`，只发 1 请求、只追加 1 次 |
| 16n-d | loadMore 与 refresh 并发 | 刷新提交，旧分页 `stale`，游标不前进，两状态恢复 |
| 16n-e/f/g | 重复页 / 空页 / 游标倒退页 | 保留原回合对象，终止分页，守卫拒绝后续请求 |
| 16n-l | 连续两页正常加载 | 157–162 无重复无乱序，游标 161→159→157 单调前移 |
| 16n-h | loadMore 失败后重试 | 错误态设置、`loadingMore` 恢复、数据/缓存不变、重试成功且只追加 1 次 |
| 16n-i | 连续刷新中旧刷新失败 | 旧失败不写错误、不破坏新刷新 |
| 16n-j | 过期 loadMore 失败 | 判 `stale`，错误态保持为空 |
| 16n-k | 响应 id 与会话不一致 | `mismatch`，不提交、不串写 B 缓存 |
| 16n-o1/o2 | 两次分页生命周期交叠（旧分页先回 / 晚回） | 旧分页一律 `stale`，只追加 1 次，不清新请求 `loadingMore` |

**敏感度验证**：§5.4 的 7 项削弱全部被对应用例检出（失败断言 1–7 条不等），
逐项恢复后重跑全绿。明细见 `docs/STATS_AUDIT.md` §20。

### 6.3 缓存隔离与失效验证结果

- 每个用例起始 `invalidateDetailCache()` 清空模块级 `DETAIL_CACHE`，断言全部
  通过真实 `readDetailCache` 读取，不是模拟缓存对象。
- 切换 / 过期 / 响应 id 不匹配 / 失败路径：缓存条目不被创建，也不被旧响应改写。
- 正常追加与无进展终止路径：缓存回合数与视图逐项一致。
- 重建路径（16n-m）：A、B 各自分槽，互不污染，无第三会话 key。
- 缓存容量（4 条）与淘汰策略未改；本轮未做容量压力验证。

### 6.4 本地全套回归

`typecheck` ✓ · `build` ✓ · `test:plugin` wire ✓ · `test:synthetic` ✓ ·
`test:scale` base / medium / large ✓（冷缓存 76 / 430 / 1613 ms，峰值内存
74 / 165 / 402 MB）。CI run 的 ID、对应 SHA 与各步骤结果以本轮交付报告为准。

### 6.5 覆盖层级与尚未覆盖的风险

**不是组件 E2E**：未挂载 SolidJS 组件，不新增依赖；驱动的是组件实际调用的
请求协调、状态更新与缓存写入路径。

| 风险 | 原因 / 归属 |
| --- | --- |
| 卸载后响应仍写 `DETAIL_CACHE` | 真实存在（`onCleanup` 只 abort 事件订阅，无卸载标志），按任务划分留 TASK-16.4；本轮不引入额外状态层 |
| Revert / Delete / cleared 事件竞态 | 留 TASK-16.3；结构上 `invalidate()` / `load(true)` 已令在途分页作废，但尚无确定性用例 |
| Solid `Show` 真实重建 / 卸载时机 | 无 DOM 与测试渲染器；用两个协调器实例模拟重建、同实例改 `currentSessionID()` 模拟原地切换 |
| 真实 RPC 网络时序 / 按钮 `disabled` 的 DOM 表现 | 由 Deferred 替代；只断言 `loadingMore` / `refreshing` 信号值 |
| 缓存淘汰压力、10,000 回合长会话性能 | 留 TASK-17 |
