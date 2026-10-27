/* ============================================================
 *  合成大奶娃 · 排行榜
 *  基于 TinyWebDB 的 REST 接口（客户端直连，无自建后端）。
 *  成绩 tag = "k_<时间>_<随机>"，value = {"n":昵称,"s":分数,"t":时间戳}
 *  （排行榜存在自己的 TinyWebDB 账号 computor 下，和作者完全分开）
 *  榜单内容 = 最新 60 次提交里的前 50 名。
 *  只读不写别人的数据：不做任何删除，旧成绩自然被后来的人挤出窗口。
 *  整个模块不依赖游戏内部状态，网络不通也只是排行榜不可用，不影响玩。
 * ============================================================ */
(function () {
  'use strict';

  /* ---- 端点与凭据（自己的 TinyWebDB 账号） ---- */
  var API = 'https://tinywebdb.appinventor.space/api';
  var USER = 'computor';
  var SECRET = '58787c39';
  var PREFIX = 'k_';     // 自己的库，新空榜

  const NAME_KEY = 'danaiwa.name';
  /* 徽章按“本局/本次提交”算，不再读写 localStorage */
  const DEFAULT_NAME = '默认用户';   // 没填昵称就用这个
  const MUTE_MIN_GAP = 3000;        // 两次提交至少间隔 3 秒
  const MAX_SCORE = 99999999;       // 明显离谱的成绩直接不收
  const SCAN_PAGES = 5;             // 最多扫 5 页（500 条），尽量多捞
  const SAMPLE = 60;                // 先取最新 60 次提交
  const WINDOW = 50;                // 再按分数取前 50 名展示

  /* ---------------------------------------------------------
   *  排行榜界面开关
   *
   *  true  = 正常展示榜单（面板入口 + 结算弹窗入口都在）
   *  false = 不展示榜单（入口隐藏、弹窗打不开、也不拉榜单），但成绩照旧上传
   *
   *  改完记得重新压一次：
   *      python tools/minify-leaderboard.py
   * ------------------------------------------------------- */
  const BOARD_UI_ENABLED = true;

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------
   *  接口
   * ------------------------------------------------------- */

  function post(params) {
    const body = new URLSearchParams();
    body.set('user', USER);
    body.set('secret', SECRET);
    for (const k in params) body.set(k, params[k]);

    const once = () => fetch(API, { method: 'POST', body: body }).then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then((text) => {
      const s = (text || '').trim();
      if (!s) return {};
      try {
        return JSON.parse(s);
      } catch (e) {
        throw new Error('服务器返回看不懂：' + s.slice(0, 60));
      }
    });

    /* 这个免费接口时不时抽风返 502，歇一下重试一次再算失败 */
    return once().catch((err) => new Promise((r) => setTimeout(r, 700)).then(once).catch(() => {
      throw err;
    }));
  }

  function addScore(name, score) {
    const tag = PREFIX + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const rec = { n: name, s: score, t: Date.now(),
                  r: runBadges.r ? 1 : 0, c: runBadges.c ? 1 : 0, g: runBadges.g ? 1 : 0 };
    const value = JSON.stringify(rec);
    return post({ action: 'update', tag: tag, value: value }).then((res) => {
      /* 记住本局提交的这条，改名时用同一个 tag 覆盖，不新增记录 */
      lastRecord = { tag: tag, rec: rec };
      return res;
    });
  }

  /* 读榜：服务端按提交时间倒序返回；并行扫最多 5 页，尽量多捞历史，
     先取最新 SAMPLE=60 条，再按分数显示前 WINDOW=50 名 */
  function searchRecent() {
    const jobs = [];
    for (let i = 0; i < SCAN_PAGES; i++) {
      jobs.push(post({
        action: 'search', no: String(1 + i * 100), count: '100',
        tag: PREFIX, type: 'both'
      }).catch(() => null));
    }
    return Promise.all(jobs).then((pages) => {
      const out = {};
      for (let p = 0; p < pages.length; p++) {
        const obj = pages[p];
        if (!obj) continue;
        for (const k in obj) {
          if (k.indexOf(PREFIX) === 0 && typeof obj[k] === 'string') out[k] = obj[k];
        }
      }
      return out;
    });
  }

  /* 提交时间：优先用记录里的 t，没有就从 tag 里的时间戳还原。
     早期版本有的 tag 写的是毫秒十进制，这里一并兼容。 */
  function stampOf(tag, rec) {
    const t = Number(rec && rec.t);
    if (isFinite(t) && t > 0) return t;
    const mid = String(tag).split('_')[1] || '';
    if (/^\d{12,}$/.test(mid)) return Number(mid);
    const s = parseInt(mid, 36);
    return isFinite(s) ? s : 0;
  }

  /* 榜单 = 最新 60 次提交，再按分数取前 50 名 */
  function fetchTop() {
    return searchRecent().then((obj) => {
      const all = [];
      for (const tag in obj) {
        const raw = obj[tag];
        if (typeof raw !== 'string') continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        const s = Number(rec && rec.s);
        if (!isFinite(s) || s < 0 || s > MAX_SCORE) continue;
        all.push({
          tag: tag,
          name: String((rec && rec.n) || '匿名玩家').slice(0, 16),
          score: s,
          rex: !!(rec && rec.r),
          cdd: !!(rec && rec.c),
          gfdn: !!(rec && rec.g),
          t: stampOf(tag, rec)
        });
      }

      /* 先按提交时间取最新的 SAMPLE 条 */
      all.sort((a, b) => (b.t - a.t) || (b.tag > a.tag ? 1 : -1));
      const recent = all.slice(0, SAMPLE);

      /* 再按分数取前 WINDOW 名 */
      recent.sort((a, b) => (b.score - a.score) || (b.t - a.t));
      return recent.slice(0, WINDOW);
    });
  }

  /* ---------------------------------------------------------
   *  昵称
   * ------------------------------------------------------- */

  /* ---------- 屏蔽词 ----------
   * 命中就直接把昵称换成「默认用户」。
   *  · 匹配前先做归一化：全角转半角、去掉空格 / 标点 / emoji、英文转小写，
   *    这样「习 近」「习·近」「蔣介石」「ＸＩ」这类插空格的写法也挡得住
   *  · 按「子串」匹配，所以只收 2 个字以上的词（单字会大面积误伤，例如「习」会打到「练习」）
   *  · 这是**前端软过滤**：直接构造请求仍然能绕过，只用于拦住玩家随手输的脏名字。
   *    要更严就得在后端做（这个免费接口没有后端我们控制不了）。
   *  · 想增删词：直接改这个数组即可，改完重新压 min 文件。 */
  const BANNED_WORDS = [
    /* —— 政治人物 / 敏感词 —— */
    '习近', '近平', '习大大', '习总', '习主', '毛泽东', '毛贼', '周恩', '蒋介石', '蒋介',
    '蔡英文', '赖清德', '马英九', '李登辉', '陈水扁', '达赖', '法轮', '六四', '天安门',
    '吾尔开希', '刘晓波', '薄熙来', '周永康', '令计划', '郭文贵', '孙政才', '徐才厚',
    '台独', '港独', '疆独', '藏独', '反共', '灭共', '共匪', '支那', '独裁者',
    '中南海', '亡党', '颠覆国家', '游行示威', '政变', '兵变',

    /* —— 辱骂 / 脏话 —— */
    '傻逼', '傻b', '傻比', '煞笔', '沙比', '傻屌', '傻鸟', '脑残', '智障', '弱智',
    '贱人', '贱货', '婊子', '骚货', '狗东西', '狗日的', '畜生', '杂种', '野种',
    '你妈', '妈的', '他妈', '尼玛', '草泥马', '卧槽', '我操', '操你', '日你', '干你',
    '滚你', '去死', '死全家', '全家死', '废物', '垃圾人', '狗屎', '屎一样',

    /* —— 色情 / 导流（顺手一起挡） —— */
    '色情', '裸聊', '黄片', '约炮', '招嫖', '卖淫', '代孕', '赌博', '博彩', '洗钱',
    '加微信', '加qq', '加群', '扫码领', '刷单',

    /* —— 英文脏话 —— */
    'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'nigger', 'nigga', 'cunt',
    'dick', 'pussy', 'motherfuck', 'whore', 'slut', 'retard'
  ];

  /* 归一化：只留汉字 / 字母 / 数字，方便子串匹配 */
  function normalizeForMatch(raw) {
    return String(raw || '')
      /* 全角字符 → 半角（！～ → !~） */
      .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .toLowerCase()
      /* 空格、标点、符号、emoji 统统去掉 */
      .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  }

  const BANNED_NORM = BANNED_WORDS.map(normalizeForMatch).filter(Boolean);

  /* 是否含屏蔽词 */
  function hasBannedWord(raw) {
    const s = normalizeForMatch(raw);
    if (!s) return false;
    for (let i = 0; i < BANNED_NORM.length; i++) {
      if (s.indexOf(BANNED_NORM[i]) >= 0) return true;
    }
    return false;
  }

  /* 上一次 cleanName 是否因为屏蔽词被替换（只用于提示用户） */
  let nameBlocked = false;

  function cleanName(raw) {
    // 去掉控制字符和首尾空白，限长
    let n = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (n.length > 12) n = n.slice(0, 12);
    // 含屏蔽词 → 一律记成「默认用户」
    if (hasBannedWord(n)) {
      nameBlocked = true;
      n = DEFAULT_NAME;
    }
    return n;
  }

  /* 统一入口：清洗（含屏蔽词）+ 保存 + 必要时提示 */
  function commitName(raw) {
    nameBlocked = false;
    const n = cleanName(raw);
    const prev = myName();
    saveName(n);
    const finalName = myName();
    if (nameBlocked) setMsg('昵称含屏蔽词，已改用「' + DEFAULT_NAME + '」', 'bad');
    paintName();
    if (nickInput) nickInput.value = loadName();
    /* 本局已经提交过：改名后覆盖同一条记录的名字，分数/时间/徽章不变 */
    if (BOARD_UI_ENABLED && lastRecord && finalName !== prev && finalName !== lastRecord.rec.n) {
      const updated = Object.assign({}, lastRecord.rec, { n: finalName });
      post({ action: 'update', tag: lastRecord.tag, value: JSON.stringify(updated) })
        .then(() => {
          lastRecord.rec = updated;
          if (modal && modal.classList.contains('show')) refreshBoard(null).catch(() => {});
        })
        .catch(() => {});
    }
    return n;
  }

  function loadName() {
    try { return cleanName(localStorage.getItem(NAME_KEY) || ''); } catch (e) { return ''; }
  }

  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch (e) { /* 忽略 */ }
  }

  /* 实际提交用的昵称：没填就用「默认用户」 */
  function myName() {
    return loadName() || DEFAULT_NAME;
  }

  /* ---------------------------------------------------------
   *  界面
   * ------------------------------------------------------- */

  const listEl = $('boardList');
  const modal = $('boardModal');
  const msgEl = $('submitMsg');
  const nickInput = $('nickInput');
  const nameLabel = $('myNameLabel');
  const submitBtn = $('submitBtn');
  const submitBox = $('submitBox');

  let lastSubmitAt = 0;
  let submitting = false;
  let pendingScore = 0;          // 本局分数（结算/重试用）
  let lastRecord = null;         // 本局刚提交的那条 { tag, rec }
  let runBadges = { r: false, c: false, g: false };  // 本局徽章状态

  const BADGE_TIPS = {
    '666': '成功让REX相遇',
    'cdd': '合成出REX但是未能让其相遇（或许是太strong了呢）',
    'gfdn': '达到一定分数但是没能合成REX'
  };
  let badgeTip = null;
  let badgeTipFor = null;
  let badgeTipShownAt = 0;

  function setMsg(text, kind) {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = 'submit-msg' + (kind ? ' is-' + kind : '');
  }

  function showRetry(show) {
    if (submitBtn) submitBtn.hidden = !show;
  }

  function ensureBadgeTip() {
    if (badgeTip) return badgeTip;
    if (!document.body) return null;
    badgeTip = document.createElement('div');
    badgeTip.className = 'badge-tip';
    badgeTip.hidden = true;
    badgeTip.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(badgeTip);
    return badgeTip;
  }

  function positionBadgeTip(anchor) {
    if (!badgeTip) return;
    const r = anchor.getBoundingClientRect();
    const tw = badgeTip.offsetWidth;
    const th = badgeTip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 8) top = r.top - th - 8;
    if (top < 8) top = 8;
    badgeTip.style.left = left + 'px';
    badgeTip.style.top = top + 'px';
  }

  function hideBadgeTip() {
    if (badgeTip) badgeTip.hidden = true;
    badgeTipFor = null;
  }

  function toggleBadgeTip(kind, anchor) {
    if (!BADGE_TIPS[kind]) return;
    if (badgeTipFor === anchor) { hideBadgeTip(); return; }
    const tip = ensureBadgeTip();
    if (!tip) return;
    badgeTipFor = anchor;
    badgeTipShownAt = Date.now();
    tip.textContent = BADGE_TIPS[kind];
    tip.hidden = false;
    positionBadgeTip(anchor);
  }

  function badgeFor(kind) {
    if (!kind) return null;
    /* 用 button 包住图片：手机上 34px 的点击区，比 16px 的图片好点得多 */
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'badge-btn';
    btn.setAttribute('aria-label', BADGE_TIPS[kind] || kind);
    const img = document.createElement('img');
    img.src = kind === '666' ? 'assets/666-badge.png'
            : kind === 'cdd' ? 'assets/cdd-badge.png'
            : 'assets/gfdn-badge.png';
    img.className = 'rex-badge';
    img.alt = kind;
    btn.appendChild(img);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBadgeTip(kind, btn);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        toggleBadgeTip(kind, btn);
      }
    });
    return btn;
  }

  /* 名字后面的小图标：666 > cdd > gfdn，全部按“本局/本次提交”算 */
  function makeBadge() {
    if (runBadges.r) return badgeFor('666');
    if (runBadges.c) return badgeFor('cdd');
    if (runBadges.g) return badgeFor('gfdn');
    return null;
  }

  function setRunBadges(b) {
    runBadges = {
      r: !!(b && b.r),
      c: !!(b && b.c),
      g: !!(b && b.g)
    };
    paintName();
  }

  /* 昵称在界面上出现的所有地方一起刷新 */
  function paintName() {
    hideBadgeTip();
    const n = myName();
    if (nameLabel) {
      nameLabel.textContent = n;
      const badge = makeBadge();
      if (badge) nameLabel.appendChild(badge);
    }
    if (nickInput && document.activeElement !== nickInput) nickInput.value = loadName();
  }

  function boardMessage(text) {
    if (!listEl) return;
    listEl.textContent = '';
    const p = document.createElement('p');
    p.className = 'board-empty';
    p.textContent = text;
    listEl.appendChild(p);
  }

  function rankClass(i) {
    return i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : '';
  }

  function renderBoard(rows, myScore) {
    hideBadgeTip();
    if (!listEl) return;
    listEl.textContent = '';
    if (!rows.length) {
      boardMessage('最近还没有人提交，快去玩一局！');
      return;
    }
    let marked = false;
    rows.forEach((row, i) => {
      const line = document.createElement('div');
      line.className = 'board-row ' + rankClass(i);

      const rank = document.createElement('span');
      rank.className = 'board-rank';
      rank.textContent = i < 3 ? ['🥇', '🥈', '🥉'][i] : String(i + 1);

      const name = document.createElement('span');
      name.className = 'board-name';
      /* 榜单里已有的历史昵称也过一遍屏蔽词（老数据里可能留着脏名字） */
      name.textContent = hasBannedWord(row.name) ? DEFAULT_NAME : row.name;

      const score = document.createElement('span');
      score.className = 'board-score';
      score.textContent = row.score;

      line.appendChild(rank);
      line.appendChild(name);
      const badge = badgeFor(row.rex ? '666' : row.cdd ? 'cdd' : row.gfdn ? 'gfdn' : null);
      if (badge) line.appendChild(badge);
      line.appendChild(score);

      // 高亮自己刚提交的那一条（同分且还没标记过）
      if (!marked && myScore != null && row.score === myScore) {
        line.classList.add('is-mine');
        marked = true;
      }
      listEl.appendChild(line);
    });
  }

  function refreshBoard(myScore) {
    /* 界面关掉的时候不拉榜单（省一次请求），但保留 Promise 语义，
       好让 pushScore 里的链路照常往下走 */
    if (!BOARD_UI_ENABLED) return Promise.resolve([]);
    boardMessage('正在读取排行榜…');
    return fetchTop().then((rows) => {
      renderBoard(rows, myScore);
      return rows;
    }).catch((err) => {
      boardMessage('读取失败：' + err.message + '（检查一下网络？）');
      throw err;
    });
  }

  function openBoard() {
    if (!BOARD_UI_ENABLED) return;      // 榜单暂时关闭，弹窗一律不打开
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    refreshBoard(null).catch(() => { /* 已经提示过了 */ });
  }

  function closeBoard() {
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  /* ---------------------------------------------------------
   *  结算 / 提交
   * ------------------------------------------------------- */

  /* 真正写库 */
  function pushScore(name, score, viaRetry) {
    if (submitting) return Promise.resolve(false);
    if (!viaRetry) {
      const now = Date.now();
      if (now - lastSubmitAt < MUTE_MIN_GAP) {
        setMsg('刚提交过啦，稍等一下', 'bad');
        return Promise.resolve(false);
      }
    }
    submitting = true;
    showRetry(false);
    setMsg('正在提交…', '');

    return addScore(name, score).then(() => {
      lastSubmitAt = Date.now();
      setMsg((BOARD_UI_ENABLED ? '已上榜 ✓　' : '成绩已上传 ✓　') + name + ' · ' + score + ' 分', 'good');
      return refreshBoard(score).then(() => true, () => true);
    }).catch((err) => {
      setMsg('提交失败：' + err.message, 'bad');
      showRetry(true);
      return false;
    }).then((ok) => {
      submitting = false;
      return ok;
    });
  }

  /* 手动重试（只在自动提交失败后出现） */
  function retry() {
    if (!pendingScore) return;
    pushScore(myName(), pendingScore, true);
  }

  /* 打完一局：直接结算上榜（榜单取最新 60 次提交里的前 50 名） */
  function onGameOver(score) {
    if (!submitBox) return;
    pendingScore = Number(score) || 0;
    paintName();
    showRetry(false);

    if (!(pendingScore > 0)) {
      submitBox.style.display = 'none';
      return;
    }
    submitBox.style.display = '';
    setMsg('正在结算…', '');
    pushScore(myName(), pendingScore, true);
  }

  /* ---------------------------------------------------------
   *  绑定
   * ------------------------------------------------------- */

  function bind() {
    const boardBtn = $('boardBtn');
    const boardBtn2 = $('boardBtn2');

    if (BOARD_UI_ENABLED) {
      if (boardBtn) boardBtn.addEventListener('click', openBoard);
      if (boardBtn2) boardBtn2.addEventListener('click', openBoard);
    } else {
      /* 榜单暂时关闭：把两处入口按钮藏掉（style.css 里 [hidden] 是 display:none !important） */
      if (boardBtn) boardBtn.hidden = true;
      if (boardBtn2) boardBtn2.hidden = true;
      if (modal) {
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
      }
    }

    const closeBtn = $('boardClose');
    if (closeBtn) closeBtn.addEventListener('click', closeBoard);

    const refreshBtn = $('boardRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      refreshBoard(null).catch(() => {});
    });

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeBoard();
      });
    }

    /* 点徽章弹解释：再点同一个关，点别处关 */
    document.addEventListener('click', (e) => {
      if (!badgeTip || badgeTip.hidden) return;
      if (badgeTip.contains(e.target)) return;
      hideBadgeTip();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideBadgeTip();
    });
    window.addEventListener('resize', hideBadgeTip);
    window.addEventListener('scroll', () => {
      /* 手机上点按偶尔会带出一次 scroll，250ms 内的忽略，避免刚弹出就被关 */
      if (Date.now() - badgeTipShownAt > 250) hideBadgeTip();
    }, true);

    if (submitBtn) submitBtn.addEventListener('click', retry);

    /* 昵称随时能改，改完记本地；含屏蔽词或空着都用「默认用户」 */
    if (nickInput) {
      nickInput.value = loadName();
      const commit = () => { commitName(nickInput.value); };
      nickInput.addEventListener('change', commit);
      nickInput.addEventListener('blur', commit);
      nickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); nickInput.blur(); }
      });
    }

    const editNameBtn = $('editNameBtn');
    if (editNameBtn) {
      editNameBtn.addEventListener('click', () => {
        if (!BOARD_UI_ENABLED) {
          /* 榜单关着的时候弹窗打不开，改昵称就用浏览器原生输入框 */
          const next = window.prompt('改个昵称（最多 12 字，留空＝默认用户）', loadName());
          if (next !== null) commitName(next);
          return;
        }
        openBoard();
        if (nickInput) setTimeout(() => { nickInput.focus(); nickInput.select(); }, 260);
      });
    }

    paintName();

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeBoard();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.DanaiwaBoard = {
    open: openBoard,
    close: closeBoard,
    refresh: refreshBoard,
    onGameOver: onGameOver,
    onNewGame: function () {
      lastRecord = null;
      runBadges = { r: false, c: false, g: false };
      paintName();
    },
    fetchTop: fetchTop,
    submitScore: addScore,
    refreshBadge: paintName,
    setRunBadges: setRunBadges,
    myName: myName,
    setName: function (n) { commitName(n); },
    hasName: function () { return !!loadName(); }
  };
})();
