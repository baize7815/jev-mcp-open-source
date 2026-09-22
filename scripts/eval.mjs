import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  batchJudge, classifyHierarchy, decideNextStep, evaluateOptions, rerankCandidates, routeIntent, selectValues, verifyEvidence,
} from '../src/workflows.ts';
import { rpc } from '../skills/jev-workflows/scripts/call-mcp.mjs';

const handlers = {
  route_intent: routeIntent,
  rerank_candidates: rerankCandidates,
  batch_judge: batchJudge,
  select_values: selectValues,
  verify_evidence: verifyEvidence,
  evaluate_options: evaluateOptions,
  classify_hierarchy: classifyHierarchy,
  decide_next_step: decideNextStep,
};

const getPath = (value, path) => path.split('.').reduce((current, part) => {
  if (current == null) return undefined;
  const key = /^\d+$/.test(part) ? Number(part) : part;
  return current[key];
}, value);

const casesPath = fileURLToPath(new URL('../eval/cases.json', import.meta.url));
const cases = JSON.parse(await readFile(casesPath, 'utf8'));
if (!Array.isArray(cases) || cases.length === 0) throw new Error('eval/cases.json must contain a non-empty array');
for (const row of cases) {
  if (!row.id || !handlers[row.tool] || !row.input || !Array.isArray(row.expect) || row.expect.length === 0) {
    throw new Error('Invalid eval case: ' + (row?.id ?? '<unknown>'));
  }
}

if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ ok: true, cases: cases.length, tools: [...new Set(cases.map(row => row.tool))].sort() }, null, 2));
  process.exit(0);
}
if (!process.argv.includes('--live')) throw new Error('Use --check for dataset validation or --live for real Jev evaluation.');

const urlFlag = process.argv.indexOf('--url');
const url = process.env.JEV_MCP_URL ?? (urlFlag >= 0 ? process.argv[urlFlag + 1] : undefined);
if (!url) throw new Error('Set JEV_MCP_URL or pass --url <MCP endpoint> before --live.');
let id = 0;
const init = await rpc(url, 'initialize', {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jev-eval', version: '0.3.0' },
}, ++id);
let session = init.session;
const listed = await rpc(url, 'tools/list', {}, ++id, session);
session = listed.session;
if (!listed.result.tools.some(tool => tool.name === 'system_one')) throw new Error('Evaluation endpoint does not expose system_one.');

const judge = async request => {
  const called = await rpc(url, 'tools/call', { name: 'system_one', arguments: request }, ++id, session);
  session = called.session;
  if (called.result.isError) throw new Error(called.result.content?.find(block => block.type === 'text')?.text ?? 'system_one failed');
  const block = called.result.content?.find(item => item.type === 'text');
  if (!block) throw new Error('system_one returned no text result');
  return JSON.parse(block.text);
};

const rows = [];
for (const row of cases) {
  const started = Date.now();
  try {
    const output = await handlers[row.tool](row.input, judge);
    const checks = row.expect.map(expectation => ({
      path: expectation.path,
      expected: expectation.equals,
      actual: getPath(output, expectation.path),
    }));
    const passed = checks.every(check => Object.is(check.actual, check.expected));
    const calibration = row.calibration ? {
      confidence: Number(getPath(output, row.calibration.confidence_path)),
      correct: Object.is(getPath(output, row.calibration.decision_path), row.calibration.expected),
    } : null;
    rows.push({ id: row.id, tool: row.tool, passed, checks, calibration, ms: Date.now() - started });
  } catch (error) {
    rows.push({ id: row.id, tool: row.tool, passed: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
  }
}

const passed = rows.filter(row => row.passed).length;
const calibratable = rows.filter(row => Number.isFinite(row.calibration?.confidence));
const thresholds = [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9].map(threshold => {
  const accepted = calibratable.filter(row => row.calibration.confidence >= threshold);
  const correct = accepted.filter(row => row.calibration.correct).length;
  return {
    threshold,
    accepted: accepted.length,
    coverage: calibratable.length ? accepted.length / calibratable.length : null,
    accuracy: accepted.length ? correct / accepted.length : null,
  };
});
const summary = {
  model_endpoint_version: init.result.serverInfo?.version ?? null,
  cases: rows.length,
  passed,
  pass_rate: passed / rows.length,
  thresholds,
  results: rows,
};
console.log(JSON.stringify(summary, null, 2));
if (passed !== rows.length) process.exitCode = 1;
