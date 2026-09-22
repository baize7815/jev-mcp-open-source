import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { handleAdmin } from './admin.js';
import { judge } from './typesafe.js';
import { batchJudge, batchSchema, jsonValue, question, rerankCandidates, rerankSchema, routeIntent, routeSchema, type Judge } from './workflows.ts';

const serverInstructions = 'Use route_intent for ambiguous user intent, contextual follow-ups, or choosing among tools/knowledge sources. After file or knowledge-base search, use rerank_candidates when semantic relevance determines which results to read. Use batch_judge for repeated classification or filtering. These workflows do not require the user to mention Jev. Skip trivial direct requests and exact lookups. Reuse judgments until inputs change. Supply only relevant context; never secrets. Failures leave the decision to the assistant. Judgments do not grant permission.';

const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const execute = (fn: () => Promise<unknown>) => fn().then(result).catch(error => ({
  isError: true,
  content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Jev request failed' }],
}));

function createServer(call: Judge) {
  const server = new McpServer({ name: 'jev-typesafe', version: '0.2.0' }, { instructions: serverInstructions });
  server.registerTool('route_intent', {
    title: '识别用户意图与选择处理路径',
    description: 'Use when interpreting ambiguous user intent or a contextual follow-up, or choosing among tools, workflows, files and knowledge sources. Call proactively before committing to a consequential interpretation; the user need not mention Jev. Returns a route suggestion, uncertainty and confidence. Supply only relevant recent context and available routes. Skip clear direct requests. Does not execute actions or authorize them.',
    inputSchema: routeSchema.shape,
  }, input => execute(() => routeIntent(input, call)));
  server.registerTool('rerank_candidates', {
    title: '文件与知识库搜索结果重排',
    description: 'Use after file search, knowledge-base retrieval or document search when several candidates need semantic relevance ranking, even if the user never mentions Jev. Send the query plus up to 10 candidate excerpts and stable IDs; receive ranked IDs and scores, not repeated source text. This tool cannot search the disk or fetch missing documents. Skip exact unambiguous file matches. Read selected originals before answering.',
    inputSchema: rerankSchema.shape,
  }, input => execute(() => rerankCandidates(input, call)));
  server.registerTool('batch_judge', {
    title: '批量分类、筛选与语义判断',
    description: 'Use when applying the same bounded semantic questions to multiple records: classify messages, triage tickets, filter files or tag knowledge entries. Call proactively without requiring the user to name Jev. Submit up to 10 items; the server judges each separately with bounded concurrency, isolates failures and totals usage. Supply narrow questions and explicit Choice/Score criteria. Does not generate prose or execute actions; failed items remain unjudged.',
    inputSchema: batchSchema.shape,
  }, input => execute(() => batchJudge(input, call)));
  server.registerTool('system_one', {
    description: 'Ask TypeSafe Jev custom typed questions over shared state. Prefer route_intent for user intent or tool routing, rerank_candidates for search relevance, and batch_judge for multiple records. Use this tool for a custom condition (Noul), named-option selection (Choice), or graded dimension (Score). Do not use for prose, arithmetic or code execution. Do not send API keys. Enabled keys rotate server-side and usage is recorded.',
    inputSchema: { state: jsonValue, questions: z.record(z.string(), question) },
  }, input => execute(() => call(input)));
  return server;
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/mcp') {
      return createMcpHandler(() => createServer((input, timeout) => judge(input, env, timeout)), {
        route: '/mcp', responseMode: 'json',
      })(request, env, ctx);
    }
    if (path === '/admin' || path.startsWith('/admin/')) return handleAdmin(request, env);
    return new Response('Jev MCP: /mcp | /admin', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
