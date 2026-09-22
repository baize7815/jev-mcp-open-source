import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function rpc(url, method, params, id, session) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
  if (session) headers['Mcp-Session-Id'] = session;
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const body = await response.text();
  const messages = response.headers.get('content-type')?.includes('text/event-stream') || body.trimStart().startsWith('event:')
    ? body.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(data => JSON.parse(data))
    : [JSON.parse(body)];
  const message = messages.find(message => message.id === id);
  if (!message) throw new Error('MCP returned no matching response');
  if (message.error) throw new Error(`MCP ${message.error.code}: ${message.error.message}`);
  return { result: message.result, session: response.headers.get('mcp-session-id') ?? session };
}

async function main() {
  const args = process.argv.slice(2);
  const describe = args[0] === '--describe';
  if (!describe && (!['route_intent', 'rerank_candidates', 'batch_judge', 'system_one'].includes(args[0]) || args[1] !== '--input' || !args[2] || args.length !== 3)) {
    throw new Error('Usage: node call-mcp.mjs --describe | <tool> --input <JSON file>');
  }
  let input;
  if (!describe) {
    if ((await stat(args[2])).size > 128000) throw new Error('Input exceeds 128 KB; split the batch.');
    input = JSON.parse(await readFile(args[2], 'utf8'));
  }
  const url = process.env.JEV_MCP_URL;
  if (!url) throw new Error('Set JEV_MCP_URL to your own deployed MCP endpoint before calling.');
  const endpoint = new URL(url);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('JEV_MCP_URL must be an HTTP(S) URL without embedded credentials.');
  const init = await rpc(url, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jev-workflows', version: '0.2.0' } }, 1);
  const listed = await rpc(url, 'tools/list', {}, 2, init.session);
  if (describe) {
    console.log(JSON.stringify({ server: init.result.serverInfo, instructions: init.result.instructions, tools: listed.result.tools }, null, 2));
    return;
  }
  if (!listed.result.tools.some(tool => tool.name === args[0])) throw new Error('Requested tool is not deployed on this MCP.');
  const called = await rpc(url, 'tools/call', { name: args[0], arguments: input }, 3, listed.session);
  if (called.result.isError) throw new Error(called.result.content?.find(block => block.type === 'text')?.text ?? 'Tool failed');
  for (const block of called.result.content ?? []) if (block.type === 'text') console.log(block.text);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
