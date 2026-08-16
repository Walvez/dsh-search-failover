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

## 测试

```bash
npm test     # node:test, 无依赖
```

## 路线

- v0.1: failover + exa/tavily/ddg + 熔断 ✅
- v0.2: 适配器扩展 — serper/serpapi/brave/jina/searxng ✅; rotate 完善、设置页 🔜
- v0.3: multi/RRF 融合 + 设置页 UI + 发布 npm/GitHub/dshmarket

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
