(function () {
  'use strict';

  var OWNER = 'egorkadykov';
  var REPO = 'neon-fortune-apk';
  var PATH = 'data/online-state.json';
  var BRANCH = 'main';
  var API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/' + PATH;
  var TOKEN_KEY = 'neon-online-token';
  var USER_KEY = 'neon-online-user';
  var TOKEN = window.NEON_GITHUB_TOKEN;
  var LITE_UI = window.matchMedia('(max-width: 700px)').matches;
  var saveTimer = null;
  var saving = false;
  var pendingSave = false;
  var lastLeaderKey = '';

  function byId(id) { return document.getElementById(id); }

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

  function friendly(error) {
    var text = error && error.message ? error.message : String(error || 'Неизвестная ошибка');
    if (/Failed to fetch|NetworkError|Load failed/i.test(text)) return 'нет связи с сервером';
    return text;
  }

  function setStatus(text, kind) {
    var auth = byId('onlineStatus');
    var settings = byId('onlineSettingsStatus');
    var full = 'Онлайн: ' + text;
    if (auth) { auth.textContent = full; auth.className = 'online-status online-' + (kind || 'wait'); }
    if (settings) { settings.textContent = text; settings.className = 'online-inline online-' + (kind || 'wait'); }
  }

  function headers() {
    return {
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN
    };
  }

  function emptyState() {
    return { version: 1, users: {}, tokens: {}, leaderboard: [] };
  }

  function decodeContent(content) {
    var binary = atob(String(content || '').replace(/\s/g, ''));
    if (window.TextDecoder) {
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(escape(binary));
  }

  function loadServer() {
    return fetch(API + '?ref=' + BRANCH + '&t=' + Date.now(), {
      headers: headers(),
      cache: 'no-store'
    }).then(function (response) {
      if (!response.ok) throw new Error('не удалось прочитать сервер (' + response.status + ')');
      return response.json();
    }).then(function (meta) {
      var state;
      try {
        state = JSON.parse(decodeContent(meta.content));
      } catch (error) {
        state = emptyState();
      }
      var safe = state && typeof state === 'object' ? state : emptyState();
      if (!safe.users || typeof safe.users !== 'object') safe.users = {};
      if (!safe.tokens || typeof safe.tokens !== 'object') safe.tokens = {};
      if (!Array.isArray(safe.leaderboard)) safe.leaderboard = [];
      return { state: safe, sha: meta.sha || '' };
    });
  }

  function readState() {
    return loadServer().then(function (result) { return result.state; });
  }

  function writeState(state, sha) {
    var body = {
      message: 'Обновление прогресса ' + new Date().toISOString(),
      content: btoa(unescape(encodeURIComponent(JSON.stringify(state)))),
      branch: BRANCH
    };
    if (sha) body.sha = sha;
    return fetch(API, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body)
    }).then(function (response) {
      if (response.status === 409) {
        var conflict = new Error('сервер обновился, повторяем');
        conflict.conflict = true;
        throw conflict;
      }
      if (!response.ok) {
        return response.text().then(function (text) {
          var message = text;
          try { message = JSON.parse(text).message || text; } catch (ignored) {}
          throw new Error(message || ('ошибка сервера ' + response.status));
        });
      }
      return response.json();
    });
  }

  function runMutation(action, attempt) {
    return loadServer().then(function (server) {
      return Promise.resolve(action(server.state)).then(function (result) {
        return writeState(server.state, server.sha).then(function () { return result; });
      });
    }).catch(function (error) {
      if (error && error.conflict && attempt < 2) return runMutation(action, attempt + 1);
      throw error;
    });
  }

  function mutate(action) {
    return runMutation(action, 0);
  }

  function keyFor(name) { return String(name).trim().toLowerCase(); }

  function publicUser(user) {
    return {
      name: user.name,
      level: (user.profile && user.profile.level) || 1,
      balance: (user.profile && user.profile.balance) || 0,
      profile: user.profile || null
    };
  }

  function makeToken() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function simpleHash(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'fnv1a-' + (hash >>> 0).toString(16);
  }

  function hashPassword(value) {
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) {
      return Promise.resolve(simpleHash(value));
    }
    var bytes = new TextEncoder().encode(value);
    return window.crypto.subtle.digest('SHA-256', bytes).then(function (buffer) {
      return 'sha256-' + Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }).catch(function () {
      return simpleHash(value);
    });
  }

  function findUser(state, suppliedToken) {
    var key = state.tokens[suppliedToken];
    if (!key || !state.users[key]) return null;
    return [key, state.users[key]];
  }

  var css = document.createElement('style');
  css.id = 'neonOnlineCss';
  css.textContent = '' +
    '.online-status{margin:10px 0 4px;padding:7px 10px;border-radius:10px;font-size:11px;letter-spacing:.03em;text-align:center;border:1px solid rgba(0,255,213,.22);background:rgba(0,255,213,.06);color:#8fffe9;}' +
    '.online-ok{border-color:rgba(80,255,170,.35);color:#8bffb8;}' +
    '.online-warn{border-color:rgba(255,180,80,.35);color:#ffd18b;}' +
    '.online-wait{border-color:rgba(140,160,255,.35);color:#b8c4ff;}' +
    '.online-inline{margin-top:8px;font-size:11px;color:#8fffe9;word-break:break-word;}' +
    '.leader-extra{display:block;font-size:10px;opacity:.72;margin-top:2px;}';
  document.head.appendChild(css);

  var authCard = document.querySelector('#authScreen .auth-card');
  if (authCard && !byId('onlineStatus')) {
    var status = document.createElement('div');
    status.id = 'onlineStatus';
    status.className = 'online-status online-wait';
    var subtitle = authCard.querySelector('.auth-subtitle');
    if (subtitle && subtitle.parentNode) subtitle.parentNode.insertBefore(status, subtitle.nextSibling);
    else authCard.insertBefore(status, authCard.firstChild);
  }
  var note = document.querySelector('#authScreen .auth-note');
  if (note) note.textContent = 'Общая онлайн-таблица: ник, пароль, баланс, уровень, игры, подарки, сундуки и достижения. Реальных денег нет — только виртуальные звёзды.';

  var stack = document.querySelector('#settingsDrawer .settings-stack');
  if (stack && !byId('onlineSettingsStatus')) {
    var card = document.createElement('section');
    card.className = 'card online-card';
    card.innerHTML = '' +
      '<h2><span data-icon="chart"></span>Онлайн-аккаунт</h2>' +
      '<p class="setting-note">Один общий сервер уже подключён. Прогресс сохраняется автоматически.</p>' +
      '<div class="online-actions"><button id="onlineTestBtn" class="side-btn" type="button">Проверить связь</button></div>' +
      '<div id="onlineSettingsStatus" class="online-inline online-wait">Проверяем связь...</div>';
    var danger = stack.querySelector('.danger-card');
    stack.insertBefore(card, danger || stack.lastChild);
  }

  function fetchLeaderboard() {
    return readState().then(function (state) {
      leaderboard = state.leaderboard.slice();
      renderLeaderboard();
      setStatus('подключено · ' + leaderboard.length + ' в топе', 'ok');
    }).catch(function (error) {
      setStatus('офлайн · ' + friendly(error), 'warn');
    });
  }

  function scheduleSave() {
    pendingSave = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, LITE_UI ? 1800 : 900);
  }

  function flushSave() {
    if (!token()) { pendingSave = false; return; }
    if (saving) { pendingSave = true; return; }
    pendingSave = false;
    saving = true;
    var snapshot = getProfileState();
    mutate(function (state) {
      var found = findUser(state, token());
      if (!found) throw new Error('Нужно войти снова');
      found[1].profile = snapshot;
      found[1].updated = Date.now();
      state.leaderboard = buildLeaderboard(state);
    }).then(function () {
      saving = false;
      setStatus('прогресс сохранён', 'ok');
      if (pendingSave) flushSave();
    }).catch(function (error) {
      saving = false;
      pendingSave = true;
      setStatus('не сохранено · ' + friendly(error), 'warn');
    });
  }

  // В топе показываем количество подарков, а не сумму вырученных за них звёзд.
  function countProfileGifts(profile) {
    var stats = profile.giftStats || {};
    if (typeof stats.received === 'number') return Math.max(0, Math.floor(stats.received));
    var held = 0;
    var savedGifts = profile.gifts || {};
    Object.keys(savedGifts).forEach(function (key) {
      held += Math.max(0, Number(savedGifts[key]) || 0);
    });
    return Math.max(0, Math.floor(Number(stats.sold) || 0)) + held;
  }

  function buildLeaderboard(state) {
    var rows = [];
    Object.keys(state.users).forEach(function (key) {
      var user = state.users[key];
      var profile = user.profile || {};
      rows.push({
        name: user.name,
        balance: (profile.balance || 0),
        level: (profile.level || 1),
        games: (profile.stats && profile.stats.spins) || 0,
        gifts: countProfileGifts(profile),
        chests: (profile.chestStats && profile.chestStats.opened) || 0,
        achievements: Array.isArray(profile.unlocked) ? profile.unlocked.length : 0,
        rank: typeof getRank === 'function' ? getRank() : '',
        ts: user.updated || 0
      });
    });
    rows.sort(function (a, b) {
      if (a.balance !== b.balance) return b.balance - a.balance;
      if (a.level !== b.level) return b.level - a.level;
      return b.games - a.games;
    });
    return rows.slice(0, 20);
  }

  var originalSaveProfile = saveProfile;
  saveProfile = function () {
    originalSaveProfile();
    if (currentUser && token()) scheduleSave();
  };

  var originalUpdateLeaderboard = updateLeaderboard;
  updateLeaderboard = function () {
    if (!currentUser) return;
    var entry = {
      name: currentUser.name,
      balance: balance,
      level: level,
      games: stats.spins,
      gifts: giftStats.received,
      chests: chestStats.opened,
      achievements: unlocked.size,
      rank: typeof getRank === 'function' ? getRank() : '',
      ts: Date.now()
    };
    var index = leaderboard.findIndex(function (item) { return item && item.name === entry.name; });
    if (index >= 0) leaderboard[index] = entry;
    else leaderboard.push(entry);
    leaderboard.sort(function (a, b) { return (b.balance || 0) - (a.balance || 0); });
    leaderboard = leaderboard.slice(0, 20);
    renderLeaderboard();
    scheduleSave();
  };

  renderLeaderboard = function () {
    var list = byId('leaderboard');
    if (!list) return;
    var key = (currentUser ? currentUser.name : '') + '#' + leaderboard.map(function (e) {
      return [e.name, e.balance, e.level, e.games, e.gifts, e.chests, e.achievements, e.rank].join('|');
    }).join(';');
    if (key === lastLeaderKey) return;
    lastLeaderKey = key;
    list.innerHTML = '';
    if (!leaderboard.length) {
      list.innerHTML = '<li><span>Пока пусто</span><span>—</span></li>';
      return;
    }
    leaderboard.forEach(function (entry, index) {
      var item = document.createElement('li');
      if (currentUser && entry.name === currentUser.name) item.className = 'me';
      var label = document.createElement('span');
      label.textContent = (index + 1) + '. ' + entry.name + ' · Ур.' + (entry.level || 1) + ' · ' + (entry.balance || 0) + '★';
      var extra = document.createElement('span');
      extra.className = 'leader-extra';
      extra.textContent = (entry.games || 0) + ' игр · ' + (entry.gifts || 0) + ' подарков · ' + (entry.chests || 0) + ' сундуков · ' + (entry.achievements || 0) + ' достижений';
      var score = document.createElement('strong');
      score.textContent = entry.rank || '';
      label.appendChild(extra);
      item.append(label, score);
      list.appendChild(item);
    });
  };

  function enterOnline(name, profile, isNew, silent) {
    currentUser = { name: name };
    localStorage.setItem(USER_KEY, name);
    setSession(normalizeName(name));
    applyProfile(profile || null);
    authScreen.hidden = true;
    authError.textContent = '';
    authPassword.value = '';
    authConfirm.value = '';
    statusEl.textContent = 'Готово к игре';
    setMessage(isNew ? 'Привет, ' + name + '! Профиль создан на сервере.' : 'С возвращением, ' + name + '! Прогресс загружен с сервера.');
    updateUI(LITE_UI);
    saveProfile();
    fetchLeaderboard();
    if (!silent) {
      toast(isNew ? 'Добро пожаловать, ' + name + '!' : 'С возвращением, ' + name + '!', isNew ? 'sparkle' : 'user');
      beep(620, 0.12, 'triangle', 0.04);
    }
  }

  authForm.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    var name = authNickname.value.trim();
    var password = authPassword.value;
    authError.textContent = '';
    if (!/^[A-Za-zА-Яа-яЁё0-9_]{3,16}$/.test(name)) {
      authError.textContent = 'Никнейм: от 3 до 16 букв, цифр или _';
      return;
    }
    if (password.length < 4) {
      authError.textContent = 'Пароль слишком короткий — минимум 4 символа';
      return;
    }
    if (authMode === 'register' && authConfirm.value !== password) {
      authError.textContent = 'Пароли не совпадают';
      return;
    }
    setStatus('связь с сервером...', 'wait');
    hashPassword(password).then(function (hash) {
      return mutate(function (state) {
        var key = keyFor(name);
        if (authMode === 'register') {
          if (state.users[key]) throw new Error('Такой игрок уже есть — войди или придумай другой ник');
          var newToken = makeToken();
          state.users[key] = { name: name, hash: hash, created: Date.now(), updated: Date.now(), profile: null };
          state.tokens[newToken] = key;
          state.leaderboard = buildLeaderboard(state);
          return { token: newToken, user: state.users[key], isNew: true };
        }
        var user = state.users[key];
        if (!user || user.hash !== hash) throw new Error('Неверный никнейм или пароль');
        var loginToken = makeToken();
        state.tokens[loginToken] = key;
        return { token: loginToken, user: user, isNew: false };
      });
    }).then(function (result) {
      localStorage.setItem(TOKEN_KEY, result.token);
      enterOnline(result.user.name, result.user.profile || null, result.isNew);
    }).catch(function (error) {
      authError.textContent = friendly(error);
      setStatus('ошибка входа', 'warn');
    });
  }, true);

  restoreSession = function () {
    if (!token()) {
      showAuth('login');
      setStatus('войди в аккаунт', 'warn');
      return;
    }
    setStatus('проверка сессии...', 'wait');
    var savedName = localStorage.getItem(USER_KEY);
    readState().then(function (state) {
      var found = findUser(state, token());
      if (!found) throw new Error('Нужно войти снова');
      enterOnline(found[1].name, found[1].profile || null, false, true);
    }).catch(function (error) {
      localStorage.removeItem(TOKEN_KEY);
      if (savedName) localStorage.removeItem(USER_KEY);
      showAuth('login');
      setStatus('нужен вход · ' + friendly(error), 'warn');
    });
  };

  logoutBtn.addEventListener('click', function (event) {
    if (!currentUser || !token()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    flushSave();
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    clearSession();
    authNickname.value = '';
    authPassword.value = '';
    authConfirm.value = '';
    closeSettings();
    showAuth('login');
    setMessage('Ты вышел из онлайн-аккаунта. Войди, чтобы продолжить.');
    updateUI();
    setStatus('вышел из аккаунта', 'ok');
  }, true);

  deleteAccountBtn.addEventListener('click', function (event) {
    if (!currentUser || !token()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!window.confirm('Удалить онлайн-аккаунт и весь прогресс на сервере?')) return;
    stopAuto();
    setStatus('удаление аккаунта...', 'wait');
    mutate(function (state) {
      var found = findUser(state, token());
      if (!found) throw new Error('Нужно войти снова');
      delete state.users[found[0]];
      Object.keys(state.tokens).forEach(function (savedToken) {
        if (state.tokens[savedToken] === found[0]) delete state.tokens[savedToken];
      });
      state.leaderboard = buildLeaderboard(state);
    }).then(function () {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      location.reload();
    }).catch(function (error) {
      setStatus('не удалось удалить · ' + friendly(error), 'warn');
    });
  }, true);

  var testBtn = byId('onlineTestBtn');
  if (testBtn) testBtn.addEventListener('click', function () {
    setStatus('проверка связи...', 'wait');
    fetchLeaderboard();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave();
  });
  setInterval(function () {
    if (document.visibilityState === 'visible') fetchLeaderboard();
  }, LITE_UI ? 30000 : 15000);

  window.NEON_ONLINE = {
    fetchLeaderboard: fetchLeaderboard,
    flushSave: flushSave
  };

  setStatus('подключение к общему серверу...', 'wait');
  restoreSession();
})();
