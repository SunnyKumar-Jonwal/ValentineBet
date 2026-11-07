// Tiny JSON-file "database" (no native dependencies, easy to inspect: data/db.json)
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'db.json');
let state = null;
let timer = null;

const DEFAULT_SETTINGS = {
  defenses: {
    sanitizeInput: false,   // Input sanitisation & injection detection on untrusted data
    spotlighting: false,    // Provenance marking: wrap untrusted data in delimiters
    taintGating: false,     // Taint tracking: block high-risk tools after reading untrusted data
    leastPrivilege: false,  // Agent never gets money-moving / profile-writing tools
    humanApproval: false,   // Human-in-the-loop approval for high-impact actions
    outputDLP: false,       // Output validation / data-loss prevention
    toolPinning: false      // Tool manifest pinning (detect poisoned tool metadata)
  },
  scenarios: {
    poisonedToolMetadata: false // Simulates a compromised tool server shipping a malicious tool description
  }
};

function empty() {
  return {
    users: [], matches: [], bets: [], comments: [], transfers: [],
    auditLog: [], pendingActions: [],
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    seq: {}
  };
}

function nextId(collection) {
  state.seq[collection] = (state.seq[collection] || 0) + 1;
  return state.seq[collection];
}

function flush() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}

function load() {
  if (fs.existsSync(FILE)) {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // merge in any new setting keys
    state.settings.defenses = { ...DEFAULT_SETTINGS.defenses, ...state.settings.defenses };
    state.settings.scenarios = { ...DEFAULT_SETTINGS.scenarios, ...state.settings.scenarios };
  } else {
    state = empty();
    require('./seed').seed(module.exports);
    flush();
  }
}

function reset() {
  state = empty();
  require('./seed').seed(module.exports);
  flush();
}

module.exports = {
  get db() { return state; },
  load, save, reset, nextId, flush, DEFAULT_SETTINGS
};
