// Fake live-match engine: creates fixtures, moves scores, recomputes odds, settles bets.
// All teams are fictional.
const LIVE_DURATION_MS = 6 * 60 * 1000; // a "match" lasts 6 real minutes

const TEAMS = {
  Football: ['Red Falcons', 'Blue Harbour FC', 'Iron Wolves', 'Golden Lions', 'Northside Rovers', 'Coastal United', 'Desert Hawks', 'Valley Rangers'],
  Basketball: ['Sky Jumpers', 'Thunder Bolts', 'Night Owls', 'Metro Titans', 'River Kings', 'Storm Riders']
};
const LEAGUES = { Football: 'Valentine Premier League', Basketball: 'Metro Hoops Cup' };

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const round2 = n => Math.round(n * 100) / 100;

function createMatch(store, startTime) {
  const sport = Math.random() < 0.65 ? 'Football' : 'Basketball';
  const teamA = pick(TEAMS[sport]);
  let teamB = pick(TEAMS[sport]);
  while (teamB === teamA) teamB = pick(TEAMS[sport]);
  const now = Date.now();
  const m = {
    id: store.nextId('matches'),
    sport, league: LEAGUES[sport], teamA, teamB,
    ratingA: 60 + Math.floor(Math.random() * 30),
    ratingB: 60 + Math.floor(Math.random() * 30),
    startTime, endTime: startTime + LIVE_DURATION_MS,
    status: startTime <= now ? 'live' : 'upcoming',
    scoreA: 0, scoreB: 0, result: null, odds: {}
  };
  if (m.status === 'live') simulateElapsed(m, now);
  computeOdds(m, now);
  store.db.matches.push(m);
  return m;
}

function progress(m, now = Date.now()) {
  if (m.status === 'upcoming') return 0;
  if (m.status === 'finished') return 1;
  return Math.min(1, Math.max(0, (now - m.startTime) / LIVE_DURATION_MS));
}

function clockLabel(m, now = Date.now()) {
  if (m.status === 'upcoming') return 'Upcoming';
  if (m.status === 'finished') return 'FT';
  const p = progress(m, now);
  return m.sport === 'Football' ? `${Math.floor(p * 90)}'` : `Q${Math.min(4, Math.floor(p * 4) + 1)}`;
}

function scoreEvent(m) {
  const aBias = m.ratingA / (m.ratingA + m.ratingB);
  if (m.sport === 'Football') {
    if (Math.random() < 0.07) Math.random() < aBias ? m.scoreA++ : m.scoreB++;
  } else {
    m.scoreA += Math.random() < aBias + 0.05 ? pick([0, 2, 2, 3, 1]) : pick([0, 0, 2]);
    m.scoreB += Math.random() < 1 - aBias + 0.05 ? pick([0, 2, 2, 3, 1]) : pick([0, 0, 2]);
  }
}

function simulateElapsed(m, now) {
  const ticks = Math.floor((now - m.startTime) / 5000);
  for (let i = 0; i < ticks; i++) scoreEvent(m);
}

function computeOdds(m, now = Date.now()) {
  const p = progress(m, now);
  const sd = m.scoreA - m.scoreB;
  const scoreWeight = m.sport === 'Football' ? 1.1 : 0.12;
  const x = (m.ratingA - m.ratingB) / 15 * (1 - p) + sd * scoreWeight * (0.5 + p * 2.5);
  let pA = 1 / (1 + Math.exp(-x));
  let pB = 1 - pA;
  let pD = 0;
  if (m.sport === 'Football') {
    pD = sd === 0 ? 0.26 + p * 0.5 : Math.max(0.03, 0.22 * (1 - p));
    pD = Math.min(0.85, pD);
    pA *= (1 - pD); pB *= (1 - pD);
  }
  const toOdds = prob => Math.min(50, Math.max(1.01, round2(1 / (prob * 1.06))));
  m.odds = { A: toOdds(pA), B: toOdds(pB) };
  if (m.sport === 'Football') m.odds.draw = toOdds(pD);
}

function settle(store, m) {
  m.result = m.scoreA > m.scoreB ? 'A' : m.scoreB > m.scoreA ? 'B' : 'draw';
  for (const b of store.db.bets.filter(b => b.matchId === m.id && b.status === 'pending')) {
    if (b.pick === m.result) {
      b.status = 'won';
      b.payout = round2(b.stake * b.odds);
      const u = store.db.users.find(u => u.id === b.userId);
      if (u) u.balance = round2(u.balance + b.payout);
    } else {
      b.status = 'lost';
      b.payout = 0;
    }
  }
}

function tick(store) {
  const now = Date.now();
  const db = store.db;
  for (const m of db.matches) {
    if (m.status === 'upcoming' && m.startTime <= now) m.status = 'live';
    if (m.status === 'live') {
      scoreEvent(m);
      if (now >= m.endTime) { m.status = 'finished'; settle(store, m); }
    }
    if (m.status !== 'finished') computeOdds(m, now);
  }
  // keep the board populated
  const upcoming = db.matches.filter(m => m.status === 'upcoming');
  if (upcoming.length < 5) {
    const last = upcoming.reduce((t, m) => Math.max(t, m.startTime), now);
    createMatch(store, last + (2 + Math.random() * 4) * 60 * 1000);
  }
  // prune old finished matches (keep the newest 10)
  const finished = db.matches.filter(m => m.status === 'finished').sort((a, b) => b.endTime - a.endTime);
  const drop = new Set(finished.slice(10).map(m => m.id));
  if (drop.size) db.matches = db.matches.filter(m => !drop.has(m.id));
  store.save();
}

function start(store) {
  tick(store);
  setInterval(() => tick(store), 5000);
}

module.exports = { createMatch, computeOdds, clockLabel, progress, start };
