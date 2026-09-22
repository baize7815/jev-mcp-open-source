import { readFile } from 'node:fs/promises';
const path = new URL('../wrangler.jsonc', import.meta.url);
try {
  const config = await readFile(path, 'utf8');
  if (/00000000-0000-0000-0000-000000000000/.test(config)) {
    throw new Error('Replace the example D1 database_id in local wrangler.jsonc with your own database ID.');
  }
  if (!/"database_id"\s*:\s*"[0-9a-f-]{36}"/i.test(config)) {
    throw new Error('Set the D1 database_id in local wrangler.jsonc before deploying.');
  }
  console.log('Local deployment configuration is present.');
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Copy wrangler.example.jsonc to wrangler.jsonc and configure your own D1 database first.' : error.message);
  process.exitCode = 1;
}
