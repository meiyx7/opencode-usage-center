# TASK-17.1 长会话性能基线报告（只读，无生产代码改动）

## 1. 审计范围与基线

| 项 | 值 |
| --- | --- |
| 执行基线 | `aa2f14b9d02d1d28ebd9cf8ff68bd19ec1f88848`（main，工作区干净） |
| 任务书给出的 CI 单次观测 | 首屏 403ms / 正文 120 行 / JSON 解析 120 次 0.4MB / 汇总扫描 40,000 行 / 167 页全链 67.3s / 单页最大 120 行 |
| 本机环境 | macOS arm64，Bun 1.3.14，本地独占运行（无并行重负载） |
| fixture | 与 `scripts/check-synthetic.ts` 15g 逐字一致：10,000 回合 / 20,000 消息 / 单条 assistant 正文 21.8KB / 3 个索引 / DB 216.2MB |
| 重复方式 | 父进程构造**同一个 DB 文件一次**，spawn 3 个**独立子进程**各跑一整套测量；每个子进程全新启动 = 天然冷缓存。同机器、同环境、同 fixture |
| 测量工具 | `scripts/check-perf.ts`（新增只读工具），原始数据 `docs/perf/TASK17_1_raw.json` |
| 复现命令 | `bun scripts/check-perf.ts 3`（单次约 48s，3 次约 2.5 分钟） |

本轮**未修改任何生产代码**（`src/` 零改动）。测量脚本通过运行时包裹 `bun:sqlite` 的 `Database.prototype.query` 做 SQL 语句级计时，不改 `store.ts`；通过生产已有的 `globalThis.__ucReadProbe` / `__ucPageReads` / `__ucSummaryProbe` 探针取解析量；`wire()` 用 `src/index.ts:10-12` 完全相同的 `JSON.parse(JSON.stringify(value))` 表达式单独计时。

## 2. 测量方法与分层

- **冷缓存**：新 `UsageStore` 实例 + `force:true` 首屏，必走 `buildSessionSummary`。
- **热缓存**：同实例第二次首屏（不传 `force`），命中服务端 `sessionCache`。
- **服务端**：`UsageStore.sessionDetail()` 真实调用，SQL 按语句标签归因；`冷 − 热` 近似 `buildSessionSummary` 成本；`热总 − 热SQL` 近似回合对象构建成本。
- **RPC**：只测 `wire()` 的序列化净化往返（生产同形）；**未测**插件宿主实际 IPC 传输与浏览器侧反序列化。
- **前端合并**：生产导出的 `applyLoadMoreResult`（内部含 `mergeTurns` 的 Map 去重 + 全量排序）逐页计时。
- **渲染**：**未测量**。未挂载 SolidJS、无 DOM；搜索/展开/折叠只测信号层纯计算，不得称为渲染耗时。
- **正确性**：每次测量内置 16 项断言（见 §8），失败即以非零码退出。

全链同时跑两种语义，这是本轮最重要的对照：

| 模式 | 请求形态 | 对应现实 |
| --- | --- | --- |
| `force-every-page` | 167 页每页都传 `force:true` | 复现 15g / CI 的 67.3s 数字 |
| `summary-cache` | 首屏一次冷汇总，翻页**不传 force** | 生产 `createDetailLoader.loadMore()` 的真实入参（`fetch({sessionID, beforeTurn})`，无 `force`） |

## 3. 十项指标（3 次独立测量的 min / 中位数 / max）

| # | 指标 | min | 中位数 | max | 单位 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冷首屏请求耗时 | 280.98 | **288.46** | 295.17 | ms |
| 1 | 热首屏请求耗时（缓存命中） | 1.06 | **1.23** | 1.28 | ms |
| 2 | 冷首屏 SQL 查询耗时 | 274.63 | **281.83** | 288.26 | ms |
| 2 | 热首屏 SQL 查询耗时 | 0.57 | **0.63** | 0.66 | ms |
| 3 | 首屏消息读取 | 120 | **120** | 120 | 行 |
| 3 | 首屏正文传入 JS | 462,180 | **462,180** | 462,180 | 字节（0.44MB） |
| 4 | 首屏 JSON 解析次数 | 120 | **120** | 120 | 次 |
| 4 | 首屏 JSON 解析字节 | 462,180 | **462,180** | 462,180 | 字节 |
| 5 | 回合对象构建耗时（热首屏总 − SQL） | 0.49 | **0.59** | 0.63 | ms |
| 5 | 冷首屏 JS 聚合耗时（总 − SQL） | 6.34 | **6.63** | 6.91 | ms |
| 6 | 单页 loadMore 服务端耗时（`force` 链，链内 min/p50/p95/max） | 274.83 | **281.44** | 297.31 | ms（p95 288.53） |
| 6 | 单页 loadMore 服务端耗时（`cache` 链，链内 min/p50/p95/max） | 0.596 | **1.072** | 286.14 | ms（p95 1.295，max 为首屏冷汇总） |
| 7 | 167 页完整加载（`force` 链墙钟） | 47.22 | **47.88** | 48.27 | s |
| 7 | 167 页完整加载（`cache` 链墙钟） | 0.560 | **0.562** | 0.565 | s |
| 8 | 全链累计 JSON 解析 | 20,000 | **20,000** | 20,000 | 次 |
| 8 | 全链累计解析字节 | 77,028,890 | **77,028,890** | 77,028,890 | 字节（73.5MB） |
| 8 | 全链累计 `wire()` 序列化字节 | 185,342,462 | **185,342,462** | 185,342,462 | 字节（176.8MB） |
| 9 | 峰值高水位 RSS | 1,179 | **1,212** | 1,214 | MB |
| 9 | 内存增长（终 − 启） | 1,081 | **1,110** | 1,115 | MB |
| 10 | 搜索首次（建 WeakMap 索引） | 102.97 | **103.96** | 104.21 | ms |
| 10 | 搜索二次（命中索引） | 7.72 | **8.28** | 8.38 | ms |
| 10 | 全部展开（`Set` 构造） | 0.40 | **0.47** | 0.48 | ms |
| 10 | 全部折叠（`Set` 构造） | ~0.0002 | **~0.0002** | ~0.0002 | ms |

补充常量项（每次运行均一致）：首屏 RPC `wire()` 0.50ms / 1,112,127 字节；汇总结构化扫描 40,000 行、正文传入 JS **0 字节**；单页最大读取 120 行；167 页 / 10,000 回合 / 无缺失无重复 / Σ页 cost = 10.00 = 全会话。

## 4. 分层耗时（区分服务端、RPC、前端合并与渲染）

| 层 | 首屏（冷 / 热） | 167 页全链（`cache` 语义） | 167 页全链（`force` 语义） |
| --- | --- | --- | --- |
| 服务端 SQL | 281.83 / 0.63 ms | ≈411.9 ms（首屏冷汇总 282.0 ms，翻页 SQL ≈129.9 ms） | ≈47,365.9 ms（其中两条汇总 SQL 47,113.1 ms，占 98.7%） |
| 服务端 JS（回合构建/聚合） | 6.63 / 0.59 ms | ≈52.7 ms | ≈385.1 ms |
| RPC `wire()` | 0.50 / — | 66.81 ms | 81.61 ms |
| 前端合并 `applyLoadMoreResult` | — | 26.80 ms（单页 max 1.16ms） | 47.61 ms（单页 max 1.38ms） |
| **渲染** | **未测量**（无 SolidJS 挂载 / 无 DOM） | 同左 | 同左 |

冷首屏 SQL 逐语句（3 次合计，单次均值）：

| SQL | 次数 | 累计 ms | 单次均值 ms | 占比 |
| --- | --- | --- | --- | --- |
| `summary.toolStats`（`json_each` 展开 30,000 个 content 元素） | 3 | 526.5 | **175.50** | 62.3% |
| `summary.scalars`（10,000 行 × 11 个 `json_extract`） | 3 | 313.9 | **104.62** | 37.1% |
| `page.pageMessages`（本页 120 行） | 3 | 1.2 | 0.39 | <0.2% |
| `summary.requestCount` / `userCount` / `page.turnCountBefore` | 9 | 2.5 | ~0.28 | <0.3% |
| 其余（`firstModel` / `firstMessage` / `userBoundaries` / `lastSeq` / `sessionRow` / PRAGMA） | 30 | 1.2 | <0.04 | <0.2% |

即：**冷首屏 288ms 里 280ms 是两条全会话汇总 SQL**，分页相关 SQL 合计 <1ms。

逐页耗时分布（run 1 链内，保留完整数组于 `docs/perf/TASK17_1_raw.json` 的 `perPageServerMs`）：

- `force` 链：n=167，min 274.83 / p50 281.44 / p95 288.53 / max 297.31 ms，首末页 281.61 / 282.06 ms —— **平坦，无随游标恶化的趋势**。
- `cache` 链：n=167，min 0.596 / p50 1.072 / p95 1.295 / max 286.14 ms（唯一异常点是首页冷汇总），末页 0.596 ms —— **翻页成本不随已加载回合数增长**。

## 5. 冷 / 热缓存与 CI 观测值对照

| 对照 | 本机 3 次中位数 | CI 单次 | 比值 |
| --- | --- | --- | --- |
| 冷首屏 | 288.46 ms | 403 ms | 1.40× |
| 167 页 `force` 全链 | 47.88 s | 67.3 s | 1.41× |

两个比值几乎一致，说明本机与 CI Runner 跑的是**同一段代码路径、同一 fixture**，差异来自机器速度而非逻辑变化。按任务书要求，**不把不同 Runner 的单次耗时当作性能退化证据**。

关键对照：`force` 链 47.88s vs `cache` 链 0.562s ≈ **85×**。SQL 计数给出原因 —— `force` 链 `summary.scalars` 与 `toolStats` 各执行 **167 次**，`cache` 链各 **1 次**。

## 6. 缓存命中与重复解析核查

| 项 | 结果 |
| --- | --- |
| 服务端 `sessionCache`（4 条 / 60s / LRU） | 冷首屏 1 次汇总；热首屏 0 次；`cache` 链 167 页仅 1 次 |
| 前端 `DETAIL_CACHE`（4 条 / 120s / LRU） | 由 16m/16q 覆盖，本轮不改；有效缓存仍可复用 |
| 重复 JSON 解析 | 无：全链恰好 20,000 次（每条消息一次），两种链模式完全相同；汇总阶段正文传入 JS 恒 0 字节 |
| 汇总结果是否避免重复解析 | 是：`cache` 链 166 次翻页完全跳过 `toolStats` + `scalars` |
| `wire()` 序列化 | 每页约 1.11MB，全链 176.8MB；这是分页 RPC 契约的固有体积，两种链模式一致 |
| 搜索索引 | `WeakMap<SessionTurn, string>` 按回合对象缓存；`mergeTurns` 复用回合对象引用，翻页不会重复建索引 |

内存分段（中位数，MB）：启动 99 → `force` 链后 455 → `cache` 链后 706 → 全量搜索后 943 → CSV 后 966 → JSON 导出后 1,212。峰值主要由 **JSON 导出生成的 172.6MB 字符串**（+246MB RSS）、**搜索索引**（+237MB）和 Bun 的 GC 回收时机共同构成；这是 Bun 进程内的 RSS 高水位，**不是浏览器堆快照**，且测量脚本在同一进程内连续做了两条全链 + 全量导出，比单个真实视图持有更多 transient 对象。

## 7. 查询计划（在 216MB / 20,000 行真实 fixture 上，不是空库）

| 查询 | 计划 |
| --- | --- |
| `userBoundaries` | `SEARCH session_message USING COVERING INDEX session_message_session_type_seq_idx (session_id=? AND type=? AND seq<?)` |
| `firstMessage` | `SEARCH ... USING INDEX session_message_session_seq_idx` |
| `pageMessages` | `SEARCH ... USING INDEX session_message_session_seq_idx (session_id=? AND seq>? AND seq<?)` |
| `turnCountBefore` | `SEARCH ... USING COVERING INDEX session_message_session_type_seq_idx` |
| `summaryScalars` | `SEARCH ... USING INDEX session_message_session_type_seq_idx (session_id=? AND type=?)`，**无 TEMP B-TREE**（`ORDER BY seq` 由索引满足） |
| `toolStats` | `SEARCH sm USING INDEX ...` + `SCAN je VIRTUAL TABLE INDEX 1:`（`json_each` 虚拟表展开，非会话表扫描） |
| `lastSeq` | `SEARCH ... USING COVERING INDEX session_message_session_seq_idx` |

全部命中索引、无 `SCAN session_message`、无临时排序；`seq` 游标查询稳定。

## 8. 正确性与稳定性

每次运行 16 项断言全绿，3 次 `failures: []`：游标查询全部命中索引、首屏 60 回合 / 120 行 / 120 次解析 / 汇总 40,000 行 / 汇总正文 0 字节、冷首屏含全会话汇总 SQL 且热首屏命中缓存、`force` 链 167 次汇总与 `cache` 链 1 次汇总、两条链 167 页 / 10,000 回合 / 无缺失无重复 / Σ页 cost = 全会话 / 单页 ≤130 行、全量 10,000 回合、展开集合大小正确。

测量稳健性：`scripts/check-perf.ts` 不做任何生产改动；Bun 会按 SQL 文本复用 `Statement`，包裹器用 `WeakSet` 保证每个 Statement 只包一次（否则计数会变成三角数，首次冒烟已发现并修复）；失败时仍写出完整原始 JSON 并以非零码退出；无未 resolve 的 Promise（本工具不用 Deferred）。

## 9. 覆盖层级声明与限制

本轮驱动的是**生产服务端分页/汇总 SQL、生产 `UsageStore.sessionDetail`、生产 RPC `wire()` 同形序列化、生产前端合并/搜索/导出纯函数**与真实 fixture 数据库。**未挂载 SolidJS 组件、无 DOM、无浏览器**：不是组件 E2E，也不是渲染性能测量。渲染耗时、真实 IPC 网络传输、浏览器反序列化与 DOM 布局重排均未覆盖，报告中一律以「未测量」标注，不用信号层计算冒充。

## 10. 完整本地回归（本阶段，生产代码零改动）

| 检查 | 结果 |
| --- | --- |
| Typecheck | ✓ |
| Build | ✓ `dist/gui-experimental.cjs` 220.83 kB / gzip 56.62 kB；`dist/index.js` 74.2 kB |
| Plugin Wire | ✓ `wire ok` |
| Synthetic | ✓ 15g 输出「首屏 295ms / 正文 120 行 0.4MB / JSON 解析 120 次 / 汇总扫描 40,000 行 / 全链 167 页 46,941ms / 单页最大 120 行」，与独立测量脚本的 288ms / 47.88s 相互印证 |
| Scale base | ✓ 冷 69ms / 热 8ms / 峰值 74MB |
| Scale medium | ✓ 冷 364ms / 热 115ms / 峰值 165MB |
| Scale large | ✓ 冷 1432ms / 热 507ms / 峰值 402MB |

本阶段未修改 `src/`、`scripts/check-synthetic.ts`、`package.json`、`.github/`，故上述结果同时也是「无回归」的证据，而不是新代码的验收。CI 结果在推送后单独报告。

## 11. 原始数据

`docs/perf/TASK17_1_raw.json` 保留 3 次运行的全部原始数值，含 `perPageServerMs` 逐页数组（167 × 2 × 3）、每次运行的 SQL 分项计数/耗时、查询计划文本、内存分段与逐项断言结果，供优化前后逐项对比。
