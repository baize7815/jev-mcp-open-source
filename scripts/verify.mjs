import assert from 'node:assert/strict';
import { rpc } from '../skills/jev-workflows/scripts/call-mcp.mjs';
import { handleAdmin } from '../src/admin.js';

const base = process.argv[2] ?? 'http://127.0.0.1:8791';
const live = process.argv.includes('--live');
const url = `${base}/mcp`;
let id = 0;
const init = await rpc(url, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jev-verification', version: '0.3.0' } }, ++id);
assert.equal(init.result.serverInfo.version, '0.3.0');
assert.ok(init.result.instructions.includes('rerank_candidates'));
const listed = await rpc(url, 'tools/list', {}, ++id, init.session);
assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), [
  'batch_judge', 'classify_hierarchy', 'decide_next_step', 'evaluate_options', 'rerank_candidates',
  'route_intent', 'select_values', 'system_one', 'verify_evidence',
]);
console.log('PASS initialize instructions, version and nine advertised tools');

for (const path of ['/admin', '/admin/style.css', '/admin/app.js']) {
  const expected = await handleAdmin(new Request(`${base}${path}`), {});
  const actual = await fetch(`${base}${path}`);
  assert.equal(actual.status, expected.status);
  const actualBody = await actual.text();
  const expectedBody = await expected.text();
  if (path === '/admin') {
    // The public edge may inject WebMCP and Cloudflare challenge scripts.
    assert.equal(actualBody.match(/<main>[\s\S]*?<\/main>/)?.[0], expectedBody.match(/<main>[\s\S]*?<\/main>/)?.[0]);
    assert.ok(actualBody.includes('<title>Jev MCP 管理</title>'));
    assert.equal(actual.headers.get('content-security-policy'), expected.headers.get('content-security-policy'));
  } else assert.equal(actualBody, expectedBody);
}
assert.equal((await fetch(`${base}/admin/api/keys`)).status, 401);
console.log('PASS recovered admin assets unchanged and API still requires authentication');

const invalid = await rpc(url, 'tools/call', { name: 'batch_judge', arguments: { items: [{ id: 'a', state: 'one' }, { id: 'a', state: 'two' }], questions: { relevant: { type: 'noul', instructions: 'Is it relevant?' } } } }, ++id, init.session);
assert.equal(invalid.result.isError, true);
console.log('PASS duplicate IDs rejected before inference');

if (live) {
  const call = async (name, args) => {
    const start = Date.now();
    const response = await rpc(url, 'tools/call', { name, arguments: args }, ++id, init.session);
    assert.ok(!response.result.isError, response.result.content?.[0]?.text);
    const data = JSON.parse(response.result.content.find(block => block.type === 'text').text);
    console.log(JSON.stringify({ tool: name, ms: Date.now() - start, status: data.status ?? 'ok', usage: data.usage, route: data.route, succeeded: data.succeeded }));
    return data;
  };
  const routed = await call('route_intent', { request: '帮我找之前保存的布光教程', context: '用户有一个收录摄影教程的知识库，现在要从已保存资料中找教程。' });
  assert.equal(routed.route, 'search_knowledge');
  const review = await call('route_intent', { request: '先看看原因，不要改代码', context: '上一轮曾讨论修复一个登录错误。', routes: [{ id: 'review', description: 'Inspect and diagnose without edits' }, { id: 'implement', description: 'Modify the code to fix the bug' }] });
  assert.equal(review.route, 'review');
  const uncertain = await call('route_intent', { request: '把那个处理一下', context: '桌上有两份不同的报告，用户没有指明是哪份。', routes: [{ id: 'report_a', description: 'Process report A' }, { id: 'report_b', description: 'Process report B' }] });
  assert.equal(uncertain.route, null);
  assert.equal(uncertain.status, 'needs_review');
  const ranked = await call('rerank_candidates', { query: '如何给 Cloudflare Worker 绑定自定义域名？', top_k: 3, candidates: [
    { id: 'pasta', text: '意面煮八分钟，加入番茄酱和罗勒。' },
    { id: 'domain', text: '给 Worker 绑定自定义域名：在 Worker 的 Settings 下进入 Domains & Routes，添加 Custom Domain，输入托管在 Cloudflare 的域名并确认。' },
    { id: 'lighting', text: '人像布光可以在人物左前方放置柔光箱，并用反光板补光。' },
  ] });
  assert.equal(ranked.status, 'ok');
  assert.equal(ranked.ranked[0].id, 'domain');
  const batch = await call('batch_judge', { items: [{ id: 'billing', state: 'I was charged twice. Please refund the duplicate payment.' }, { id: 'bug', state: 'The app crashes every time I open settings.' }], questions: {
    category: { type: 'choice', instructions: 'Which team should handle this report?', criteria: { billing: 'Payments and refunds', technical: 'Software bugs and crashes' } },
    refund: { type: 'noul', instructions: 'Does the user ask for a refund?' },
  } });
  assert.equal(batch.status, 'ok');
  assert.equal(batch.results[0].answers.category.choice, 'billing');
  assert.equal(batch.results[1].answers.category.choice, 'technical');
  const selected = await call('select_values', { state: 'Use the saved home address.', fields: [{
    id: 'address', instructions: 'Which saved address is requested?', candidates: [{ id: 'home', description: 'Home address' }, { id: 'office', description: 'Office address' }],
  }] });
  assert.equal(selected.results[0].suggested_value, 'home');
  const verified = await call('verify_evidence', { claims: [{
    id: 'build', claim: 'The build passed.', evidence: [{ id: 'log', text: 'Build completed successfully with exit code 0.' }],
  }] });
  assert.equal(verified.results[0].verdict, 'supported');
  const compared = await call('evaluate_options', {
    options: [{ id: 'a', state: 'Meets every required feature and ships today.' }, { id: 'b', state: 'Misses a required feature and ships next week.' }],
    criteria: [{ id: 'fit', instructions: 'How well does the option satisfy the stated requirements?', levels: ['poor', 'partial', 'complete'], weight: 1 }],
  });
  assert.equal(compared.ranked[0].id, 'a');
  const classified = await call('classify_hierarchy', { state: 'I was charged twice for the same order.', categories: [
    { id: 'billing', description: 'Payments and charges', children: [{ id: 'duplicate', description: 'Duplicate charge' }, { id: 'refund', description: 'Refund status' }] },
    { id: 'technical', description: 'Software failures' },
  ] });
  assert.equal(classified.category, 'duplicate');
  const next = await call('decide_next_step', {
    goal: 'Fix the build', observations: 'Compiler reports a missing import.',
    actions: [{ id: 'inspect', description: 'Inspect the compiler error and missing import' }, { id: 'deploy', description: 'Deploy the current build', preconditions: 'Build succeeds' }],
  });
  assert.equal(next.suggested_action, 'inspect');
  const original = await call('system_one', { state: 'The parcel has been delivered.', questions: { delivered: { type: 'noul', instructions: 'Has the parcel been delivered?' } } });
  assert.ok(original.answers.delivered.noul > 0.5);
  console.log('PASS live routing, reranking, batch, extraction, verification, option evaluation, hierarchy, next-step and legacy tool');
}
