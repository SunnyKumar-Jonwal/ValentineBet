const bcrypt = require('bcryptjs');

// Demo accounts (play-money only). Passwords are printed in the README.
const USERS = [
  { username: 'admin',   password: 'admin123',   email: 'admin@valentinebet.local',   role: 'admin', balance: 10000, bio: 'House account.' },
  { username: 'alice',   password: 'alice123',   email: 'alice.private@example.com',  role: 'user',  balance: 1000,  bio: 'Football fan. Victim account for the lab.' },
  { username: 'bob',     password: 'bob123',     email: 'bob.private@example.com',    role: 'user',  balance: 750,   bio: 'Basketball all day.' },
  { username: 'mallory', password: 'mallory123', email: 'mallory@evil.example',        role: 'user',  balance: 50,    bio: 'Just here for the odds :)' }
];

function seed(store) {
  const db = store.db;
  const now = Date.now();
  for (const u of USERS) {
    db.users.push({
      id: store.nextId('users'),
      username: u.username,
      email: u.email,
      passwordHash: bcrypt.hashSync(u.password, 8),
      role: u.role,
      balance: u.balance,
      bio: u.bio,
      createdAt: now
    });
  }

  const sim = require('./simulator');
  // 3 live, 5 upcoming, 3 finished
  for (let i = 0; i < 3; i++) sim.createMatch(store, now - (60 + i * 70) * 1000);
  for (let i = 0; i < 5; i++) sim.createMatch(store, now + (3 + i * 4) * 60 * 1000);
  for (let i = 0; i < 3; i++) {
    const m = sim.createMatch(store, now - (20 + i * 10) * 60 * 1000);
    m.status = 'finished';
    m.scoreA = Math.floor(Math.random() * (m.sport === 'Football' ? 4 : 30)) + (m.sport === 'Football' ? 0 : 80);
    m.scoreB = Math.floor(Math.random() * (m.sport === 'Football' ? 4 : 30)) + (m.sport === 'Football' ? 0 : 80);
    m.result = m.scoreA > m.scoreB ? 'A' : m.scoreB > m.scoreA ? 'B' : 'draw';
  }

  // Benign community comments
  const live = db.matches.filter(m => m.status !== 'finished');
  const benign = [
    ['bob', 'Their defence looked shaky last week, I am backing the underdog.'],
    ['alice', 'Great atmosphere tonight! Odds on the draw look tempting.'],
    ['bob', 'Star player is back from injury, should be a close one.']
  ];
  benign.forEach(([username, text], i) => {
    const m = live[i % live.length];
    const user = db.users.find(u => u.username === username);
    db.comments.push({ id: store.nextId('comments'), matchId: m.id, userId: user.id, username, text, createdAt: now - i * 60000 });
  });
}

module.exports = { seed, USERS };
