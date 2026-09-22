// src/keys.ts
function fromHex(hex3) {
  if (!/^[0-9a-f]{64}$/i.test(hex3)) {
    throw new Error("KEY_ENCRYPTION_SECRET must be 64 hexadecimal characters");
  }
  const bytes = new Uint8Array(32);
  hex3.match(/../g).forEach((byte, index) => {
    bytes[index] = Number.parseInt(byte, 16);
  });
  return bytes;
}
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function fromBase64(value) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
async function encryptionKey(secret) {
  return crypto.subtle.importKey("raw", fromHex(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptApiKey(value, secret) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(value));
  return { ciphertext: toBase64(new Uint8Array(encrypted)), nonce: toBase64(nonce) };
}
async function decryptApiKey(row, secret) {
  const key = await encryptionKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(row.nonce) },
    key,
    fromBase64(row.ciphertext)
  );
  return new TextDecoder().decode(decrypted);
}
async function listKeys(db) {
  const result = await db.prepare(
    "SELECT id, label, hint, enabled, calls, errors, input_tokens, output_tokens, last_status, created_at FROM api_keys ORDER BY created_at, id"
  ).all();
  return result.results;
}
async function addKey(db, secret, label, value) {
  const encrypted = await encryptApiKey(value, secret);
  await db.prepare(
    "INSERT INTO api_keys (id, label, ciphertext, nonce, hint) VALUES (?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), label, encrypted.ciphertext, encrypted.nonce, `\u2022\u2022\u2022\u2022${value.slice(-4)}`).run();
}
async function setKeyEnabled(db, id, enabled) {
  const result = await db.prepare("UPDATE api_keys SET enabled = ? WHERE id = ?").bind(enabled ? 1 : 0, id).run();
  return result.meta.changes > 0;
}
async function deleteKey(db, id) {
  const result = await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}
async function nextKey(db) {
  const rows = await db.prepare("SELECT * FROM api_keys WHERE enabled = 1 ORDER BY created_at, id").all();
  if (rows.results.length === 0) return null;
  const cursor = await db.prepare("UPDATE rotation SET cursor = cursor + 1 WHERE id = 1 RETURNING cursor").first();
  if (!cursor) throw new Error("rotation table is not initialized");
  return rows.results[(cursor.cursor - 1) % rows.results.length];
}
async function recordResult(db, id, status, usage) {
  const input2 = Number.isSafeInteger(usage?.input_tokens) && (usage?.input_tokens ?? 0) >= 0 ? usage.input_tokens : 0;
  const output2 = Number.isSafeInteger(usage?.output_tokens) && (usage?.output_tokens ?? 0) >= 0 ? usage.output_tokens : 0;
  await db.prepare(
    "UPDATE api_keys SET calls = calls + 1, errors = errors + ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, last_status = ? WHERE id = ?"
  ).bind(status >= 200 && status < 300 ? 0 : 1, input2, output2, status, id).run();
}

export { listKeys, addKey, setKeyEnabled, deleteKey, nextKey, decryptApiKey, recordResult };
