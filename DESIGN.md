# 用量中心 · 设计草图 v0.1

> 目标：给 OpenCode 做一个本地优先的模型用量、订阅额度和时效监控面板。
> 一句话：**用量看得见，额度不爆仓，凭据不过期。**

草图：`design/sketch.html` / `design/sketch.png`

---

## 1. 设计目标

| 能力 | 说明 |
| --- | --- |
| 用量汇总 | Token、费用、请求数、缓存命中，按时间 / 模型 / 供应商 / 项目 / 会话聚合 |
| 订阅量监控 | OpenCode Go 的滚动 5 小时、本周、本月额度；Trae CN（个人 / 企业）Credits；Qoder CN 套餐 + 加油包；统一抽象成 meters 列表 |
| 时效监控 | 首字时延、总时延、输出速度、慢请求比例；OAuth / API Key 到期倒计时 |
| 异常提醒 | 额度将尽、凭据将过期、费用异常、时延劣化、限流 / 重试、数据过期 |
| 本地优先 | 默认只读本机数据，不上传会话内容；导出由用户主动触发 |

---

## 2. 信息架构

```text
模型用量
├── 总览          KPI · Token 趋势 · 费用构成 · 模型分布 · 额度/时效/时延速览
├── 额度与时效    多供应商额度（Go 三档 · Trae Credits · Qoder）· 凭据到期时间线 · 重置倒计时
├── 时延          首字/总时延分位 · 模型对比 · 慢请求 · 限流/重试 · 错误率
├── 会话明细      按项目/模型/时间筛选 · 单会话展开 · 导出 CSV / JSON
└── 设置          刷新频率 · 告警阈值 · 手动订阅 · 货币 · 数据保留
```

入口：

- Settings 页「模型用量」
- 顶栏胶囊「用量 98%」，点击打开独立宽弹窗
- 快捷键 `⌥U`
- 额度 ≥ 90% 或凭据 < 14 天时，顶栏胶囊变琥珀色

---

## 3. 总览布局（草图）

```text
┌ Hero：标题 / 范围切换 / 刷新 ───────────────────────────────┐
├ Tabs：总览 · 额度与时效 · 时延 · 会话明细 ──────────────────┤
├ 告警条：月度额度仅剩 2% ────────────────────────────────────┤
├ KPI × 4：Token / 费用 / 请求 / 缓存命中 ────────────────────┤
├──────────────────────────────┬──────────────────────────────┤
│ Token 趋势（30 天）           │ OpenCode Go 额度（环形 + 3 档）│
│ 费用构成（按模型环形）        ├──────────────────────────────┤
│                              │ 订阅时效（OAuth / Key）       │
├ 模型分布（Token / 占比 / 费用）├──────────────────────────────┤
│                              │ 时延与健康（P50 / P95 / tok/s）│
└──────────────────────────────┴──────────────────────────────┘
```

设计要点：

1. **先回答“花了多少、花在哪”**：KPI 和费用构成放在第一屏，不把额度藏到二级页。
2. **额度与时效放在右栏**：额度是“现在会不会断”，时效是“什么时候会失效”，两者都是行动项。
3. **时延放右下角**：不抢主视觉，但 P95 和慢请求比例用琥珀色提示。
4. **模型表按有效 Token 排序**：缓存读取单独展示，不然 4.6B 缓存会把真实输入量淹没。
5. **费用洞察直接写结论**：草图中 `gpt-6-luna 占 49.8% 费用，但只占 0.2% Token`，比单纯堆图表有用。

---

## 4. 数据来源与可行性（已核对）

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 总量 / 趋势 / 模型分布 | `ctx.client.experimental.session.stats({ from, to })` | 返回 sessions、prompts、steps、tokens、cost、activeDays、streak、activity、models |
| 会话明细 | `ctx.client.session.list()` | 会话已有 cost / tokens / model / time 字段 |
| OpenCode Go 额度 | `ctx.client.experimental.usage.limits()` | 返回 `data.go.rolling / weekly / monthly`，含 percent、limited、resetsAt |
| Console 预算 | 同上 `data.budgets` | limit / spent / per / models / vendors / resetsAt |
| Go 额度兜底 | `GET https://opencode.ai/zen/go/v1/usage` | 已用 `opencode-go` 凭据实测 200，返回 rolling / weekly / monthly |
| Trae 额度 | `POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage` | 读 `trae-cn` / `trae-cn-ent` 凭据 `metadata.v1` 的 Cloud-IDE-JWT；个人版返回 Credits 池，企业版返回空额度 |
| Qoder 额度 | `GET https://openapi.qoder.com.cn/sash/api/v2/me/usage` | 读 `qoder` 凭据的 `access` 设备令牌；返回套餐额度与加油包 |
| 凭据到期 | `ctx.client.credential.list()` | OAuth 的 `value.expires`；API Key 无到期时间 |
| 实时时延 / 限流 | 服务端 `session.http.response` hook | 可读响应头、状态码；按请求配对 `http.request` 计算耗时 |
| 历史时延 | 本地 `session_message` 的 `time.created / streamed / completed` | 公开 API 暂无历史分位；可选只读 DB 扫描 |
| 实时刷新 | `session.usage.updated` / `session.retry.scheduled` / `session.execution.failed` | 事件驱动，避免轮询 |

### 关键约束

1. `usage.limits` 的 Go 部分依赖 OpenCode Console 的 `orgID`；API Key 连接可能返回 `data: null`。
   - 兜底：服务端 RPC 只读本地凭据，请求 `/zen/go/v1/usage`，只回传百分比和重置时间。
   - 密钥不进入渲染进程、不写日志、不出现在错误信息里。
2. 公开 API 没有历史首字时延分位。
   - P0 先做“本次会话 / 今日”的实时 hook。
   - P1 再做只读 DB 扫描，按 5 分钟缓存；失败则隐藏，不影响总量面板。
3. 本机 DB 约 1.5GB、5.4 万条 assistant 消息。
   - 总量走 `session.stats`，不要每次渲染都跑 SQL。
   - DB 扫描必须带 `time_created` 索引并缓存。
4. 不同供应商的额度暴露程度不同。
   - OpenAI / Anthropic / OpenRouter 可尝试从 `x-ratelimit-*`、`anthropic-ratelimit-*`、`retry-after` 响应头读取。
   - OpenCode Go（滚动 5 小时 / 本周 / 本月）、Trae CN（Credits 池）、Qoder CN（套餐 + 加油包）都有实测可用的额度接口，统一抽象成 `QuotaProvider.meters` 列表渲染。
   - 企业版 Trae 只返回空额度，用 `note` 说明「企业租户未暴露额度」，不伪装成 Free。
   - 凭据只读数据库、不实现刷新；token 失效时提示到对应插件里重新登录。

---

## 5. 指标定义

| 指标 | 定义 |
| --- | --- |
| 有效 Token | `input + output`，趋势和模型占比默认用它 |
| 缓存命中率 | `cache.read / (cache.read + input)`，草图为 97.0% |
| 缓存读取 | 单独展示，不混进有效 Token |
| 费用 | 消息/会话的 `cost` 字段；订阅内调用可能为 0，需标注“按量计费” |
| 首字时延 TTFT | `time.streamed - time.created` |
| 总时延 | `time.completed - time.created` |
| 输出速度 | `output tokens / 总时延`，草图为 9.5 tok/s |
| 慢请求 | 总时延 > 30s 的请求占比 |
| 活跃天数 / 连续天数 | 直接取 `session.stats.activeDays / streak` |

---

## 6. 告警规则（建议默认值）

| 规则 | 阈值 | 级别 | 动作 |
| --- | --- | --- | --- |
| 月度额度 | ≥ 90% / ≥ 97% | 警告 / 严重 | 告警条 + 胶囊变色 |
| 周额度 | ≥ 90% | 警告 | 告警条 |
| 滚动 5 小时 | ≥ 95% | 警告 | 提示切换模型 |
| OAuth 到期 | ≤ 14 天 / ≤ 3 天 | 警告 / 严重 | 胶囊红点 + 续期链接 |
| 7 天费用 | ≥ 预算 80% / 100% | 警告 / 严重 | 告警条 |
| P95 首字时延 | > 30s | 警告 | 时延卡片高亮 |
| 慢请求比例 | > 20% | 警告 | 时延卡片高亮 |
| 缓存命中 | < 70%（7 天） | 提示 | 建议检查 prompt 结构 |
| 限流 / 重试 | 1 小时 > 3 次 | 警告 | 记录事件 + 提示 |
| 数据过期 | > 10 分钟未更新 | 提示 | 顶部“已暂停刷新” |

告警默认只在本机展示；桌面通知作为 P2，复用现有通知插件或系统通知。

---

## 7. 技术结构

```text
GUI（SettingsPage / Dialog / TitlebarItem）
  ├─ ctx.client.experimental.session.stats   总量、趋势、模型
  ├─ ctx.client.session.list                 会话明细
  ├─ ctx.client.experimental.usage.limits    额度 / 预算
  ├─ ctx.client.credential.list              凭据到期
  └─ ctx.client.rpc(Usage)                   实时时延、限流、Go 额度兜底

Server（Plugin.define）
  ├─ session.http.request / response hook    耗时、状态码、rate-limit headers
  ├─ event.subscribe                          usage / retry / failed 增量
  ├─ 只读本地 DB（bun:sqlite）                 历史 TTFT（可选）
  ├─ GET /zen/go/v1/usage                     Go 额度兜底
  └─ storage                                 最近快照、事件环形缓冲
```

缓存策略：

- `session.stats`：60 秒；切换范围时取消旧请求。
- `usage.limits`：5 分钟；手动刷新时强制。
- 实时时延：内存环形缓冲，页面打开时拉最近 24 小时。
- 历史分位：5 分钟；DB 扫描加只读连接。

错误处理：

- 额度接口不可用 → 显示“未连接”与手动配置入口，不阻塞总量。
- 凭据读取失败 → 只隐藏时效卡片，不影响其他模块。
- 时延数据不足 → 显示“样本不足”，不显示假分位。

---

## 8. 版本计划

### P0 · 已实现（0.1.0）

- 总览：KPI、Token 趋势、模型分布、费用构成
- 额度与时效：OpenCode Go 三档额度、Trae CN（个人 / 企业）Credits、Qoder CN 套餐 + 加油包，多供应商 meters 列表 + 重置倒计时、凭据到期列表
- 时延：首字 / 总时延分位、按模型 P95 对比、慢请求、输出速度
- 会话明细：500 条、搜索、项目列、CSV 导出
- 会话回放：按回合展开用户提示、模型请求、思考 / 回复、工具调用与缓存 / 时延 / 费用；长会话分页，支持会话内搜索与 CSV 导出
- 历史首字 / 总时延分位（只读 DB）
- 独立 x-large 弹窗 + Settings 页 + 顶栏胶囊 + `⌥U`
- 全部项目 / 当前项目 / 指定项目筛选
- 手动刷新 + 事件触发刷新 + 60 秒兜底轮询

### P1 · 监控闭环

- Console 预算、手动订阅、额度历史曲线
- 限流 / 重试事件与 in-flight 请求
- 告警阈值设置 + 本地通知
- 会话明细按项目 / 模型 / 日期组合筛选

### P2 · 深入

- 实时 in-flight 首字采集（`session.http.response` hook）与历史合并
- 费用预算 / 日限额
- 按项目 / 子代理拆分
- 额度历史曲线与预测（按当前速度估算耗尽时间）
- 多设备同步（可选，默认关闭）

---

## 9. 已确认

1. **统计范围**：默认全部项目；可切换「当前项目」或指定项目。
2. **订阅范围**：P0 只做 OpenCode Go；Trae / Qoder 仅显示凭据到期时间。
3. **历史与实时**：两者不冲突，都做。
   - 历史：只读本机 DB，负责完整、可回溯的聚合。
   - 实时：只作为刷新信号，不把同一份调用再计数一次；收到事件后重新读 DB 并替换快照。
   - 后续如果加入 in-flight 请求，会单独标记为「进行中」，不与已完成历史相加。
4. **告警出口**：P0 应用内告警条；系统通知放在 P1。
5. **命名**：`opencode-usage-center`（npm 当前可用）。

---

## 10. 草图说明

草图中的数字是 **2026-11-06 21:22 的真实本机快照**，用于验证布局与数据可行性：

- 30 天有效 Token 150.0M，费用 $11.31，缓存命中 97.0%
- OpenCode Go：滚动 1%、本周 36%、本月 98%（约 16 小时后重置）
- Qoder OAuth 28 天后到期，Trae CN OAuth 13 天后到期
- P50 首字 10.8s，P95 首字 52.7s，慢请求 19.4%
- `gpt-6-luna` 仅占 0.2% 有效 Token，却产生 49.8% 的费用

P0 实现使用同一套聚合口径；实现截图见 `preview/page.png`（本地预览，不随包发布）。
