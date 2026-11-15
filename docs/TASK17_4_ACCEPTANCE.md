# TASK-17.4 长会话性能专项最终验收报告（第二批收尾）

## 1. 最终基线 SHA

| 项 | 值 |
| --- | --- |
| 执行基线 | `6caf227464e54cfa95b4613007469ac313ba55db`（main，工作区干净，`git status` 零输出） |
| CI Run | [43708219978](https://github.com/meiyx7/opencode-usage-center/actions/runs/43708219978)（CI #46，push 事件，**SHA 精确匹配 6caf227**，Success，1m26s） |
| 验收方式 | 只读审查 + 现有自动化回归核验；本轮**零生产代码改动**，唯一提交为本报告文档 |

## 2. 第二批任务完成情况

第二批「会话回放真正分页与长会话性能优化」覆盖 `docs/STATS_AUDIT.md` §13–§25 对应的任务：

| 任务 | 状态 | 提交 | 关键产出 |
| --- | --- | --- | --- |
| 阶段 A 服务端真分页（TASK-01～06） | ✓ | 40d3b11…e1fc800 | `buildSessionSummary` / `buildTurnPage` / seq 游标 / `SESSION_PAGE_SQLS` |
| 阶段 A 收尾（TASK-06～09） | ✓ | 5c6261c / 2c55a1c | 请求计数、页界、覆盖索引、10k 用例、查询计划回归 |
| 阶段 A 最终补丁（TASK-10～13） | ✓ | 5c6261c / 2c55a1c / 7c8ba5d | 工具错误真值、探针、Revert 失效、删除事件竞态 |
| TASK-14 前端数据流核查 | ✓ | f3f9eba / 8f1bb19 | 游标停滞守卫、共享 loadMore 链回归 |
| TASK-15 搜索与导出范围 | ✓ | f99a265 | 搜索/导出只作用于已加载回合 |
| TASK-16.1 首次加载与会话切换 | ✓ | e036ff4 | A/B 切换不串会话、mismatch 拒提交 |
| TASK-16.2 刷新与 loadMore 并发 | ✓ | 14ce9ca | 旧刷新不覆盖新视图、分页代际协调 |
| TASK-16.3 Revert/Delete/cleared 竞态 | ✓ | 51078a5 | cleared 不再混同 committed、refreshing 卡死修复 |
| TASK-16.4 卸载与缓存生命周期 | ✓ | 5e1d129 | `disposed` 逻辑失效、幂等 dispose、迟到请求零写入 |
| TASK-16.5 整体集成验收 | ✓ | aa2f14b | R1/C1/C2 一致、无假分页残留、P0/P1 清零 |
| TASK-17.1/17.2 性能基线与瓶颈 | ✓ | a206947 | 85× 口径差异定位、O-1 建议 |
| TASK-17.3 测试口径修正 | ✓ | 6caf227 | 15g 生产语义化、17a 缓存行为测试、SQL 计数证明 |

## 3. 生产代码改动范围与约束核对

第二批完整 diff 范围 `41227ce..6caf227`：14 个文件、+10,194/−342。

**生产代码仅 3 个文件**：`src/server/store.ts`（+531/−…，真分页与汇总缓存）、`src/gui/session-detail.tsx`（请求协调器）、`src/gui/page.tsx`（事件分支）。其余为测试（`scripts/check-synthetic.ts`、`scripts/check-perf.ts`）与文档。

| 约束项 | 核对结果 | 证据 |
| --- | --- | --- |
| 新依赖 / 版本号 | **无** | `git diff 41227ce..6caf227 -- package.json` 为空 |
| schema / 索引写入 | **无** | diff 中无任何 `CREATE TABLE` / `CREATE INDEX` 变更 |
| 缓存 TTL / 容量 / LRU | **未变** | `DETAIL_CACHE_MS = 60_000` 不变；sessionCache 仅 value 类型收窄（整页 detail → 汇总），命中/失效语义不变 |
| 会话列表 LIMIT 500 | **未变** | `store.ts:1343` 保持 `LIMIT 500` |
| R1（reasoning 不计入有效 Token） | **未变** | 批量 diff 中无 `input + output` 合计相关改动；synthetic 主场景断言 `input + output = 90,000`、`cacheRead = 240,000` 独立字段 |
| C1（cost 缺失/为 0 均按 0） | **未变** | `COALESCE(json_extract(data,'$.cost'),0)` 保持 |
| C2（Sessions 模型筛选按 modelID） | **未变** | `page.tsx:818` 保持 `session.modelID !== modelFilter()` |
| 分页协议 / 游标 / 排序 | **未变**（阶段 A 内按任务建立后冻结） | 16n-l 断言游标单调；15f 断言 59/60/61 边界；15h 断言查询计划走覆盖索引 |
| 搜索 / 导出 / 脱敏语义 | **未变** | 15l 断言脱敏请求无 text/reasoning/tools、保留工具错误计数 |
| 未提交修改 / 遗留文件 | **无** | `git status --short` 零输出 |

## 4. 分页正确性验收（17.4.2，依据现有自动化断言）

| 验收项 | 断言位置 | 结果 |
| --- | --- | --- |
| 首屏只读取当前页 | 15g：首屏正文 120 行 / JSON 解析 120 次 / 汇总正文 0 字节 | ✓ |
| loadMore 只读取新增页 | 15e/15g：单页最大读取 ≤130 行（全会话 20,000 行）；15k 游标逐页断言 | ✓ |
| 游标稳定不遗漏不重复 | 15g：无缺失（Set 对账 10,000）/无重复；15f：59/60/61 边界序号连续 1..N | ✓ |
| 一个 user 对应多个 assistant | 15e（TASK-05C 复杂会话覆盖） | ✓ |
| 无 user 的 assistant（合成回合） | 15e/15f：头部合成回合页、hasMore 终止语义 | ✓ |
| 无 assistant 的 user 回合 | 15e：尾部无回复、totalTurns 独立预期 | ✓ |
| seq 不连续 | 15e fixture seq 跨越 + 游标对账 | ✓ |
| 坏 JSON | 15e：`big requestCount 含坏 JSON 行`、`big cost = 独立预期`（坏行 cost 缺失按 0） | ✓ |
| Revert 截断历史 | 15i：删消息后 force 汇总 = 3 回合、页内无已删回合、无关会话缓存不受影响；16p-a1/a2 已截断回合未复活 | ✓ |
| 全会话汇总与分页明细对账 | 15e：Σ页 cost = summary = 独立预期；15g：Σ页 cost = 汇总 = 10,000 × 0.001 | ✓ |

## 5. 全会话统计对账结果

| 维度 | 覆盖方式 | 结果 |
| --- | --- | --- |
| Cost | synthetic 主场景（600 会话独立预期 $6）、15e/15g（回合级 Σ页对账）、scale 三档独立预期 | ✓ |
| Input / Output（R1 口径） | 主场景 90,000 + 项目维度 45,000 ×2；scale 三维度逐 Key 对账 | ✓ |
| Reasoning / CacheRead / CacheWrite | 字段独立累计；scale 对 `eReasoning/eCacheRead/eCacheWrite` 逐 Key 独立预期对账 | ✓ |
| 请求数 / 回合数 / 工具数 / 错误数 | 15e（`big requestCount/toolCount/errorCount`，含 falsy error 工具与坏 JSON 行） | ✓ |
| TTFT / 总时延 / P50 / P95 | 生产路径 `store.ts percentile()`（ttftP50/P95、totalP50/P95）被主场景与 check-data 真实库执行覆盖；**无独立预期值的分位数断言**（见 §9 P3） | 计算路径 ✓ / 分位数对账未断言 |
| 慢请求比例 | 同上，`slowRate` 随快照计算执行，无独立预期断言（P3） | 同上 |

## 6. 10k 长会话性能结果（17.4.3）

**三种口径严格区分**（不得混用；口径①→②是测试口径修正，**不是生产性能提升**，本轮生产代码零改动）：

| 口径 | 定义 | 167 页全链（本机中位数） | 汇总 SQL 执行次数 |
| --- | --- | --- | --- |
| ① 旧 force-every-page（历史测试口径） | 每页 `force:true` | 47.88s（CI 单次 67.3s，17.1 基线） | 167 × 2 条 = 334 次 |
| ② 修正后生产语义分页（15g 现行） | 首屏 force 冷汇总，翻页复用缓存 | **435–447ms**（17.3 三轮：444/435/447ms） | 首屏 force 各 1 次，**翻页 0 次** |
| ③ 单请求口径（check-perf） | 冷首屏 / 热首屏 / 强制刷新 | 冷 288.46ms / 热 1.23ms / 刷新≈冷 | 冷 1 / 热 0 / 刷新 1 |

17.4.3 验收项逐条确认（`scripts/check-synthetic.ts` 15g + 17a + check-perf 17.1 数据）：

- 10,000 回合 / 20,000 消息 fixture（216.2MB，与 17.1 逐字一致）：✓
- 首屏最多处理当前页：120 行 / 120 次解析 / 0.44MB（<5% 全会话）：✓
- 167 页完整遍历：✓（`huge 全链无缺失回合` / `无重复回合` 断言）
- 正常翻页不重复执行汇总 SQL：✓（`huge 翻页汇总 SQL 执行 0 次`，SQL 计数证明）
- Σ页 Cost = 全会话汇总 = 独立预期（10.00）：✓
- 单页最大读取 120 行 ≤ 130 行：✓
- 搜索 / 导出仍只覆盖已加载回合：✓（15l：首屏/第二页 JSON 搜索命中回合数分开断言，CSV/JSON 范围 = `detail().turns`）
- 缓存生命周期独立测试：✓（17a 12 条：建缓存 / 命中 0 次 / force 绕过 1 次 / 刷新后重新命中 / 四路径统计一致）

## 7. 生命周期验收（17.4.4）

覆盖层级声明：以下全部为**生产函数级确定性测试**（Deferred 精确控制响应顺序、事件 harness、真实缓存），**不是 SolidJS 组件 E2E**——未挂载组件、无 DOM，渲染层未覆盖。

| 场景 | 测试块 | 结果 |
| --- | --- | --- |
| A/B 会话切换 | 16m（a 切换旧首屏拒提交 / d 响应 id mismatch 拒写缓存 / f 旧请求不提交不报错） | ✓ |
| 首屏刷新乱序 | 16n-a：#1 晚于 #2 返回，旧响应不覆盖视图/缓存/错误态 | ✓ |
| loadMore 并发 | 16n-c：守卫拦第二次，只发一个请求 | ✓ |
| loadMore 与 refresh 交错 | 16n-d：刷新提交、旧分页判 stale、不写错误 | ✓ |
| 重复分页 / 空页 / 游标倒退 | 16n-e/f/g：保留已有回合、终止分页、不重复请求 | ✓ |
| 失败后重试 | 16n-h：错误态设置→重试成功清空 | ✓ |
| 过期请求失败 | 16n-j：过期 loadMore 失败不污染当前视图 | ✓ |
| 响应 id 与请求会话不一致 | 16n-k / 16m-d：mismatch 拒提交、零缓存写入 | ✓ |
| Revert committed | 16p-a1/a2（首屏两种时序）、16p-b（loadMore 挂起交错） | ✓ |
| Revert cleared | 16p-f1/f2/f3：不失效、不刷新、不动缓存（D1 回归点） | ✓ |
| session.deleted | 16p-e1/e2：停止消费、重复 delete 无副作用；16q-d5：Delete 清缓存+短路 | ✓ |
| dispose 后迟到请求 | 16q-a1/a2/a3/a4、b1/b2/b3：成功/失败迟到均零状态写入 | ✓ |
| 缓存隔离 | 16q-d4：A/B 缓存互串为零；c3：新实例不受旧实例迟到请求影响 | ✓ |
| 旧请求不覆盖新会话 | 16n-b/m、16q-d3 | ✓ |
| 删除后不再加载或写缓存 | 16q-d5 Delete 后不发请求、短路 | ✓ |
| TTL / LRU / 容量回归 | 16q-e1：120s 过期、容量 4、LRU 保活/淘汰、指定/全清失效 | ✓ |

## 8. CI Run 与逐项结果（17.4.5）

Run [43708219978](https://github.com/meiyx7/opencode-usage-center/actions/runs/43708219978)（CI #46）：push 触发、commit **6caf227**（与基线精确匹配）、**Success、1m26s**（前基线 run 2m38s）。job `build` 全部步骤成功（API 逐 step 核验）：

| Step | 结果 |
| --- | --- |
| Typecheck / Build / Plugin wire tests / Synthetic data tests / Scale regression (base / medium / large) | 全部 success |

Synthetic 结束标志证据链：该步骤 conclusion = success；`check-synthetic.ts` 逻辑保证仅在全部断言通过后打印 `synthetic ok: 600 sessions across 2 projects, attribution complete beyond list cap, cold-start stable` 并以 0 退出（任何失败走 `process.exit(1)`）；同 SHA 本地 5 次复跑均实测打印该标志与 `[长会话] 10000 回合 … 全链 167 页 432–447ms / 翻页汇总 SQL 0 次`。未以旧 SHA 的 CI 结果替代当前提交（#45/a206947 仅作历史对照）。

## 9. 未解决的 P2 / P3（保留，不删除）

| 级别 | 项 | 状态 |
| --- | --- | --- |
| P2 | 10,000 回合全量加载 + 全量搜索/JSON 导出时 Bun 进程 RSS 峰值 1.2GB | 保留（17.2 §6）；只在极端组合出现，改变需动导出/搜索语义（禁止） |
| P3 | TTFT / 总时延 / P50 / P95 / 慢请求比例无独立预期值的分位数断言（计算路径被执行覆盖，无对账断言） | 本轮核实并显式记录；不放宽、不新增范围 |
| P3 | 渲染层 / 真实 IPC 传输 / 浏览器反序列化 / DOM 布局未覆盖（函数级测试，非组件 E2E） | 保留，报告如实声明 |
| P3 | 服务端 sessionCache 在 delete 后最多保留 60s 一条轻量汇总 | 保留（有界、不可读、无正确性影响） |
| P3 | 每页 2 次首条消息查询、汇总 `ORDER BY seq` 等理论冗余（<1ms/页） | 保留，不优化 |
| P3 | GitHub Actions runner 的 Node 20 deprecation 警告、ubuntu-latest 迁移通知 | 仅提示性 annotation，不影响结果 |

已关闭项：P2「15g 夹具 force:true 测量口径」已于 TASK-17.3（6caf227）修正关闭。

## 10. 最终结论

**通过。**

- 真分页功能完整（阶段 A 服务端 + 阶段 B 前端协调器），游标稳定、边界形态全覆盖、无缺失无重复；
- 全会话汇总与分页明细对账一致（Cost / Token / 请求数 / 回合数 / 工具数 / 错误数）；分位数指标为 P3 覆盖缺口，如实记录，不影响口径正确性；
- 10,000 回合长会话在生产语义口径下全链 <0.5s、翻页零重复汇总、单页读取有界；
- 缓存 / 并发 / Revert / Delete / dispose 生命周期 16 组竞态场景全绿，缓存行为由 SQL 执行计数独立证明；
- 搜索、导出、脱敏、R1/C1/C2、LIMIT 500、TTL/LRU、schema/索引、依赖与版本号经 diff 核验零变化；
- CI #46 与基线 SHA 精确匹配、全部步骤成功；
- 文档准确区分生产真实行为 / Synthetic 测试行为 / 本地测量 / CI 测量 / 未覆盖层级 / P2/P3 遗留，且遗留项全部保留。

第二批（会话回放真正分页与长会话性能优化）正式关闭。未发布 npm、未创建 tag、未新增依赖；不自动开启第三批。
