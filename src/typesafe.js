import { nextKey, decryptApiKey, recordResult } from "./keys.js";
// src/typesafe.ts
function checkJudgment(input2) {
  const entries = Object.entries(input2.questions);
  if (entries.length === 0 || entries.length > 32) {
    throw new Error("questions must contain 1\u201332 judgments");
  }
  for (const [name, question2] of entries) {
    if (!name || name.length > 80) throw new Error("invalid question name");
    if (question2.type === "choice" && (!question2.criteria || Array.isArray(question2.criteria))) {
      throw new Error(`Choice ${name} needs object criteria`);
    }
    if (question2.type === "score" && (!Array.isArray(question2.criteria) || question2.criteria.length < 2)) {
      throw new Error(`Score ${name} needs at least two ordered criteria`);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(input2)).length > 128e3) {
    throw new Error("request is too large");
  }
}
async function judge(input2, env, timeoutMs = 30000) {
  checkJudgment(input2);
  const row = await nextKey(env.DB);
  if (!row) throw new Error("No enabled TypeSafe API key. Add one in /admin.");
  const apiKey = await decryptApiKey(row, env.KEY_ENCRYPTION_SECRET);
  let status = 502;
  try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ...input2, model: "jev-latest" }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    status = response.status;
    if (!response.ok) {
      throw new Error(`TypeSafe API returned HTTP ${status}`);
    }
    const data = await response.json();
    await recordResult(env.DB, row.id, status, data.usage);
    return data;
  } catch (error62) {
    if (status < 200 || status >= 300) await recordResult(env.DB, row.id, status);
    throw error62;
  }
}

export { checkJudgment, judge };
