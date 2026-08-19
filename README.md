# dsh-search-failover

DSH 的 **provider 级搜索池**: 原生 `web_search` 工具不变, 内部自动在多个
免费/付费搜索后端间 failover / rotate, 带**额度感知熔断**。

> 状态: v0.2 (8 个后端适配器) · 设计文档见 dsh-config/docs/search-failover-design.md

## 为什么

- `dsh-search-mcp` 能配多个服务器但没有自动 failover
- `dsh-web-search-pro` 有自动回退但是重依赖的工具套件, 不是 provider 级
- 本插件: 轻量(纯 HTTP) + provider 级(保留原生工具) + 额度感知熔断

## 架构

```
web_search (原生工具)
  └── ctx.web → searchProvider: "search-pool"
        └── SearchPoolProvider.search(query)
              ├─ failover: 按 priority 依次尝试, 首个成功返回
              ├─ rotate:   健康后端轮询 (分散免费额度)
              ├─ 熔断: QUOTA→长冷却(1h) / TRANSIENT→阈值3次/5min→短冷却(60s)
              └─ 冷却到期半开探活, 成功即恢复
```

## 开发安装 (link:)

```bash
# 1. 装进 web profile (link: 改代码即时生效)
#    package.json 声明 dsh.bundle.patch → 自动加入 profile bundle 层
dsh plugin --profile web add link:/Users/walve/Documents/Codex/dsh-search-failover

# 2. 用户 patch (cordis.patch.yml) 提供后端链配置:
#    - id: web  → searchProvider: search-pool
#    - id: search-pool → config.backends (见下)
#    (bundle 只插入行; key 经 apiKeyEnv 从 ~/.dsh/.env 读取)

# 3. 验证组合树 (无需重启): dsh --profile web --dump-config | grep -A30 "id: search-pool"

# 4. 重启 dsh web 生效
```

## 后端适配器 (免费额度, 2026-08 核实)

| kind | 后端 | 免费额度 | key | 说明 |
|---|---|---|---|---|
| `exa` | Exa | 注册 $20 + $10/月; 教育 $1000 | 必须 | `apiKeyEnv: EXA_API_KEY` ✅ 实测可用 |
| `tavily` | Tavily | 1000 积分/月 | 可选 | 无 key 自动走 keyless 匿名档 ✅ 实测可用 |
| `serper` | Serper.dev | 2500 次一次性 | 必须 | Google SERP |
| `serpapi` | SerpApi | 250 次/月 | 必须 | Google SERP |
| `brave` | Brave | ⚠️ 免费档已撤 (2026-08 实测注册需订阅) | 必须 | 不推荐 |
| `jina` | Jina s.jina.ai | 免费注册得 key | 必须 | ⚠️ 实测 2026-08 无 key 已 401, markdown 解析 |
| `ddg` | DuckDuckGo | 完全免费 | 无 | ⚠️ 实测 2026-08 被反爬拦截 (202 anomaly), 视网络/IP 而定 |
| `searxng` | SearXNG 自托管 | 完全免费 | 无 | `baseURL` 或 env `SEARXNG_BASE_URL`; 实例需开 `format: json` |

每个后端通用字段: `id`(熔断/日志标识)、`kind`、`priority`(failover 顺序, 小者优先)、
`apiKey` / `apiKeyEnv`(从环境读 key)、`baseURL`(searxng 用)。

## 配置 (cordis.patch.yml)

```yaml
- id: search-pool
  name: dsh-search-failover
  config:
    strategy: failover          # failover | rotate
    maxResults: 8
    timeoutMs: 15000
    backends:
      - id: exa                 # 主力 (需 key)
        kind: exa
        apiKeyEnv: EXA_API_KEY
        priority: 1
      - id: serper              # 2500 次试用 (需 key)
        kind: serper
        apiKeyEnv: SERPER_API_KEY
        priority: 2
      - id: tavily-anon         # 无 key → Tavily keyless 匿名档
        kind: tavily
        priority: 3
      - id: jina                # 免费注册 key 后可用
        kind: jina
        apiKeyEnv: JINA_API_KEY
        priority: 4
      - id: ddg                 # DuckDuckGo HTML, 完全免费 (可能被反爬拦截)
        kind: ddg
        priority: 5
      - id: serpapi             # 250 次/月 (需 key)
        kind: serpapi
        apiKeyEnv: SERPAPI_API_KEY
        priority: 6
      - id: brave               # 2000 次/月 (需 key)
        kind: brave
        apiKeyEnv: BRAVE_API_KEY
        priority: 7
      - id: searxng             # 自托管 (可选)
        kind: searxng
        baseURL: http://localhost:8080
        priority: 8
    circuit:
      threshold: 3
      burstWindowMs: 300000
      cooldownMs: 60000
      quotaCooldownMs: 3600000
```

## 设置页 (v0.3+)

GUI 内管理所有后端的 API Key: **设置 → 搜索池**, 每个后端一行,
填 key 点保存即写入 `settings.yaml` user 层并**立即生效 (无需重启)** —
provider 每次搜索实时读取配置。页面还实时显示每个后端的熔断/冷却状态
(正常 / 冷却中 / 额度冷却 + 倒计时), 以及 key 是否已配置。

- 保存路径: `POST /search-pool/keys` (same-origin 校验) → `settings.update`
- 恢复默认: `POST /search-pool/reset` → `settings.replace({})`, 回退到行内配置
- 状态查询: `GET /search-pool/state` (no-store)
- 优先级: 设置页保存的 `apiKey` > 行内 `apiKey` > `apiKeyEnv` 环境变量
- **自定义后端**: 「添加后端」可选择任意已支持类型（含自托管 SearXNG），保存即热生效；
  所有后端都可一键删除（内置项删除后可用「恢复默认配置」找回）。
- **策略切换**: 「使用方式」一键切换 failover(按优先级) / rotate(轮询分摊)。
  - failover 顺序 = 列表顺序：每行 ↑↓ 按钮直接排序。
  - rotate 可设每后端权重 1-10（默认 1），搜索按权重分配。
- **AI 换源工具**: 插件注册 `web_search_from(query, source)` 工具, AI 觉得 web_search 结果不理想时
  可显式指定某引擎(如 `serper`/`tavily`/`jina`…)再搜或对比 — 判断权在 AI, 不做硬合并。
- **可选多源合并**: 设 `mergeThreshold`(默认 0=关闭) 后, failover 在当前后端结果不足阈值时才会自动追加后续源并合并去重。
- **额度查询**: 每个后端行内实时显示剩余额度（SerpApi 支持，其余无公开接口则标注）。
- **测试连接**: 每行 ▶ 按钮对该后端发一次真实轻量搜索 (1 条), 显示可用性与耗时。
- 密钥只存在本机 `~/.dsh/settings.yaml`, 绝不进 git / 不上报

## 测试

```bash
npm test     # node:test, 纯逻辑无网络
```

## 路线

- v0.1: failover + exa/tavily/ddg + 熔断 ✅
- v0.2: 适配器扩展 — serper/serpapi/brave/jina/searxng ✅; 故障演练+console 日志 ✅
- v0.3: 设置页 UI (GUI 填 key 热生效) ✅; 发布 npm/GitHub ✅; 收录 awesome-dsh-plugin ✅
- v0.4: multi/RRF 融合 🔜 | rotate 分散额度 🔜

## 真实网络验证 (2026-08-16 实测)

```bash
EXA_API_KEY=xxx node scripts/smoke.mjs [kind...]   # 逐个真实调用并打印结果
```

| kind | 实测结果 |
|---|---|
| `exa` (真实 key) | ✅ 5 条结果 ~2s |
| `tavily` (真实 key) | ✅ 5 条结果 ~1.3s |
| `tavily` (keyless 匿名) | ✅ 5 条结果 ~2.8s |
| `serper` (真实 key) | ✅ 5 条结果 ~2.3s |
| `serpapi` (真实 key) | ✅ 6 条结果 ~14s (最慢) |
| `jina` (真实 key) | ✅ 6 条结果 ~8.3s |
| `ddg` | ❌ html/lite 双端点均 202 anomaly (反爬), 浏览器 UA 无效 |
| `brave` | ❌ 免费档已撤, 未注册 |

## 合规提示

- DDG 走非官方 HTML 端点, 有 ToS 风险, 实测已被反爬拦截, 仅作兜底
- Tavily keyless / Exa 均为官方免费档, 有限速

## 致谢

- 熔断模式借鉴 [dsh-model-failover](https://github.com/dsh-model-failover)
- 适配器/归一化参考 [dsh-search-mcp](https://github.com/gxpppp/dsh-search-mcp) (MIT)
