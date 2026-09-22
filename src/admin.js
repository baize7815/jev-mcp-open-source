import { listKeys, addKey, setKeyEnabled, deleteKey } from "./keys.js";
// src/admin.ts
var html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev MCP \u7BA1\u7406</title><link rel="stylesheet" href="/admin/style.css"></head>
<body><main><header><div><h1>Jev MCP</h1><p>\u7BA1\u7406 TypeSafe API Key \xB7 \u7528\u91CF\u4EC5\u7EDF\u8BA1\u7ECF\u672C MCP \u7684\u8C03\u7528</p></div><span class="badge">/mcp \u516C\u5F00</span></header>
<section id="login"><h2>\u7BA1\u7406\u767B\u5F55</h2><p>\u8F93\u5165\u90E8\u7F72\u65F6\u8BBE\u7F6E\u7684 ADMIN_TOKEN\u3002\u4EE4\u724C\u4EC5\u4FDD\u5B58\u5728\u5F53\u524D\u9875\u9762\u5185\u5B58\u4E2D\u3002</p>
<form id="login-form"><input id="token" type="password" required autocomplete="off" placeholder="ADMIN_TOKEN"><button>\u8FDB\u5165</button></form></section>
<section id="panel" hidden><div class="toolbar"><div><h2>API Key</h2><p id="summary"></p></div><button id="logout" class="secondary">\u9000\u51FA</button></div>
<form id="add-form" class="add-form"><input id="label" maxlength="80" required placeholder="\u540D\u79F0\uFF0C\u4F8B\u5982\uFF1A\u4E3B\u8D26\u53F7"><input id="api-key" type="password" required autocomplete="off" placeholder="TypeSafe API Key"><button>\u6DFB\u52A0</button></form>
<p id="message" role="status"></p><div class="table-wrap"><table><thead><tr><th>\u540D\u79F0</th><th>\u5BC6\u94A5</th><th>\u72B6\u6001</th><th>\u8C03\u7528</th><th>\u8F93\u5165 token</th><th>\u8F93\u51FA token</th><th>\u9519\u8BEF</th><th>\u64CD\u4F5C</th></tr></thead><tbody id="key-list"></tbody></table></div>
<p class="note">\u65B0\u8BF7\u6C42\u4F9D\u6B21\u9009\u7528\u5DF2\u542F\u7528\u7684 Key\u3002\u8BF7\u6C42\u5931\u8D25\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1\uFF0C\u907F\u514D\u91CD\u590D\u8BA1\u8D39\u3002\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u8BE5 Key\u3002</p></section>
</main><script src="/admin/app.js" defer><\/script></body></html>`;
var css = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#17253b;background:#f5f8fc}*{box-sizing:border-box}body{margin:0}main{max-width:1120px;margin:0 auto;padding:40px 24px}header,.toolbar{display:flex;justify-content:space-between;align-items:center;gap:20px}header{margin-bottom:28px}h1{font-size:30px;margin:0 0 6px}h2{font-size:19px;margin:0 0 8px}p{color:#61718b;margin:0 0 14px;line-height:1.5}.badge{border:1px solid #cbd8eb;border-radius:30px;padding:8px 12px;color:#38639c;white-space:nowrap}section{background:#fff;border:1px solid #e2e9f3;box-shadow:0 12px 36px #203b6410;border-radius:16px;padding:24px;margin-bottom:20px}form{display:flex;gap:10px}input{min-width:0;flex:1;padding:11px 12px;border:1px solid #cad5e5;border-radius:8px;font:inherit}button{border:0;border-radius:8px;background:#2259a8;color:white;padding:11px 16px;font:inherit;cursor:pointer}button:hover{background:#194984}.secondary{background:#edf3fa;color:#24538d}.secondary:hover{background:#e0ebf8}.danger{background:#fff2f2;color:#a12e34}.danger:hover{background:#ffe6e6}.add-form{margin:18px 0}#message{min-height:24px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;white-space:nowrap}th,td{padding:13px 10px;border-bottom:1px solid #e9eef5;font-size:14px}th{color:#63748e;font-weight:600}td.actions{display:flex;gap:7px}td.actions button{padding:7px 10px}.note{font-size:13px;margin:18px 0 0}#login{max-width:500px}#login form{margin-top:18px}@media(max-width:650px){main{padding:24px 14px}header{align-items:flex-start}.add-form{flex-direction:column}}`;
var js = `(() => {
  let token = '';
  const $ = (id) => document.getElementById(id);
  const message = (value) => { $('message').textContent = value; };
  const number = (value) => Number(value || 0).toLocaleString('zh-CN');
  async function api(path, options = {}) {
    const response = await fetch('/admin/api' + path, {
      ...options,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '\u8BF7\u6C42\u5931\u8D25');
    return body;
  }
  async function load() {
    const { keys } = await api('/keys');
    const body = $('key-list'); body.replaceChildren();
    const totals = keys.reduce((s, k) => ({ calls: s.calls + k.calls, input: s.input + k.input_tokens }), { calls: 0, input: 0 });
    $('summary').textContent = keys.length + ' \u4E2A Key \xB7 ' + number(totals.calls) + ' \u6B21\u8C03\u7528 \xB7 ' + number(totals.input) + ' \u8F93\u5165 token';
    for (const key of keys) {
      const tr = document.createElement('tr');
      for (const value of [key.label, key.hint, key.enabled ? '\u5DF2\u542F\u7528' : '\u5DF2\u505C\u7528', number(key.calls), number(key.input_tokens), number(key.output_tokens), number(key.errors)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      const actions = document.createElement('td'); actions.className = 'actions';
      const toggle = document.createElement('button'); toggle.className = 'secondary'; toggle.textContent = key.enabled ? '\u505C\u7528' : '\u542F\u7528';
      toggle.onclick = async () => { try { await api('/keys/' + encodeURIComponent(key.id), { method: 'PATCH', body: JSON.stringify({ enabled: !key.enabled }) }); await load(); } catch (e) { message(e.message); } };
      const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = '\u5220\u9664';
      remove.onclick = async () => { if (!confirm('\u6C38\u4E45\u5220\u9664 ' + key.label + '\uFF1F')) return; try { await api('/keys/' + encodeURIComponent(key.id), { method: 'DELETE' }); await load(); } catch (e) { message(e.message); } };
      actions.append(toggle, remove); tr.append(actions); body.append(tr);
    }
  }
  $('login-form').onsubmit = async (event) => {
    event.preventDefault(); token = $('token').value; $('token').value = '';
    try { await load(); $('login').hidden = true; $('panel').hidden = false; }
    catch (e) { token = ''; alert(e.message); }
  };
  $('logout').onclick = () => { token = ''; $('panel').hidden = true; $('login').hidden = false; };
  $('add-form').onsubmit = async (event) => {
    event.preventDefault(); message('');
    try {
      await api('/keys', { method: 'POST', body: JSON.stringify({ label: $('label').value, apiKey: $('api-key').value }) });
      $('label').value = ''; $('api-key').value = ''; await load(); message('\u5DF2\u6DFB\u52A0');
    } catch (e) { message(e.message); }
  };
})();`;
function json2(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
async function authorized(request, expected) {
  if (!expected) return false;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const actual = new Uint8Array(actualHash);
  const wanted = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ wanted[index];
  return difference === 0;
}
async function handleAdmin(request, env) {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && (path === "/admin" || path === "/admin/")) {
    return new Response(html, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff"
    } });
  }
  if (request.method === "GET" && path === "/admin/style.css") {
    return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
  }
  if (request.method === "GET" && path === "/admin/app.js") {
    return new Response(js, { headers: { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
  }
  if (!path.startsWith("/admin/api/")) return json2({ error: "Not found" }, 404);
  if (!await authorized(request, env.ADMIN_TOKEN)) return json2({ error: "\u7BA1\u7406\u4EE4\u724C\u9519\u8BEF" }, 401);
  try {
    if (path === "/admin/api/keys") {
      if (request.method === "GET") return json2({ keys: await listKeys(env.DB) });
      if (request.method === "POST") {
        if (Number(request.headers.get("Content-Length") ?? "0") > 8192) return json2({ error: "\u8BF7\u6C42\u592A\u5927" }, 413);
        const body = await request.json();
        if (typeof body.label !== "string" || !body.label.trim() || body.label.length > 80 || typeof body.apiKey !== "string" || !body.apiKey.trim() || body.apiKey.length > 2048) {
          return json2({ error: "\u8BF7\u586B\u5199\u540D\u79F0\u548C\u6709\u6548 API Key" }, 400);
        }
        await addKey(env.DB, env.KEY_ENCRYPTION_SECRET, body.label.trim(), body.apiKey.trim());
        return json2({ ok: true }, 201);
      }
    }
    const match = /^\/admin\/api\/keys\/([0-9a-f-]{36})$/.exec(path);
    if (match) {
      if (request.method === "DELETE") {
        return await deleteKey(env.DB, match[1]) ? json2({ ok: true }) : json2({ error: "Key \u4E0D\u5B58\u5728" }, 404);
      }
      if (request.method === "PATCH") {
        const body = await request.json();
        if (typeof body.enabled !== "boolean") return json2({ error: "enabled \u5FC5\u987B\u662F\u5E03\u5C14\u503C" }, 400);
        return await setKeyEnabled(env.DB, match[1], body.enabled) ? json2({ ok: true }) : json2({ error: "Key \u4E0D\u5B58\u5728" }, 404);
      }
    }
    return json2({ error: "Not found" }, 404);
  } catch (error62) {
    console.error(JSON.stringify({ event: "admin_error", message: error62 instanceof Error ? error62.message : "unknown" }));
    return json2({ error: "\u7BA1\u7406\u8BF7\u6C42\u5931\u8D25" }, 500);
  }
}

export { handleAdmin };
