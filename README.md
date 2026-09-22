# Jev MCP for Cloudflare

自部署的 Jev MCP 与配套 Codex Skill。支持用户意图路由、文件/知识库检索结果重排、批量语义判断，以及通用的 TypeSafe System One 调用。

## 包含什么

- Cloudflare Worker：`src/`。
- MCP：`/mcp`，提供 `route_intent`、`rerank_candidates`、`batch_judge`、`system_one`。
- 管理页面：`/admin`，添加、停用和删除 TypeSafe API Key，查看本 MCP 的用量统计。
- D1 初始化：`migrations/`。Key 使用 AES-GCM 加密保存，启用的 Key 轮询使用。
- 主动调用 Skill：`skills/jev-workflows/`。

本包没有预设远程 MCP 地址，也不包含任何部署者的账号、数据库 ID、密钥或登录授权文件。`wrangler.example.jsonc` 仅提供占位配置，实际配置文件被 Git 忽略。

## 部署自己的 MCP

需要 Node.js 24.11+、npm、Cloudflare 账户和自己的 TypeSafe API Key。

1. 安装依赖并复制配置模板：

   ```powershell
   npm ci
   Copy-Item wrangler.example.jsonc wrangler.jsonc
   ```

   macOS/Linux 使用 `cp wrangler.example.jsonc wrangler.jsonc`。

2. 登录自己的 Cloudflare 账户并创建数据库：

   ```sh
   npx wrangler login
   npx wrangler d1 create jev-mcp
   ```

   将创建结果中的 `database_id` 填入本地 `wrangler.jsonc`，替换全零占位值。若使用其他 Worker/数据库名称，同步修改配置和后续命令。多账户用户在本地配置中指定自己的 `account_id`。

3. 初始化远程空数据库：

   ```sh
   npx wrangler d1 migrations apply jev-mcp --remote
   ```

4. 设置两个 Worker Secret。命令会交互式要求输入值，不要把值写在源码、配置模板或命令参数里：

   ```sh
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put KEY_ENCRYPTION_SECRET
   ```

   `ADMIN_TOKEN` 使用随机管理口令。`KEY_ENCRYPTION_SECRET` 使用密码管理器或可靠随机工具生成的 **64 个十六进制字符（32 字节）**。保管好它；更换或丢失它会使已存的 Key 无法解密。Wrangler 设置 Secret 时可能创建/部署 Worker 版本。

5. 检查并发布：

   ```sh
   npm run types
   npm run typecheck
   npm test
   npm run deploy:check
   npm run deploy
   ```

6. 使用 Wrangler 输出的 **你自己的 Worker 地址**，打开其 `/admin`，输入管理口令并添加 TypeSafe API Key。在 MCP 客户端配置同一地址的 `/mcp`。

默认 `/mcp` 无鉴权，知道部署地址的人可以消耗你配置的 TypeSafe 额度；只有管理 API 需要口令。这是此项目的默认服务方式。用量统计仅包含经过此 MCP 的调用，不是 TypeSafe 账户剩余额度。

## 安装 Skill

将 `skills/jev-workflows` 文件夹复制到 Codex 的个人 Skill 目录（通常是 `~/.codex/skills/`）。连接自己部署的 MCP，并刷新工具列表。

Skill 会在歧义意图、工具/知识源选择、检索后语义筛选和重复分类场景主动使用 Jev。它是工具使用指导，并非拦截每条消息的 Hook。

若客户端只显示旧工具，可使用 Skill 内的备用脚本。**必须先在运行脚本的环境里设置自己的 `JEV_MCP_URL`**：

```powershell
$env:JEV_MCP_URL = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp'
node skills/jev-workflows/scripts/call-mcp.mjs --describe
node skills/jev-workflows/scripts/call-mcp.mjs rerank_candidates --input candidates.json
```

macOS/Linux 使用 `export JEV_MCP_URL='https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp'`。以上域名是占位示例，不能直接调用。脚本没有默认远程地址，未配置时不会联网；不读取 Cloudflare 登录文件，也不需要本地 TypeSafe Key。

`candidates.json` 示例：

```json
{
  "query": "如何配置应用的登录回调？",
  "candidates": [
    { "id": "auth-guide", "text": "登录回调地址必须与身份提供方登记的 redirect_uri 一致。" },
    { "id": "style-guide", "text": "界面按钮采用统一的圆角与间距。" }
  ],
  "top_k": 2
}
```

服务器不读取你的本地磁盘；搜索工具先获得候选片段，Jev 再做排序，助手最后读取相关原文。

## 限制与验证

批量判断和重排每批最多 10 条，总输入上限 128 KB，并发上限 3。不自动重试失败请求。失败项保留为未判断，不能当作无关内容；`usage_complete: false` 表示汇总未覆盖失败响应的潜在消耗。意图置信度默认复核阈值 0.65 是可调启发值，不是正确性保证或用户授权。

离线测试运行 `npm test`。本地开发前将测试用 Secret 放入被忽略的 `.dev.vars`，并运行：

```sh
npx wrangler d1 migrations apply jev-mcp --local
npm run dev -- --local --port 8791
node scripts/verify.mjs http://127.0.0.1:8791
```

使用自己的部署地址运行 `node scripts/verify.mjs https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev --live` 会额外执行少量真实推理并消耗自己的 TypeSafe 额度。不传 `--live` 时只验证工具列表、后台资源和输入校验。

## 上传 GitHub

仅提交源文件与配置模板。不要强制添加被 `.gitignore` 排除的真实配置、环境文件、运行缓存、数据库、依赖或日志。仓库不需要包含任何 Cloudflare OAuth token、部署地址或 API Key；每位使用者在自己的环境完成授权和配置。

---

Copyright © 2026 baize7815。本项目原创代码与 Skill 采用 https://github.com/baize7815/jev-mcp-open-source/blob/main/LICENSE 许可证；依赖和参考项目见 https://github.com/baize7815/jev-mcp-open-source/blob/main/THIRD_PARTY_NOTICES.md 。
