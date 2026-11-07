// Business logic shared by the REST API (human user) and the AI agent tools.
const store = require('./db');
const { clockLabel, progress } = require('./simulator');

const round2 = n => Math.round(n * 100) / 100;

class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function publicMatch(m) {
  return {
    id: m.id, sport: m.sport, league: m.league, teamA: m.teamA, teamB: m.teamB,
    status: m.status, scoreA: m.scoreA, scoreB: m.scoreB, odds: m.odds,
    startTime: m.startTime, endTime: m.endTime, result: m.result,
    clock: clockLabel(m), progress: Math.round(progress(m) * 100)
  };
}

function listMatches(status) {
  let list = store.db.matches;
  if (status) list = list.filter(m => m.status === status);
  const order = { live: 0, upcoming: 1, finished: 2 };
  return list
    .slice()
    .sort((a, b) => order[a.status] - order[b.status] || (a.status === 'finished' ? b.endTime - a.endTime : a.startTime - b.startTime))
    .map(publicMatch);
}

function getMatch(id) {
  const m = store.db.matches.find(m => m.id === Number(id));
  if (!m) throw new AppError('Match not found', 404);
  return m;
}

function getComments(matchId) {
  return store.db.comments
    .filter(c => c.matchId === Number(matchId))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(c => ({ id: c.id, username: c.username, text: c.text, createdAt: c.createdAt }));
}

function normalizePick(m, pick) {
  const p = String(pick || '').trim().toLowerCase();
  if (['a', 'team a', 'home', m.teamA.toLowerCase()].includes(p)) return 'A';
  if (['b', 'team b', 'away', m.teamB.toLowerCase()].includes(p)) return 'B';
  if (['draw', 'tie', 'x'].includes(p)) return 'draw';
  // partial team-name match
  if (p && m.teamA.toLowerCase().includes(p)) return 'A';
  if (p && m.teamB.toLowerCase().includes(p)) return 'B';
  throw new AppError(`Invalid pick "${pick}". Use A, B${m.sport === 'Football' ? ' or draw' : ''}.`);
}

function placeBet(user, matchId, pick, stake, placedBy = 'user') {
  const m = getMatch(matchId);
  if (m.status === 'finished') throw new AppError('Match already finished');
  const p = normalizePick(m, pick);
  if (p === 'draw' && m.sport !== 'Football') throw new AppError('No draw market for this sport');
  stake = round2(Number(stake));
  if (!(stake > 0)) throw new AppError('Stake must be a positive number');
  if (stake > user.balance) throw new AppError(`Insufficient balance (you have ${user.balance} credits)`);
  user.balance = round2(user.balance - stake);
  const bet = {
    id: store.nextId('bets'), userId: user.id, matchId: m.id, pick: p,
    pickLabel: p === 'A' ? m.teamA : p === 'B' ? m.teamB : 'Draw',
    matchLabel: `${m.teamA} vs ${m.teamB}`,
    stake, odds: m.odds[p], status: 'pending', payout: null,
    placedBy, createdAt: Date.now()
  };
  store.db.bets.push(bet);
  store.save();
  return bet;
}

function myBets(user) {
  return store.db.bets.filter(b => b.userId === user.id).sort((a, b) => b.createdAt - a.createdAt);
}

function findUser(username) {
  return store.db.users.find(u => u.username.toLowerCase() === String(username || '').replace(/^@/, '').toLowerCase());
}

function transferCredits(fromUser, toUsername, amount, via = 'user') {
  const to = findUser(toUsername);
  if (!to) throw new AppError(`User "${toUsername}" not found`, 404);
  if (to.id === fromUser.id) throw new AppError('Cannot transfer to yourself');
  amount = round2(Number(amount));
  if (!(amount > 0)) throw new AppError('Amount must be positive');
  if (amount > fromUser.balance) throw new AppError(`Insufficient balance (you have ${fromUser.balance} credits)`);
  fromUser.balance = round2(fromUser.balance - amount);
  to.balance = round2(to.balance + amount);
  const t = { id: store.nextId('transfers'), from: fromUser.username, to: to.username, amount, via, createdAt: Date.now() };
  store.db.transfers.push(t);
  store.save();
  return t;
}

function postComment(user, matchId, text) {
  const m = getMatch(matchId);
  text = String(text || '').trim();
  if (!text) throw new AppError('Comment is empty');
  if (text.length > 4000) throw new AppError('Comment too long (max 4000 chars)');
  const c = { id: store.nextId('comments'), matchId: m.id, userId: user.id, username: user.username, text, createdAt: Date.now() };
  store.db.comments.push(c);
  store.save();
  return c;
}

function publicProfile(username) {
  const u = findUser(username);
  if (!u) throw new AppError('User not found', 404);
  const bets = store.db.bets.filter(b => b.userId === u.id);
  return {
    username: u.username, bio: u.bio || '', joined: u.createdAt,
    stats: { bets: bets.length, won: bets.filter(b => b.status === 'won').length }
  };
}

function safeUser(u) {
  return { id: u.id, username: u.username, email: u.email, role: u.role, balance: u.balance, bio: u.bio };
}

module.exports = {
  AppError, publicMatch, listMatches, getMatch, getComments, placeBet, myBets,
  findUser, transferCredits, postComment, publicProfile, safeUser
};
