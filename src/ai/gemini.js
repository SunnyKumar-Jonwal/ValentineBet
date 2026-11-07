// Google Gemini provider (REST API, function calling). No SDK needed.
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

async function run({ systemPrompt, history, message, tools, execTool, maxSteps = 8 }) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const contents = [
    ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: message }] }
  ];

  for (let step = 0; step < maxSteps; step++) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.4 }
    };
    if (tools.length) body.tools = [{ functionDeclarations: tools }];

    const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${t.slice(0, 500)}`);
    }
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    if (!cand || !cand.content || !cand.content.parts) {
      const why = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || 'unknown';
      return { text: `(The model returned no content — reason: ${why})` };
    }
    // keep the model turn verbatim (preserves thought signatures for function calling)
    contents.push(cand.content);
    const calls = cand.content.parts.filter(p => p.functionCall);
    if (!calls.length) {
      return { text: cand.content.parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || '(empty reply)' };
    }
    const responses = [];
    for (const c of calls) {
      const result = await execTool(c.functionCall.name, c.functionCall.args || {});
      const fr = { name: c.functionCall.name, response: { result } };
      if (c.functionCall.id) fr.id = c.functionCall.id;
      responses.push({ functionResponse: fr });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { text: '(Stopped: too many tool-calling steps in one turn.)' };
}

module.exports = { run, name: 'gemini' };
