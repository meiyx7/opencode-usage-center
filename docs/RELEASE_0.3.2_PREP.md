# 0.3.2 发布前验收报告（发布准备批次，未执行正式发布）

## 1. npm 版本核查

| 项 | 结果 |
| --- | --- |
| npm 已发布版本 | `0.0.0-stage`, `0.1.0`, `0.1.1`, `0.2.0`, `0.3.0`, `0.3.1` |
| dist-tag `latest` | **0.3.1**（2026-11-12 发布） |
| 0.3.2 占用状态 | **未占用**，可用于本次发布 |
| 仓库 `package.json` 当前版本 | `1.0.0`（0.3.1 发布后仓库侧先行升到 1.0.0，但 1.0.0 **从未发布到 npm**） |

**⚠️ 发布决策时必须处理的版本错位**：发布 0.3.2 前需把 `package.json` 与
`package-lock.json` 的根版本（顶层 `version` 与 `packages[""].version`）从
`1.0.0` **同步**改为 `0.3.2`（publish.yml 有 tag↔package.json 版本硬校验，tag
`v0.3.2` 必须匹配 package.json）。本轮按任务边界**未修改**。

## 2. 真实变更清单（`v0.3.1`（`ba6e113`）→ `7fa451b`）

41 个提交，27 文件，+13,405 / −578。生产代码 9 个文件
（`store.ts` / `session-detail.tsx` / `page.tsx` / `contract.ts` /
`integrations.tsx` / `metrics.ts` / `models-explorer.tsx` / `gui.tsx` 体系），
其余为测试脚本（+4,234 行）与文档（+6,031 行）。

按类归并（完整逐条见 [CHANGELOG.md](../CHANGELOG.md) 0.3.2 节）：

| 类别 | 主要变更 | 来源提交 |
| --- | --- | --- |
| 会话回放真分页 | 服务端 seq 游标分页、首屏只读当前页、边界形态全覆盖、查询计划回归 | 40d3b11, d12c329, 5c6261c, 2c55a1c, e1fc800 |
| 长会话性能 | 汇总缓存（60s/4 条 LRU）、10k fixture 167 页全链 435–447ms、翻页零重复汇总 SQL | e1fc800, 6caf227, a206947（测量与口径修正） |
| 生命周期可靠性 | 16 组竞态修复：切换/刷新乱序/loadMore 并发/Revert/Delete/cleared/dispose 迟到请求 | e036ff4, 14ce9ca, 51078a5, 5e1d129, f3f9eba, 8f1bb19 |
| 成本归因与 GUI | agent×项目归因、费用瀑布、模型效率散点、JSON 导出+脱敏、主题变量化 | dc4b341, 67689e3, 058193e, b48c647, 41227ce |
| 数据可信门槛 | 超 500 条归因完整性、按库指纹隔离日缓存、DST 安全边界、全历史无上限 | cd713bb, 24b5570, e889f0c, 05862ca, 922af62 |
| 工程与 CI | Synthetic 550+ 断言、Scale 三档、check-perf、Bun 锁定 | 7454b84, 98c730e, f0d6f9e, 新增脚本 |

## 3. CHANGELOG.md（本轮新增）

新建根目录 `CHANGELOG.md`，Keep a Changelog 格式：0.3.2「待发布」节 + 0.1.0–0.3.1
历史节。0.3.2 节突出三类核心改进：会话回放真分页、长会话性能、可靠性与生命周期，
并如实区分「0.3.1 之后累积的 0.5/1.0 计划内容随本版一并发布」。所有数字均来自
仓库内测试断言与测量报告，无虚构。

## 4. README 修正（3 处）

| 位置 | 修正前 | 修正后 |
| --- | --- | --- |
| 开头版本说明 | 「当前是 `1.0.0`」（npm 上不存在） | npm 最新 `0.3.1`；`0.3.2` 发布准备中，链接 CHANGELOG |
| 安装示例 | `opencode-usage-center@1.0.0` | `opencode-usage-center@0.3.2`（发布决策后生效） |
| 「发布」章节 | 「第一次发布（npm 目前没有这个包）」+ 手动发布指引（已过时：包自 0.1.0 已存在） | 现行流程：版本 bump → `git tag v0.3.2` → push，publish.yml 自动校验+构建+`--provenance` 发布；注明 0.3.1 起 Trusted Publishing 已验证生效 |

`npm version patch && git push --follow-tags` 的旧建议已移除（与 publish.yml 的
tag 校验语义配合更直观的手工 tag 流程）。

## 5. 发布配置核查

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| `package.json` 发布字段 | ✓ | name/main/module/exports（含 `./gui-experimental`）/files（dist,src,LICENSE）/publishConfig(access public)/engines(node>=20) 全部就绪 |
| tarball 内容 | ✓ | `npm pack --dry-run`：16 文件 / 186.8 kB / unpacked 702.3 kB，含 dist 产物与 src |
| 构建产物 | ✓ | `dist/index.js` 76.0 kB + `dist/gui-experimental.cjs` 220.8 kB（基线 7fa451b 内容一致，CI #47 构建通过） |
| 本地发布封锁 | ✓ **实测** | `npm publish --dry-run` 被 `ensure-ci-publish.mjs` 以非零码拦截 |
| `publish.yml`（Tag 触发） | ✓ 评审通过 | tag↔package.json 版本硬校验、OIDC（`id-token: write`）、`npm publish --access public --provenance`、已发布版本防重复、concurrency 串行 |
| `publish.yml` 触发面收紧（本轮修正） | ✓ 修正后评审 | 移除 `workflow_dispatch`（原手动触发可带任意 ref 走到 Publish 步骤，构成绕过）；仅保留 `push: tags: ['v*']`；另加 Publish 前 ref 硬守卫（非 `refs/tags/v*` 直接失败），纵深防御不依赖触发器配置 |
| `ci.yml`（push 门禁） | ✓ | CI #46/#47 全绿（Typecheck/Build/Wire/Synthetic/Scale×3） |
| Trusted Publishing | ✓ **已验证生效** | npm registry 上 0.3.1 带 SLSA provenance attestation（`dist.attestations.provenance`），证明 OIDC 链路真实工作过；无存储令牌 |

## 6. 未验证项（如实标注，不标记为通过）

1. **0.3.2 的完整 publish 路径未实测**：tag `v0.3.2` 触发 publish.yml 的端到端
   流程要等真正打 tag 才能验证；本轮已静态评审该 workflow 且 0.3.1 用同一路径
   成功发布，但「0.3.2 会成功」是推断不是事实。
2. **npmjs.com 侧 Trusted Publisher 设置界面**无法从仓库侧直接查看；以 0.3.1
   的 provenance 作为链路生效的间接证据。
3. **安装示例 `@0.3.2` 在发布前指向不存在的版本**：README 该示例在 0.3.2 实际
   发布后才与 npm 一致（发布准备文档的固有顺序问题，已在报告与 README 中注明）。
4. `docs/` 内所有验收/性能数字基于本机测量（macOS arm64 / Bun 1.3.14）；CI Runner
   数值另有口径（CI #46 中 synthetic 已提速至 1m26s 总时长）。

## 7. 发布决策时的待办清单（本轮未执行）

1. 版本号**两处同步**：`package.json` 与 `package-lock.json` 根版本均 `1.0.0` →
   `0.3.2`（本轮禁止项，未动；tag 校验只读 package.json，lockfile 同步靠
   `npm version 0.3.2` 一条命令同时更新两处，或手工改后用
   `node -p "require('./package-lock.json').version"` 核对）
2. CHANGELOG.md：把 0.3.2 的「待发布」改为发布日期
3. 确认 main 干净后 `git tag v0.3.2 && git push origin v0.3.2`
4. 观察 publish.yml run：版本校验 → 构建门禁 → `--provenance` 发布
5. 发布后验证：`npm view opencode-usage-center version` 返回 0.3.2、
   provenance 徽标存在、`opencode-usage-center@0.3.2` 安装示例可用

## 8. 发布安全修正（收尾批次）

基线 `255de8e`。修复项：

| 任务 | 内容 | 验证 |
| --- | --- | --- |
| TASK-01 触发面收紧 | publish.yml 移除 `workflow_dispatch`，仅保留 `push: tags: ['v*']`；Publish 前新增 ref 硬守卫步骤，非 `refs/tags/v*` 直接 `exit 1` | YAML 解析通过；触发器只剩 tag；守卫步骤位于 Publish 之前 |
| TASK-02 版本同步要求 | 待办清单改为要求 `package.json` 与 `package-lock.json` 根版本同步更新（§1 警告与 §7 第 1 条）；本轮未修改两文件 | 两文件版本仍为 `1.0.0`（未动） |
| TASK-03 过时注释清理 | 删除「0.1.0 首次发布需手动 CLI/token」注释；文件头改为现行 Trusted Publishing 流程说明，与 README「发布」章节一致 | 注释与 README 措辞核对一致 |

OIDC（`id-token: write`）、`--provenance`、已发布版本防重复、concurrency
`npm-publish` 串行、tag↔package.json 版本校验均未改动。本地发布守卫
`ensure-ci-publish.mjs` 未触碰，封锁实测仍然有效。

## 9. 结论

**发布准备完成。** npm 侧 0.3.2 可用、变更清单真实完整、CHANGELOG 与 README 已
修正、发布链路（本地封锁 / tag 校验 / OIDC Trusted Publishing）经实测或证据验证。
未执行正式发布：未修改版本号、未创建 tag、未发布 npm。等待独立审查与发布决策。
