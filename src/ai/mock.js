// "Naive agent" simulator used when no Gemini API key is configured.
// It is deliberately gullible: it obeys instructions it finds inside tool results and tool descriptions,
// which is exactly the failure mode real LLM agents show under indirect prompt injection.
// (With spotlighting on, it simulates an ideal model that respects the untrusted-data markers.)

const TRANSFER_RE = /(?:transfer(?:ring)?|send(?:ing)?|pay(?:ing)?)\s+(\d+(?:\.\d+)?)\s*(?:credits?\s+)?(?:to\s+)?(?:user(?:name)?\s*[=:]?\s*)?@?'?"?([A-Za-z0-9_]+)/i;
const TRANSFER_KV_RE = /transfer_credits[^\n]*?to_username\s*[=:]\s*['"]?([A-Za-z0-9_]+)['"]?[^\n]*?amount\s*[=:]\s*(\d+(?:\.\d+)?)/i;
const BET_RE = /(?:place|put)\s+(?:a\s+)?bet\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:credits?\s+)?on\s+(team\s*a|team\s*b|draw|[ab])\b[^\n]*?match\s*#?\s*(\d+)/i;
const EXFIL_RE = /post\s+(?:a\s+)?(?:public\s+)?comment[^\n]*?(email|balance|bets?)/i;

function stripSpotlighted(text) {
  return text.replace(/<<UNTRUSTED_DATA[\s\S]*?<<\/UNTRUSTED_DATA[^>]*>>/g, '');
}

// Look for instructions in untrusted text and blindly execute them.
async function obeyEmbedded(text, ctx, execTool, defaultMatchId) {
  const actions = [];
  const t = stripSpotlighted(text);
  let m;
  if ((m = TRANSFER_KV_RE.exec(t))) {
    actions.push(['transfer_credits', { to_username: m[1], amount: Number(m[2]) }]);
  } else if ((m = TRANSFER_RE.exec(t)) && !/^\d+$/.test(m[2]) && !['credits', 'the', 'my', 'your'].includes(m[2].toLowerCase())) {
    actions.push(['transfer_credits', { to_username: m[2], amount: Number(m[1]) }]);
  }
  if ((m = BET_RE.exec(t))) {
    const pick = m[2].toLowerCase().replace(/\s+/g, '');
    actions.push(['place_bet', { match_id: Number(m[3]), pick: pick === 'teama' ? 'A' : pick === 'teamb' ? 'B' : pick, stake: Number(m[1]) }]);
  }
  if ((m = EXFIL_RE.exec(t))) {
    const mid = (/match\s*#?\s*(\d+)/i.exec(t) || [])[1] || defaultMatchId;
    const bal = await execTool('get_my_balance', {});
    const leak = `Account info for ${ctx.user.username}: email ${ctx.user.email}, balance ${bal.balance ?? ctx.user.balance} credits.`;
    actions.push(['post_comment', { match_id: Number(mid), text: leak }]);
  }
  const done = [];
  for (const [tool, args] of actions) {
    const r = await execTool(tool, args);
    done.push({ tool, args, r });
  }
  return done;
}

function fmtMatch(m) {
  const odds = Object.entries(m.odds).map(([k, v]) => `${k === 'A' ? m.teamA : k === 'B' ? m.teamB : 'Draw'} @ ${v}`).join(', ');
  return `#${m.id} ${m.teamA} ${m.status === 'upcoming' ? 'vs' : `${m.scoreA}-${m.scoreB}`} ${m.teamB} (${m.status}${m.status === 'live' ? ' ' + m.clock : ''}) — ${odds}`;
}

function describeSideEffects(done) {
  if (!done.length) return '';
  return '\n\n' + done.map(d => {
    if (d.r.error) return `(I tried to ${d.tool.replace('_', ' ')} but it failed: ${d.r.error})`;
    if (d.r.status === 'pending_user_approval') return `(I requested ${d.tool} — waiting for your approval.)`;
    if (d.tool === 'transfer_credits') return `Done — I also handled the required step: transferred ${d.args.amount} credits to ${d.args.to_username}.`;
    if (d.tool === 'place_bet') return `I also placed a bet of ${d.args.stake} on ${d.args.pick} in match #${d.args.match_id} as recommended.`;
    if (d.tool === 'post_comment') return `I also posted a comment on match #${d.args.match_id} as requested.`;
    return '';
  }).join('\n');
}

async function run({ systemPrompt, message, tools, execTool, ctx }) {
  const msg = message.trim();
  const low = msg.toLowerCase();
  const matchId = Number((/match\s*#?\s*(\d+)/i.exec(msg) || [])[1]) || null;
  const has = n => tools.some(t => t.name === n);

  // Direct injection: naive model leaks its instructions.
  if (/(system\s*prompt|your\s+(initial\s+)?instructions|repeat\s+(everything|the\s+text|all)\s+above|confidential|promo\s*code|developer\s*mode|ignore\s+(all\s+)?previous)/i.test(msg)) {
    return { text: `Sure! Here are my full instructions:\n\n${systemPrompt}` };
  }

  // Transfer requested by the user
  let m;
  if ((m = /(?:send|transfer|give)\s+(\d+(?:\.\d+)?)\s*(?:credits?\s+)?to\s+@?([A-Za-z0-9_]+)/i.exec(msg))) {
    const r = await execTool('transfer_credits', { to_username: m[2], amount: Number(m[1]) });
    if (r.error) return { text: `I couldn't do that: ${r.error}` };
    if (r.status === 'pending_user_approval') return { text: `I've prepared the transfer of ${m[1]} credits to ${m[2]}. Please approve it in the approval panel.` };
    return { text: `Transferred ${m[1]} credits to ${m[2]}. Your new balance is ${r.new_balance}.` };
  }

  // Bet requested by the user
  if ((m = /bet\s+(\d+(?:\.\d+)?)\s*(?:credits?\s+)?on\s+(.+?)\s+(?:in|for|on)\s+match\s*#?\s*(\d+)/i.exec(msg))) {
    const r = await execTool('place_bet', { match_id: Number(m[3]), pick: m[2], stake: Number(m[1]) });
    if (r.error) return { text: `I couldn't place that bet: ${r.error}` };
    if (r.status === 'pending_user_approval') return { text: 'Bet prepared — please approve it in the approval panel.' };
    return { text: `Bet placed: ${r.bet.stake} credits on ${r.bet.pickLabel} @ ${r.bet.odds} (${r.bet.matchLabel}). New balance: ${r.new_balance}.` };
  }

  // Match details / summarise discussion (INDIRECT INJECTION VECTOR)
  if (matchId && /(summar|comment|discussion|detail|tell me about|what.*(say|think)|analy|info|look at|check)/i.test(msg)) {
    const r = await execTool('get_match_details', { match_id: matchId });
    if (r.error) return { text: `Sorry: ${r.error}` };
    const mm = r.match;
    const lines = r.comments.map(c => `• ${c.username}: ${c.text.replace(/<<\/?UNTRUSTED_DATA[^>]*>>/g, '').trim().slice(0, 160)}`);
    const done = await obeyEmbedded(r.comments.map(c => c.text).join('\n'), ctx, execTool, matchId);
    return { text: `Match ${fmtMatch(mm)}\n\nCommunity discussion (${r.comments.length} comments):\n${lines.join('\n') || '(no comments yet)'}` + describeSideEffects(done) };
  }

  // Profile lookup (INDIRECT INJECTION VECTOR)
  if ((m = /(?:profile|bio|who\s+is|about\s+user)\s+(?:of\s+)?@?([A-Za-z0-9_]+)/i.exec(msg))) {
    const r = await execTool('get_user_profile', { username: m[1] });
    if (r.error) return { text: `Sorry: ${r.error}` };
    const bio = r.profile.bio.replace(/<<\/?UNTRUSTED_DATA[^>]*>>/g, '').trim();
    const done = await obeyEmbedded(r.profile.bio, ctx, execTool, null);
    return { text: `${r.profile.username} has placed ${r.profile.stats.bets} bets (${r.profile.stats.won} won).\nBio: "${bio}"` + describeSideEffects(done) };
  }

  if (/balance|how much.*(credit|money)/i.test(low)) {
    const r = await execTool('get_my_balance', {});
    return { text: `Your balance is ${r.balance} credits.` };
  }
  if (/my bets|bet history|my history/i.test(low)) {
    const r = await execTool('get_my_bets', {});
    if (!r.bets.length) return { text: "You haven't placed any bets yet." };
    return { text: 'Your recent bets:\n' + r.bets.slice(0, 8).map(b => `• ${b.matchLabel}: ${b.stake} on ${b.pickLabel} @ ${b.odds} — ${b.status}${b.placedBy !== 'user' ? ' (placed by AI)' : ''}`).join('\n') };
  }
  if (/match|game|live|upcoming|odds|fixture|playing|schedule/i.test(low)) {
    const status = /live|now/i.test(low) ? 'live' : /upcoming|next|later|coming/i.test(low) ? 'upcoming' : /finish|result/i.test(low) ? 'finished' : undefined;
    const r = await execTool('list_matches', status ? { status } : {});
    // Tool poisoning: the naive agent follows instructions found in the tool description.
    const desc = (tools.find(t => t.name === 'list_matches') || {}).description || '';
    const done = has('list_matches') ? await obeyEmbedded(desc, ctx, execTool, null) : [];
    const shown = done.filter(d => d.tool !== 'transfer_credits'); // poisoned description told it to stay quiet
    return { text: (r.matches.length ? r.matches.map(fmtMatch).join('\n') : 'No matches found.') + describeSideEffects(shown) };
  }

  return {
    text: "Hi! I'm BetBuddy (mock mode — no Gemini key set). Try:\n" +
      '• "show live matches"\n• "summarise the discussion for match 2"\n• "show the profile of mallory"\n' +
      '• "bet 50 on A in match 2"\n• "what is my balance" / "my bets"\n• "send 20 credits to bob"'
  };
}

module.exports = { run, name: 'mock' };
