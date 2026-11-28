const OWNER = 'egorkadykov';
const REPO = 'neon-fortune-apk';
const PATH = 'data/online-state.json';
const BRANCH = 'main';
const GH_API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
let versionCache = { at: 0, value: null };

const MAX_BALANCE = 1000000000000;
// Игровая экономика полностью считается здесь. Клиент не присылает ни баланс,
// ни выигрыш, ни подарки — только действия. Коэффициенты ниже дают RTP < 1,
// поэтому повтор запросов не позволяет «накрутить» звёзды.
const PAYOUT_FACTOR = 0.6;
const MAX_MULT = 1.5;
const LUCKY_CHANCE = 0.03;
const MAX_GAIN_PER_ACTION = 10000;
const MIN_ACTION_MS = 120;
const MAX_ACTIONS_PER_MIN = 180;
const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
// Защита от массовой регистрации ботов и от перегрузки сервера.
const MAX_BODY_BYTES = 16384;
const MAX_USERS = 500;
const MAX_REGISTRATIONS_PER_HOUR = 3;
const MAX_SAME_PASSWORD_USERS = 3;
const MAX_BET = 100;
const BETS = [1, 5, 10, 25, 50, 100];
const GAMES = ['slots', 'dice', 'roulette', 'darts', 'cards'];

const SYMBOLS = [
  { icon: 'cherry', weight: 18, payout: 2, refund: 10 },
  { icon: 'lemon', weight: 16, payout: 1, refund: 10 },
  { icon: 'bell', weight: 15, payout: 3, refund: 30 },
  { icon: 'star', weight: 14, payout: 4, refund: 60 },
  { icon: 'diamond', weight: 12, payout: 6, refund: 100 },
  { icon: 'melon', weight: 10, payout: 2, refund: 20 },
  { icon: 'slotDie', weight: 9, payout: 4, refund: 40 },
  { icon: 'seven', weight: 6, payout: 12, refund: 150 }
];
const DICE_FACES = ['dice1', 'dice2', 'dice3', 'dice4', 'dice5', 'dice6'];
const SUITS = ['spades', 'hearts', 'clubs', 'diamonds'];
const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5'];
const COLLECTIBLES = [
  ...SYMBOLS.map((s) => s.icon), ...DICE_FACES,
  'red', 'black', 'green', 'bullseye', 'dartGold', 'dartOuter', ...SUITS
];
const ACHIEVEMENT_IDS = [
  'first', 'dartBull', 'cardFlush', 'streak3', 'jackpot',
  'games10', 'level3', 'allChests', 'giftSell', 'giftHunter'
];
const MISSIONS = [
  { id: 'games', title: 'Сыграй 10 игр', target: 10, reward: 30 },
  { id: 'wins', title: 'Победи 5 раз', target: 5, reward: 50 },
  { id: 'triple', title: 'Получи трипу в костях', target: 1, reward: 75 },
  { id: 'jackpot', title: 'Сорви джекпот', target: 1, reward: 100 }
];
const GIFTS = {
  candy: 5, brick: 10, heart: 15, teddy: 15, rose: 25, giftBox: 25,
  cake: 50, bouquet: 50, rocket: 50, champagne: 50, postcard: 60,
  scarf: 75, musicBox: 90, lamp: 120, trophy: 100, diamond: 100,
  ring: 100, camera: 150, sneakers: 180, headphones: 220, watch: 275,
  console: 350, bike: 450, telephone: 600, crownGem: 1000
};
const RARITY = {
  candy: 1, brick: 1, heart: 1, teddy: 1, rose: 1, giftBox: 1,
  cake: 0.7, bouquet: 0.7, rocket: 0.7, champagne: 0.7, postcard: 0.7,
  scarf: 0.7, musicBox: 0.7, lamp: 0.7,
  trophy: 0.45, diamond: 0.45, ring: 0.45, camera: 0.45,
  sneakers: 0.45, headphones: 0.45, watch: 0.45,
  console: 0.12, bike: 0.12, telephone: 0.12, crownGem: 0.12
};
const CHESTS = {
  free: { cost: 0, cooldown: 86400000, delay: 500 },
  paper: { cost: 10, cooldown: 5000, delay: 500 },
  wood: { cost: 30, cooldown: 8000, delay: 560 },
  bronze: { cost: 60, cooldown: 12000, delay: 650 },
  silver: { cost: 100, cooldown: 15000, delay: 680 },
  gold: { cost: 180, cooldown: 25000, delay: 780 },
  diamond: { cost: 280, cooldown: 40000, delay: 900 },
  cosmic: { cost: 450, cooldown: 35000, delay: 820 },
  legendary: { cost: 800, cooldown: 60000, delay: 1000 }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

let env = {};

// Все запросы идут через один Durable Object: он сериализует ходы и хранит
// состояние в постоянном хранилище. GitHub синхронизируется в фоне только
// для админского просмотра и никогда не перезаписывает выигрыши игроков.
let store = null;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function fail(message, status = 400) {
  return reply({ ok: false, error: String(message || 'Ошибка сервера') }, status);
}

// Информация о свежем APK берётся из публичного релиза GitHub. Клиент получает
// только номер версии и ссылку на скачивание — токенов и секретов здесь нет.
async function latestRelease() {
  const now = Date.now();
  if (versionCache.value && now - versionCache.at < 30 * 1000) return versionCache.value;
  const response = await fetch(RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'neon-fortune-worker',
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!response.ok) throw new Error(`GitHub вернул ${response.status}`);
  const release = await response.json();
  const asset = (release.assets || []).find((item) => /\.apk$/i.test(item.name || ''));
  const value = {
    code: Number(String(release.tag_name || '').replace(/^v/i, '')) || 0,
    name: release.name || release.tag_name || '',
    url: asset ? asset.browser_download_url : '',
    notes: String(release.body || '').slice(0, 300)
  };
  versionCache = { at: now, value };
  return value;
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

async function readState() {
  const response = await fetch(`${GH_API}?ref=${BRANCH}`, { headers: ghHeaders() });
  if (!response.ok) throw new Error(`не удалось прочитать данные (${response.status})`);
  const json = await response.json();
  let state;
  try {
    state = JSON.parse(decodeURIComponent(escape(atob(json.content.replace(/\n/g, '')))));
  } catch (error) {
    const bytes = Uint8Array.from(atob(json.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    state = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  }
  if (!state || typeof state !== 'object') state = emptyState();
  if (!state.users || typeof state.users !== 'object') state.users = {};
  if (!state.tokens || typeof state.tokens !== 'object') state.tokens = {};
  if (!Array.isArray(state.leaderboard)) state.leaderboard = [];
  return { state, sha: json.sha };
}

async function writeState(state, sha) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(state, null, 2))));
  const response = await fetch(GH_API, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'server: обновление прогресса',
      content,
      sha,
      branch: BRANCH
    })
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`не удалось записать данные (${response.status})`);
    if (response.status === 409) error.conflict = true;
    throw error;
  }
  const json = await response.json();
  return json && json.content ? json.content.sha : null;
}

async function loadState(force) {
  if (!store) return await readState();
  return await store.ensure(force);
}

// Состояние сохраняется в Durable Object до ответа игроку — выигрыш не может
// пропасть при перезапуске или при параллельных запросах с других устройств.
// GitHub обновляется тревогой в фоне и служит только для просмотра админом.
async function persistStore() {
  if (!store) return;
  const snapshot = JSON.parse(JSON.stringify(store.state));
  store.dirty = true;
  await store.storage.put({ state: snapshot, sha: store.sha });
  await store.storage.setAlarm(Date.now() + 1000);
}

async function mutate(action) {
  const server = await loadState();
  const result = await action(server.state);
  await persistStore();
  return result;
}

async function mutateSync(action) {
  return await mutate(action);
}

function int(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function keyFor(name) {
  return String(name).trim().toLowerCase();
}

function defaultProfile() {
  return {
    balance: 100,
    currentBet: 1,
    stats: { spins: 0, wins: 0, best: 0 },
    history: [],
    streak: 0,
    xp: 0,
    level: 1,
    xpToNext: 120,
    collection: [],
    collectionRewardGiven: false,
    missions: MISSIONS.map((m) => ({ ...m, progress: 0, claimed: false })),
    chestStats: { opened: 0, best: 0, types: [] },
    chestCooldowns: {},
    gifts: {},
    giftStats: { sold: 0, earned: 0, received: 0, found: [] },
    activeView: 'games',
    unlocked: [],
    activeGame: 'slots',
    cardsChoice: 'spades',
    soundEnabled: true,
    lastActionAt: 0,
    actionWindowStart: 0,
    actionCount: 0
  };
}

// Все поля профиля задаёт сервер. Входящие данные из старого файла
// нормализуются, чтобы подделанный клиент не мог подсунуть лишнее.
function normalizeProfile(raw) {
  const p = defaultProfile();
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  p.balance = int(s.balance, 100, 0, MAX_BALANCE);
  p.currentBet = BETS.includes(Number(s.currentBet)) ? Number(s.currentBet) : 1;
  const stats = s.stats && typeof s.stats === 'object' ? s.stats : {};
  p.stats = {
    spins: int(stats.spins, 0, 0, MAX_BALANCE),
    wins: int(stats.wins, 0, 0, MAX_BALANCE),
    best: int(stats.best, 0, 0, MAX_BALANCE)
  };
  p.history = Array.isArray(s.history) ? s.history.slice(0, 6) : [];
  p.streak = int(s.streak, 0, 0, 1000);
  p.xp = int(s.xp, 0, 0, MAX_BALANCE);
  p.level = int(s.level, 1, 1, 10000);
  p.xpToNext = int(s.xpToNext, p.level * 120, 1, MAX_BALANCE);
  p.collection = Array.isArray(s.collection)
    ? s.collection.filter((id) => COLLECTIBLES.includes(id)) : [];
  p.collectionRewardGiven = !!s.collectionRewardGiven;
  const missions = Array.isArray(s.missions) ? s.missions : [];
  p.missions = MISSIONS.map((m) => {
    const found = missions.find((item) => item && item.id === m.id);
    return {
      ...m,
      progress: found ? int(found.progress, 0, 0, m.target) : 0,
      claimed: !!(found && found.claimed)
    };
  });
  const chestStats = s.chestStats && typeof s.chestStats === 'object' ? s.chestStats : {};
  p.chestStats = {
    opened: int(chestStats.opened, 0, 0, MAX_BALANCE),
    best: int(chestStats.best, 0, 0, MAX_BALANCE),
    types: Array.isArray(chestStats.types)
      ? chestStats.types.filter((id) => Object.prototype.hasOwnProperty.call(CHESTS, id)) : []
  };
  const cooldowns = s.chestCooldowns && typeof s.chestCooldowns === 'object' ? s.chestCooldowns : {};
  p.chestCooldowns = {};
  Object.keys(CHESTS).forEach((id) => {
    const until = int(cooldowns[id], 0, 0, 4102444800000);
    if (until > Date.now()) p.chestCooldowns[id] = until;
  });
  const gifts = s.gifts && typeof s.gifts === 'object' ? s.gifts : {};
  p.gifts = {};
  Object.keys(gifts).forEach((id) => {
    const count = int(gifts[id], 0, 0, 1000000);
    if (GIFTS[id] && count > 0) p.gifts[id] = count;
  });
  const giftStats = s.giftStats && typeof s.giftStats === 'object' ? s.giftStats : {};
  p.giftStats = {
    sold: int(giftStats.sold, 0, 0, MAX_BALANCE),
    earned: int(giftStats.earned, 0, 0, MAX_BALANCE),
    received: int(giftStats.received, 0, 0, MAX_BALANCE),
    found: Array.isArray(giftStats.found)
      ? giftStats.found.filter((id) => GIFTS[id]) : []
  };
  p.activeView = ['games', 'chests', 'gifts', 'progress', 'top'].includes(s.activeView) ? s.activeView : 'games';
  p.unlocked = Array.isArray(s.unlocked)
    ? s.unlocked.filter((id) => ACHIEVEMENT_IDS.includes(id)) : [];
  p.activeGame = GAMES.includes(s.activeGame) ? s.activeGame : 'slots';
  p.cardsChoice = SUITS.includes(s.cardsChoice) ? s.cardsChoice : 'spades';
  p.soundEnabled = s.soundEnabled !== false;
  return p;
}

function profileOf(user) {
  return normalizeProfile(user.profile);
}

function applyCosmetics(profile, body) {
  if (BETS.includes(Number(body.bet))) profile.currentBet = Number(body.bet);
  if (GAMES.includes(body.game)) profile.activeGame = body.game;
  if (['games', 'chests', 'gifts', 'progress', 'top'].includes(body.view)) profile.activeView = body.view;
  if (SUITS.includes(body.choice)) profile.cardsChoice = body.choice;
  if (typeof body.sound === 'boolean') profile.soundEnabled = body.sound;
}

function rateLimit(profile) {
  const now = Date.now();
  if (now - (profile.lastActionAt || 0) < MIN_ACTION_MS) throw new Error('слишком быстро — подожди немного');
  if (now - (profile.actionWindowStart || 0) > 60000) {
    profile.actionWindowStart = now;
    profile.actionCount = 0;
  }
  profile.actionCount = (profile.actionCount || 0) + 1;
  if (profile.actionCount > MAX_ACTIONS_PER_MIN) throw new Error('лимит действий в минуту');
  profile.lastActionAt = now;
}

function random() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return (bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]) / 4294967296;
}

function pickWeighted(items, roll, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let left = roll * total;
  for (const item of items) {
    left -= weightOf(item);
    if (left <= 0) return item;
  }
  return items[items.length - 1];
}

function multiplierFor(streak) {
  return 1 + Math.min(Math.max(streak - 1, 0), 4) * ((MAX_MULT - 1) / 4);
}

function refund(bet, percent) {
  return bet <= 1 ? 0 : Math.ceil((bet * percent * PAYOUT_FACTOR) / 100);
}

function addXp(profile, amount, messages) {
  profile.xp += amount;
  while (profile.xp >= profile.xpToNext && profile.level < 10000) {
    profile.xp -= profile.xpToNext;
    profile.level += 1;
    profile.xpToNext = profile.level * 120;
    const reward = Math.min(profile.level * 25 * PAYOUT_FACTOR, MAX_GAIN_PER_ACTION);
    profile.balance = Math.min(MAX_BALANCE, profile.balance + reward);
    messages.push(`Уровень ${profile.level}! +${reward} звёзд`);
  }
}

function discover(profile, icons, messages) {
  icons.forEach((id) => {
    if (!profile.collection.includes(id)) {
      profile.collection.push(id);
      messages.push('Найдено: ' + id);
    }
  });
  if (profile.collection.length >= COLLECTIBLES.length && !profile.collectionRewardGiven) {
    profile.collectionRewardGiven = true;
    profile.balance = Math.min(MAX_BALANCE, profile.balance + 200);
    messages.push('Коллекция собрана! +200 звёзд');
  }
}

function checkAchievements(profile, extra) {
  const tests = {
    first: () => profile.stats.wins >= 1,
    dartBull: () => !!extra.dartBull,
    cardFlush: () => !!extra.cardFlush,
    streak3: () => profile.streak >= 3,
    jackpot: () => !!extra.jackpot,
    games10: () => profile.stats.spins >= 10,
    level3: () => profile.level >= 3,
    allChests: () => profile.chestStats.types.length >= Object.keys(CHESTS).length,
    giftSell: () => profile.giftStats.sold >= 1,
    giftHunter: () => profile.giftStats.found.length >= Object.keys(GIFTS).length
  };
  ACHIEVEMENT_IDS.forEach((id) => {
    if (!profile.unlocked.includes(id) && tests[id]()) profile.unlocked.push(id);
  });
}

function ranks(level) {
  if (level >= 9) return 'Легенда';
  if (level >= 7) return 'Мастер';
  if (level >= 5) return 'Профи';
  if (level >= 3) return 'Игрок';
  return 'Новичок';
}

function countGifts(profile) {
  return Object.values(profile.gifts).reduce((sum, count) => sum + count, 0);
}

function publicUser(user) {
  const profile = profileOf(user);
  return {
    name: user.name,
    level: profile.level,
    balance: profile.balance,
    games: profile.stats.spins,
    gifts: countGifts(profile),
    chests: profile.chestStats.opened,
    achievements: profile.unlocked.length,
    rank: ranks(profile.level),
    ts: user.updated || 0
  };
}

function buildLeaderboard(state) {
  const rows = Object.keys(state.users).map((key) => publicUser(state.users[key]));
  rows.sort((a, b) => {
    if (a.balance !== b.balance) return b.balance - a.balance;
    if (a.level !== b.level) return b.level - a.level;
    return b.games - a.games;
  });
  return rows.slice(0, 20);
}

function publicState(state) {
  const profiles = {};
  Object.keys(state.users).forEach((key) => {
    const user = state.users[key];
    if (user.profile) profiles[user.name] = publicUser(user);
  });
  return { version: state.version || 1, leaderboard: state.leaderboard.slice(), profiles };
}

function sessionUser(user) {
  return {
    name: user.name,
    profile: profileOf(user),
    level: profileOf(user).level,
    balance: profileOf(user).balance
  };
}

function sessionFor(state, token, user) {
  if (!token || state.tokens[token] !== keyFor(user.name)) throw new Error('Нужно войти снова');
  if (Date.now() - (user.sessionAt || 0) > SESSION_MAX_MS) throw new Error('Сессия истекла — войди заново');
}

function chestPrizes(id) {
  if (id === 'free') {
    const allowed = Object.keys(GIFTS).filter((gift) => GIFTS[gift] < 100);
    const weights = allowed.map((gift) => (RARITY[gift] || 1) / (0.5 + GIFTS[gift] / 100));
    const sum = weights.reduce((a, b) => a + b, 0);
    return allowed.map((gift, i) => ({
      weight: (100 * weights[i]) / sum,
      gift,
      text: `${giftName(gift)}! Продай его в разделе «Подарки»`,
      kind: 'special'
    }));
  }
  const cost = CHESTS[id].cost;
  const minValue = cost >= 60 ? 100 : 0;
  const maxValue = cost < 60 ? 100 : cost < 180 ? 450 : Infinity;
  const allowed = Object.keys(GIFTS).filter((gift) => GIFTS[gift] >= minValue && GIFTS[gift] < maxValue);
  const weights = allowed.map((gift) =>
    (1 / (0.35 + GIFTS[gift] / Math.max(1, cost))) * (RARITY[gift] || 1)
  );
  const giftSum = weights.reduce((a, b) => a + b, 0);
  const chances = weights.map((w) => (95 * w) / giftSum);
  const cuts = { candy: 7, brick: -3 };
  let freed = 0;
  chances.forEach((chance, i) => {
    const cut = cuts[allowed[i]] || 0;
    if (!cut) return;
    const actual = Math.min(cut, Math.max(0, chance - 0.01));
    chances[i] -= actual;
    freed += actual;
  });
  const others = chances.map((_, i) => i).filter((i) => !cuts[allowed[i]]);
  if (others.length && freed > 0) others.forEach((i) => { chances[i] += freed / others.length; });
  const prizes = allowed.map((gift, i) => ({
    weight: chances[i],
    gift,
    text: `${giftName(gift)}! Продай его в разделе «Подарки»`,
    kind: 'special'
  }));
  prizes.push({ weight: 5, text: 'Пусто! В сундуке ничего нет.', kind: 'empty' });
  return prizes;
}

function giftName(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function answerPlay(profile, body) {
  const game = body.game;
  const bet = Number(body.bet);
  if (!GAMES.includes(game)) throw new Error('Неизвестная игра');
  if (!BETS.includes(bet)) throw new Error('Недопустимая ставка');
  rateLimit(profile);
  if (profile.balance < bet) throw new Error('Недостаточно звёзд');

  const rolls = [];
  const roll = () => { const value = random(); rolls.push(value); return value; };
  const mult = multiplierFor(profile.streak);
  let win = 0;
  let text = 'Не повезло — попробуй ещё раз';
  let kind = 'lose';
  let jackpot = false;
  let triple = false;
  let refunded = false;
  let dartBull = false;
  let cardFlush = false;
  let icons = [];
  let discovered = [];
  let glyph = game;

  if (game === 'slots') {
    const picks = [pickWeighted(SYMBOLS, roll(), (s) => s.weight),
      pickWeighted(SYMBOLS, roll(), (s) => s.weight),
      pickWeighted(SYMBOLS, roll(), (s) => s.weight)];
    icons = picks.map((p) => p.icon);
    discovered = icons.slice();
    glyph = 'slots';
    if (picks[0].icon === picks[1].icon && picks[1].icon === picks[2].icon) {
      win = Math.round(bet * picks[0].payout * mult * PAYOUT_FACTOR);
      text = `ДЖЕКПОТ! ×3 · +${win}`;
      kind = 'win';
      jackpot = true;
    } else {
      const pair = picks[0].icon === picks[1].icon || picks[1].icon === picks[2].icon || picks[0].icon === picks[2].icon;
      if (pair) {
        const duplicate = picks[0].icon === picks[1].icon || picks[0].icon === picks[2].icon ? picks[0] : picks[1];
        win = refund(bet, duplicate.refund);
        kind = win ? 'refund' : 'lose';
        refunded = !!win;
        text = win ? `Два одинаковых — возврат: +${win}` : 'Два одинаковых — при ставке 1 возврата нет';
      }
    }
  } else if (game === 'dice') {
    const faces = [roll(), roll(), roll()].map((r) => DICE_FACES[Math.floor(r * DICE_FACES.length)]);
    icons = faces.slice();
    discovered = faces.slice();
    glyph = 'dice';
    triple = faces.every((face) => face === faces[0]);
    const pair = faces[0] === faces[1] || faces[1] === faces[2] || faces[0] === faces[2];
    if (triple) {
      win = Math.round(bet * 8 * mult * PAYOUT_FACTOR);
      text = `ТРИПА! +${win}`;
      kind = 'win';
      jackpot = true;
    } else if (pair) {
      const dup = faces[0] === faces[1] || faces[0] === faces[2] ? faces[0] : faces[1];
      const percent = [10, 25, 40, 60, 100, 150][DICE_FACES.indexOf(dup)] ?? 10;
      win = refund(bet, percent);
      kind = win ? 'refund' : 'lose';
      refunded = !!win;
      text = win ? `Пара — возврат ${percent}%: +${win}` : 'Пара есть — при ставке 1 возврата нет';
    }
  } else if (game === 'roulette') {
    const index = Math.floor(roll() * 12);
    const color = index === 0 ? 'green' : index % 2 === 1 ? 'red' : 'black';
    const choice = body.spinChoice && typeof body.spinChoice === 'object' ? body.spinChoice : {};
    icons = [String(index), color];
    discovered = [color];
    glyph = 'roulette';
    if (choice.type === 'number' && Number(choice.number) === index) {
      win = Math.min(MAX_GAIN_PER_ACTION, Math.round(bet * 10 * mult));
      text = `Точное попадание! ${index} · ×10 — +${win}`;
      kind = 'win';
      jackpot = true;
    } else if (choice.type === 'color' && choice.color === color) {
      win = Math.min(MAX_GAIN_PER_ACTION, Math.round(bet * 2 * mult));
      text = `Цвет угадан: ${color} · ×2 — +${win}`;
      kind = 'win';
    } else {
      text = `Выпало ${index} (${color}) — не угадали`;
    }
  } else if (game === 'darts') {
    const value = roll();
    roll();
    if (value > 0.08) roll();
    const icon = value <= 0.03 ? 'bullseye' : value <= 0.08 ? 'dartGold' : 'dartOuter';
    icons = [icon];
    discovered = [icon];
    glyph = 'target';
    if (icon === 'bullseye') {
      win = Math.round(bet * 20 * mult * PAYOUT_FACTOR);
      text = `ЯБЛОЧКО! +${win}`;
      kind = 'win';
      jackpot = true;
      dartBull = true;
    } else if (icon === 'dartGold') {
      win = Math.round(bet * 3 * mult * PAYOUT_FACTOR);
      text = `Золотая зона! +${win}`;
      kind = 'win';
    }
  } else if (game === 'cards') {
    const suit = SUITS[Math.floor(roll() * SUITS.length)];
    const otherSuit = SUITS[Math.floor(roll() * SUITS.length)];
    const firstRank = RANKS[Math.floor(roll() * RANKS.length)];
    const secondRank = RANKS[Math.floor(roll() * RANKS.length)];
    icons = [suit, otherSuit];
    discovered = [suit, otherSuit];
    glyph = 'cards';
    const pair = suit === otherSuit && firstRank === secondRank;
    if (pair && firstRank === 'A') {
      win = Math.round(bet * 12 * mult * PAYOUT_FACTOR);
      text = `Два туза! +${win}`;
      kind = 'win';
      jackpot = true;
      cardFlush = true;
    } else if (pair) {
      win = Math.round(bet * 5 * mult * PAYOUT_FACTOR);
      text = `Одинаковые карты! +${win}`;
      kind = 'win';
      cardFlush = true;
    }
  }

  // Клиент в старой версии делал ещё один бросок на «счастливый шанс».
  // Добавляем число в поток, чтобы анимация совпадала с решением сервера.
  const luckyRoll = roll();
  if (win <= 0 && luckyRoll < LUCKY_CHANCE) {
    win = Math.max(1, Math.ceil(bet * 1.1));
    text = `Счастливый шанс! +${win}`;
    kind = 'win';
    refunded = false;
  }

  const isWin = win > 0 && !refunded;
  const before = profile.balance;
  profile.balance = Math.min(MAX_BALANCE, before - bet + Math.min(win, MAX_GAIN_PER_ACTION));
  profile.stats.spins += 1;
  if (isWin) {
    profile.streak += 1;
    profile.stats.wins += 1;
    profile.stats.best = Math.max(profile.stats.best, win);
  } else {
    profile.streak = 0;
  }
  profile.history = [{ glyph, icons, delta: win - bet }, ...profile.history].slice(0, 6);

  const gamesMission = profile.missions.find((m) => m.id === 'games');
  if (gamesMission) gamesMission.progress = Math.min(gamesMission.target, profile.stats.spins);
  if (isWin) {
    const winsMission = profile.missions.find((m) => m.id === 'wins');
    if (winsMission) winsMission.progress = Math.min(winsMission.target, profile.stats.wins);
  }
  if (triple) {
    const m = profile.missions.find((x) => x.id === 'triple');
    if (m) m.progress = 1;
  }
  if (jackpot) {
    const m = profile.missions.find((x) => x.id === 'jackpot');
    if (m) m.progress = 1;
  }
  const messages = [];
  addXp(profile, 2 + (isWin ? 8 : 0) + (jackpot ? 30 : 0), messages);
  discover(profile, discovered, messages);
  checkAchievements(profile, { jackpot, triple, dartBull, cardFlush });
  applyCosmetics(profile, body);

  return {
    rolls,
    win,
    text,
    kind,
    icons,
    glyph,
    jackpot,
    triple,
    refund: refunded,
    dartBull,
    cardFlush,
    multiplier: mult,
    bet,
    messages,
    profile
  };
}

function answerChest(profile, body) {
  const id = body.id;
  const chest = CHESTS[id];
  if (!chest) throw new Error('Неизвестный сундук');
  rateLimit(profile);
  if (profile.balance < chest.cost) throw new Error('Недостаточно звёзд');
  if ((profile.chestCooldowns[id] || 0) > Date.now()) throw new Error('Сундук ещё на перезарядке');

  profile.balance -= chest.cost;
  const prize = pickWeighted(chestPrizes(id), random(), (item) => item.weight);
  const dropped = prize.gift ? [prize.gift] : [];
  dropped.forEach((gift) => {
    profile.gifts[gift] = (profile.gifts[gift] || 0) + 1;
    profile.giftStats.received += 1;
    if (!profile.giftStats.found.includes(gift)) profile.giftStats.found.push(gift);
  });
  profile.chestStats.opened += 1;
  dropped.forEach((gift) => {
    profile.chestStats.best = Math.max(profile.chestStats.best, GIFTS[gift] || 0);
  });
  if (!profile.chestStats.types.includes(id)) profile.chestStats.types.push(id);
  const until = Date.now() + chest.cooldown;
  profile.chestCooldowns[id] = until;
  checkAchievements(profile, { jackpot: !!prize.jackpot });
  applyCosmetics(profile, body);
  return { prize, cooldownUntil: until, profile };
}

function answerSell(profile, body) {
  rateLimit(profile);
  let total = 0;
  let count = 0;
  if (body.all === true) {
    Object.keys(profile.gifts).forEach((id) => {
      const amount = profile.gifts[id] || 0;
      total += (GIFTS[id] || 0) * amount;
      count += amount;
      profile.giftStats.sold += amount;
      delete profile.gifts[id];
    });
  } else {
    const id = body.id;
    if (!GIFTS[id] || !(profile.gifts[id] > 0)) throw new Error('Такого подарка нет');
    total = GIFTS[id];
    count = 1;
    profile.gifts[id] -= 1;
    if (!profile.gifts[id]) delete profile.gifts[id];
    profile.giftStats.sold += 1;
  }
  if (!count) throw new Error('Нечего продавать');
  profile.balance = Math.min(MAX_BALANCE, profile.balance + total);
  profile.giftStats.earned += total;
  checkAchievements(profile, {});
  applyCosmetics(profile, body);
  return { total, count, profile };
}

function answerMission(profile, body) {
  const mission = profile.missions.find((m) => m.id === body.id);
  if (!mission || mission.claimed || mission.progress < mission.target) throw new Error('Задание ещё не выполнено');
  rateLimit(profile);
  mission.claimed = true;
  profile.balance = Math.min(MAX_BALANCE, profile.balance + mission.reward);
  applyCosmetics(profile, body);
  return { reward: mission.reward, title: mission.title, profile };
}

async function handle(request, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/state';

  if (path === '/state' && request.method === 'GET') {
    // Принудительное чтение GitHub доступно только фоновой синхронизации DO.
    // Злоумышленник не может заставить сервер лезть в GitHub через ?reload.
    const server = await loadState(false);
    return reply({ ok: true, state: publicState(server.state) });
  }
  if (request.method !== 'POST') return fail('Метод не поддерживается', 405);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return fail('Слишком большой запрос', 413);
    body = JSON.parse(raw);
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
    const result = await mutateSync((state) => {
      const key = keyFor(name);
      if (mode === 'register') {
        if (state.users[key]) throw new Error('Такой игрок уже есть — войди или придумай другой ник');
        if (Object.keys(state.users).length >= MAX_USERS) throw new Error('Сервер переполнен — попробуйте позже');
        if (/^(bot|nb)\d+$/i.test(key)) throw new Error('Такое имя нельзя использовать');
        if (store && store.registerGuard) store.registerGuard(hash);
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        const token = Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join('');
        state.users[key] = {
          name, hash, created: Date.now(), updated: Date.now(),
          sessionAt: Date.now(), profile: normalizeProfile(null)
        };
        Object.keys(state.tokens).forEach((old) => {
          if (state.tokens[old] === key) delete state.tokens[old];
        });
        state.tokens[token] = key;
        state.leaderboard = buildLeaderboard(state);
        return { token, user: sessionUser(state.users[key]), isNew: true };
      }
      const user = state.users[key];
      if (!user || user.hash !== hash) throw new Error('Неверный никнейм или пароль');
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const token = Array.from(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join('');
      Object.keys(state.tokens).forEach((old) => {
        if (state.tokens[old] === key) delete state.tokens[old];
      });
      state.tokens[token] = key;
      user.sessionAt = Date.now();
      user.profile = normalizeProfile(user.profile);
      return { token, user: sessionUser(user), isNew: false };
    });
    return reply({ ok: true, ...result });
  }

  if (path === '/session') {
    const token = String(body.token || '');
    const server = await loadState();
    const key = server.state.tokens[token];
    if (!key || !server.state.users[key]) return fail('Нужно войти снова', 401);
    sessionFor(server.state, token, server.state.users[key]);
    return reply({ ok: true, user: sessionUser(server.state.users[key]) });
  }

  // Админская правка баланса. Ключ хранится только в секрете Cloudflare,
  // клиент не знает его и не может изменить свои звёзды.
  if (path === '/admin/balance') {
    const supplied = String(request.headers.get('x-admin-token') || '');
    if (!env.ADMIN_TOKEN || supplied !== env.ADMIN_TOKEN) return fail('Нет доступа', 403);
    if (typeof body.balance !== 'number' || !Number.isFinite(body.balance)) {
      return fail('Некорректный баланс');
    }
    const balance = Math.min(MAX_BALANCE, Math.max(0, Math.floor(body.balance)));
    const result = await mutateSync((state) => {
      const user = state.users[keyFor(String(body.name || ''))];
      if (!user) throw new Error('Игрок не найден');
      user.profile = normalizeProfile(user.profile);
      user.profile.balance = balance;
      user.updated = Date.now();
      state.leaderboard = buildLeaderboard(state);
      return { name: user.name, balance: user.profile.balance };
    });
    return reply({ ok: true, ...result });
  }

  // Админское удаление аккаунта: используется только для чистки ботов.
  // Ключ хранится в секрете Cloudflare и не попадает в клиент.
  if (path === '/admin/delete') {
    const supplied = String(request.headers.get('x-admin-token') || '');
    if (!env.ADMIN_TOKEN || supplied !== env.ADMIN_TOKEN) return fail('Нет доступа', 403);
    const targetKey = keyFor(String(body.name || ''));
    const result = await mutateSync((state) => {
      const user = state.users[targetKey];
      if (!user) throw new Error('Игрок не найден');
      delete state.users[targetKey];
      Object.keys(state.tokens).forEach((old) => {
        if (state.tokens[old] === targetKey) delete state.tokens[old];
      });
      state.leaderboard = buildLeaderboard(state);
      return { name: user.name };
    });
    return reply({ ok: true, ...result });
  }

  // Действия. Клиент НЕ передаёт баланс, статистику или подарки —
  // сервер сам решает, что выпало и сколько начислено.
  const actions = {
    '/play': (state, key, user) => answerPlay(profileOf(user), body),
    '/chest': (state, key, user) => answerChest(profileOf(user), body),
    '/sell': (state, key, user) => answerSell(profileOf(user), body),
    '/mission': (state, key, user) => answerMission(profileOf(user), body),
    '/settings': (state, key, user) => {
      const profile = profileOf(user);
      applyCosmetics(profile, body);
      return { profile };
    }
  };

  if (Object.prototype.hasOwnProperty.call(actions, path)) {
    const result = await mutate((state) => {
      const token = String(body.token || '');
      const key = state.tokens[token];
      if (!key || !state.users[key]) throw new Error('Нужно войти снова');
      const user = state.users[key];
      sessionFor(state, token, user);
      const outcome = actions[path](state, key, user);
      user.profile = normalizeProfile(outcome.profile);
      user.updated = Date.now();
      state.leaderboard = buildLeaderboard(state);
      return outcome;
    }, ctx);
    return reply({ ok: true, ...result });
  }

  if (path === '/logout') {
    await mutateSync((state) => { delete state.tokens[String(body.token || '')]; });
    return reply({ ok: true });
  }

  if (path === '/delete') {
    await mutateSync((state) => {
      const token = String(body.token || '');
      const key = state.tokens[token];
      if (!key || !state.users[key]) throw new Error('Нужно войти снова');
      delete state.users[key];
      Object.keys(state.tokens).forEach((saved) => {
        if (state.tokens[saved] === key) delete state.tokens[saved];
      });
      state.leaderboard = buildLeaderboard(state);
    });
    return reply({ ok: true });
  }

  return fail('Не найдено', 404);
}

export class FortuneState {
  constructor(state, environment) {
    this.storage = state.storage;
    this.env = environment;
    this.state = null;
    this.sha = null;
    this.dirty = false;
    this.loading = null;
    this.registerTimes = [];
    this.registerHashes = new Map();
  }

  // Строгий глобальный лимит внутри одного Durable Object: боты с разных IP
  // не могут завести сотни аккаунтов, даже обойдя сетевой лимит Cloudflare.
  registerGuard(hash) {
    const now = Date.now();
    this.registerTimes = (this.registerTimes || []).filter((t) => now - t < 60 * 60 * 1000);
    if (this.registerTimes.length >= MAX_REGISTRATIONS_PER_HOUR) {
      throw new Error('Слишком много регистраций — попробуйте позже');
    }
    const hashes = this.registerHashes || new Map();
    for (const [saved, info] of hashes) {
      if (now - info.at > 24 * 60 * 60 * 1000) hashes.delete(saved);
    }
    const info = hashes.get(hash) || { count: 0, at: now };
    if (info.count >= MAX_SAME_PASSWORD_USERS) {
      throw new Error('Этот пароль уже используют слишком много игроков');
    }
    info.count += 1;
    info.at = now;
    hashes.set(hash, info);
    this.registerHashes = hashes;
    this.registerTimes.push(now);
  }

  ensure(force) {
    if (this.loading) return this.loading;
    if (this.state && !(force && !this.dirty)) return Promise.resolve(this);
    this.loading = (async () => {
      if (force && !this.dirty) {
        const server = await readState();
        this.state = server.state;
        this.sha = server.sha;
        this.dirty = false;
        await this.storage.put({ state: this.state, sha: this.sha });
      } else if (!this.state) {
        const saved = await this.storage.get(['state', 'sha']);
        if (saved && saved.state) {
          this.state = saved.state;
          this.sha = saved.sha || null;
        } else {
          const server = await readState();
          this.state = server.state;
          this.sha = server.sha;
          await this.storage.put({ state: this.state, sha: this.sha });
        }
      }
      this.loading = null;
      return this;
    })();
    return this.loading;
  }

  async fetch(request) {
    env = this.env;
    store = this;
    await this.ensure();
    try {
      return await handle(request);
    } catch (error) {
      return fail(error && error.message ? error.message : String(error), 500);
    }
  }

  // Фоновая синхронизация с GitHub: состояние DO всегда главнее, поэтому
  // чужие правки файла не перезаписывают выигрыши и токены игроков.
  async alarm() {
    env = this.env;
    store = this;
    await this.ensure();
    if (!this.state) return;
    try {
      let newSha = await writeState(this.state, this.sha);
      if (!newSha) {
        const server = await readState();
        this.sha = server.sha;
        newSha = await writeState(this.state, this.sha);
      }
      if (newSha) this.sha = newSha;
      this.dirty = false;
      await this.storage.put({ state: this.state, sha: this.sha });
    } catch (error) {
      if (error && error.conflict) {
        const server = await readState();
        this.sha = server.sha;
        const newSha = await writeState(this.state, this.sha);
        if (newSha) this.sha = newSha;
        this.dirty = false;
        await this.storage.put({ state: this.state, sha: this.sha });
      } else {
        await this.storage.setAlarm(Date.now() + 5000);
        throw error;
      }
    }
  }
}

export default {
  async fetch(request, environment) {
    env = environment;

    // Дешёвые ответы и отсечение мусора — до обращения к Durable Object.
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const path = new URL(request.url).pathname.replace(/\/$/, '') || '/state';
    const length = Number(request.headers.get('content-length') || 0);
    if (length > MAX_BODY_BYTES) return fail('Слишком большой запрос', 413);

    // Проверка обновлений не должна зависеть от игровых лимитов и Durable Object.
    if (path === '/version' && request.method === 'GET') {
      try {
        return reply({ ok: true, version: await latestRelease() });
      } catch (error) {
        return reply({ ok: true, version: { code: 0, name: '', url: '', notes: '' } });
      }
    }

    const ip = request.headers.get('cf-connecting-ip') ||
      (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const login = path === '/login';
    // Проверку сессии не ограничиваем: временный 429 заставлял старый клиент
    // удалить токен и требовать вход заново. Остальные запросы по-прежнему ограничены.
    const skipLimit = path === '/session' || path === '/version';
    const limiter = skipLimit ? null : login ? environment.AUTH_GUARD : environment.API_GUARD;
    if (limiter) {
      // Ход стоит дороже чтения таблицы лидеров, вход — отдельный квотный пул.
      const delta = login ? 2 : path === '/state' ? 1 : 2;
      let allowed = true;
      try {
        const decision = await limiter.limit({ key: ip, delta });
        allowed = decision && decision.success !== false;
      } catch (error) {
        // При недоступности лимитера не блокируем игроков.
      }
      if (!allowed) return fail('Слишком много запросов — попробуйте позже', 429);
    }

    const id = environment.STATE.idFromName('global');
    return environment.STATE.get(id).fetch(request);
  }
};
