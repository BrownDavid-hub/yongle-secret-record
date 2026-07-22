/* 永乐秘闻录 · 竖屏版游戏逻辑（移植自旧版 app.js，UI 绑定 prototype.html） */
const STORAGE_KEY = 'yongle-game-v4';
// 直接双击 index.html 打开时，前端用 config.local.js 里的密钥直连 DeepSeek；
// 通过本地服务端打开时，走服务端代理（密钥不落前端）。
const SERVER_URL = '';
const DIRECT_API_KEY = typeof window !== 'undefined' ? window.DEEPSEEK_API_KEY : '';
const USE_DIRECT = location.protocol === 'file:' && !!DIRECT_API_KEY;

const STORY = window.YONGLE_STORY;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let game; // 在常量与工厂函数定义之后初始化

function loadGame() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (saved && Number.isInteger(saved.chapter) && Array.isArray(saved.history)) return ensureCompat(saved);
  return newGame();
}

// 旧存档兼容：缺字段时补默认值，清洗脏数据
function ensureCompat(g) {
  g.stats = g.stats || defaultStats();
  g.time = g.time || defaultTime();
  g.relations = g.relations || defaultRelations();
  // 清洗旧存档中的噪音人物名（如"有交情的庙祝""庙当起了庙祝"等）
  if (g.relations) {
    const clean = {};
    for (const [key, val] of Object.entries(g.relations)) {
      const ck = cleanPersonName(key);
      if (ck && ck !== key) {
        // 合并到正确名字下，取其最大值
        clean[ck] = clean[ck] || val;
        clean[ck].value = Math.max(clean[ck].value || 0, val.value || 0);
        clean[ck].met = clean[ck].met || val.met;
      } else if (ck) {
        clean[ck] = val;
      }
    }
    // 补回默认关系中的初始角色
    for (const n of INITIAL_RELATIONS) {
      if (!clean[n]) {
        clean[n] = n === '玄真道人' ? { value: 65, met: true } : { value: 0, met: false };
      }
    }
    g.relations = clean;
    // 恢复出场顺序计数器
    const orders = Object.values(g.relations).map(r => r.order).filter(o => typeof o === 'number');
    relationOrder = orders.length ? Math.max(...orders) + 1 : INITIAL_RELATIONS.length;
  }
  g.snapshots = g.snapshots || [];
  g.clues = g.clues || [];
  g.suggestions = g.suggestions || [];
  g.notes = g.notes || [];
  g.location = g.location || defaultLocation();
  return g;
}

/* ---------- 属性系统 ---------- */
const STAT_DEFS = [
  { key: '气血', max: 100, color: '#c04a3a', desc: '受伤会扣除，归零会被迫休养' },
  { key: '道行', max: 100, color: '#c9a96a', desc: '法术根基，决定能否强行施法' },
  { key: '心神', max: 100, color: '#8a7ab0', desc: '受惊吓会扣除，过低会生出幻象' },
  { key: '声望', max: 100, color: '#5a8a5a', desc: '北平城里的名气，影响他人态度' },
  { key: '银两', max: 9999, color: '#a08a50', desc: '可以打点、购置，没有上限' },
];
const STAT_ICONS = {
  气血: 'assets/kit/icons/common/battle.png',
  道行: 'assets/kit/icons/common/book.png',
  心神: 'assets/kit/icons/common/investigate.png',
  声望: 'assets/kit/icons/common/talk.png',
  银两: 'assets/kit/icons/common/silver.png',
};

function defaultStats() {
  return { 气血: 100, 道行: 12, 心神: 100, 声望: 0, 银两: 20 };
}

function clampStat(key, value) {
  const def = STAT_DEFS.find((d) => d.key === key);
  if (!def) return null;
  return Math.max(0, Math.min(def.max, Math.round(value)));
}

// 应用 AI 返回的属性变化，带护栏：只认白名单属性、单次限幅 ±20
function applyStatChanges(changes) {
  if (!Array.isArray(changes)) return [];
  game.stats = game.stats || defaultStats();
  const applied = [];
  for (const c of changes.slice(0, 4)) {
    const key = String(c?.name || '');
    const delta = Number(c?.delta);
    if (!STAT_DEFS.some((d) => d.key === key)) continue;
    if (!Number.isFinite(delta) || delta === 0) continue;
    const safeDelta = Math.max(-20, Math.min(20, Math.round(delta)));
    const before = game.stats[key] ?? 0;
    const after = clampStat(key, before + safeDelta);
    if (after === before) continue;
    game.stats[key] = after;
    applied.push({ name: key, delta: after - before, after });
  }
  return applied;
}

/* ---------- 时辰天气系统 ---------- */
const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const SHICHEN_ICONS = ['zi', 'chou', 'yin', 'mao', 'chen', 'si', 'wu', 'wei', 'shen', 'you', 'xu', 'hai'];
const WEATHER_LIST = ['晴', '阴', '雨', '雾', '雪'];

// 开局是戌时（日暮下山，入夜遇诡异）
function defaultTime() {
  return { year: '永乐十七年', season: '春', shichen: 4, weather: '晴' };
}

// 护栏：advanceHours 由 AI 根据场景耗时决定，冷却 2 回合
let lastHourAdvance = -10;
function applyTimeWeather(tw) {
  if (!tw || typeof tw !== 'object') return;
  game.time = game.time || defaultTime();
  if (!Number.isInteger(game.time.shichen) || game.time.shichen < 0 || game.time.shichen > 11) {
    game.time.shichen = defaultTime().shichen;
  }
  // advanceHours: AI 决定跳过几个时辰，范围 0~8，冷却 2 轮
  const n = Number(tw.advanceHours);
  if (Number.isFinite(n) && n > 0 && game.turn - lastHourAdvance >= 2) {
    const skip = Math.max(0, Math.min(8, Math.round(n)));
    game.time.shichen = (game.time.shichen + skip) % 12;
    lastHourAdvance = game.turn;
  }
  const w = String(tw.weather || '');
  if (WEATHER_LIST.includes(w)) game.time.weather = w;
}

function timeText() {
  const t = game.time || defaultTime();
  return `${t.year} · ${t.season} · ${SHICHEN[t.shichen]}时`;
}

/* ---------- 人物关系系统 ---------- */
const INITIAL_RELATIONS = ['沈炼', '玄真道人', '周庙祝'];
let relationOrder = INITIAL_RELATIONS.length; // 按出场顺序编号

function defaultRelations() {
  const r = {};
  for (let i = 0; i < INITIAL_RELATIONS.length; i++) {
    const n = INITIAL_RELATIONS[i];
    if (n === '玄真道人') {
      r[n] = { value: 65, met: true, order: i };
    } else {
      r[n] = { value: 0, met: false, order: i };
    }
  }
  return r;
}

// 人名清洗：合并重复称呼，去除噪音片段
function cleanPersonName(raw) {
  const s = String(raw || '').trim();
  // 噪音模式：包含这些词的是文本截断碎片，不是真实人名
  if (/^[的是向了和从把被到说看会对与跟给让请].*/.test(s)) return null;
  if (s.length < 2 || s.length > 8) return null;
  // 合并已知重复称呼
  if (/师父玄真|掌教玄真|玄真道长/.test(s)) return '玄真道人';
  if (/锦衣卫百户|的锦衣卫/.test(s)) return '沈炼';
  if (/李庙祝|老庙祝|姓李/.test(s)) return '李庙祝';
  if (/周庙祝|向周庙祝/.test(s)) return '周庙祝';
  // 纯代词/泛称不收录
  if (/^(他|她|你|我|它|那|这|一|几|谁|某|有人)/.test(s)) return null;
  return s;
}

// 白名单：初始三人 + 当前章 people + 历史已出现人物（不锁死新人）
function relationWhitelist() {
  const people = (chapter().people || [])
    .map(cleanPersonName)
    .filter(Boolean);
  const existing = Object.keys(game.relations || {});
  return [...new Set([...INITIAL_RELATIONS, ...people, ...existing])];
}

// 护栏：白名单校验（含历史人物）、delta 限幅 ±10、数量上限
function applyRelations(list) {
  if (!Array.isArray(list)) return;
  game.relations = game.relations || defaultRelations();
  const white = relationWhitelist();
  for (const r of list.slice(0, 4)) {
    const name = String(r?.name || '').trim();
    // AI 标记删除：案件结束与该人物无关
    if (r?.remove === true && name) {
      const clean = cleanPersonName(name);
      if (clean && game.relations[clean]) delete game.relations[clean];
      if (game.relations[name]) delete game.relations[name];
      continue;
    }
    const clean = cleanPersonName(name);
    if (!clean) continue;
    // 新人不在白名单也可以加入
    if (!white.includes(clean) && !white.includes(name)) {
      game.relations[clean] = { value: 0, met: false };
    }
    const key = game.relations[clean] ? clean : (game.relations[name] ? name : null);
    if (!key) { game.relations[clean] = { value: 0, met: false }; }
    const rec = game.relations[clean] || game.relations[name];
    if (!rec) continue;
    const delta = Number(r?.delta);
    if (Number.isFinite(delta) && delta !== 0) {
      const safeDelta = Math.max(-10, Math.min(10, Math.round(delta)));
      rec.value = Math.max(0, Math.min(100, rec.value + safeDelta));
    }
    // 初次相遇时按顺序编号
    if (r?.met === true && !rec.met) {
      rec.met = true;
      if (rec.order === undefined) { rec.order = relationOrder++; }
    }
    if (r?.met === true) rec.met = true;
  }
}

function relationStatus(rec) {
  if (!rec.met) return '尚未相遇';
  if (rec.value < 10) return '初次相遇';
  if (rec.value < 30) return '相识';
  if (rec.value < 60) return '熟识';
  return '信赖';
}

/* ---------- 立绘头像 ---------- */
const AVATAR_TYPES = ['村民', '妇人', '官吏', '老者', '孩童'];

// assets/people/<name>.png → 剪影.png → 移除
function avatarImg(name, cls) {
  const im = document.createElement('img');
  im.className = cls;
  im.alt = name;
  im.src = `assets/people/${name}.png`;
  im.onerror = () => { im.src = 'assets/people/剪影.png'; im.onerror = () => im.remove(); };
  return im;
}

/* ---------- 场景背景联动 ---------- */
const BG_RULES = [
  [/药铺/, 'bg-12'],
  [/杂货/, 'bg-10'],
  [/夜市/, 'bg-07'],
  [/土地庙|破庙|荒庙/, 'bg-09'],
  [/城隍庙|庙门|庙/, 'bg-11'],
  [/窄巷|小巷|暗巷|巷子/, 'bg-06'],
  [/码头|河边|漕|船|水边/, 'bg-08'],
  [/客栈|客店|旅店/, 'bg-13'],
  [/城门|城墙|城门口/, 'bg-03'],
  [/官道|驿道|大路|官路/, 'bg-02'],
  [/龙虎山|道观|山上|山门|竹舍/, 'bg-01'],
  [/雨/, 'bg-05'],
  [/街|闹市|市集|集市/, 'bg-04'],
];

function defaultLocation() {
  return { name: '龙虎山', bg: 'bg-01' };
}

// 模糊匹配：AI 给的 location 字段 + 旁白文本，匹配不到保持当前图
function matchSceneBg(text) {
  const t = String(text || '');
  for (const [re, bg] of BG_RULES) if (re.test(t)) return bg;
  return null;
}

function applyLocation(data) {
  game.location = game.location || defaultLocation();
  const locName = typeof data.location === 'string' ? data.location.trim().slice(0, 12) : '';
  const probe = `${locName}\n${data.reply || ''}`;
  const bg = matchSceneBg(probe);
  if (locName && locName.length >= 2 && !/夜晚|白天|街上|这里|原地/.test(locName)) {
    game.location.name = locName;
  }
  if (bg) game.location.bg = bg;
}

/* ---------- 道具图标 ---------- */
function itemIcon(name) {
  const n = String(name || '');
  if (/压胜钱/.test(n)) return 'assets/items/压胜钱.png';
  if (/铜钱|银|钱/.test(n)) return 'assets/kit/icons/common/silver.png';
  if (/钥匙/.test(n)) return 'assets/kit/icons/common/key.png';
  if (/信|纸条|纸|书|卷/.test(n)) return 'assets/kit/icons/common/letter.png';
  if (/剑|刀/.test(n)) return 'assets/kit/icons/common/battle.png';
  if (/符/.test(n)) return 'assets/kit/icons/common/scroll.png';
  if (/药/.test(n)) return 'assets/kit/icons/common/medicine.png';
  return 'assets/kit/icons/common/item.png';
}

function itemsList() {
  return String(game.items || '').split(/[、，,；;]/).map((x) => x.trim()).filter(Boolean);
}

function newGame() {
  return {
    chapter: 0,
    node: 0,
    turn: 0,
    clues: [],
    history: [openingEntry(0)],
    suggestions: [],
    identity: '许七安 · 龙虎山弟子',
    items: '桃木剑（剑格甲子）、半卷神鬼异志、符纸、朱砂',
    snapshots: [],
    stats: defaultStats(),
    time: defaultTime(),
    relations: defaultRelations(),
    notes: [],
    location: defaultLocation(),
  };
}

/* ---------- 回合快照：支撑重新生成与撤回编辑 ---------- */
function takeSnapshot() {
  return JSON.parse(JSON.stringify({
    chapter: game.chapter,
    node: game.node,
    turn: game.turn,
    clues: game.clues,
    history: game.history,
    suggestions: game.suggestions,
    identity: game.identity,
    items: game.items,
    chapterGate: !!game.chapterGate,
    stats: game.stats || defaultStats(),
    time: game.time || defaultTime(),
    relations: game.relations || defaultRelations(),
    notes: game.notes || [],
    location: game.location || defaultLocation(),
  }));
}

function restoreSnapshot(snap) {
  const s = JSON.parse(JSON.stringify(snap));
  game.chapter = s.chapter;
  game.node = s.node;
  game.turn = s.turn;
  game.clues = s.clues;
  game.history = s.history;
  game.suggestions = s.suggestions;
  game.identity = s.identity;
  game.items = s.items;
  game.chapterGate = s.chapterGate;
  game.stats = s.stats || defaultStats();
  game.time = s.time || defaultTime();
  game.relations = s.relations || defaultRelations();
  game.notes = s.notes || [];
  game.location = s.location || defaultLocation();
}

// 第 t 个玩家回合（0 起）对应的行动原文
function actionOfTurn(t) {
  let count = -1;
  for (const x of game.history) {
    if (x.kind === 'player') {
      count++;
      if (count === t) return x.text;
    }
  }
  return null;
}

// 撤回并编辑：回滚到第 t 回合之前，把原话填回输入框
function editTurn(t) {
  if ($('#btn-send').disabled) return;
  const snap = (game.snapshots || [])[t];
  const action = actionOfTurn(t);
  if (!snap || action == null) return;
  restoreSnapshot(snap);
  save();
  paint();
  const input = $('#action-input');
  input.value = action;
  input.focus();
  pushNarrate({ tag: '记录', text: '已回滚到该回合之前，修改上方文字后提交，剧情将从这里重新演绎。', kind: 'notice' });
}

// 重新生成：回滚第 t 回合的 AI 回复，用同一行动重新演绎
async function regenerateTurn(t) {
  if ($('#btn-send').disabled) return;
  const snap = (game.snapshots || [])[t];
  const action = actionOfTurn(t);
  if (!snap || action == null) return;
  restoreSnapshot(snap);
  save();
  paint();
  await send(action);
}

function chapter() {
  return STORY.chapters[Math.min(game.chapter, STORY.chapters.length - 1)];
}

function node() {
  const c = chapter();
  return c.nodes[Math.min(game.node, c.nodes.length - 1)];
}

function openingEntry(index) {
  const c = STORY.chapters[index];
  return {
    tag: `${c.volumeTitle} / ${c.title}`,
    text: c.opening,
    kind: 'ai',
    img: index,
  };
}

function shortTitle(c) {
  return String(c.title || '').replace(/^第.+?章[：:]/, '').trim() || c.title;
}

/* ---------- 存档：localStorage + 服务端同步 ---------- */
let syncTimer = null;

function save() {
  game.savedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
  if (location.protocol.startsWith('http')) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncSaveToServer, 600);
  }
  // 轻提示：右下角短暂显示"已存档"
  const toast = document.createElement('div');
  toast.textContent = '✓ 已存档';
  toast.style.cssText = 'position:fixed;bottom:80px;right:14px;z-index:999;padding:4px 12px;background:rgba(0,0,0,.75);color:var(--gold);font-size:11px;border-radius:3px;pointer-events:none;transition:opacity .5s;';
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 600); }, 1500);
}

async function syncSaveToServer() {
  try {
    const res = await fetch(SERVER_URL + '/api/save', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(game),
    });
    return res.ok;
  } catch (_) { return false; }
}

// 启动时：服务端存档比本地新就采用服务端那份（手机电脑互通）
// force=true 时（菜单页手动"从服务器读取"）无条件采用服务端存档
async function pullServerSave(force = false) {
  if (!location.protocol.startsWith('http')) return false;
  try {
    const res = await fetch(SERVER_URL + '/api/save');
    if (!res.ok) return false;
    const remote = await res.json();
    if (!Number.isInteger(remote.chapter) || !Array.isArray(remote.history)) return false;
    // 忽略重置标记（chapter 0 且无历史 = 刚被清空的存档）
    if (remote.chapter === 0 && remote.history.length === 0) return false;
    if (force || (remote.savedAt || 0) > (game.savedAt || 0)) {
      game = ensureCompat(remote);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(game));
      return true;
    }
  } catch (_) {}
  return false;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ---------- 旁白渲染 ---------- */
const NO_AVATAR_TAGS = ['叙述', '章节推进', '记录', '连接提示', '导入提示', '错误', '缺少密钥'];

function pushNarrate(x, turnIdx = -1) {
  const box = $('#narrate');
  const div = document.createElement('div');
  div.className = `msg ${x.kind || ''}`;
  if (x.kind === 'player') {
    const p = document.createElement('p');
    p.className = 'player';
    p.textContent = x.text;
    div.append(p);
  } else {
    const sp = document.createElement('span');
    sp.className = 'sp';
    sp.textContent = x.tag;
    div.append(sp);
    String(x.text).split(/\n+/).filter(Boolean).forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      div.append(p);
    });
    // AVG 对话框：更新说话人名 + 立绘（旁白/系统标签/无匹配立绘时不显示）
    const dlgN = $('#dlgName');
    const SYS_TAGS = ['章节推进', '记录', '连接提示', '导入提示', '错误', '缺少密钥'];
    if (dlgN && x.kind === 'ai' && !SYS_TAGS.includes(x.tag) && !/[/·]/.test(x.tag || '')) {
      dlgN.textContent = x.tag === '叙述' ? '旁白' : (x.tag || '旁白');
      const dlgP = $('#dlgPortrait');
      if (dlgP) {
        dlgP.innerHTML = '';
        dlgP.hidden = true;
        if (x.tag && x.tag !== '旁白' && x.tag !== '叙述') {
          const im = document.createElement('img');
          im.alt = x.tag;
          im.onload = () => { dlgP.hidden = false; };
          im.onerror = () => { dlgP.hidden = true; };
          im.src = `assets/people/cutout/${encodeURIComponent(x.tag)}.png`;
          dlgP.append(im);
        }
      }
    }
  }
  // 回合操作按钮：玩家行动可撤回编辑，AI 回复可重新生成
  if (turnIdx >= 0 && (x.kind === 'player' || (x.kind === 'ai' && x.tag !== '章节推进'))) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'act';
    if (x.kind === 'player') {
      b.textContent = '✏ 撤回修改';
      b.onclick = () => editTurn(turnIdx);
    } else {
      b.textContent = '🔄 重新生成';
      b.onclick = () => regenerateTurn(turnIdx);
    }
    div.append(b);
  }
  box.append(div);
  box.scrollTop = box.scrollHeight;
}

function add(tag, text, kind = '') {
  game.history.push({ tag, text, kind });
  if (game.history.length > 80) game.history.splice(1, game.history.length - 80);
}

/* ---------- 全量重绘 ---------- */
function paint() {
  const c = chapter();
  const n = node();
  // 旁白
  $('#narrate').innerHTML = '';
  let turnIdx = -1;
  game.history.forEach((x) => {
    if (x.kind === 'player') turnIdx++;
    const hasSnap = turnIdx >= 0 && (game.snapshots || [])[turnIdx];
    pushNarrate(x, hasSnap ? turnIdx : -1);
  });
  // 地点条 + 罗盘（主页/菜单页各一份）
  const t = game.time || defaultTime();
  const loc = game.location || defaultLocation();
  $$('.loc-bar').forEach((bar) => {
    bar.innerHTML = `<div class="loc-text">
      <div class="loc-line1"><img src="assets/kit/icons/common/map-pin.png" alt="">${escapeHtml(loc.name)} · ${escapeHtml(shortTitle(c))}</div>
      <div class="loc-line2">${escapeHtml(t.year)} <b>${escapeHtml(t.season)}</b> <b>${SHICHEN[t.shichen]}时</b> · ${escapeHtml(t.weather)}</div>
    </div>
    <div class="compass"><span class="hour-name">${SHICHEN[t.shichen]}时</span>${
      SHICHEN_ICONS.map((ic, i) => `<img class="sh" src="assets/kit/icons/shichen/${ic}.png" alt="" style="opacity:${i === t.shichen ? '.65' : '.5'}">`).join('')
    }<span class="compass-pointer" style="transform:rotate(${t.shichen * 30}deg)"></span></div>`;
  });
  // 场景卡
  const sw = $('#sceneWrap');
  if (sw) sw.style.backgroundImage = `url("assets/backgrounds/webp/${loc.bg}.webp")`;
  $('#sceneTitle').textContent = loc.name;
  $('#sceneText').textContent = String(n.brief || '').slice(0, 90);
  // 主页右侧任务/线索纸卷面板
  const qsQ = $('#qsQuest');
  if (qsQ) qsQ.innerHTML = `<b>${escapeHtml(shortTitle(c))}</b><small>${escapeHtml(n.goal || '')}</small>`;
  const qsC = $('#qsClues');
  if (qsC) {
    const qlist = game.clues.slice(0, 12);
    while (qlist.length < 3) qlist.push(null);
    qsC.innerHTML = qlist.map((x) => (x
      ? `<div class="qs-clue">${escapeHtml(x)}</div>`
      : '<div class="qs-clue unknown">???</div>')).join('');
  }
  // 建议行动
  paintSuggestions();
  // 任务页
  $('#qMain').textContent = c.title;
  const briefHead = String(n.brief || '').split(/[。！？]/)[0].slice(0, 42);
  $('#qSub').textContent = briefHead ? `${n.goal}（${briefHead}…）` : (n.goal || '');
  const overall = Math.round(((game.chapter + game.node / c.nodes.length) / STORY.chapters.length) * 100);
  $('#qProgress').textContent = `章节 ${game.chapter + 1}/${STORY.chapters.length} · 节点 ${game.node + 1}/${c.nodes.length} · 全书 ${overall}%`;
  paintClues();
  paintRelations();
  paintPeople();
  paintStatsBar();
  paintBag();
  paintNotes();
  paintCase();
}

function paintSuggestions() {
  const box = $('#suggestRow');
  box.innerHTML = '';
  const list = (game.suggestions && game.suggestions.length ? game.suggestions : defaultSuggestions()).slice(0, 3);
  list.forEach((text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = text;
    b.disabled = $('#btn-send').disabled;
    b.onclick = () => send(text);
    box.append(b);
  });
}

function paintClues() {
  const box = $('#qClues');
  const shown = game.clues.slice(0, 12);
  while (shown.length < 3) shown.push(null);
  box.innerHTML = shown.map((x) => (x
    ? `<div class="clue-row"><img src="assets/kit/icons/common/clue.png" alt="">${escapeHtml(x)}<span class="dot"></span></div>`
    : '<div class="clue-row unknown">??? <span class="dot"></span></div>')).join('');
}

function relRowHtml(name, rec) {
  const status = relationStatus(rec);
  return `<div class="rel-row">
    <img class="rel-ava" src="assets/people/${escapeHtml(name)}.png" alt="${escapeHtml(name)}"
         onerror="this.onerror=function(){this.remove()};this.src='assets/people/剪影.png'">
    <div class="rel-info">
      <div class="rel-name">${escapeHtml(name)}</div>
      <div class="rel-state">${status}</div>
      ${rec.met ? `<div class="rel-bar"><i style="width:${Math.min(100, rec.value)}%"></i></div>` : ''}
    </div>
    <div class="rel-val${rec.met ? '' : ' unknown'}">${rec.met ? rec.value : '???'}</div>
  </div>`;
}

function paintRelations() {
  const rel = game.relations || defaultRelations();
  const names = Object.keys(rel).sort((a, b) => (rel[a].order ?? 99) - (rel[b].order ?? 99));
  $('#qRels').innerHTML = names.map((n) => relRowHtml(n, rel[n])).join('')
    || '<div class="clue-row unknown">尚未结识任何人</div>';
  // 长按删除——用事件委托（替换整个容器，旧监听自动清除）
  let timer;
  $('#qRels').onpointerdown = (e) => {
    const row = e.target.closest('.rel-row');
    if (!row) return;
    const name = names[[...$('#qRels').querySelectorAll('.rel-row')].indexOf(row)];
    if (!name) return;
    timer = setTimeout(() => {
      showModal('删除人物', `<p>确定要移除 <b>${escapeHtml(name)}</b> 吗？</p>`, [
        { text: '取消', onClick: closeModal },
        { text: '删除', cls: 'danger', onClick: () => {
          delete (game.relations || {})[name];
          save(); paintRelations();
          closeModal();
        }}
      ]);
    }, 3000);
  };
  $('#qRels').onpointerup = () => clearTimeout(timer);
  $('#qRels').onpointerleave = () => clearTimeout(timer);
}

function paintPeople() {
  const rel = game.relations || defaultRelations();
  const filter = $('#peopleTabs .tab.on')?.dataset.filter || 'all';
  const names = Object.keys(rel)
    .sort((a, b) => (rel[a].order ?? 99) - (rel[b].order ?? 99))
    .filter((n) => {
      if (filter === 'met') return rel[n].met;
      if (filter === 'unmet') return !rel[n].met;
      return true;
    });
  $('#peopleList').innerHTML = names.map((name) => {
    const rec = rel[name];
    return `<div class="people-card" data-name="${escapeHtml(name)}">
      <img class="pc-ava" src="assets/people/${escapeHtml(name)}.png" alt="${escapeHtml(name)}"
           onerror="this.onerror=function(){this.remove()};this.src='assets/people/剪影.png'">
      <div>
        <div class="pc-name">${escapeHtml(name)}</div>
        <div class="pc-state">${relationStatus(rec)}</div>
        <div class="pc-rel">关系：<b>${rec.met ? rec.value : '???'}</b>${rec.met ? `<span class="rel-bar"><i style="width:${Math.min(100, rec.value)}%"></i></span>` : ''}</div>
      </div>
    </div>`;
  }).join('') || '<div class="clue-row unknown" style="margin:10px 12px">这个分类下暂无人物</div>';

  // 长按删除——事件委托
  let pressTimer;
  $('#peopleList').onpointerdown = (e) => {
    const card = e.target.closest('.people-card');
    if (!card) return;
    const name = card.dataset.name;
    if (!name) return;
    pressTimer = setTimeout(() => {
      showModal('删除人物', `<p>确定要从人物列表中移除 <b>${escapeHtml(name)}</b> 吗？</p><p style="color:var(--paper-dim);font-size:12px">此操作不可撤销，但不影响剧情进度。</p>`, [
        { text: '取消', onClick: closeModal },
        { text: '删除', cls: 'danger', onClick: () => {
          const rel = game.relations || {};
          delete rel[name];
          game.relations = rel;
          save();
          paintPeople();
          closeModal();
        }}
      ]);
    }, 3000);
  };
  $('#peopleList').onpointerup = () => clearTimeout(pressTimer);
  $('#peopleList').onpointerleave = () => clearTimeout(pressTimer);
}

function paintStatsBar() {
  const stats = game.stats || defaultStats();
  $('#sbIdentity').textContent = (game.identity || '许七安 · 龙虎山弟子').split('·')[1]?.trim() || '龙虎山弟子';
  const hp = stats['气血'] ?? 0;
  $('#sbHpNum').textContent = `${hp}/100`;
  $('#sbHpBar').style.width = `${Math.min(100, hp)}%`;
  $('#sbStats').innerHTML = STAT_DEFS.filter((d) => d.key !== '气血').map((d) => {
    const v = stats[d.key] ?? 0;
    return `<div class="sb-stat" title="${d.desc}">
      <span class="st-circle"><img src="${STAT_ICONS[d.key]}" alt=""></span>
      <span class="st-name">${d.key}</span>
      <span class="st-val">${v}${d.max < 9999 ? '/' + d.max : ''}</span>
    </div>`;
  }).join('');
}

/* ---------- 背包 ---------- */
let bagSel = -1;

function paintBag() {
  const grid = $('#bagGrid');
  const cells = [];
  const counts = {};
  itemsList().forEach((n) => { counts[n] = (counts[n] || 0) + 1; });
  Object.entries(counts).forEach(([name, qty]) => cells.push({ type: 'item', name, qty }));
  // 线索不显示在背包中，请前往任务页查看
  if (cells.length === 0) {
    grid.innerHTML = '<div class="clue-row unknown" style="margin:10px 0;text-align:center">尚无道具，线索请前往任务页查看</div>';
    return;
  }
  grid.innerHTML = cells.map((cell, i) => `<div class="bag-cell${i === bagSel ? ' sel' : ''}" data-i="${i}" data-type="${cell.type}" data-name="${escapeHtml(cell.name)}">
      ${cell.qty > 1 ? `<span class="bi-num">${cell.qty}</span>` : ''}
      <img src="${itemIcon(cell.name)}" alt="">
      <span class="bi-name">${escapeHtml(cell.name)}</span>
    </div>`).join('')
    + Array.from({ length: Math.max(0, 6 - cells.length) }, () => '<div class="bag-cell empty"></div>').join('');
  grid.querySelectorAll('.bag-cell[data-i]').forEach((el) => {
    el.onclick = () => {
      bagSel = Number(el.dataset.i);
      grid.querySelectorAll('.bag-cell').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
    };
  });
}

function selectedBagCell() {
  const el = $('#bagGrid .bag-cell.sel');
  return el ? { type: el.dataset.type, name: el.dataset.name } : null;
}

/* ---------- 笔记 ---------- */
function pushNote(title, body = '') {
  game.notes = game.notes || [];
  const t = game.time || defaultTime();
  game.notes.unshift({
    title: String(title).slice(0, 24),
    body: String(body).slice(0, 140),
    fav: false,
    date: `${t.year} ${t.season} ${SHICHEN[t.shichen]}时`,
  });
  if (game.notes.length > 40) game.notes.length = 40;
}

function paintNotes() {
  const filter = $('#noteTabs .tab.on')?.dataset.filter || 'all';
  const list = (game.notes || []).map((nt, i) => ({ ...nt, i }))
    .filter((nt) => filter !== 'fav' || nt.fav);
  $('#notesList').innerHTML = list.map((nt) => `<div class="note-card" data-i="${nt.i}">
      <span class="nc-c tl"></span><span class="nc-c tr"></span><span class="nc-c bl"></span><span class="nc-c br"></span>
      <img class="nt-star${nt.fav ? '' : ' off'}" src="assets/kit/batch-ui-sheet-8.png/buttons/button-star.png" alt="收藏" data-star="${nt.i}">
      <div class="nt-title">${escapeHtml(nt.title)}</div>
      ${nt.body ? `<div class="nt-body">${escapeHtml(nt.body)}</div>` : ''}
      <div class="nt-date">${escapeHtml(nt.date)}</div>
    </div>`).join('')
    + '<div style="height:14px"></div>';
  $$('#notesList .nt-star').forEach((st) => {
    st.onclick = (e) => {
      e.stopPropagation();
      const nt = game.notes[Number(st.dataset.star)];
      if (nt) { nt.fav = !nt.fav; save(); paintNotes(); }
    };
  });
}

/* ---------- 案件板 ---------- */
function paintCase() {
  const board = $('#case-board');
  const c = chapter();
  const rel = game.relations || defaultRelations();
  const met = Object.keys(rel).filter((n) => rel[n].met);
  const unmet = Object.keys(rel).filter((n) => !rel[n].met);
  const nodes = [];
  // 中心：当前案件（章节）
  nodes.push({ kind: 'center', name: `${shortTitle(c)}`, x: 50, y: 48 });
  // 已相遇人物 + 线索围一圈，未相遇人物为 ??? 节点
  const ring = [
    ...met.map((n) => ({ kind: 'person', name: n })),
    ...game.clues.slice(0, 4).map((cl) => ({ kind: 'clue', name: cl })),
    ...unmet.slice(0, 2).map((n) => ({ kind: 'unknown', name: '???' })),
  ];
  ring.slice(0, 8).forEach((nd, i) => {
    const a = (i / Math.max(ring.length, 1)) * Math.PI * 2 - Math.PI / 2;
    nodes.push({ ...nd, x: 50 + Math.cos(a) * 34, y: 48 + Math.sin(a) * 34 });
  });
  if (!ring.length) nodes.push({ kind: 'unknown', name: '???', x: 50, y: 14 });
  board.innerHTML = nodes.map((nd) => {
    const cls = nd.kind === 'center' ? 'node center' : nd.kind === 'unknown' ? 'node unknown' : 'node';
    const inner = nd.kind === 'person'
      ? `<img class="nd-img" src="assets/people/${escapeHtml(nd.name)}.png" alt=""
           onerror="this.onerror=function(){this.remove()};this.src='assets/people/剪影.png'">`
      : nd.kind === 'unknown'
        ? `<img class="nd-img" src="assets/people/剪影.png" alt="">`
        : `<span class="nd-icon"><img src="assets/kit/icons/common/${nd.kind === 'center' ? 'investigate' : 'clue'}.png" alt=""></span>`;
    return `<div class="${cls}" style="left:${nd.x}%;top:${nd.y}%">${inner}<span class="nd-name">${escapeHtml(String(nd.name).slice(0, 10))}</span></div>`;
  }).join('');
  drawCaseLines();
}

function drawCaseLines() {
  const board = $('#case-board');
  if (!board) return;
  board.querySelectorAll('.link-line').forEach((l) => l.remove());
  const center = board.querySelector('.node.center');
  if (!center) return;
  const r = board.getBoundingClientRect();
  const c = center.getBoundingClientRect();
  const cx = c.left - r.left + c.width / 2, cy = c.top - r.top + c.height / 2;
  board.querySelectorAll('.node:not(.center)').forEach((nd) => {
    const b = nd.getBoundingClientRect();
    const x = b.left - r.left + b.width / 2, y = b.top - r.top + b.height / 2;
    const dx = x - cx, dy = y - cy;
    const len = Math.sqrt(dx * dx + dy * dy) - 34;
    const line = document.createElement('div');
    line.className = 'link-line' + (nd.classList.contains('unknown') ? ' dashed' : '');
    line.style.left = cx + 'px'; line.style.top = cy + 'px';
    line.style.width = len + 'px';
    line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    board.appendChild(line);
  });
}

/* ---------- AI 接口 ---------- */
function parseJson(text) {
  try {
    const data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return { speaker: '叙述', reply: '', newClues: [], progress: 'hold', suggestions: [], ...data };
  } catch {
    return { speaker: '叙述', reply: text, newClues: [], progress: 'hold', suggestions: [] };
  }
}

function cleanSuggestions(list) {
  const banned = futureBanList();
  return (Array.isArray(list) ? list : [])
    .map((x) => String(x || '').trim())
    .filter((x) => x && x.length <= 24 && !banned.some((w) => w && x.includes(w)))
    .filter((x) => !/手机|电脑|汽车|飞机|报警|互联网|穿越/.test(x))
    .slice(0, 3);
}

function defaultSuggestions() {
  const n = node();
  const brief = n.brief || '';
  const picks = [];
  if (/棺|送葬|队伍/.test(brief)) picks.push('观察送葬队伍', '拦住领头者询问', '保持距离跟上去');
  else if (/庙/.test(brief)) picks.push('进庙借宿', '向庙祝打听怪事', '查看庙中异样');
  else picks.push('观察四周气息', '上前询问', '循着线索查探');
  return picks.slice(0, 3);
}

function earlyChapterBanList() {
  if (game.chapter !== 0) return [];
  return [
    '白莲教', '王家纸扎', '纸人傀儡', '替身咒', '锁魂钉',
    '郑和', '扬州', '纪纲', '鲛人', '龙脉',
  ];
}

function futureBanList() {
  const c = chapter();
  const futureTitles = c.lockedFuture || [];
  const titleWords = futureTitles.flatMap((title) => {
    const stripped = title.replace(/^第.+?章[：:]/, '').trim();
    return stripped && stripped.length >= 3 ? [title, stripped] : [title];
  });
  return [...new Set([...titleWords, ...earlyChapterBanList()])];
}

function sanitizeUserText(text) {
  let clean = String(text || '');
  futureBanList().forEach((word) => {
    if (word) clean = clean.split(word).join('');
  });
  return clean;
}

function systemPrompt(correction = '') {
  const c = chapter();
  const n = node();
  const next = c.nodes[game.node + 1];
  const prev = c.nodes[Math.max(0, game.node - 1)];
  const t = game.time || defaultTime();
  return `你是《永乐秘闻录》的文字冒险主持人，玩家扮演许七安。
你必须紧贴当前小说章节，不要自创主线，不要提前泄露后续章节。

【以下开局设定不可偏离——每次开局必须严格遵循】
- 许七安此时持有三样东西：①百年桃木剑（剑格刻"甲子"）②半卷《神鬼异志》③符纸和朱砂。这是不可更改的事实。
- 师父玄真道人已嘱托他：去北平找锦衣卫百户沈炼，先到城外的土地庙落脚，从周庙祝处了解情况。师父特别警告"遇城隍，需谨慎"。
- 北平城上空有阴浊灰雾。城东村落近三月多名手艺人离奇死亡；死者家属会梦到死者诡笑。
- 周庙祝是第一个关键NPC，玩家必须先与他接触，从他口中获知纸人案、城隍庙异象等信息。

【主线自检——每轮必查】
- 在生成回复前，先问自己：当前剧情是否偏离了本章节点目标"${n.brief}"？
- 若已偏离（如沉迷支线、与无关NPC深聊、在无关地点逗留），你必须用 NPC 对话、环境细节或突发事件，**自然地**将玩家注意力引回当前节点目标。不是生硬地说"你得回去"，而是让故事本身产生拉力——比如周庙祝咳嗽提醒、天色将晚催促赶路、远处传来异响、师父的叮嘱浮上心头。
- 若未偏离，正常推进即可。不要每轮都强行拉回。

当前章节：${c.volumeTitle} / ${c.title}
当前节点：${n.brief}
上一节点参考：${prev && prev.id !== n.id ? prev.brief : '无'}
下一节点只可作为方向，不可直接剧透：${next ? next.brief : '本章即将收束'}
本章结尾方向：${c.endingHint}
本章可出现人物：${c.people.length ? c.people.join('、') : '许七安、与本章原文有关的人物'}
暂时禁止提前展开：${futureBanList().join('、') || '无'}

当前时辰天气：${timeText()}，天气 ${t.weather}
【时辰严格规则——必须遵守】
- 你的场景描述中的天色、光线、氛围必须严格与当前时辰吻合：
  卯时(5-7)辰时(7-9)巳时(9-11)→早晨/上午：晨雾、朝阳、鸟鸣、露水、市集渐开
  午时(11-13)→正午：烈日、树荫、蝉鸣、路人稀少避暑
  未时(13-15)申时(15-17)→下午：斜阳、微风、行人赶路
  酉时(17-19)→黄昏：日头偏西、暮色、炊烟、收摊
  戌时(19-21)亥时(21-23)→夜晚：掌灯、月色、更夫、寂静、夜风
  子时(23-1)丑时(1-3)寅时(3-5)→深夜：漆黑、万籁俱寂、烛火、寒气
- 严禁在午时描写"夜色"，严禁在子时描写"阳光"。
- 【advanceHours 强制规则——必须严格执行】
  如果你的回复中出现了以下情况，就必须设置对应的 advanceHours：
  · 回复中提到"天亮""第二天""次日""一夜过去""睡醒" → advanceHours 至少填 5
  · 回复中提到"走了半天""赶了一天的路""长途跋涉" → advanceHours 至少填 4
  · 回复中提到"打坐一个时辰""走了半个时辰" → advanceHours 填 1~2
  · 回复中提到"过了两个时辰""半日过去" → advanceHours 填 2~3
  · 只是闲聊、观察、小范围走动 → 不填或 0
  如果回复描述了时间跨度但没填 advanceHours，时钟就卡住了——这是严重错误。
- 天气白名单：晴、阴、雨、雾、雪。不要用"夜"当天气。

当前场景：${(game.location || defaultLocation()).name}
场景规则（location 字段）：
- 只有玩家确实移动到了新的地点时，才填 location（2 到 8 个字的地点名，如 土地庙、官道、城隍庙、客栈）；原地行动就省略。

说话人规则（speaker 字段）：
- 本回合主要是谁在对玩家开口说话，speaker 就填谁的名字（从本章可出现人物或已相遇人物中选，如 沈炼、玄真道人、周庙祝）；纯叙述、没有人物开口时填 "旁白"。

当前人物关系：
${Object.entries(game.relations || defaultRelations()).map(([name, r]) => `- ${name}：关系值 ${r.value}，${relationStatus(r)}`).join('\n') || '无'}
人物关系规则（relations 字段）：
- 只有与玩家发生真实互动的人物才填 relations；name 必须从这份名单里原样选取：${relationWhitelist().join('、')}。
- delta 表示本回合关系变化，范围 -10 到 +10，涨跌都要有剧情依据，不要每回合硬凑；初次真实见面并互动时填 "met": true，之后省略 met。
- 当案件阶段性结束、某人物与后续剧情不再相关时，填 "remove": true（如 {"name":"王贵","remove":true}），系统会将其从人物栏移除。

许七安当前状态：
${STAT_DEFS.map((d) => `- ${d.key}：${(game.stats || defaultStats())[d.key]}/${d.max}`).join('\n')}
状态规则：
- 你的叙事要考虑这些数值：道行低时强行施法会失败甚至反噬；气血低时行动会吃力；心神低时会出现恍惚、幻听；声望影响乡民官吏的态度；银两不够就买不到东西、打不动关系。
- 每回合根据剧情自然结算 statChanges：受伤扣气血、见鬼怪扣心神、有效修行或施法成功加道行、办成事加声望、花钱扣银两。无事发生就给空数组。单项变化控制在 -15 到 +15 之间，涨跌都要有剧情依据，不要每回合硬凑变化。

规则：
- 每次回复 120 到 260 字，像明代志怪悬疑小说。
- newClues 最多 2 条，每条不超过 16 个字，只写本回合新发现的关键信息，不要复述已知线索。
- 玩家乱来、现代化、跳章节、杀关键人物、改变主线时，让行为自然落空，再用当前线索引回本节点目标。
- note 字段：本回合若发生值得记下的关键事件（重要发现、人物初遇、章节转折），填一个 4 到 12 字的笔记标题；没有就省略，不要每回合硬凑。

- AI 只负责演绎和对话，不能决定跳到远处剧情。
- 不要把后续章节标题、后续真相、后续反派提前说出来。
- 不要把许七安改成锦衣卫、捕头、官差；他当前是龙虎山弟子。
- 不要让已知关键人物无故死亡，不要创造会抢主线的新角色。
- progress 只有在玩家确实完成当前节点的观察、询问、跟随、查探、进入等有效行动时才可为 advance；胡话、越界、攻击关键人物必须 hold。
- suggestions 给出 3 个贴合当前节点、玩家下一步可采取的行动建议，每条 4 到 14 个字，第一人称动词开头，风格符合明代志怪；不得包含任何后文剧透或违禁内容。
- 只有当玩家身份或随身之物在本回合真实发生变化时，才填 identity（如“许七安 · 龙虎山弟子”）或 items（如“桃木剑、残卷、符纸”）字段，没变化就省略；不得把身份改成锦衣卫、捕头、官差。
- 只输出 JSON：{"speaker":"叙述或人物名","reply":"正文","newClues":["短线索"],"progress":"hold|advance","suggestions":["建议一","建议二","建议三"],"statChanges":[{"name":"气血","delta":-5}],"identity":"有变化才填","items":"有变化才填","timeWeather":{"advanceHours":0,"weather":"晴"},"relations":[{"name":"沈炼","delta":5,"met":true}],"location":"场景变化才填","note":"关键事件标题，没有就省略"}
${correction}`;
}

function findViolations(data) {
  const text = [data.speaker, data.reply, ...(data.newClues || [])].join('\n');
  const bad = [];
  for (const word of futureBanList()) {
    if (word && text.includes(word)) bad.push(word);
  }
  if (/手机|电脑|汽车|飞机|报警|互联网|摄像头|手枪|炸弹|穿越回/.test(text)) bad.push('现代或越界物品');
  if (/许七安.{0,8}(捕头|锦衣卫|官差|百户)/.test(text)) bad.push('身份跑偏');
  if (/(冒充|自称|假称).{0,12}(锦衣卫|百户|官差|捕头)|锦衣卫校尉/.test(text)) bad.push('官身跑偏');
  if (/玄真.{0,8}(死|亡|仙逝|遇害)|师父.{0,8}(死|亡|仙逝|遇害)/.test(text) && game.chapter < 50) bad.push('关键人物状态跑偏');
  if (game.chapter === 0 && game.node < 2 && /沈炼.{0,16}(出现|现身|开口|说道|冷声|拔刀|按刀|看向|挡住|已经|就在)/.test(text)) bad.push('沈炼提前登场');
  return [...new Set(bad)];
}

function actionIsClearlyOffTrack(action) {
  const text = String(action || '');
  return /手机|电脑|汽车|飞机|报警|互联网|穿越|知道全部剧情|白莲教|郑和|扬州|纪纲|锁魂钉|废弃城隍庙|城隍庙|李庙祝|杀了|烧了|冒充|自称/.test(text);
}

async function postGame(messages, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (USE_DIRECT) {
      return await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DIRECT_API_KEY },
        body: JSON.stringify({
          model: 'deepseek-chat',
          temperature: 0.48,
          max_tokens: 720,
          response_format: { type: 'json_object' },
          messages,
        }),
        signal: controller.signal,
      });
    }
    return await fetch(SERVER_URL + '/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function askDeepSeek(action, correction = '') {
  const recent = game.history
    .slice(-10)
    .map((x) => `${x.tag}：${sanitizeUserText(x.text)}`)
    .join('\n');
  const messages = [
    { role: 'system', content: systemPrompt(correction) },
    { role: 'user', content: `已发生记录：\n${recent}\n\n玩家本回合行动：\n${sanitizeUserText(action)}` },
  ];
  let response;
  try {
    response = await postGame(messages);
  } catch (e) {
    response = await postGame(messages);
  }
  const raw = await response.json();
  if (!response.ok) throw new Error(raw.error?.message || raw.error || '服务端请求失败');
  return parseJson(raw.choices?.[0]?.message?.content || '');
}

function shouldAdvance(action, data) {
  if (actionIsClearlyOffTrack(action)) return false;
  if (data.progress !== 'advance') return false;
  const text = `${action}\n${data.reply || ''}`;
  return /继续|前往|跟上|进入|询问|调查|查看|观察|追踪|守夜|推门|出发|离开|靠近|搜寻|试探|端详|打听/.test(text);
}

function canLeaveChapter(action, data) {
  if (actionIsClearlyOffTrack(action)) return false;
  const text = `${action}\n${data.reply || ''}`;
  return /本章|线索已明|真相渐明|告一段落|离开此地|天色将明|准备去|前往下一处|循着线索|找到沈炼|去见沈炼|入夜再探|明日再查|收束/.test(text);
}

function advanceStory(action, data) {
  const c = chapter();
  if (game.node < c.nodes.length - 1) {
    game.node++;
    return;
  }
  if (game.chapter < STORY.chapters.length - 1) {
    game.chapter++;
    game.node = 0;
    add('章节推进', openingEntry(game.chapter).text, 'ai');
  }
}

function fallbackReply(data, bad) {
  const safeClues = (data.newClues || []).filter((c) => {
    return !bad.some((w) => w && c.includes(w));
  });
  return {
    speaker: data.speaker || '叙述',
    reply: data.reply || '夜色深沉，线索在暗中交织。你凝神思索，试图理清头绪。',
    newClues: safeClues,
    progress: 'hold',
    suggestions: data.suggestions || [],
  };
}

function setBusy(on) {
  $('#btn-send').disabled = on;
  $$('#suggestRow .chip').forEach((b) => (b.disabled = on));
}

async function send(action) {
  if (!action.trim() || $('#btn-send').disabled) return;
  setBusy(true);
  game.snapshots = game.snapshots || [];
  game.snapshots.push(takeSnapshot());
  if (game.snapshots.length > 40) game.snapshots.shift();
  add('你的行动', action, 'player');
  // 章末收束门：上一章已收束且玩家向前行动时翻章
  let chapterTurnNote = '';
  if (game.chapterGate && game.chapter < STORY.chapters.length - 1
    && /下一章|继续|前往|进入|跟上|离开|出发|赶路|前行|深入|动身|启程|追|探|查|走/.test(action)) {
    game.chapterGate = false;
    game.chapter++;
    game.node = 0;
    const nc = chapter();
    add('章节推进', `—— ${nc.volumeTitle} / ${nc.title} ——`, 'ai');
    pushNote(`${nc.title} 开篇`, String(nc.opening || '').slice(0, 60));
    chapterTurnNote = `\n本回合是新章开篇：先用一两句话自然收束上一幕（给上一场戏一个交代），再过渡到新章场景（新章开场参考：${String(nc.opening || '').slice(0, 140)}），然后回应玩家本回合行动。`;
  }
  paint();
  $('#action-input').value = '';
  pushNarrate({ tag: '记录', text: '正在推演……', kind: 'pending' });

  try {
    let data = await askDeepSeek(action, chapterTurnNote);
    let bad = findViolations(data);
    if (bad.length) {
      data = await askDeepSeek(action, `${chapterTurnNote}\n上一版越界：${bad.join('、')}。请完全删除这些内容，用其他方式自然叙述，严格回到当前节点。`);
      bad = findViolations(data);
    }
    if (bad.length) data = fallbackReply(data, bad);

    game.suggestions = cleanSuggestions(data.suggestions);
    const statDelta = applyStatChanges(data.statChanges);
    game.lastStatDelta = statDelta;
    applyTimeWeather(data.timeWeather);
    applyRelations(data.relations);
    applyLocation(data);
    // 归零兜底：气血耗尽强制休养，心神耗尽生出幻象
    game.stats = game.stats || defaultStats();
    if (game.stats['气血'] <= 0) {
      game.stats['气血'] = 30;
      data.reply = `${data.reply || ''}\n\n伤势再也压不住，许七安眼前一黑，只得觅地调养。半日后醒来，伤口已草草包扎，气血稍复——只是耽搁的这段时间里，北平城的雾气似乎更浓了。（气血耗尽，被迫休养，气血恢复至 30）`;
      data.speaker = data.speaker || '叙述';
    } else if (game.stats['心神'] <= 0) {
      game.stats['心神'] = 40;
      data.reply = `${data.reply || ''}\n\n连日惊惧压得心神崩断，许七安恍惚间见满城人影皆无面孔，急忙默诵清心咒，良久才稳住神魂。他知道，再这样下去，没见到妖物自己先疯了。（心神耗尽，幻象丛生，心神稳回 40）`;
      data.speaker = data.speaker || '叙述';
    }
    if (typeof data.identity === 'string' && data.identity.trim()
      && !/锦衣卫|捕头|官差|百户|皇帝/.test(data.identity)) {
      game.identity = data.identity.trim().slice(0, 30);
    }
    if (typeof data.items === 'string' && data.items.trim()
      && !/手机|电脑|汽车|飞机|手枪|炸弹/.test(data.items)) {
      game.items = data.items.trim().slice(0, 60);
    }
    // newItems: 追加新物品，不去重（允许多张符纸等）
    if (Array.isArray(data.newItems) && data.newItems.length) {
      const cur = itemsList();
      const adds = data.newItems.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 20));
      const merged = [...cur, ...adds];
      game.items = merged.join('、') || '两手空空';
    }
    if (typeof data.note === 'string' && data.note.trim()) {
      pushNote(data.note.trim(), String(data.reply || '').slice(0, 60));
    }
    $('#narrate .msg.pending')?.remove();
    add(data.speaker || '叙述', data.reply || '夜色沉沉，线索还未明朗。', 'ai');
    (data.newClues || []).slice(0, 2).forEach((x) => {
      if (x && !game.clues.includes(x)) game.clues.unshift(x);
    });
    if (game.clues.length > 12) game.clues.length = 12;
    const atLastNode = game.node >= chapter().nodes.length - 1;
    if (atLastNode) {
      if (shouldAdvance(action, data) || canLeaveChapter(action, data)) {
        game.chapterGate = true;
        if (!game.suggestions.includes('进入下一章')) game.suggestions.unshift('进入下一章');
        game.suggestions = game.suggestions.slice(0, 3);
      }
    } else if (shouldAdvance(action, data)) {
      advanceStory(action, data);
    }
    game.turn++;
    save();
    paint();
  } catch (e) {
    $('#narrate .msg.pending')?.remove();
    pushNarrate({ tag: '连接提示', text: `AI 请求未完成：${e.message}。请检查网络是否能访问 DeepSeek；若通过服务端启动，请确认服务窗口没有关闭。`, kind: 'notice' });
  } finally {
    setBusy(false);
    paintSuggestions();
    $('#action-input').focus();
  }
}

/* ---------- 通用弹层 ---------- */
function showModal(title, bodyHtml, footButtons = []) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  footButtons.forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'kbtn';
    btn.textContent = b.text;
    btn.onclick = b.onClick;
    foot.append(btn);
  });
  $('#modal').hidden = false;
}

function closeModal() { $('#modal').hidden = true; }

/* ---------- 菜单页功能 ---------- */
function openSaveModal() {
  const c = chapter();
  const saved = game.savedAt ? new Date(game.savedAt).toLocaleString('zh-CN') : '尚未保存';
  showModal('存档 / 读档', `
    <div style="text-align:center;color:var(--paper-dim);font-size:12px;margin-bottom:10px">
      当前：${c.volumeTitle} / ${shortTitle(c)} · 节点 ${game.node + 1}/${c.nodes.length}<br>
      上次存档：${saved}
    </div>
    <div class="mrow"><button class="kbtn" id="sv-save">💾 手动存档</button></div>
    <div class="mrow"><button class="kbtn" id="sv-sync">🔄 同步到服务器</button></div>
    <div class="mrow"><button class="kbtn" id="sv-pull">📥 从服务器读取</button></div>
    <div class="mrow">
      <button class="kbtn" id="sv-export">📤 导出文件</button>
      <button class="kbtn" id="sv-import">📥 导入文件</button>
    </div>
    <input id="sv-file" type="file" accept="application/json" hidden>
    <div class="m-status" id="sv-status"></div>`, [
    { text: '关闭', onClick: closeModal },
  ]);
  const status = (t) => { $('#sv-status').textContent = t; };
  $('#sv-save').onclick = () => {
    save();
    paint();
    status('✅ 已存档。');
  };
  $('#sv-sync').onclick = async () => {
    save();
    const ok = await syncSaveToServer();
    status(ok ? '✅ 已同步到服务器，手机/电脑可互通。' : '❌ 同步失败：请确认通过本地服务端打开。');
  };
  $('#sv-pull').onclick = async () => {
    const ok = await pullServerSave(true);
    if (ok) { paint(); status('✅ 已从服务器读取最新存档。'); } else status('❌ 服务器上没有可用存档。');
  };
  $('#sv-export').onclick = () => {
    const blob = new Blob([JSON.stringify(game, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `永乐秘闻录-存档-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    status('✅ 已导出存档文件。');
  };
  $('#sv-import').onclick = () => $('#sv-file').click();
  $('#sv-file').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Number.isInteger(data.chapter) || !Array.isArray(data.history)) throw new Error('bad');
        game = ensureCompat(data);
        save();
        paint();
        closeModal();
      } catch {
        status('❌ 这个文件不是有效的存档。');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };
}

/* ---------- 摸鱼模式 ---------- */
const STEALTH_KEY = 'yongle-stealth';

function setStealth(on) {
  document.body.classList.toggle('fish', on);
  $('#m-fish-sub').textContent = on ? '已开启（再点一次恢复）' : '伪装成朴素备忘录';
  localStorage.setItem(STEALTH_KEY, on ? '1' : '0');
}

/* ---------- 页面切换 ---------- */
function go(id) {
  $$('.page').forEach((p) => p.classList.remove('active'));
  const t = document.getElementById(id);
  if (t) t.classList.add('active');
  const sc = t && t.querySelector('.scroll');
  if (sc) sc.scrollTop = 0;
  if (id === 'page-case') setTimeout(drawCaseLines, 30);
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $$('[data-go]').forEach((el) => el.addEventListener('click', () => go(el.dataset.go)));
  $$('.tabs').forEach((bar) => {
    bar.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        bar.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
        tab.classList.add('on');
        bagSel = -1;
        paintBag(); paintNotes(); paintPeople();
      });
    });
  });

  $('#btn-send').onclick = () => send($('#action-input').value);
  $('#action-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send($('#action-input').value); }
  });
  $('#btn-observe').onclick = () => send('我仔细观察四周');

  // 主页悬浮件
  const qsT = $('#qsToggle');
  if (qsT) qsT.onclick = () => $('#questPanel').classList.toggle('collapsed');
  const mapF = $('#btn-map-float');
  if (mapF) mapF.onclick = () => showModal('地图', '<p style="color:var(--paper-dim)">地图功能尚未开放。</p>', [{ text: '关闭', onClick: closeModal }]);
  const dlgE = $('#dlgExpand');
  if (dlgE) dlgE.onclick = () => {
    const box = $('#dlgBox');
    box.classList.toggle('expanded');
    dlgE.textContent = box.classList.contains('expanded') ? '收起 ▴' : '展开 ▾';
  };

  $('#m-map').onclick = () => showModal('地图', '<p style="color:var(--paper-dim)">地图功能尚未开放。</p>', [{ text: '关闭', onClick: closeModal }]);
  $('#m-save').onclick = openSaveModal;
  $('#m-fish').onclick = () => setStealth(!document.body.classList.contains('fish'));
  const mRestart = $('#m-restart');
  if (mRestart) mRestart.onclick = () => {
    showModal('重新开始', '<p>确定要清除所有存档，重新开始游戏吗？</p><p style="color:var(--paper-dim);font-size:12px">此操作不可撤销。</p>', [
      { text: '取消', onClick: closeModal },
      { text: '确认重启', onClick: () => {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STEALTH_KEY);
        // 强制从服务器拉取最新（绕过缓存），同时清除服务器端存档
        const ts = Date.now();
        if (location.protocol.startsWith('http')) {
          fetch('/api/save', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chapter: 0, history: [] }) })
            .finally(() => { location.href = '/?r=' + ts; });
        } else {
          location.href = location.href.split('?')[0] + '?r=' + ts;
        }
      } },
    ]);
  };

  // 背包操作
  $('#bag-view').onclick = () => {
    const sel = selectedBagCell();
    if (!sel) return showModal('查看', '<p style="color:var(--paper-dim)">先点选一格物品。</p>', [{ text: '关闭', onClick: closeModal }]);
    showModal(sel.name, sel.type === 'clue'
      ? `<p>线索：${escapeHtml(sel.name)}</p><p style="color:var(--paper-dim)">这是查案过程中记下的关键信息。</p>`
      : `<p>${escapeHtml(sel.name)}</p><p style="color:var(--paper-dim)">随身之物。关键时刻或许能派上用场。</p>`,
      [{ text: '关闭', onClick: closeModal }]);
  };
  $('#bag-use').onclick = () => {
    const sel = selectedBagCell();
    if (!sel || sel.type !== 'item') return;
    bagSel = -1;
    go('page-home');
    send(`我取出${sel.name}，试着使用它`);
  };
  $('#bag-drop').onclick = () => {
    const sel = selectedBagCell();
    if (!sel || sel.type !== 'item') return;
    const list = itemsList();
    const i = list.indexOf(sel.name);
    if (i >= 0) list.splice(i, 1);
    game.items = list.join('、') || '两手空空';
    bagSel = -1;
    save();
    paint();
  };

  // 笔记
  $('#note-new').onclick = () => {
    showModal('新建笔记', '<input type="text" id="nt-title" placeholder="笔记标题"><div style="height:8px"></div><textarea id="nt-body" placeholder="内容（可留空）"></textarea>', [
      {
        text: '保存',
        onClick: () => {
          const title = $('#nt-title').value.trim();
          if (!title) return;
          pushNote(title, $('#nt-body').value.trim());
          save();
          paintNotes();
          closeModal();
        },
      },
      { text: '取消', onClick: closeModal },
    ]);
  };

  $('#case-refresh').onclick = () => {
    const clues = game.clues.length ? game.clues.join('；') : '暂无';
    go('page-home');
    setTimeout(() => {
      send(`帮我整理一下当前线索：${clues}。分析它们之间的关联，推理可能的真相。`);
    }, 300);
  };

  // 老板键：按 ` 瞬间切换摸鱼模式
  document.addEventListener('keydown', (e) => {
    if (e.key === '`') {
      e.preventDefault();
      setStealth(!document.body.classList.contains('fish'));
    }
  });
  window.addEventListener('resize', drawCaseLines);
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
}

/* ---------- 启动 ---------- */
game = loadGame();
bind();
if (localStorage.getItem(STEALTH_KEY) === '1') setStealth(true);

if (!STORY || !STORY.chapters?.length) {
  pushNarrate({ tag: '错误', text: '没有找到剧情卡 story-data.js。', kind: 'notice' });
} else if (location.protocol === 'file:' && !DIRECT_API_KEY) {
  pushNarrate({ tag: '缺少密钥', text: '直接打开网页需要 config.local.js 里的密钥；或者通过本地服务端运行。', kind: 'notice' });
  $('#btn-send').disabled = true;
} else {
  pullServerSave().finally(() => {
    paint();
    if (game.history.some((x) => x.kind === 'player') && !(game.snapshots || []).length) {
      pushNarrate({ tag: '记录', text: '撤回修改 / 重新生成功能已上线：从本回合起，新发生的回合会显示操作按钮（历史回合无法回溯）。', kind: 'notice' });
    }
  });
}
// 深链：#page-xxx 直达（QA 用）
if (location.hash && document.getElementById(location.hash.slice(1))) {
  go(location.hash.slice(1));
}
