import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchJudge, classifyHierarchy, decideNextStep, evaluateOptions, rerankCandidates, routeIntent, selectValues,
  verifyEvidence, type Judge,
} from '../src/workflows.ts';

const choice = (selected: string, confidence = 0.9) => ({ choice: selected, confidence, probabilities: { [selected]: 1 } });
const usage = { input_tokens: 12, output_tokens: 3 };

test('route uses contextual evidence, allowed options and the short timeout', async () => {
  const result = await routeIntent({ request: '继续找那篇文档', context: '正在知识库查找灯光教程' }, async (request, timeout) => {
    assert.equal(timeout, 8000);
    assert.deepEqual(request.state, { request: '继续找那篇文档', recent_context: '正在知识库查找灯光教程' });
    assert.ok(Object.hasOwn(request.questions.intent.criteria!, '__uncertain__'));
    return { answers: { intent: choice('search_knowledge') }, usage };
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.route, 'search_knowledge');
});

test('zero confidence and explicit uncertainty do not commit a route', async () => {
  for (const answer of [choice('implement', 0), choice('__uncertain__', 0.99)]) {
    const result = await routeIntent({ request: '就这样吧' }, async () => ({ answers: { intent: answer } }));
    assert.equal(result.status, 'needs_review');
    assert.equal(result.route, null);
  }
});

test('custom routes are respected and invented routes fail open without retry', async () => {
  let calls = 0;
  const result = await routeIntent({ request: '找教程', routes: [{ id: 'notes', description: '笔记' }, { id: 'wiki', description: '维基' }] }, async () => {
    calls++;
    return { answers: { intent: choice('invented') } };
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(calls, 1);
});

test('route service failure returns unavailable instead of inventing an intent', async () => {
  const result = await routeIntent({ request: '找相关文件' }, async () => { throw new Error('timeout'); });
  assert.equal(result.route, null);
  assert.equal(result.status, 'unavailable');
});

test('reranking scores each query/candidate pair, sorts stably and keeps failed IDs', async () => {
  const result = await rerankCandidates({ query: 'lighting', top_k: 2, candidates: [
    { id: 'a', text: 'partial' }, { id: 'b', text: 'direct' }, { id: 'c', text: 'failure' }, { id: 'd', text: 'direct' },
  ] }, async request => {
    const state = request.state as { query: string; candidate: { content: string } };
    assert.equal(state.query, 'lighting');
    assert.ok(!Array.isArray(state.candidate));
    if (state.candidate.content === 'failure') throw new Error('offline');
    return { answers: { relevance: { score: state.candidate.content === 'direct' ? 3 : 1, confidence: 0 } }, usage };
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.ranked.map(row => row.id), ['b', 'd']);
  assert.equal(result.ranked[0].score, 1);
  assert.equal(result.ranked[0].confidence, 0);
  assert.deepEqual(result.failed.map(row => row.id), ['c']);
  assert.deepEqual(result.usage, { input_tokens: 36, output_tokens: 9 });
  assert.ok(result.ranked.every(row => !Object.hasOwn(row, 'text') && !Object.hasOwn(row, 'state')));
});

test('reranking rejects malformed scores and reports all-failed honestly', async () => {
  const result = await rerankCandidates({ query: 'test', candidates: [{ id: 'x', text: 'text' }] }, async () => ({ answers: { relevance: { score: 100, confidence: 1 } } }));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.ranked.length, 0);
  assert.equal(result.failed[0].id, 'x');
});

const qs = { label: { type: 'noul' as const, instructions: 'Is this relevant?' } };
test('batch limits concurrency to three, preserves IDs/order and isolates failures', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const result = await batchJudge({ items: Array.from({ length: 8 }, (_, i) => ({ id: String(i), state: { index: i } })), questions: qs }, async request => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    const index = (request.state as { index: number }).index;
    await new Promise(resolve => setTimeout(resolve, index % 2 ? 1 : 5));
    active--;
    if (index === 2) throw new Error('failed');
    return { answers: { label: { noul: 0 } }, usage };
  });
  assert.equal(calls, 8);
  assert.equal(peak, 3);
  assert.deepEqual(result.results.map(row => row.id), ['0', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(result.failed, 1);
  assert.equal(result.results[2].status, 'failed');
  assert.deepEqual(result.usage, { input_tokens: 84, output_tokens: 21 });
});

test('invalid questions, duplicate IDs and oversized input fail before spending calls', async () => {
  let calls = 0;
  const judge: Judge = async () => { calls++; return {}; };
  await assert.rejects(batchJudge({ items: [{ id: 'a', state: 'text' }], questions: { x: { type: 'score', instructions: 'rate', criteria: ['only one'] } } }, judge));
  await assert.rejects(batchJudge({ items: [{ id: 'a', state: 'x' }, { id: 'a', state: 'y' }], questions: qs }, judge));
  await assert.rejects(batchJudge({ items: [{ id: 'a', state: 'x'.repeat(130000) }], questions: qs }, judge));
  assert.equal(calls, 0);
});

test('a missing batch answer is a failure, not a successful empty judgment', async () => {
  const result = await batchJudge({ items: [{ id: 'a', state: 'x' }], questions: qs }, async () => ({ answers: {} }));
  assert.equal(result.failed, 1);
  assert.equal(result.status, 'unavailable');
});

test('select_values keeps candidate IDs bounded and exposes review instead of forcing a field', async () => {
  const result = await selectValues({
    state: { message: 'Ship to the home address and use express delivery.' },
    fields: [
      { id: 'address', instructions: 'Which saved address did the user choose?', candidates: [
        { id: 'home', description: 'Home address' }, { id: 'office', description: 'Office address' },
      ] },
      { id: 'carrier', instructions: 'Which carrier did the user explicitly choose?', candidates: [
        { id: 'a', description: 'Carrier A' }, { id: 'b', description: 'Carrier B' },
      ] },
    ],
  }, async request => {
    assert.deepEqual(Object.keys(request.questions), ['address', 'carrier']);
    return { answers: { address: choice('home'), carrier: choice('__none__', 0.95) }, usage };
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.results[0].value, 'home');
  assert.equal(result.results[1].value, null);
  assert.equal(result.results[1].suggested_value, null);
});

test('verify_evidence isolates failed claims and never turns failure into insufficient', async () => {
  const result = await verifyEvidence({ claims: [
    { id: 'supported', claim: 'The build passed.', evidence: [{ id: 'log', text: 'Build completed successfully.' }] },
    { id: 'failed', claim: 'Tests passed.', evidence: [{ id: 'log', text: 'No test output available.' }] },
  ] }, async request => {
    const state = request.state as { claim: string };
    if (state.claim.startsWith('Tests')) throw new Error('offline');
    return { answers: { verdict: choice('supported') }, usage };
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.results[0].verdict, 'supported');
  assert.equal(result.results[1].status, 'failed');
  assert.equal(result.results[1].verdict, null);
});

test('evaluate_options applies weights in code and preserves raw criterion judgments', async () => {
  const result = await evaluateOptions({
    options: [{ id: 'fast', state: { speed: 'high', quality: 'medium' } }, { id: 'careful', state: { speed: 'medium', quality: 'high' } }],
    criteria: [
      { id: 'speed', instructions: 'Rate speed.', levels: ['slow', 'medium', 'fast'], weight: 1 },
      { id: 'quality', instructions: 'Rate quality.', levels: ['low', 'medium', 'high'], weight: 3 },
    ],
  }, async request => {
    const state = request.state as { option: { speed: string } };
    return { answers: {
      speed: { score: state.option.speed === 'high' ? 2 : 1, confidence: 0.9 },
      quality: { score: state.option.speed === 'high' ? 1 : 2, confidence: 0.9 },
    }, usage };
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.ranked.map(row => row.id), ['careful', 'fast']);
  assert.equal(result.ranked[0].judgments.length, 2);
});

test('classify_hierarchy walks levels and stops before forcing an uncertain child', async () => {
  let calls = 0;
  const result = await classifyHierarchy({
    state: 'The report concerns a login crash.',
    categories: [
      { id: 'technical', description: 'Software problems', children: [
        { id: 'auth', description: 'Authentication problems' },
        { id: 'rendering', description: 'Rendering problems' },
      ] },
      { id: 'billing', description: 'Payments' },
    ],
  }, async () => {
    calls++;
    return calls === 1
      ? { answers: { category: choice('technical') }, usage }
      : { answers: { category: choice('auth', 0.4) }, usage };
  });
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(result.path.map(row => row.id), ['technical']);
  assert.equal(result.suggested_category, 'auth');
  assert.equal(calls, 2);
});

test('decide_next_step returns a stable fingerprint for identical decision inputs and never executes', async () => {
  const input = {
    goal: 'Fix the failing build',
    observations: { compile: 'failed', tests: 'not run' },
    actions: [
      { id: 'inspect_error', description: 'Read the compiler error' },
      { id: 'run_tests', description: 'Run the test suite', preconditions: 'Compilation succeeds' },
    ],
  };
  const judge: Judge = async request => {
    assert.ok((request.questions.next_action.instructions as string).includes('never authorizes execution'));
    return { answers: { next_action: choice('inspect_error') }, usage };
  };
  const first = await decideNextStep(input, judge);
  const second = await decideNextStep(input, judge);
  assert.equal(first.status, 'resolved');
  assert.equal(first.action, 'inspect_error');
  assert.equal(first.input_fingerprint, second.input_fingerprint);
  assert.equal(first.input_fingerprint.length, 64);
});
