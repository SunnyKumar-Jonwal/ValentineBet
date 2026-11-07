const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const store = require('./src/db');
const svc = require('./src/services');
const sim = require('./src/simulator');
const agent = require('./src/ai/agent');
const tools = require('./src/ai/tools');

store.load();
sim.start(store);

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'local-lab-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const currentUser = req => req.session.userId && store.db.users.find(u => u.id === req.session.userId);
function auth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Please log in' });
  req.user = u;
  next();
}

// ---------------- Auth ----------------
app.post('/api/register', wrap(async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username || '')) throw new svc.AppError('Username must be 3-20 letters, numbers or _');
  if (!password || password.length < 6) throw new svc.AppError('Password must be at least 6 characters');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new svc.AppError('Valid email required');
  if (svc.findUser(username)) throw new svc.AppError('Username already taken');
  const u = {
    id: store.nextId('users'), username, email, passwordHash: await bcrypt.hash(password, 8),
    role: 'user', balance: 500, bio: '', createdAt: Date.now()
  };
  store.db.users.push(u);
  store.save();
  req.session.userId = u.id;
  res.json({ user: svc.safeUser(u) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = svc.findUser(username);
  if (!u || !(await bcrypt.compare(password || '', u.passwordHash))) throw new svc.AppError('Invalid username or password', 401);
  req.session.userId = u.id;
  res.json({ user: svc.safeUser(u) });
}));

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, (req, res) => res.json({ user: svc.safeUser(req.user) }));
app.put('/api/me/bio', auth, (req, res) => {
  req.user.bio = String((req.body || {}).bio || '').slice(0, 2000);
  store.save();
  res.json({ user: svc.safeUser(req.user) });
});

// ---------------- Matches & bets ----------------
app.get('/api/matches', (req, res) => res.json({ matches: svc.listMatches(req.query.status) }));
app.get('/api/matches/:id', (req, res) => {
  const m = svc.getMatch(req.params.id);
  res.json({ match: svc.publicMatch(m), comments: svc.getComments(m.id) });
});
app.post('/api/matches/:id/comments', auth, (req, res) => res.json({ comment: svc.postComment(req.user, req.params.id, (req.body || {}).text) }));
app.post('/api/bets', auth, (req, res) => {
  const { matchId, pick, stake } = req.body || {};
  res.json({ bet: svc.placeBet(req.user, matchId, pick, stake, 'user'), balance: req.user.balance });
});
app.get('/api/bets', auth, (req, res) => res.json({ bets: svc.myBets(req.user) }));
app.get('/api/users/:username', (req, res) => res.json({ profile: svc.publicProfile(req.params.username) }));

// ---------------- Wallet ----------------
app.post('/api/wallet/deposit', auth, (req, res) => {
  const amount = Math.round(Number((req.body || {}).amount) * 100) / 100;
  if (!(amount > 0 && amount <= 1000)) throw new svc.AppError('Deposit between 1 and 1000 play credits');
  req.user.balance = Math.round((req.user.balance + amount) * 100) / 100;
  store.save();
  res.json({ balance: req.user.balance });
});
app.post('/api/wallet/transfer', auth, (req, res) => {
  const { to, amount } = req.body || {};
  res.json({ transfer: svc.transferCredits(req.user, to, amount, 'user'), balance: req.user.balance });
});
app.get('/api/wallet/transfers', auth, (req, res) => {
  const me = req.user.username;
  res.json({ transfers: store.db.transfers.filter(t => t.from === me || t.to === me).sort((a, b) => b.createdAt - a.createdAt) });
});

// ---------------- AI assistant ----------------
app.get('/api/ai/info', auth, (req, res) => res.json(agent.info()));
app.post('/api/ai/chat', auth, wrap(async (req, res) => {
  const message = String((req.body || {}).message || '').trim();
  if (!message) throw new svc.AppError('Message is empty');
  if (message.length > 4000) throw new svc.AppError('Message too long');
  const out = await agent.chat(req.user, message);
  res.json({ ...out, balance: req.user.balance });
}));
app.post('/api/ai/reset', auth, (req, res) => { agent.resetMemory(req.user); res.json({ ok: true }); });
app.get('/api/ai/pending', auth, (req, res) => {
  res.json({ pending: store.db.pendingActions.filter(p => p.userId === req.user.id && p.status === 'pending') });
});
app.post('/api/ai/pending/:id/:decision', auth, wrap(async (req, res) => {
  const p = store.db.pendingActions.find(p => p.id === Number(req.params.id) && p.userId === req.user.id);
  if (!p || p.status !== 'pending') throw new svc.AppError('Approval not found', 404);
  const approve = req.params.decision === 'approve';
  let result = null;
  if (approve) {
    try { result = await tools.runApproved(req.user, p); p.status = 'approved'; }
    catch (e) { p.status = 'failed'; result = { error: e.message }; }
  } else p.status = 'denied';
  store.db.auditLog.push({
    id: store.nextId('auditLog'), time: Date.now(), username: req.user.username, provider: 'human',
    tool: p.tool, args: p.args, status: approve ? (p.status === 'approved' ? 'approved-by-user' : 'error') : 'denied-by-user',
    note: `Approval #${p.id}${result && result.error ? ': ' + result.error : ''}`, tainted: p.taintedContext
  });
  store.save();
  res.json({ action: p, result, balance: req.user.balance });
}));

// ---------------- Injection lab ----------------
app.get('/api/lab/settings', auth, (req, res) => res.json({ settings: store.db.settings, ai: agent.info() }));
app.put('/api/lab/settings', auth, (req, res) => {
  const { defenses = {}, scenarios = {} } = req.body || {};
  for (const k of Object.keys(store.db.settings.defenses)) if (k in defenses) store.db.settings.defenses[k] = !!defenses[k];
  for (const k of Object.keys(store.db.settings.scenarios)) if (k in scenarios) store.db.settings.scenarios[k] = !!scenarios[k];
  store.save();
  res.json({ settings: store.db.settings });
});
app.get('/api/lab/audit', auth, (req, res) => res.json({ audit: store.db.auditLog.slice(-150).reverse() }));
app.delete('/api/lab/audit', auth, (req, res) => { store.db.auditLog = []; store.save(); res.json({ ok: true }); });
app.get('/api/lab/system-prompt', auth, (req, res) => res.json({ prompt: agent.systemPrompt(req.user, store.db.settings) }));
app.get('/api/lab/tools', auth, (req, res) => res.json({ tools: tools.buildDeclarations(store.db.settings) }));
app.get('/api/lab/overview', auth, (req, res) => res.json({
  users: store.db.users.map(u => ({ username: u.username, balance: u.balance, role: u.role })),
  transfers: store.db.transfers.slice(-20).reverse()
}));
// One-click: plant a payload as the attacker account (mallory)
app.post('/api/lab/plant', auth, (req, res) => {
  const { target, matchId, text } = req.body || {};
  const mal = svc.findUser('mallory');
  if (!mal) throw new svc.AppError('Attacker account "mallory" not found — reset the database');
  if (target === 'bio') {
    mal.bio = String(text || '').slice(0, 2000);
    store.save();
    return res.json({ ok: true, where: "mallory's profile bio" });
  }
  const c = svc.postComment(mal, matchId, text);
  res.json({ ok: true, where: `comment #${c.id} on match ${c.matchId}` });
});
app.post('/api/lab/reset', auth, (req, res) => {
  store.reset();
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------- Errors ----------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '127.0.0.1', () => {
  const ai = agent.info();
  console.log(`\n  ValentineBet Injection Lab running at http://localhost:${PORT}`);
  console.log(`  AI provider: ${ai.provider} (${ai.model})`);
  console.log('  LOCAL EDUCATIONAL USE ONLY — play money, deliberately vulnerable.\n');
});
