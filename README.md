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
# 1. 装进 web profile (本地 link, 改代码即时生效)
dsh plugin --profile web add link:/Users/walve/Documents/Codex/dsh-search-failover

# 2. 改用户 patch: web.searchProvider → search-pool
#    (插件 bundle 在用户 patch 之前应用, 用户自己的 exa 配置会覆盖)

# 3. 重启 dsh web
```

## 后端适配器 (免费额度, 2026-08 核实)

| kind | 后端 | 免费额度 | key | 说明 |
|---|---|---|---|---|
| `exa` | Exa | 注册 $20 + $10/月; 教育 $1000 | 必须 | `apiKeyEnv: EXA_API_KEY` |
| `tavily` | Tavily | 1000 积分/月 | 可选 | 无 key 自动走 keyless 匿名档 |
| `serper` | Serper.dev | 2500 次一次性 | 必须 | Google SERP |
| `serpapi` | SerpApi | 250 次/月 | 必须 | Google SERP |
| `brave` | Brave | 2000 次/月 (注册要信用卡) | 必须 | |
| `jina` | Jina s.jina.ai | 无 key 20 RPM / key 500 RPM | 可选 | markdown 解析 |
| `ddg` | DuckDuckGo | 完全免费 | 无 | 非官方 HTML 端点, ToS 风险 |
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
      - id: jina                # 无 key 免费档
        kind: jina
        priority: 4
      - id: ddg                 # DuckDuckGo HTML, 完全免费
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

## 合规提示

- DDG 走非官方 HTML 端点, 有 ToS 风险, 仅作个人兜底
- Tavily keyless / Exa 匿名 MCP 均为官方免费档, 有限速

## 致谢

- 熔断模式借鉴 [dsh-model-failover](https://github.com/dsh-model-failover)
- 适配器/归一化参考 [dsh-search-mcp](https://github.com/gxpppp/dsh-search-mcp) (MIT)
