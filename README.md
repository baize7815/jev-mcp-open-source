# Jev MCP for Cloudflare

[English](README.en.md) | 中文

自部署的 MCP 网关，运行在 Cloudflare Workers 上，把 TypeSafe / Jev 的 System One 模型包装成四个工具，供 AI 助手在本地完成**意图路由、检索结果重排、批量语义判断**这类"判断但不生成长文"的工作。配套提供一个 Codex Skill，让助手在合适的决策点主动调用它。

- **后端**：Cloudflare Workers + D1（SQLite）
- **上游模型**：TypeSafe System One（`jev-latest`）
- **传输**：标准 Model Context Protocol（JSON-RPC，`/mcp`）
- **管理**：内置 `/admin` 控制台，增删 API Key 并查看用量

## 工具

部署后 `/mcp` 暴露以下四个工具。所有判断都只返回结构化答案与置信度，不生成散文；服务端对每批请求做大小校验、并发限制和失败隔离。

| 工具 | 用途 | 典型场景 |
| --- | --- | --- |
| `route_intent` | 在多个候选路径/工具/知识源之间选择，并给出置信度 | 用户说"把那个整理一下"，需要判断指哪份文件、走检索还是直接回答 |
| `rerank_candidates` | 对检索回来的多条候选片段按语义相关性打分排序 | 本地搜索或知识库返回 10 条结果，决定先读哪几条原文 |
| `batch_judge` | 把同一组问题批量套到多条记录上做分类/标注/筛选 | 给一批工单分部门、给一批文档打标签、过滤候选文件 |
| `system_one` | 直通 TypeSafe System One，自定义 state 与问题 | 上面三个工具覆盖不了的自定义布尔/选项/打分判断 |

通用限制：单批最多 **10** 条记录，总输入 **128 KB**，服务端并发 **3**。批量判断中失败的记录标记为 `failed`，不会被当作"无关"丢弃；不自动重试，避免重复计费。

## 工作原理

```
AI 助手 (Codex / MCP 客户端)
        │  JSON-RPC over HTTP
        ▼
Cloudflare Worker  ──►  D1：加密存储的 TypeSafe API Key（AES-GCM）
        │
        │  Authorization: Bearer <轮换中的 Key>
        ▼
https://api.typesafe.ai/v1/systemone   (model: jev-latest)
```

- TypeSafe API Key 只存在服务端 D1，用 `KEY_ENCRYPTION_SECRET` 做 AES-GCM 加密，数据库里只看到密文和后四位提示。
- 启用中的 Key 按游标轮询使用，调用结果（成功/失败、token 用量）写回 D1。
- `/mcp` 端点按设计**不设鉴权**——知道部署地址的人就能消耗你的 TypeSafe 额度；只有 `/admin` 需要 `ADMIN_TOKEN`。请把部署地址当作半公开端点对待，或在 Cloudflare 侧自行加访问控制。

## 前置要求

- Node.js **24.11+** 与 npm
- 一个 Cloudflare 账户
- 至少一个 TypeSafe API Key（在 TypeSafe 控制台申请）

## 部署

1. 安装依赖并复制配置模板：

   ```powershell
   npm ci
   Copy-Item wrangler.example.jsonc wrangler.jsonc
   ```

   macOS / Linux 用 `cp wrangler.example.jsonc wrangler.jsonc`。

2. 登录 Cloudflare 并创建 D1 数据库：

   ```sh
   npx wrangler login
   npx wrangler d1 create jev-mcp
   ```

   把输出里的 `database_id` 填进本地 `wrangler.jsonc`，替换掉模板里的全零占位。多账户用户在该文件里同时指定自己的 `account_id`。

3. 初始化远程数据库表：

   ```sh
   npx wrangler d1 migrations apply jev-mcp --remote
   ```

4. 设置两个 Worker Secret（命令会交互式要求输入值，不要把值写进源码或命令行参数）：

   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put KEY_ENCRYPTION_SECRET
   ```

   - `ADMIN_TOKEN`：你自己选的管理口令。
   - `KEY_ENCRYPTION_SECRET`：**64 个十六进制字符（32 字节）**，用密码管理器或 `openssl rand -hex 32` 生成。它用于加密 D1 里的 API Key；丢失或更换会让已存的 Key 无法解密，请妥善保管。

5. 检查并发布：

   ```sh
   npm run types
   npm run typecheck
   npm test
   npm run deploy:check
   npm run deploy
   ```

6. 用 Wrangler 输出的 Worker 地址打开 `/admin`，输入 `ADMIN_TOKEN`，添加你的 TypeSafe API Key。然后在 MCP 客户端里把同一个 Worker 地址的 `/mcp` 配进去。

## 调用方式

### `route_intent`

```json
{
  "request": "帮我找之前保存的布光教程",
  "context": "用户有一个收录摄影教程的知识库，现在要从已保存资料中找教程。",
  "min_confidence": 0.65
}
```

不传 `routes` 时使用内置的六条标准路径：`answer`、`search_files`、`search_knowledge`、`search_web`、`implement`、`review`。也可以传入自己的候选：

```json
{
  "request": "把那个处理一下",
  "context": "桌上有两份不同的报告，用户没有指明是哪份。",
  "routes": [
    { "id": "report_a", "description": "Process report A" },
    { "id": "report_b", "description": "Process report B" }
  ]
}
```

返回 `status: "resolved"` 时给出选中的 `route` 与 `confidence`；置信度低于 `min_confidence` 或无法决定时返回 `needs_review`，并提示 `__uncertain__`。

### `rerank_candidates`

```json
{
  "query": "如何给 Cloudflare Worker 绑定自定义域名？",
  "top_k": 3,
  "candidates": [
    { "id": "pasta", "text": "意面煮八分钟，加入番茄酱和罗勒。" },
    { "id": "domain", "text": "在 Worker 的 Settings → Domains & Routes 添加 Custom Domain……" },
    { "id": "lighting", "text": "人像布光可以在人物左前方放置柔光箱……" }
  ]
}
```

返回按相关性打分（0–1）排序的 `ranked` 列表；打分失败的候选进入 `failed`，表示"未判断"而不是"无关"。`text` 要传实际片段而不只是文件名。

### `batch_judge`

```json
{
  "items": [
    { "id": "billing", "state": "I was charged twice. Please refund the duplicate payment." },
    { "id": "bug",     "state": "The app crashes every time I open settings." }
  ],
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Which team should handle this report?",
      "criteria": { "billing": "Payments and refunds", "technical": "Software bugs and crashes" }
    },
    "refund": {
      "type": "noul",
      "instructions": "Does the user ask for a refund?"
    }
  }
}
```

问题类型：

- `noul`：判断条件是否成立，返回 `{ noul: 0..1, confidence }`。
- `choice`：从 2–255 个命名选项里选一个，返回 `{ choice, confidence, probabilities }`。
- `score`：在 2–10 个有序等级上打分，返回 `{ score: 0..n-1, confidence }`。

### `system_one`

上面三个工具之外的自定义判断，直接传 `state` 和 `questions`：

```json
{
  "state": "The parcel has been delivered.",
  "questions": {
    "delivered": { "type": "noul", "instructions": "Has the parcel been delivered?" }
  }
}
```

## 管理控制台

打开 `/admin`，用 `ADMIN_TOKEN` 登录后可以：

- 添加 / 停用 / 删除 TypeSafe API Key（Key 标签 + 后四位提示）。
- 查看每个 Key 的调用次数、错误数、输入/输出 token 用量。
- 启用中的 Key 由服务端按游标轮询，调用失败不会自动重发到下一个 Key。

管理接口用 `SHA-256` 对令牌做恒定时间比较，控制台页面带严格的 CSP；令牌只保存在当前浏览器内存里。

## 配套 Codex Skill

把 `skills/jev-workflows/` 整个目录复制到 Codex 的个人 Skill 目录（通常是 `~/.codex/skills/`），连接你部署的 MCP 后刷新工具列表。

Skill 会在三类决策点主动调用 Jev，而不是拦截每条消息：

1. 意图有歧义、需要承接上文、或要在多个工具/知识源之间选择时；
2. 文件/知识库检索返回多条候选、需要按相关性决定先读哪些原文时；
3. 需要把同一组问题批量套到多条记录上做分类或筛选时。

如果 MCP 客户端只缓存了旧的 `system_one`，可以用 Skill 自带的备用脚本直连：

```powershell
$env:JEV_MCP_URL = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp'
node skills/jev-workflows/scripts/call-mcp.mjs --describe
node skills/jev-workflows/scripts/call-mcp.mjs rerank_candidates --input candidates.json
```

脚本不内置任何远程地址，未设置 `JEV_MCP_URL` 时不会联网；也不读取 Cloudflare 登录文件或本地 API Key。

## 本地开发

把测试用 Secret 放进被忽略的 `.dev.vars`，然后：

```sh
npx wrangler d1 migrations apply jev-mcp --local
npm run dev -- --local --port 8791
node scripts/verify.mjs http://127.0.0.1:8791
```

不加 `--live` 时只校验工具列表、管理页静态资源和入参校验。对自己部署的地址加 `--live` 会执行少量真实推理并消耗你自己的 TypeSafe 额度：

```sh
node scripts/verify.mjs https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev --live
```

## 限制

- 每批最多 10 条记录，总输入 128 KB，服务端并发 3。
- 不自动重试失败请求；`usage_complete: false` 表示汇总未覆盖失败项的潜在消耗。
- 意图置信度阈值（默认 0.65）是启发式复核线，不是正确性保证，也不构成用户授权。
- 分数和路由建议都是相对信号，最终回答仍以助手读到的原文为准。

## 安全提示

- 仓库只包含源码与配置模板；真实的 `wrangler.jsonc`、`.dev.vars`、`.env*`、`*.pem`、`*.key` 等都被 `.gitignore` 排除。
- `/mcp` 默认无鉴权，任何知道部署地址的人都能消耗你配置的 TypeSafe 额度；如果不希望公开，请在 Cloudflare 侧加访问控制。
- `ADMIN_TOKEN` 与 `KEY_ENCRYPTION_SECRET` 通过 Wrangler Secret 注入，不要写进源码、配置文件或命令行参数。

---

Copyright © 2026 baize7815。本项目原创代码与 Skill 采用 https://github.com/baize7815/jev-mcp-open-source/blob/main/LICENSE 许可证；依赖和参考项目见 https://github.com/baize7815/jev-mcp-open-source/blob/main/THIRD_PARTY_NOTICES.md 。
