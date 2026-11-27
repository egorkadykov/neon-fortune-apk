const OWNER = 'egorkadykov';
const REPO = 'neon-fortune-apk';
const PATH = 'data/online-state.json';
const BRANCH = 'main';
const GH_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
const MAX_BALANCE = 1000000000000;
const MAX_GAIN_PER_SAVE = 100000;

let env = {};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function fail(message, status = 400) {
  return reply({ ok: false, error: String(message || 'Ошибка сервера') }, status);
}

function emptyState() {
  return { version: 1, users: {}, tokens: {}, leaderboard: [] };
}

function ghHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${env.GITHUB_TOKEN || ''}`,
    'User-Agent': 'neon-fortune-worker'
  };
}

function fromBase64(content) {
  const binary = atob(String(content || '').replace(/\s/g, ''));
  if (typeof TextDecoder !== 'undefined') {
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  return decodeURIComponent(escape(binary));
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function normalize(state) {
  const safe = state && typeof state === 'object' ? state : emptyState();
  if (!safe.users || typeof safe.users !== 'object' || Array.isArray(safe.users)) safe.users = {};
  if (!safe.tokens || typeof safe.tokens !== 'object' || Array.isArray(safe.tokens)) safe.tokens = {};
  if (!Array.isArray(safe.leaderboard)) safe.leaderboard = [];
  return safe;
}

async function readState() {
  const response = await fetch(`${GH_API}?ref=${BRANCH}&t=${Date.now()}`, {
    headers: ghHeaders(),
    cf: { cacheTtl: 0, cacheEverything: false }
  });
  if (!response.ok) throw new Error(`не удалось прочитать сервер (${response.status})`);
  const meta = await response.json();
  let state;
  try {
    state = JSON.parse(fromBase64(meta.content));
  } catch (error) {
    state = emptyState();
  }
  return { state: normalize(state), sha: meta.sha || '' };
}

async function writeState(state, sha) {
  const body = {
    message: 'Обновление прогресса через сервер игры',
    content: toBase64(JSON.stringify(state)),
    branch: BRANCH
  };
  if (sha) body.sha = sha;
  const response = await fetch(GH_API, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify(body)
  });
  if (response.status === 409) {
    const conflict = new Error('сервер обновился, повторяем');
    conflict.conflict = true;
    throw conflict;
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text).message || text; } catch (ignored) {}
    throw new Error(message || `ошибка записи (${response.status})`);
  }
  return response.json();
}

async function mutate(action) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const server = await readState();
      const result = await action(server.state);
      await writeState(server.state, server.sha);
      return result;
    } catch (error) {
      if (error && error.conflict) { lastError = error; continue; }
      throw error;
    }
  }
  throw lastError || new Error('не удалось записать прогресс');
}

function keyFor(name) {
  return String(name).trim().toLowerCase();
}

function countOwnedGifts(profile) {
  const saved = (profile && profile.gifts) || {};
  let total = 0;
  for (const key of Object.keys(saved)) total += Math.max(0, Number(saved[key]) || 0);
  return Math.max(0, Math.floor(total));
}

function buildLeaderboard(state) {
  const rows = [];
  for (const key of Object.keys(state.users)) {
    const user = state.users[key];
    const profile = user.profile || {};
    rows.push({
      name: user.name,
      balance: Number(profile.balance) || 0,
      level: Number(profile.level) || 1,
      games: (profile.stats && Number(profile.stats.spins)) || 0,
      gifts: countOwnedGifts(profile),
      chests: (profile.chestStats && Number(profile.chestStats.opened)) || 0,
      achievements: Array.isArray(profile.unlocked) ? profile.unlocked.length : 0,
      rank: typeof profile.rank === 'string' ? profile.rank : '',
      ts: user.updated || 0
    });
  }
  rows.sort((a, b) => {
    if (a.balance !== b.balance) return b.balance - a.balance;
    if (a.level !== b.level) return b.level - a.level;
    return b.games - a.games;
  });
  return rows.slice(0, 20);
}

function makeToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join('');
}

function sanitizeProfile(profile, oldBalance) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Некорректный профиль');
  const clean = {};
  for (const key of Object.keys(profile)) {
    if (key === 'balance') continue;
    const value = profile[key];
    if (value && typeof value === 'object') {
      try { clean[key] = JSON.parse(JSON.stringify(value)); } catch (ignored) {}
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      clean[key] = value;
    }
  }
  let balance = Math.floor(Number(profile.balance));
  if (!Number.isFinite(balance) || balance < 0) balance = 0;
  balance = Math.min(balance, MAX_BALANCE, oldBalance + MAX_GAIN_PER_SAVE);
  clean.balance = balance;
  return clean;
}

function publicState(state) {
  const profileMap = {};
  for (const key of Object.keys(state.users)) {
    const user = state.users[key];
    if (user.profile) profileMap[user.name] = publicUser(user);
  }
  return { version: state.version || 1, leaderboard: state.leaderboard.slice(), profiles: profileMap };
}

function publicUser(user) {
  const profile = user.profile || {};
  return {
    name: user.name,
    level: Number(profile.level) || 1,
    balance: Number(profile.balance) || 0,
    games: (profile.stats && Number(profile.stats.spins)) || 0,
    gifts: countOwnedGifts(profile),
    chests: (profile.chestStats && Number(profile.chestStats.opened)) || 0,
    achievements: Array.isArray(profile.unlocked) ? profile.unlocked.length : 0,
    rank: typeof profile.rank === 'string' ? profile.rank : '',
    ts: user.updated || 0
  };
}

function sessionUser(user) {
  const profile = user.profile || null;
  return {
    name: user.name,
    profile: profile,
    level: (profile && Number(profile.level)) || 1,
    balance: (profile && Number(profile.balance)) || 0
  };
}

async function handle(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/state';

  if (path === '/state' && request.method === 'GET') {
    const server = await readState();
    return reply({ ok: true, state: publicState(server.state) });
  }

  if (request.method !== 'POST') return fail('Метод не поддерживается', 405);

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return fail('Некорректный запрос');
  }
  if (!body || typeof body !== 'object') return fail('Некорректный запрос');

  if (path === '/login') {
    const name = String(body.name || '').trim();
    const hash = String(body.hash || '');
    const mode = body.mode === 'register' ? 'register' : 'login';
    if (!/^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/.test(name)) return fail('Никнейм: от 3 до 16 букв, цифр или _');
    if (!/^(sha256-[0-9a-f]{64}|fnv1a-[0-9a-f]{1,8})$/.test(hash)) return fail('Некорректный пароль');

    const result = await mutate((state) => {
      const key = keyFor(name);
      if (mode === 'register') {
        if (state.users[key]) throw new Error('Такой игрок уже есть — войди или придумай другой ник');
        const newToken = makeToken();
        state.users[key] = { name, hash, created: Date.now(), updated: Date.now(), profile: null };
        state.tokens[newToken] = key;
        state.leaderboard = buildLeaderboard(state);
        return { token: newToken, user: sessionUser(state.users[key]), isNew: true };
      }
      const user = state.users[key];
      if (!user || user.hash !== hash) throw new Error('Неверный никнейм или пароль');
      const sessionToken = makeToken();
      state.tokens[sessionToken] = key;
      return { token: sessionToken, user: sessionUser(user), isNew: false };
    });
    return reply({ ok: true, ...result });
  }

  if (path === '/session') {
    const sessionToken = String(body.token || '');
    const server = await readState();
    const key = server.state.tokens[sessionToken];
    if (!key || !server.state.users[key]) return fail('Нужно войти снова', 401);
    return reply({ ok: true, user: sessionUser(server.state.users[key]) });
  }

  if (path === '/save') {
    const sessionToken = String(body.token || '');
    const result = await mutate((state) => {
      const key = state.tokens[sessionToken];
      if (!key || !state.users[key]) throw new Error('Нужно войти снова');
      const user = state.users[key];
      const oldBalance = Number(user.profile && user.profile.balance) || 0;
      const profile = sanitizeProfile(body.profile, oldBalance);
      user.profile = profile;
      user.updated = Date.now();
      state.leaderboard = buildLeaderboard(state);
      return { balance: profile.balance };
    });
    return reply({ ok: true, ...result });
  }

  if (path === '/logout') {
    const sessionToken = String(body.token || '');
    await mutate((state) => {
      delete state.tokens[sessionToken];
    });
    return reply({ ok: true });
  }

  if (path === '/delete') {
    const sessionToken = String(body.token || '');
    await mutate((state) => {
      const key = state.tokens[sessionToken];
      if (!key || !state.users[key]) throw new Error('Нужно войти снова');
      delete state.users[key];
      for (const savedToken of Object.keys(state.tokens)) {
        if (state.tokens[savedToken] === key) delete state.tokens[savedToken];
      }
      state.leaderboard = buildLeaderboard(state);
    });
    return reply({ ok: true });
  }

  return fail('Не найдено', 404);
}

export default {
  async fetch(request, environment) {
    env = environment;
    try {
      return await handle(request);
    } catch (error) {
      return fail(error && error.message ? error.message : String(error), 500);
    }
  }
};
