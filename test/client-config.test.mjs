import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the public client refuses to run without an explicitly configured endpoint', () => {
  const env = { ...process.env };
  delete env.JEV_MCP_URL;
  const client = fileURLToPath(new URL('../skills/jev-workflows/scripts/call-mcp.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [client, '--describe'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set JEV_MCP_URL/);
});

test('the public client rejects credentials embedded in the endpoint URL', () => {
  const client = fileURLToPath(new URL('../skills/jev-workflows/scripts/call-mcp.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [client, '--describe'], { env: { ...process.env, JEV_MCP_URL: 'https://user:password@example.invalid/mcp' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without embedded credentials/);
});
