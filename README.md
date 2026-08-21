# dsh-search-failover

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-search-failover"><img src="https://img.shields.io/npm/v/dsh-search-failover.svg?style=flat-square&color=blue" alt="npm version"></a>
  <a href="https://github.com/Walvez/dsh-search-failover/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/Walvez/dsh-search-failover/test.yml?style=flat-square&label=tests" alt="build status"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg?style=flat-square" alt="node version"></a>
  <a href="https://github.com/Walvez/dsh-search-failover/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license"></a>
  <a href="https://github.com/deepseek-ai/awesome-dsh-plugin"><img src="https://img.shields.io/badge/dsh-awesome--plugin-orange.svg?style=flat-square" alt="awesome plugin"></a>
</p>

<p align="center">
  <b>DeepSeek Harness (DSH) 原生 provider 级智能搜索池插件</b><br>
  多源容灾（Failover）· 加权轮询（Weighted Rotate）· 额度感知熔断 · AI 自主换源 · 实时 Web GUI 设置面板
</p>

---

## ✨ 核心特性

- 🛡️ **Provider 级透明替换**：无侵入接管 DSH `ctx.web`，保持原生 `web_search` 工具签名完全不变，会话与 Agent 零感知。
- 🔄 **双重路由策略**：
  - **优先顺序 (Failover)**：按优先级从高到低依次尝试，前一个后端失败或熔断自动下探下一个。
  - **加权轮询 (Weighted Rotate)**：按 1~10 权重将搜索流量平摊到所有健康引擎，最大化榨干各大搜索源的免费额度。
- ⚡ **智能额度感知与熔断器 (Circuit Breaker)**：
  - 遇到额度耗尽（HTTP 402/429/Quota Exceeded）→ **长冷却 (1h)**，避免无效请求；
  - 遇到临时网络抖动（Transient Error）→ 5 分钟内连续 3 次失败触发 **短冷却 (60s)**；
  - 冷却到期自动半开探活，成功立即恢复。
- 🤖 **AI 自主换源技能 (`web_search_from`)**：
  - 为 Agent 注入专属换源工具。当 AI 认为默认结果不够理想、信息过时或源单一时，可自主选择 `exa` / `serper` / `tavily` / `jina` 等引擎重新搜索并对比。
- 🎛️ **Web GUI 实时热生效设置面板**：
  - 在 DSH 设置页一键填写/修改 API Key、切换策略、拖拽排序、测试连通性，**保存即实时生效，无需重启进程**。
  - 密钥安全保存在本地 `~/.dsh/settings.yaml`，绝不上报。
- 🔌 **全生态搜索引擎适配**：
  - 内置支持 **Exa**, **Serper.dev**, **Tavily** (支持 keyless 匿名档), **Jina Search**, **SerpApi**, **SearXNG** (自托管), **DuckDuckGo**, **Brave**。

---

## 🏗️ 架构概览

```text
┌──────────────────────────────────────────────────────────────┐
│                    AI Agent / User Chat                      │
└──────────────┬────────────────────────────────┬──────────────┘
               │ (默认搜索)                      │ (显式换源)
               ▼                                ▼
┌──────────────────────────────┐ ┌─────────────────────────────┐
│  web_search (DSH 原生工具)    │ │  web_search_from (增强工具)   │
└──────────────┬───────────────┘ └──────────────┬──────────────┘
               │                                │
               ▼                                ▼
┌──────────────────────────────────────────────────────────────┐
│               SearchPoolProvider (search-pool)               │
│                                                              │
│  [调度决策]                                                  │
│   ├── 指定源 (source): 直连指定引擎, 不走池                    │
│   ├── Failover: 按 priority 升序依次尝试                      │
│   └── Rotate: 按 weight 展开加权轮转                         │
│                                                              │
│  [熔断与健康守护]                                            │
│   ├── CircuitBreaker 监控各后端健康度                         │
│   └── 额度耗尽(1h 冷却) / 瞬时错误(60s 冷却) / 探活恢复       │
└──────────────────────────────┬───────────────────────────────┘
                               │
   ┌──────────┬──────────┬─────┴────┬──────────┬──────────┐
   ▼          ▼          ▼          ▼          ▼          ▼
┌─────┐    ┌─────┐    ┌──────┐   ┌──────┐   ┌─────┐   ┌─────────┐
│ Exa │    │Serper│   │Tavily│   │ Jina │   │Serp-│   │ SearXNG │
│     │    │ .dev │   │(Anon)│   │  AI  │   │ Api │   │ (Local) │
└─────┘    └─────┘    └──────┘   └──────┘   └─────┘   └─────────┘
```

---

## 🚀 快速开始

### 1. 安装插件

在你的 DSH 项目或 Web Profile 下安装：

```bash
# 方式 A: 从 npm 安装 (推荐)
dsh plugin --profile web add dsh-search-failover

# 方式 B: 本地克隆软链调试 (开发者)
git clone https://github.com/Walvez/dsh-search-failover.git
dsh plugin --profile web add link:$(pwd)/dsh-search-failover
```

### 2. 启用配置

在 `cordis.patch.yml` 中声明挂载与默认后端配置：

```yaml
- id: search-pool
  name: dsh-search-failover
  config:
    strategy: failover          # failover (优先顺序) | rotate (轮询分摊)
    maxResults: 8               # 默认返回条数上限
    timeoutMs: 15000            # 单个请求超时时间 (ms)
    backends:
      - id: exa
        kind: exa
        apiKeyEnv: EXA_API_KEY  # 从 ~/.dsh/.env 读取
        priority: 1
      - id: serper
        kind: serper
        apiKeyEnv: SERPER_API_KEY
        priority: 2
      - id: tavily
        kind: tavily
        apiKeyEnv: TAVILY_API_KEY
        priority: 3
      - id: jina
        kind: jina
        apiKeyEnv: JINA_API_KEY
        priority: 4
      - id: serpapi
        kind: serpapi
        apiKeyEnv: SERPAPI_API_KEY
        priority: 5
      - id: searxng
        kind: searxng
        baseURL: http://127.0.0.1:8080
        priority: 6
    circuit:
      threshold: 3              # 连续错误阈值
      burstWindowMs: 300000     # 统计时间窗口 (5 分钟)
      cooldownMs: 60000         # 瞬时错误冷却时间 (1 分钟)
      quotaCooldownMs: 3600000  # 额度耗尽冷却时间 (1 小时)
```

### 3. 启动 DSH Web

```bash
dsh web
```

打开 Web GUI (默认 `http://127.0.0.1:3080`)，进入 **设置 → 搜索池** 即可在界面直接管理所有 Key。

---

## 📊 后端引擎支持与额度参考

| 引擎标识 (`kind`) | 后端服务 | 官方免费额度 (核实) | 密钥要求 | 特性与说明 |
|---|---|---|---|---|
| `exa` | **Exa (Metaphor)** | 注册送 $20，每月赠 $10（学生认证 $1000） | 必须 | 语义神经搜索，质量极高，推荐作为主力 |
| `serper` | **Serper.dev** | 注册赠送 2,500 次调用 | 必须 | Google SERP 原生结果，速度快 (~2s) |
| `tavily` | **Tavily** | 每月 1,000 次免费额度 | 可选 | 专为 LLM 设计，无 key 时自动回退至官方匿名档 |
| `jina` | **Jina Search** | 免费注册获取 API Key | 必须 | `s.jina.ai` Markdown 深度提取 |
| `serpapi` | **SerpApi** | 每月 250 次免费搜索 | 必须 | 支持实时账户额度余量查询 |
| `searxng` | **SearXNG** | 自托管，完全无限免费 | 无 | 需在自建实例中开启 `format: json` |
| `brave` | **Brave Search** | 需绑卡订阅 | 必须 | 商业索引 |
| `ddg` | **DuckDuckGo** | 完全免费 | 无 | HTML 解析（受网络和反爬限制，适合最后兜底） |

---

## 🤖 AI 自主换源工具 (`web_search_from`)

当 Agent 认为默认搜索结果不理想时，可以主动调用由本插件注册的 `web_search_from` 工具：

### 工具参数

```json
{
  "name": "web_search_from",
  "description": "用指定的搜索后端(引擎)搜索当前信息并返回该源原始结果。可用于多源对比或换引擎重试。",
  "parameters": {
    "query": { "type": "string", "description": "搜索关键词" },
    "source": { "type": "string", "description": "指定后端类型 (例如 exa, serper, tavily, jina, searxng 等)" },
    "maxResults": { "type": "number", "description": "返回结果数量上限 (默认 8)" }
  }
}
```

### Agent 典型工作流

1. Agent 执行 `web_search(query="最新技术动态")` 走默认搜索池；
2. 发现结果大多是旧闻或不相关，Agent 主动调用 `web_search_from(query="最新技术动态", source="serper")` 从 Google 实时索引获取结果；
3. 对比各源信息，输出最准确、最及时的回答。

---

## 🎛️ Web GUI 设置面板

在 DSH Web 管理界面（**设置 → 搜索池**）中：

- **实时密钥填写**：随时填写或更新各引擎 API Key，点击保存立即热生效。
- **一键测试连接 (▶)**：对指定后端发起 1 条测试搜索，毫秒级反馈连通状态与响应耗时。
- **动态优先级调整 (↑ / ↓)**：通过按钮调整引擎在 Failover 链中的优先级。
- **轮询权重调节**：在轮询分摊模式下，为不同引擎设置 1~10 权重值。
- **添加自定义后端**：无需改写代码或配置文件，直接在界面添加 SearXNG 实例或新后端。
- **额度余量透视**：行内直接显示支持额度查询的后端（如 SerpApi）的套餐类型、剩余次数及重置日期。

---

## 🧪 单元测试

项目包含完善的单元测试套件（覆盖熔断器状态机、加权轮询、优先级排序、多源容灾、自愈探活等）：

```bash
# 运行单元测试
npm test

# 运行真实网络冒烟测试
EXA_API_KEY=your_key node scripts/smoke.mjs exa serper tavily
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。

欢迎提交 Issue 和 Pull Request 共同改进！
