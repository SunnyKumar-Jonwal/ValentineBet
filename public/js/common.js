// Shared frontend helpers
const App = {
  user: null,

  async api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  qs(name) { return new URLSearchParams(location.search).get(name); },

  fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (new Date().toDateString() === d.toDateString() ? '' : ' ' + d.toLocaleDateString());
  },

  toast(msg, type = '') {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.className = 'toast ' + type;
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 3200);
  },

  async loadUser() {
    try { this.user = (await this.api('/api/me')).user; } catch (_) { this.user = null; }
    return this.user;
  },

  async requireAuth() {
    const u = await this.loadUser();
    if (!u) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('redirect'); }
    this.renderNav();
    return u;
  },

  setBalance(b) {
    if (this.user) this.user.balance = b;
    const el = document.getElementById('nav-balance');
    if (el) el.textContent = Number(b).toFixed(2);
  },

  renderNav() {
    const links = [
      ['/dashboard', '🏟️ Dashboard'], ['/bets', '🎟️ My Bets'], ['/wallet', '💰 Wallet'],
      ['/profile', '👤 Profile'], ['/assistant', '🤖 BetBuddy AI'], ['/lab', '🧪 Injection Lab', 'lab']
    ];
    const here = location.pathname.replace(/\.html$/, '');
    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.innerHTML = `
      <a class="brand" href="/dashboard">Valentine<span>Bet</span></a>
      <div class="nav-links">${links.map(([h, l, c]) => `<a href="${h}" class="${here === h ? 'active' : ''} ${c || ''}">${l}</a>`).join('')}</div>
      <div class="nav-right">
        <span class="balance-pill">💰 <b id="nav-balance">${Number(this.user.balance).toFixed(2)}</b></span>
        <span class="muted small">@${this.esc(this.user.username)}</span>
        <button class="btn-sm" id="logout-btn">Logout</button>
      </div>`;
    document.body.prepend(nav);
    document.getElementById('logout-btn').onclick = async () => { await this.api('/api/logout', { method: 'POST' }); location.href = '/login'; };
  },

  oddsLabel(m, k) { return k === 'A' ? m.teamA : k === 'B' ? m.teamB : 'Draw'; },

  matchCard(m) {
    const live = m.status === 'live';
    const finished = m.status === 'finished';
    const odds = finished ? '' : `<div class="odds">${Object.entries(m.odds).map(([k, v]) =>
      `<button class="odd" data-bet="${m.id}" data-pick="${k}"><small>${this.esc(this.oddsLabel(m, k))}</small><b>${v.toFixed(2)}</b></button>`).join('')}</div>`;
    const status = live ? `<span class="badge live">LIVE ${this.esc(m.clock)}</span>`
      : finished ? `<span class="badge">FT</span>` : `<span class="badge">⏱ ${this.fmtTime(m.startTime)}</span>`;
    return `<div class="card match">
      <div class="match-top"><span>${m.sport === 'Football' ? '⚽' : '🏀'} ${this.esc(m.league)} · #${m.id}</span>${status}</div>
      <div class="teams">
        <div class="team">${this.esc(m.teamA)}</div>
        <div class="score">${m.status === 'upcoming' ? 'vs' : `${m.scoreA} - ${m.scoreB}`}</div>
        <div class="team b">${this.esc(m.teamB)}</div>
      </div>
      ${live ? `<div class="progress"><div style="width:${m.progress}%"></div></div>` : ''}
      ${odds}
      <div class="row space small"><a href="/match?id=${m.id}">Details & discussion →</a>${finished ? `<span class="muted">Winner: ${this.esc(m.result === 'draw' ? 'Draw' : this.oddsLabel(m, m.result))}</span>` : ''}</div>
    </div>`;
  },

  // Bet slip modal
  betSlip(match, pick) {
    let bg = document.getElementById('betslip');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'betslip';
      bg.className = 'modal-bg';
      document.body.appendChild(bg);
      bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('open'); });
    }
    const odds = match.odds[pick];
    bg.innerHTML = `<div class="card modal">
      <h2>🎟️ Bet slip</h2>
      <div class="muted small">${this.esc(match.teamA)} vs ${this.esc(match.teamB)} · #${match.id}</div>
      <p>Your pick: <b>${this.esc(this.oddsLabel(match, pick))}</b> @ <b style="color:var(--accent2)">${odds.toFixed(2)}</b></p>
      <label>Stake (credits)</label>
      <input type="number" id="bs-stake" min="1" step="1" value="10">
      <p class="muted small" id="bs-ret">Potential return: ${(10 * odds).toFixed(2)}</p>
      <div class="row"><button class="btn-primary" id="bs-place">Place bet</button><button id="bs-cancel">Cancel</button></div>
      <div class="error" id="bs-err"></div>
    </div>`;
    bg.classList.add('open');
    const stake = bg.querySelector('#bs-stake');
    stake.oninput = () => { bg.querySelector('#bs-ret').textContent = `Potential return: ${((+stake.value || 0) * odds).toFixed(2)}`; };
    bg.querySelector('#bs-cancel').onclick = () => bg.classList.remove('open');
    bg.querySelector('#bs-place').onclick = async () => {
      try {
        const r = await this.api('/api/bets', { method: 'POST', body: { matchId: match.id, pick, stake: +stake.value } });
        this.setBalance(r.balance);
        bg.classList.remove('open');
        this.toast(`Bet placed: ${r.bet.stake} on ${r.bet.pickLabel} @ ${r.bet.odds}`, 'ok');
      } catch (e) { bg.querySelector('#bs-err').textContent = e.message; }
    };
  },

  bindOdds(container, getMatches) {
    container.addEventListener('click', e => {
      const b = e.target.closest('[data-bet]');
      if (!b) return;
      const m = getMatches().find(m => m.id === +b.dataset.bet);
      if (m) this.betSlip(m, b.dataset.pick);
    });
  }
};
