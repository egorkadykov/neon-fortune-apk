(function () {
  'use strict';

  // Тонкий слой поверх игры. Все решения о выигрыше принимает сервер:
  // клиент отправляет только действие и проигрывает присланную сервером
  // последовательность случайных чисел. Подмена файла игры ничего не даёт.
  var API = window.NEON_API_BASE || '';
  var TOKEN_KEY = 'neon-online-token';
  var USER_KEY = 'neon-online-user';
  var LITE_UI = window.matchMedia('(max-width: 700px)').matches;
  var serverRolls = [];
  var serverResult = null;
  var serverBusy = false;
  var settingsTimer = null;
  var lastLeaderKey = '';
  var sessionRetries = 0;

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

  function api(path, body) {
    if (!API) return Promise.reject(new Error('адрес сервера не настроен'));
    var init = {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      cache: 'no-store'
    };
    if (body) init.body = JSON.stringify(body);
    return fetch(API.replace(/\/$/, '') + path, init)
      .then(function (response) {
        return response.json().catch(function () {
          throw new Error('сервер вернул некорректный ответ (' + response.status + ')');
        });
      })
      .then(function (data) {
        if (!data || data.ok !== true) {
          throw new Error(data && data.error ? data.error : 'ошибка сервера');
        }
        return data;
      });
  }

  function actionBody(extra) {
    var body = {
      token: token(),
      game: activeGame,
      bet: currentBet,
      view: activeView,
      choice: cardsChoice,
      sound: soundEnabled,
      spinChoice: typeof rouletteChoice === 'object' ? rouletteChoice : null
    };
    if (extra) Object.keys(extra).forEach(function (key) { body[key] = extra[key]; });
    return body;
  }

  function hashPassword(value) {
    function simple() {
      var hash = 2166136261;
      for (var i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return 'fnv1a-' + (hash >>> 0).toString(16);
    }
    if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) return Promise.resolve(simple());
    var bytes = new TextEncoder().encode(value);
    return window.crypto.subtle.digest('SHA-256', bytes).then(function (buffer) {
      return 'sha256-' + Array.prototype.map.call(new Uint8Array(buffer), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    }).catch(function () { return simple(); });
  }

  function fetchLeaderboard() {
    return fetch(API.replace(/\/$/, '') + '/state', {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    }).then(function (response) { return response.json(); }).then(function (data) {
      if (!data || data.ok !== true) throw new Error('ошибка сервера');
      leaderboard = (data.state && data.state.leaderboard ? data.state.leaderboard : []).slice();
      renderLeaderboard();
      setStatus('подключено · ' + leaderboard.length + ' в топе', 'ok');
    }).catch(function (error) {
      setStatus('офлайн · ' + friendly(error), 'warn');
    });
  }

  // Ни в коем случае не применяем пустой профиль: он означает дефолтные
  // 100 звёзд. Если ответ сервера не содержал профиль — переспрашиваем сессию.
  function applyServerProfile(profile, retried) {
    if (!profile) {
      if (!retried && token()) {
        api('/session', { token: token() }).then(function (session) {
          applyServerProfile(session.user && session.user.profile, true);
        }).catch(function () {});
      }
      return;
    }
    var auto = autoEnabled;
    var timer = autoTimer;
    // keepVisuals: сервер обновляет баланс и прогресс, но не стирает
    // символы, которые только что показала анимация.
    applyProfile(profile, true);
    if (auto) {
      autoEnabled = true;
      autoTimer = timer;
      updateAutoButton();
    }
  }

  // Случайность приходит с сервера. Если поток кончился (декоративные
  // искры, анимации), используется обычный локальный генератор.
  var originalRandomValue = randomValue;
  randomValue = function () {
    if (serverRolls.length) return serverRolls.shift();
    return originalRandomValue();
  };

  var originalFinishRound = finishRound;
  finishRound = function (details) {
    var result = serverResult || {};
    var merged = {
      icons: details && details.icons ? details.icons : [],
      win: Number(result.win) || 0,
      text: result.text || (details && details.text) || '',
      kind: result.kind || (details && details.kind) || 'lose',
      jackpot: !!result.jackpot,
      triple: !!result.triple,
      refund: !!result.refund,
      dartBull: !!result.dartBull,
      cardFlush: !!result.cardFlush,
      discovered: details && details.discovered ? details.discovered : [],
      serverAuthoritative: true
    };
    originalFinishRound(merged);
    if (!serverResult) {
      // Ход пришёл не через серверный слой (например, событие привязано к
      // старой функции) — возвращаем настоящий баланс с сервера.
      setStatus('ход без проверки — синхронизируем', 'warn');
      applyServerProfile(null);
      serverRolls = [];
      serverResult = null;
      fetchLeaderboard();
      return;
    }
    applyServerProfile(result.profile);
    serverRolls = [];
    serverResult = null;
    setStatus('ход проверен сервером', 'ok');
    fetchLeaderboard();
  };

  // Сервер считает ход через Constant Object и отвечает ~250 мс. Пока ответ
  // идёт, поле слегка размыто — игрок видит реакцию мгновенно, а настоящая
  // анимация стартует сразу после получения честных случайных чисел.
  function waitingVisual(on) {
    var id = activeGame === 'slots' ? 'reelsWrap' : activeGame === 'dice' ? 'diceWrap' :
      activeGame === 'roulette' ? 'wheel' : activeGame === 'darts' ? 'dartsWrap' : 'cardTable';
    var element = byId(id);
    if (element) element.classList.toggle('neon-wait', !!on);
  }

  var originalPlay = play;
  play = function () {
    if (!currentUser || playing || serverBusy || !token()) return;
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    setStatus('проверка хода...', 'wait');
    statusEl.textContent = 'Играем…';
    setMessage(
      activeGame === 'slots' ? 'Крутим барабаны…' : activeGame === 'dice' ? 'Бросаем кости…' :
      activeGame === 'roulette' ? 'Крутим колесо…' : activeGame === 'darts' ? 'Метам дротики…' : 'Раздаём карты…'
    );
    waitingVisual(true);
    serverBusy = true;
    api('/play', actionBody({ game: activeGame })).then(function (result) {
      serverBusy = false;
      waitingVisual(false);
      serverRolls = Array.isArray(result.rolls) ? result.rolls.slice() : [];
      serverResult = result;
      currentBet = result.bet;
      playing = true;
      statusEl.textContent = 'Играем…';
      setMessage(
        activeGame === 'slots' ? 'Крутим барабаны…' : activeGame === 'dice' ? 'Бросаем кости…' :
        activeGame === 'roulette' ? 'Крутим колесо…' : activeGame === 'darts' ? 'Метам дротики…' : 'Раздаём карты…'
      );
      updateUI(LITE_UI);
      beep(220, 0.08, 'square', 0.025);
      var multiplier = Number(result.multiplier) || 1;
      if (activeGame === 'slots') spinSlots(multiplier);
      else if (activeGame === 'dice') rollDice(multiplier);
      else if (activeGame === 'roulette') spinRoulette(multiplier);
      else if (activeGame === 'darts') playDarts(multiplier);
      else playCards(multiplier);
    }).catch(function (error) {
      serverBusy = false;
      waitingVisual(false);
      playing = false;
      statusEl.textContent = 'Готово к игре';
      setStatus('ошибка хода · ' + friendly(error), 'warn');
      setMessage(friendly(error), 'warn');
      updateUI(LITE_UI);
    });
  };

  var originalOpenChest = openChest;
  openChest = function (id) {
    if (!currentUser || playing || chestBusy || serverBusy || !token()) return;
    var chest = chestTypes.find(function (item) { return item.id === id; });
    if (!chest) return;
    setStatus('открываем сундук...', 'wait');
    serverBusy = true;
    api('/chest', actionBody({ id: id })).then(function (result) {
      serverBusy = false;
      chestBusy = id;
      chestCooldowns[id] = result.cooldownUntil;
      setMessage('Открываем ' + chest.name.toLowerCase() + ' сундук…');
      showChestOverlay(chest);
      updateUI();
      setTimeout(function () {
        var prize = result.prize || {};
        setMessage(prize.text || '', prize.kind === 'empty' ? 'lose' : 'win');
        revealChest(prize);
        if (prize.kind !== 'empty') { confetti(); beep(700, 0.14, 'triangle', 0.05); }
        checkAchievements({ jackpot: !!prize.jackpot });
        applyServerProfile(result.profile);
        chestBusy = null;
        updateUI(LITE_UI);
        setStatus('сундук открыт', 'ok');
        fetchLeaderboard();
      }, Math.max(900, chest.delay + 200));
    }).catch(function (error) {
      serverBusy = false;
      setStatus('ошибка сундука · ' + friendly(error), 'warn');
      setMessage(friendly(error), 'warn');
    });
  };

  var originalSellGift = sellGift;
  sellGift = function (id) {
    if (!currentUser || playing || chestBusy || !token()) return;
    setStatus('продажа...', 'wait');
    api('/sell', actionBody({ id: id })).then(function (result) {
      var gift = giftDefs.find(function (item) { return item.id === id; });
      toast((gift ? gift.name : 'Подарок') + ' продан: +' + result.total + ' звёзд', 'coin');
      setMessage('Подарок продан за ' + result.total + ' звёзд!', 'win');
      applyServerProfile(result.profile);
      updateUI();
      setStatus('продажа сохранена', 'ok');
      fetchLeaderboard();
    }).catch(function (error) {
      setStatus('ошибка продажи · ' + friendly(error), 'warn');
    });
  };

  var originalSellAllGifts = sellAllGifts;
  sellAllGifts = function () {
    if (!currentUser || playing || chestBusy || !token()) return;
    setStatus('продажа...', 'wait');
    api('/sell', actionBody({ all: true })).then(function (result) {
      toast('Продано ' + result.count + ' подарков: +' + result.total + ' звёзд', 'coin');
      setMessage('Продано ' + result.count + ' подарков за ' + result.total + ' звёзд!', 'win');
      applyServerProfile(result.profile);
      updateUI();
      setStatus('продажа сохранена', 'ok');
      fetchLeaderboard();
    }).catch(function (error) {
      setStatus('ошибка продажи · ' + friendly(error), 'warn');
    });
  };

  // В игре кнопки привязаны к функциям через addEventListener при загрузке
  // страницы — ссылка указывает на оригинальную функцию, поэтому простой
  // перехват глобальной переменной не работает. Ловим клик на document в
  // фазе capture и запускаем серверные версии.
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('#playBtn')) {
      var playButton = byId('playBtn');
      if (!playButton || playButton.disabled || !currentUser || !token()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      play();
      return;
    }
    if (target.closest('#sellAllBtn')) {
      var sellButton = byId('sellAllBtn');
      if (!sellButton || sellButton.disabled || !currentUser || !token()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sellAllGifts();
    }
  }, true);

  // Настройки (ставка, вкладка, звук) — косметика. Сервер хранит их,
  // но никогда не берёт отсюда баланс или прогресс.
  saveProfile = function () {
    if (!token()) return;
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(function () {
      settingsTimer = null;
      api('/settings', actionBody()).catch(function () {});
    }, 600);
  };

  updateLeaderboard = function () {
    if (currentUser) fetchLeaderboard();
  };

  renderLeaderboard = function () {
    var list = byId('leaderboard');
    if (!list) return;
    var key = (currentUser ? currentUser.name : '') + '#' + leaderboard.map(function (entry) {
      return [entry.name, entry.balance, entry.level, entry.games, entry.gifts, entry.chests, entry.achievements, entry.rank].join('|');
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

  var missionsRoot = byId('missions');
  if (missionsRoot) {
    missionsRoot.addEventListener('click', function (event) {
      var button = event.target.closest('.mission-claim');
      if (!button || !currentUser || !token()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setStatus('проверка задания...', 'wait');
      api('/mission', actionBody({ id: button.dataset.id })).then(function (result) {
        toast(result.title + ': +' + result.reward + ' звёзд', 'check');
        confetti();
        applyServerProfile(result.profile);
        updateUI();
        setStatus('задание выполнено', 'ok');
        fetchLeaderboard();
      }).catch(function (error) {
        setStatus('ошибка задания · ' + friendly(error), 'warn');
      });
    }, true);
  }

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
      return api('/login', {
        name: name,
        hash: hash,
        mode: authMode === 'register' ? 'register' : 'login'
      });
    }).then(function (result) {
      localStorage.setItem(TOKEN_KEY, result.token);
      enterOnline(result.user.name, result.user.profile || null, result.isNew === true);
    }).catch(function (error) {
      authError.textContent = friendly(error);
      setStatus('ошибка входа', 'warn');
    });
  }, true);

  restoreSession = function (retry) {
    if (!token()) {
      showAuth('login');
      setStatus('войди в аккаунт', 'warn');
      return;
    }
    setStatus(retry ? 'повторная проверка сессии...' : 'проверка сессии...', 'wait');
    api('/session', { token: token() }).then(function (result) {
      sessionRetries = 0;
      enterOnline(result.user.name, result.user.profile || null, false, true);
    }).catch(function (error) {
      var message = String((error && error.message) || error || '');
      // Токен недействителен — только в этом случае требуем вход.
      if (/Нужно войти снова|Сессия истекла|Неверный никнейм|Некорректный запрос/.test(message)) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        showAuth('login');
        setStatus('нужен вход · ' + friendly(error), 'warn');
        return;
      }
      // Сеть, 429, 5xx — временная ошибка. Токен сохраняем и пробуем ещё раз.
      var attempt = Number(retry || 0);
      sessionRetries = attempt + 1;
      if (attempt < 3) {
        setStatus('нет связи · ' + friendly(error) + ' — повтор ' + (attempt + 1), 'wait');
        setTimeout(function () { restoreSession(attempt + 1); }, 1200 * (attempt + 1));
      } else {
        setStatus('офлайн · ' + friendly(error) + ' — токен сохранён', 'warn');
      }
    });
  };

  logoutBtn.addEventListener('click', function (event) {
    if (!currentUser || !token()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var savedToken = token();
    api('/logout', { token: savedToken }).catch(function () {});
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
    api('/delete', { token: token() }).then(function () {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      location.reload();
    }).catch(function (error) {
      setStatus('не удалось удалить · ' + friendly(error), 'warn');
    });
  }, true);

  var css = document.createElement('style');
  css.id = 'neonOnlineCss';
  css.textContent = '' +
    '.online-status{margin:10px 0 4px;padding:7px 10px;border-radius:10px;font-size:11px;letter-spacing:.03em;text-align:center;border:1px solid rgba(0,255,213,.22);background:rgba(0,255,213,.06);color:#8fffe9;}' +
    '.online-ok{border-color:rgba(80,255,170,.35);color:#8bffb8;}' +
    '.online-warn{border-color:rgba(255,180,80,.35);color:#ffd18b;}' +
    '.online-wait{border-color:rgba(140,160,255,.35);color:#b8c4ff;}' +
    '.online-inline{margin-top:8px;font-size:11px;color:#8fffe9;word-break:break-word;}' +
    '.leader-extra{display:block;font-size:10px;opacity:.72;margin-top:2px;}' +
    '.neon-wait{filter:blur(3px) brightness(.8);transition:filter .12s linear;}';
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
  if (note) note.textContent = 'Общий сервер с защитой: ник, пароль, баланс, уровень, игры, подарки, сундуки и достижения. Все выигрыши считает сервер — подмена игры не поможет. Реальных денег нет — только виртуальные звёзды.';

  var stack = document.querySelector('#settingsDrawer .settings-stack');
  if (stack && !byId('onlineSettingsStatus')) {
    var card = document.createElement('section');
    card.className = 'card online-card';
    card.innerHTML = '' +
      '<h2><span data-icon="chart"></span>Онлайн-аккаунт</h2>' +
      '<p class="setting-note">Общий сервер подключён. Баланс и выигрыши проверяет сервер, поэтому их нельзя подделать. Прогресс сохраняется автоматически.</p>' +
      '<div class="online-actions"><button id="onlineTestBtn" class="side-btn" type="button">Проверить связь</button></div>' +
      '<div id="onlineSettingsStatus" class="online-inline online-wait">Проверяем связь...</div>';
    var danger = stack.querySelector('.danger-card');
    stack.insertBefore(card, danger || stack.lastChild);
  }

  var testBtn = byId('onlineTestBtn');
  if (testBtn) testBtn.addEventListener('click', function () {
    setStatus('проверка связи...', 'wait');
    fetchLeaderboard();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && token()) {
      api('/settings', actionBody()).catch(function () {});
    }
  });

  window.NEON_ONLINE = {
    fetchLeaderboard: fetchLeaderboard,
    syncSettings: function () { api('/settings', actionBody()).catch(function () {}); }
  };

  setStatus('подключение к общему серверу...', 'wait');
  restoreSession();
})();
