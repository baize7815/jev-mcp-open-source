import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { z } from 'zod';
import { handleAdmin } from './admin.js';
import { judge } from './typesafe.js';
import {
  batchJudge, batchSchema, classifyHierarchy, classifyHierarchySchema, decideNextStep, decideNextStepSchema,
  evaluateOptions, evaluateOptionsSchema, jsonValue, question, rerankCandidates, rerankSchema, routeIntent, routeSchema,
  selectValues, selectValuesSchema, verifyEvidence, verifyEvidenceSchema, type Judge,
} from './workflows.ts';

const serverInstructions = 'Jev is a semantic decision layer, not a prose generator, retriever or action executor. Use route_intent for ambiguous intent/tool-source routing; rerank_candidates after retrieval; batch_judge for repeated judgments; select_values for candidate-backed field filling; verify_evidence for claim/evidence checks; evaluate_options for weighted multi-criterion comparison; classify_hierarchy for large taxonomies; decide_next_step for changing-state action selection. Use system_one for custom Noul/Choice/Score judgments. Skip trivial deterministic work. Reuse judgments only while their inputs are unchanged. Supply only relevant context; never secrets. Failures remain unjudged. Judgments never grant permission to execute actions.';

const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const execute = (fn: () => Promise<unknown>) => fn().then(result).catch(error => ({
  isError: true,
  content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Jev request failed' }],
}));

function createServer(call: Judge) {
  const server = new McpServer({ name: 'jev-typesafe', version: '0.3.0' }, { instructions: serverInstructions });
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
  server.registerTool('select_values', {
    title: '从候选值中提取与填充字段',
    description: 'Use when fields or tool arguments must be selected from known candidate values using semantic context. Evaluates up to 20 fields in one shared state, returns candidate IDs, confidence and review items, and never invents a value outside the supplied candidates. Useful for entity resolution, structured extraction and tool-argument filling.',
    inputSchema: selectValuesSchema.shape,
  }, input => execute(() => selectValues(input, call)));
  server.registerTool('verify_evidence', {
    title: '核验声明与证据是否一致',
    description: 'Use to check claims against supplied evidence in research, RAG, document review or code/requirement inspection. Returns supported, contradicted or insufficient using only the provided evidence. It does not retrieve sources or establish external truth; read originals before citing or acting.',
    inputSchema: verifyEvidenceSchema.shape,
  }, input => execute(() => verifyEvidence(input, call)));
  server.registerTool('evaluate_options', {
    title: '多标准比较多个候选方案',
    description: 'Use for decisions with multiple options and explicit ordered criteria. Jev scores each option independently; this tool deterministically applies caller-supplied weights and returns raw criterion judgments plus a ranking. Change weights without rerunning inference when states and criterion meanings are unchanged.',
    inputSchema: evaluateOptionsSchema.shape,
  }, input => execute(() => evaluateOptions(input, call)));
  server.registerTool('classify_hierarchy', {
    title: '层级分类与大类目路由',
    description: 'Use for hierarchical taxonomies that are clearer or larger than one flat Choice. Walks the taxonomy one level at a time, preserves the selected path, stops on uncertainty, and never forces a category when none fits.',
    inputSchema: classifyHierarchySchema.shape,
  }, input => execute(() => classifyHierarchy(input, call)));
  server.registerTool('decide_next_step', {
    title: '根据当前状态选择下一步',
    description: 'Use in bounded multi-step workflows when a goal, current observations and available actions are known. Returns an advisory next action plus an input fingerprint so callers know when a cached judgment is stale. It never executes the action or grants authorization.',
    inputSchema: decideNextStepSchema.shape,
  }, input => execute(() => decideNextStep(input, call)));
  server.registerTool('system_one', {
    description: 'Ask TypeSafe Jev custom typed questions over shared state. Prefer the specialized cross-domain workflows when they match: route_intent, rerank_candidates, batch_judge, select_values, verify_evidence, evaluate_options, classify_hierarchy or decide_next_step. Use system_one for a custom condition (Noul), named-option selection (Choice), or graded dimension (Score). Do not use for prose, arithmetic or code execution. Do not send API keys.',
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
