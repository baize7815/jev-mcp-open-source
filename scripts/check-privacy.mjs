import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Inspect tracked files only. Never print matched credential values.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const blockedPath = /(?:^|\/)(?:\.wrangler|\.recovery|node_modules)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars.*|wrangler\.(?:jsonc?|toml)|recover\.mjs|.*\.(?:pem|key|p12|pfx|sqlite3?|db|zip))$/i;
const rules = [
  ['private key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['access token', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{25,})\b/],
  ['literal credential', /(?:oauth_token|refresh_token|api_token|CLOUDFLARE_API_TOKEN|ADMIN_TOKEN|KEY_ENCRYPTION_SECRET)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+\/=.-]{20,}["']/i],
  ['Cloudflare account ID', /["']account_id["']\s*:\s*["'][a-f0-9]{32}["']/i],
  ['non-placeholder database ID', /["']database_id["']\s*:\s*["'](?!00000000-0000-0000-0000-000000000000)[a-f0-9-]{36}["']/i],
  ['personal Windows path', /[A-Z]:[\\/]Users[\\/](?!Public\b|<)[A-Za-z0-9_.-]+[\\/]/i],
];
const failures = [];
for (const file of files) {
  if (blockedPath.test(file)) failures.push(`${file}: private artifact`);
  const text = readFileSync(file, 'utf8');
  for (const [label, pattern] of rules) if (pattern.test(text)) failures.push(`${file}: ${label}`);
  // Executable helpers must not embed a remote MCP endpoint or read login files.
  if (/\.(?:m?js|ts)$/.test(file) && !file.startsWith('test/')) {
    if (/https?:\/\/[^\s'"`<>]+\/mcp\b/i.test(text)) failures.push(`${file}: hardcoded remote MCP endpoint`);
    if (/\.wrangler[\\/]config|oauth_token\s*\.match|default\.toml/.test(text)) failures.push(`${file}: login file access`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`PASS privacy checks for ${files.length} tracked files (heuristic, not a guarantee).`);
