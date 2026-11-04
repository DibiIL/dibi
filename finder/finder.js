#!/usr/bin/env node
/*
 * dibi finder — רץ על השרת (Vultr), בלי תלויות חיצוניות (Node 18+).
 *
 *   node finder.js prices   מעדכן מחירים/תמונות של כל המוצרים באתר (data/products.json)
 *   node finder.js find     מחפש מוצרים חדשים לפי finder/keywords.json → data/candidates.json
 *   node finder.js all      שניהם
 *   node finder.js test     בודק מפתחות API וגישה ל-GitHub, בלי לשנות כלום
 *
 * המפתחות נקראים מקובץ .env שנמצא בתיקייה שמעל ה-repo (נוצר ע"י install.sh) — לא נשמרים ב-git.
 * כל שינוי נדחף ל-GitHub, ו-Netlify מעלה אותו לאתר אוטומטית.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- config ----------
const HOME = process.env.DIBI_HOME || path.resolve(__dirname, '..', '..'); // <home>/repo/finder/finder.js
const ENV_FILE = path.join(HOME, '.env');
const REPO = process.env.DIBI_REPO_DIR || path.join(HOME, 'repo');
const STATE_FILE = path.join(HOME, 'state.json');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(ENV_FILE);
const E = process.env;
const CFG = {
  key: E.ALI_APP_KEY, secret: E.ALI_APP_SECRET, tracking: E.ALI_TRACKING_ID,
  api: E.ALI_API_URL || 'https://api-sg.aliexpress.com/sync',
  token: E.GITHUB_TOKEN, repo: E.GITHUB_REPO || 'DibiIL/dibi', branch: E.GITHUB_BRANCH || 'main',
  gitRemote: E.GIT_REMOTE_URL, // לבדיקות בלבד
  sshKey: E.GIT_SSH_KEY,        // מפתח Deploy key (חלופה לטוקן)
  minCommission: +(E.MIN_COMMISSION || 5),   // %
  minOrders: +(E.MIN_ORDERS || 100),
  minRating: +(E.MIN_RATING || 90),          // % ביקורות חיוביות
  keywordsPerRun: +(E.KEYWORDS_PER_RUN || 20),
  perCat: +(E.CANDIDATES_PER_CAT || 4),
  maxPending: +(E.MAX_PENDING || 60),
  sleepMs: +(E.API_SLEEP_MS || 1100),
  autoPerDay: +(E.AUTO_ADD_PER_DAY ?? 3),         // כמה מוצרים הבוט מוסיף לאתר בעצמו כל יום (0 = רק רשימת אישור)
  publishMinOrders: +(E.PUBLISH_MIN_ORDERS || 200), // סף מחמיר יותר למוצר שעולה לאתר בלי אישור
  publishMinRating: +(E.PUBLISH_MIN_RATING || 95),
  dryRun: E.DRY_RUN === '1',
};

const log = (...a) => console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = x => (Array.isArray(x) ? x : x ? [x] : []);
const num = x => { const n = parseFloat(String(x ?? '').replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; };
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } };
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 1) + '\n', 'utf8');
const nowIso = () => new Date().toISOString();

// ---------- AliExpress API ----------
class FatalApiError extends Error {}
async function api(method, params) {
  const p = { app_key: CFG.key, method, sign_method: 'sha256', timestamp: String(Date.now()) };
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p[k] = String(v);
  const base = Object.keys(p).sort().map(k => k + p[k]).join('');
  p.sign = crypto.createHmac('sha256', CFG.secret).update(base, 'utf8').digest('hex').toUpperCase();
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(CFG.api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams(p).toString(),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch (_) { throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`); }
      if (j.error_response) {
        const e = j.error_response, msg = `${e.code || ''} ${e.msg || ''} ${e.sub_msg || ''}`.trim();
        if (/sign|appkey|app key|InvalidApp|permission|Invalid.*key/i.test(msg)) throw new FatalApiError(msg);
        throw new Error(msg);
      }
      const w = j[method.replace(/\./g, '_') + '_response'] || j;
      const rr = w.resp_result || w;
      if (rr.resp_code !== undefined && Number(rr.resp_code) !== 200) {
        // 405 = "no result" אצל אליאקספרס — לא שגיאה אמיתית
        if (Number(rr.resp_code) === 405) return {};
        throw new Error(`resp ${rr.resp_code} ${rr.resp_msg || ''}`);
      }
      return rr.result || {};
    } catch (e) {
      if (e instanceof FatalApiError) throw e;
      lastErr = e;
      await sleep((/limit|frequency/i.test(String(e.message)) ? 3000 : 1500) * attempt);
    }
  }
  throw lastErr;
}
const products = r => list(r.products && (r.products.product || r.products));

function commission(p) {
  const r = [p.commission_rate, p.hot_product_commission_rate, p.relevant_market_commission_rate].map(num).filter(x => x !== null);
  return r.length ? Math.max(...r) : null;
}
// המחיר שהגולש רואה: הנמוך מבין מחיר האתר ומחיר האפליקציה (מבצעים זמניים)
function bestPrice(p) {
  const c = [p.target_app_sale_price, p.target_sale_price, p.app_sale_price && p.app_sale_price_currency === 'ILS' ? p.app_sale_price : null]
    .map(num).filter(x => x && x > 0);
  return c.length ? Math.min(...c) : null;
}

// ---------- git ----------
function git(args, opts = {}) {
  const user = CFG.repo.split('/')[0];
  const auth = CFG.token && !CFG.sshKey ? ['-c', 'http.extraHeader=Authorization: Basic ' + Buffer.from(user + ':' + CFG.token).toString('base64')] : [];
  return execFileSync('git', [...auth, ...args], {
    cwd: opts.cwd || REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
      ...(CFG.sshKey ? { GIT_SSH_COMMAND: `ssh -i ${CFG.sshKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes` } : {}) }, // אף פעם לא לעצור ולשאול סיסמה
  }).trim();
}
function remoteUrl() { return CFG.gitRemote || (CFG.sshKey ? `git@github.com:${CFG.repo}.git` : `https://github.com/${CFG.repo}.git`); }
function syncRepo() {
  if (!fs.existsSync(path.join(REPO, '.git'))) {
    log('משכפל את האתר מ-GitHub…');
    git(['clone', '--branch', CFG.branch, remoteUrl(), REPO], { cwd: HOME });
  }
  git(['remote', 'set-url', 'origin', remoteUrl()]);
  git(['fetch', '--quiet', 'origin', CFG.branch]);
  git(['checkout', '--quiet', '-B', CFG.branch, 'origin/' + CFG.branch]);
  git(['reset', '--quiet', '--hard', 'origin/' + CFG.branch]);
  git(['config', 'user.name', 'dibi-bot']);
  git(['config', 'user.email', 'dibi-bot@users.noreply.github.com']);
}
/* מבצע שינוי על עותק עדכני ודוחף. אם מישהו (Claude) דחף באמצע — מושך שוב ומריץ את השינוי מחדש. */
async function commitChange(files, message, mutate) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    syncRepo();
    const changed = await mutate();
    if (!changed) { log('אין שינויים לשמור.'); return false; }
    const status = git(['status', '--porcelain', '--', ...files]);
    if (!status) { log('אין שינויים לשמור.'); return false; }
    if (CFG.dryRun) { log('[DRY_RUN] לא דוחף:', message); log(git(['diff', '--stat'])); return true; }
    git(['add', '--', ...files]);
    git(['commit', '--quiet', '-m', message]);
    try {
      git(['push', '--quiet', 'origin', 'HEAD:' + CFG.branch]);
      log('✅ נדחף ל-GitHub:', message);
      return true;
    } catch (e) {
      log(`הדחיפה נכשלה (ניסיון ${attempt}), מנסה שוב…`, String(e.stderr || e.message).split('\n')[0]);
      await sleep(3000 * attempt);
    }
  }
  throw new Error('לא הצלחתי לדחוף ל-GitHub אחרי 3 ניסיונות');
}

// ---------- status report (data/bot-status.json) ----------
// דוח פומבי בלי סודות: מתי הבוט רץ, מה ה-API החזיר בפועל לכל מוצר, ומה נכתב לאתר. משמש לבקרה.
const STATUS = () => path.join(REPO, 'data', 'bot-status.json');
function writeStatus(part, value) {
  const st = readJson(STATUS(), {});
  st[part] = value;
  writeJson(STATUS(), st);
}
async function reportFailure(part, message) {
  try {
    await commitChange(['data/bot-status.json'], 'דוח בוט: תקלה', () => { writeStatus(part, { at: nowIso(), ok: false, error: String(message).slice(0, 300) }); return true; });
  } catch (e) { log('לא הצלחתי לשמור דוח תקלה:', e.message); }
}

// ---------- prices ----------
const PRODUCTS = () => path.join(REPO, 'data', 'products.json');

async function fetchDetails(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    const r = await api('aliexpress.affiliate.productdetail.get', {
      product_ids: batch.join(','), target_currency: 'ILS', target_language: 'EN', country: 'IL', tracking_id: CFG.tracking,
    });
    for (const p of products(r)) out.set(String(p.product_id), p);
    await sleep(CFG.sleepMs);
  }
  return out;
}

async function updatePrices() {
  // קודם מושכים את הנתונים מה-API (פעם אחת), ואז מחילים על העותק העדכני של הקובץ
  syncRepo();
  const ids = readJson(PRODUCTS(), { products: [] }).products.map(p => String(p.id)).filter(Boolean);
  if (!ids.length) { log('אין מוצרים לעדכן.'); return; }
  log(`בודק מחירים ל-${ids.length} מוצרים…`);
  const details = await fetchDetails(ids);
  log(`התקבלו פרטים ל-${details.size}/${ids.length} מוצרים.`);
  if (details.size === 0) {
    log('⚠️ לא התקבל אף מוצר מה-API — לא משנה מחירים (כנראה תקלה זמנית).');
    await reportFailure('prices', 'ה-API לא החזיר אף מוצר');
    return;
  }

  const changes = [];
  await commitChange(['data/products.json', 'data/bot-status.json'], 'עדכון מחירים אוטומטי', () => {
    const data = readJson(PRODUCTS(), null);
    const report = [];
    if (!data) throw new Error('data/products.json לא תקין');
    changes.length = 0;
    let dirty = false;
    for (const p of data.products) {
      const d = details.get(String(p.id));
      const before = p.price;
      if (d) report.push({
        id: String(p.id), name: p.short || p.name, before,
        api: { sale: d.target_sale_price ?? null, app: d.target_app_sale_price ?? null, original: d.target_original_price ?? null,
               currency: d.target_sale_price_currency || d.target_app_sale_price_currency || null },
        image: d.product_main_image_url || null,
      });
      else report.push({ id: String(p.id), name: p.short || p.name, before, missing: (p.missing || 0) + 1 });
      if (!d) {
        p.missing = (p.missing || 0) + 1;
        if (p.missing >= 3 && p.active !== false) { p.active = false; p.autoHidden = true; changes.push(`🚫 הוסתר (לא זמין): ${p.short || p.name}`); }
        dirty = true;
        continue;
      }
      if (p.missing) { delete p.missing; dirty = true; }
      if (p.autoHidden) { p.active = true; delete p.autoHidden; changes.push(`♻️ חזר למלאי: ${p.short || p.name}`); dirty = true; }
      const price = bestPrice(d);
      if (price) {
        const np = Math.round(price);
        if (np !== p.price) {
          const ratio = p.price ? np / p.price : 1;
          if (ratio < 0.3 || ratio > 3) changes.push(`⚠️ קפיצת מחיר חריגה ${p.short || p.name}: ₪${p.price}→₪${np} (עודכן, כדאי לבדוק)`);
          else changes.push(`${p.short || p.name}: ₪${p.price} → ₪${np}`);
          p.price = np; dirty = true;
        }
      }
      const lp = num(d.target_original_price);
      const nlp = lp && price && lp > price * 1.05 ? Math.round(lp) : undefined;
      if (nlp !== p.listPrice) { if (nlp) p.listPrice = nlp; else delete p.listPrice; dirty = true; }
      if (!p.image && d.product_main_image_url) { p.image = d.product_main_image_url; dirty = true; }
      const cr = commission(d);
      if (cr !== null && cr !== p.commission) { p.commission = cr; dirty = true; }
    }
    const last = Date.parse(data.updated || 0) || 0;
    // את תאריך "המחירים עודכנו" מרעננים כשיש שינוי, ולפחות פעם ביום
    if (changes.length || Date.now() - last > 20 * 3600e3) { data.updated = nowIso(); dirty = true; }
    if (dirty) writeJson(PRODUCTS(), data);
    const byId = new Map(data.products.map(p => [String(p.id), p]));
    report.forEach(r => { const p = byId.get(r.id); if (p) { r.after = p.price; r.listPrice = p.listPrice ?? null; r.siteImage = p.image || null; r.active = p.active !== false; } });
    writeStatus('prices', { at: nowIso(), ok: true, checked: data.products.length, returned: details.size, changes: changes.slice(), items: report });
    return true; // תמיד שומרים את הדוח — גם משמש "דופק" שהבוט חי
  });
  if (changes.length) changes.forEach(c => log('  ' + c)); else log('המחירים לא השתנו.');
}

// ---------- find ----------
const STOP = new Set(['for', 'with', 'and', 'the', 'new', 'pro', 'mini', 'set', 'kit', 'pcs', 'professional', 'portable', 'original', 'upgraded', 'upgrade', '2023', '2024', '2025', '2026', '2027', 'hot', 'sale', 'usb', 'xlr', 'microphone', 'mic', 'speaker', 'speakers', 'headphones', 'headphone', 'headset', 'earphones', 'wireless', 'bluetooth', 'guitar', 'audio', 'studio', 'gaming', 'recording', 'condenser', 'dynamic', 'stand', 'rgb', 'led', 'light', 'video', 'camera', 'phone', 'controller', 'keyboard', 'type', 'c', 'type-c']);
const EXCL = /^(ps[1-5]|usb\d?|mp[34]|win\d+|ios\d*|bt\d+|v\d+(\.\d+)?|x\d+|[1-9]d|\d+in\d*|(dc|ac)\d+v|\d+(v|w|hz|khz|bit|k|mm|cm|m|pcs|ch|in|inch|db|ohm|mah|g|kg|x|d|p|keys?|ft))$/;
function modelKey(title) {
  const raw = String(title || '').toLowerCase().replace(/[^a-z0-9\- ]+/g, ' ');
  const w = raw.replace(/-/g, '').split(/\s+/).filter(x => x.length > 1 && !STOP.has(x));
  const brand = w[0] || '';
  const isModel = x => /[a-z]/.test(x) && /\d/.test(x) && x.length <= 9 && !EXCL.test(x);
  let model = w.slice(1).find(isModel);
  if (!model) { const m = raw.match(/\b(pro|max|plus|lite|mini|air|studio)\s+(\d{1,4})\b/); if (m) model = m[1] + m[2]; }
  return model ? brand + '|' + model : w.slice(0, 3).join(' ');
}
const JUNK = /\b(replacement|spare|repair|parts?|sticker|decal|cover only|case only|ear ?pads?|cushions?|cable only|adapter only|dummy|toy|kids?|children|glow stick|glow sticks|cheer|foam stick|wedding|costume|halloween|christmas)\b/i;
// מילים משמעותיות בכותרת — לזיהוי מוצרים כמעט זהים ממוכרים שונים (בלי מותג)
const words = t => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0; A.forEach(w => { if (B.has(w)) both++; });
  return both / Math.min(A.size, B.size) >= 0.6;
}
const brandOf = t => { const w = String(t || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-z][A-Za-z-]{2,}$/.test(w) && w === w.toUpperCase() ? w.toLowerCase() : ''; };
function relevant(title, kw) {
  const t = title.toLowerCase();
  const words = kw.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !/^\d/.test(w) && !['with', 'for', 'and'].includes(w));
  const hits = words.filter(w => t.includes(w.replace(/s$/, ''))).length;
  return words.length === 0 || hits >= Math.ceil(words.length * 0.6);
}

const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (title, w) => new RegExp('(^|[^a-z0-9])' + esc(w.toLowerCase()) + '(e?s)?($|[^a-z0-9])').test(title.toLowerCase());
// כללי הקטגוריה מ-keywords.json: מילה נדרשת (need), מילים פוסלות (not), טווח מחיר
function catRules(kwTree, niche, cat) { return ((kwTree || {})[niche] || {})[cat] || null; }
function fitsCategory(title, price, conf) {
  if (!conf) return true;
  if (JUNK.test(title)) return false;
  if (conf.need && conf.need.length && !conf.need.some(w => hasWord(title, w))) return false;
  if (conf.not && conf.not.some(w => hasWord(title, w))) return false;
  if (price && conf.min && price < conf.min * 0.9) return false;
  if (price && conf.max && price > conf.max * 1.1) return false;
  return true;
}

function pickKeywords(kwTree, state) {
  const all = [];
  for (const [niche, cats] of Object.entries(kwTree)) {
    if (niche.startsWith('_')) continue;
    for (const [cat, conf] of Object.entries(cats)) for (const kw of conf.kw) all.push({ niche, cat, kw, min: conf.min, max: conf.max });
  }
  const used = state.kw || {};
  // הכי פחות בשימוש לאחרונה קודם; גיוון — לא יותר משתי מילים מאותה קטגוריה בריצה
  all.sort((a, b) => ((used[a.kw] || {}).at || 0) - ((used[b.kw] || {}).at || 0) || Math.random() - 0.5);
  const picked = [], perCat = {};
  for (const k of all) {
    const key = k.niche + '/' + k.cat;
    if ((perCat[key] || 0) >= 2) continue;
    perCat[key] = (perCat[key] || 0) + 1;
    picked.push(k);
    if (picked.length >= CFG.keywordsPerRun) break;
  }
  return picked;
}

async function findProducts() {
  syncRepo();
  const kwTree = readJson(path.join(REPO, 'finder', 'keywords.json'), null);
  if (!kwTree) throw new Error('finder/keywords.json חסר או לא תקין');
  const state = readJson(STATE_FILE, { kw: {} });
  const picked = pickKeywords(kwTree, state);
  log(`מחפש ${picked.length} מילות חיפוש: ${picked.map(k => k.kw).join(' · ')}`);

  const found = []; // מועמדים גולמיים מהריצה הזו
  for (const k of picked) {
    const st = state.kw[k.kw] || { page: 0 };
    const page = (st.page % 3) + 1; // עמודים 1→2→3→1 כדי לקבל מוצרים אחרים בכל פעם
    try {
      const r = await api('aliexpress.affiliate.product.query', {
        keywords: k.kw, page_no: page, page_size: 50, sort: 'LAST_VOLUME_DESC',
        target_currency: 'ILS', target_language: 'EN', ship_to_country: 'IL', tracking_id: CFG.tracking,
        min_sale_price: k.min ? k.min * 100 : undefined, max_sale_price: k.max ? k.max * 100 : undefined,
      });
      const items = products(r);
      let ok = 0;
      for (const p of items) {
        const title = p.product_title || '';
        const c = {
          id: String(p.product_id), title, niche: k.niche, cat: k.cat, keyword: k.kw,
          price: bestPrice(p), listPrice: num(p.target_original_price), commission: commission(p),
          orders: num(p.lastest_volume), rating: num(p.evaluate_rate),
          image: p.product_main_image_url || '', link: p.promotion_link || '', url: p.product_detail_url || '',
        };
        if (!c.link || !c.price) continue;
        if (c.commission === null || c.commission < CFG.minCommission) continue;
        if ((c.orders || 0) < CFG.minOrders) continue;
        if (c.rating !== null && c.rating < CFG.minRating) continue;
        if (JUNK.test(title) || !relevant(title, k.kw)) continue;
        if (!fitsCategory(title, c.price, catRules(kwTree, k.niche, k.cat))) continue;
        c.model = modelKey(title);
        found.push(c); ok++;
      }
      log(`  "${k.kw}" עמוד ${page}: ${items.length} תוצאות, ${ok} עברו סינון`);
      state.kw[k.kw] = { page: items.length < 50 ? 0 : page, at: Date.now() };
    } catch (e) {
      if (e instanceof FatalApiError) throw e;
      log(`  "${k.kw}": שגיאה — ${e.message}`);
      state.kw[k.kw] = { page: st.page || 0, at: Date.now() };
    }
    await sleep(CFG.sleepMs);
  }
  if (!CFG.dryRun) writeJson(STATE_FILE, state);

  let added = [];
  await commitChange(['data/candidates.json', 'data/bot-status.json'], 'חיפוש מוצרים: מועמדים לאישור', () => {
    const site = readJson(PRODUCTS(), { products: [] });
    const cand = readJson(path.join(REPO, 'data', 'candidates.json'), { nextNum: 1, pending: [], rejected: [] });
    cand.pending = cand.pending || []; cand.rejected = cand.rejected || []; cand.nextNum = cand.nextNum || 1;

    const siteIds = new Set(site.products.map(p => String(p.id)));
    const siteModels = new Set(site.products.map(p => modelKey(p.name)));
    const rejIds = new Set(cand.rejected.map(r => String(r.id || r)));
    const rejModels = new Set(cand.rejected.map(r => r.model).filter(Boolean));
    // מנקים מהרשימה מוצרים שכבר נוספו לאתר
    cand.pending = cand.pending.filter(c => !siteIds.has(c.id) && !siteModels.has(c.model));
    // מוצרים ישנים ברשימה שכבר לא עומדים בכללי הקטגוריה — יוצאים
    const before = cand.pending.length;
    cand.pending = cand.pending.filter(c => fitsCategory(c.title, c.price, catRules(kwTree, c.niche, c.cat)));
    if (cand.pending.length < before) log(`ניקיתי ${before - cand.pending.length} מוצרים לא רלוונטיים מהרשימה`);
    const takenIds = new Set(cand.pending.map(c => c.id));
    const takenModels = new Set(cand.pending.map(c => c.model));
    const perCat = {};
    cand.pending.forEach(c => { const k = c.niche + '/' + c.cat; perCat[k] = (perCat[k] || 0) + 1; });

    // ציון: הרבה הזמנות + עמלה טובה + דירוג גבוה
    const score = c => Math.log10((c.orders || 1) + 1) * 10 + (c.commission || 0) * 0.8 + ((c.rating || 90) - 90);
    found.sort((a, b) => score(b) - score(a));
    added = [];
    for (const c of found) {
      const k = c.niche + '/' + c.cat;
      if (siteIds.has(c.id) || rejIds.has(c.id) || takenIds.has(c.id)) continue;
      if (siteModels.has(c.model) || rejModels.has(c.model) || takenModels.has(c.model)) continue;
      // גיוון: מוצר כמעט זהה או אותו מותג באותה קטגוריה — פעם אחת בלבד
      const sameCat = cand.pending.filter(x => x.niche === c.niche && x.cat === c.cat);
      if (sameCat.some(x => similar(x.title, c.title))) continue;
      const br = brandOf(c.title);
      if (br && sameCat.some(x => brandOf(x.title) === br)) continue;
      if (site.products.some(p => p.cat === c.cat && similar(p.name, c.title))) continue;
      if ((perCat[k] || 0) >= CFG.perCat) continue;
      perCat[k] = (perCat[k] || 0) + 1;
      takenIds.add(c.id); takenModels.add(c.model);
      const entry = {
        num: cand.nextNum++, id: c.id, title: c.title, niche: c.niche, cat: c.cat,
        price: Math.round(c.price), listPrice: c.listPrice && c.listPrice > c.price * 1.05 ? Math.round(c.listPrice) : undefined,
        commission: c.commission, orders: c.orders, rating: c.rating, image: c.image, link: c.link, url: c.url,
        keyword: c.keyword, model: c.model, found: nowIso(),
      };
      cand.pending.push(entry); added.push(entry);
    }
    // מגבלת גודל: שומרים את הטובים ביותר
    if (cand.pending.length > CFG.maxPending) cand.pending = cand.pending.sort((a, b) => score(b) - score(a)).slice(0, CFG.maxPending);
    cand.pending.sort((a, b) => a.niche.localeCompare(b.niche) || a.cat.localeCompare(b.cat) || b.num - a.num);
    cand.updated = nowIso();
    writeJson(path.join(REPO, 'data', 'candidates.json'), cand);
    writeStatus('find', { at: nowIso(), ok: true, keywords: picked.map(k => k.kw), rawMatches: found.length, added: added.map(c => c.num), pending: cand.pending.length });
    return true;
  });
  log(added.length ? `🆕 ${added.length} מועמדים חדשים:` : 'לא נמצאו מועמדים חדשים בריצה הזו.');
  added.forEach(c => log(`  #${c.num} [${c.niche}/${c.cat}] ₪${c.price} · ${c.orders} הזמנות · ${c.commission}% · ${c.title.slice(0, 70)}`));
}

// ---------- publish: מוסיף לאתר לבד את המועמדים הטובים ביותר ----------
// כל מוצר נבדק שוב מול ה-API לפני שהוא עולה: קיים, יש מחיר, יש קישור Affiliate ויש עמלה.
const FEATURES = [
  [/\b2\.4 ?g(hz)?\b/i, 'חיבור אלחוטי 2.4GHz'], [/bluetooth|\bbt ?5/i, 'Bluetooth'],
  [/\b(usb[- ]?c|type[- ]?c)\b/i, 'חיבור USB-C'], [/\bxlr\b/i, 'חיבור XLR'],
  [/\b4k\b/i, 'תומך בתוכן 4K', ['projector'], 'res'], [/\b1080p|full ?hd/i, 'תומך Full HD', ['projector'], 'res'],
  [/\b8k\b/i, 'רזולוציית 8K', null, 'res'], [/\b4k\b/i, 'רזולוציית 4K', null, 'res'], [/\b2k\b|1440p/i, 'רזולוציית 2K', null, 'res'], [/1080p|full ?hd/i, 'Full HD', null, 'res'],
  [/\b(1[2-9]\d|2[0-4]\d)\s?hz\b/i, m => `קצב רענון ${m[1]}Hz`, ['display']],
  [/(\d{3,5}) ?(ansi )?lumens?/i, m => `בהירות ${m[1]} לומן`, ['projector']],
  [/android/i, 'מערכת Android מובנית', ['projector']], [/auto ?(focus|keystone)/i, 'פוקוס ויישור תמונה אוטומטיים', ['projector']],
  [/(?<![\d.])(\d{1,3}(?:\.\d+)?) ?(inch|")/i, m => `${m[1]} אינץ'`, ['display', 'projector', 'screen-acc']],
  [/(\d+) ?(tb|gb)\b/i, m => `נפח ${m[1]}${m[2].toUpperCase()}`, ['editing']],
  [/(\d{2,3}) ?keys?\b/i, m => `${m[1]} קלידים`, ['midi']], [/(\d{1,2}) ?pads?\b/i, m => `${m[1]} פדים`, ['midi']],
  [/(\d) ?-?channels?\b/i, m => `${m[1]} ערוצים`, ['mixer', 'interface', 'dj-controller']],
  [/noise (cancel|reduc)|\banc\b/i, 'סינון רעשים'], [/7\.1/, 'סראונד 7.1'],
  [/cardioid/i, 'קליטה כיוונית'], [/condenser/i, 'מיקרופון קונדנסר'], [/dynamic/i, 'מיקרופון דינמי'],
  [/phantom|48v/i, 'פנטום 48V'], [/\bmute\b/i, 'כפתור השתקה'], [/monitoring|zero latency|headphone (jack|output)/i, 'האזנה בזמן אמת'],
  [/serato|rekordbox|virtual ?dj|djay/i, 'תואם תוכנות DJ'], [/jog ?wheel/i, 'גלגלי Jog'],
  [/sound activated|music activated|voice control/i, 'מגיב למוזיקה'], [/\bdmx\b/i, 'שליטת DMX'],
  [/\brgb\b/i, 'תאורת RGB'], [/dimm(able|ing)|stepless/i, 'עוצמה מתכווננת'], [/cri ?9\d/i, 'צבעים נאמנים (CRI 95+)'],
  [/auto ?focus/i, 'פוקוס אוטומטי'], [/(ai|face|auto) tracking/i, 'מעקב אוטומטי אחרי הפנים'], [/gesture/i, 'שליטה בתנועות יד'],
  [/stabiliz|\beis\b|gimbal/i, 'ייצוב תמונה'], [/waterproof|ipx\d/i, 'עמיד במים'], [/remote/i, 'שלט רחוק'],
  [/mechanical/i, 'מקלדת מכנית'], [/hot[- ]?swap/i, 'מתגים מתחלפים'], [/\bips\b/i, 'פאנל IPS'], [/\bhdr\b/i, 'HDR'],
  [/touch ?screen|touchscreen/i, 'מסך מגע'], [/magnetic/i, 'הצמדה מגנטית'], [/fold(able|ing)/i, 'מתקפל'],
  [/alumin(um|ium)|metal/i, 'גוף מתכת'], [/rechargeable|\d{3,5} ?mah/i, 'סוללה נטענת'],
  [/plug ?(and|&|n) ?play/i, 'Plug & Play'], [/ps5|ps4|xbox|nintendo|switch/i, 'תואם קונסולות'],
  [/iphone|\bios\b/i, 'תואם iPhone'],
];
function hebrewFeatures(title, cat) {
  const out = [];
  const groups = new Set();
  for (const [re, label, cats, group] of FEATURES) {
    if (cats && !cats.includes(cat)) continue;
    if (group && groups.has(group)) continue;
    const m = title.match(re);
    if (!m) continue;
    const l = typeof label === 'function' ? label(m) : label;
    if (!out.includes(l)) out.push(l);
    if (group) groups.add(group);
    if (out.length >= 4) break;
  }
  return out;
}
function cleanName(title) {
  let t = String(title || '').replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ').split(/[,，|;]/)[0].replace(/\s+/g, ' ').trim();
  const words = t.split(' '), out = [];
  for (const w of words) {
    if (out.length >= 3 && /^(for|with|compatible|suitable)$/i.test(w)) break;
    out.push(w);
    if (out.join(' ').length > 42) break;
  }
  return out.join(' ').replace(/(\s+\d+)+$/, '').replace(/[-–:\s]+$/, '');
}
function soldLabel(n) {
  if (!n) return '';
  if (n < 100) return `${n} מכירות`;
  const d = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return `${(Math.floor(n / d) * d).toLocaleString('en-US')}+ מכירות`;
}
const todayIL = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

async function publishProducts(kwTree) {
  if (!(CFG.autoPerDay > 0)) return;
  const state = readJson(STATE_FILE, { kw: {} });
  const day = todayIL();
  const already = (state.published || {})[day] || 0;
  const quota = CFG.autoPerDay - already;
  if (quota <= 0) { log(`כבר נוספו היום ${already} מוצרים לאתר — ממשיך מחר.`); return; }

  syncRepo();
  const site = readJson(PRODUCTS(), { products: [], categories: {} });
  const cand = readJson(path.join(REPO, 'data', 'candidates.json'), { pending: [] });
  const count = {};
  site.products.filter(p => p.active !== false).forEach(p => (p.niches || []).forEach(n => { const k = n + '/' + p.cat; count[k] = (count[k] || 0) + 1; }));
  // עדיפות לקטגוריות שעדיין ריקות באתר, ואחר כך הזמנות, עמלה ודירוג
  const score = c => Math.log10((c.orders || 1) + 1) * 10 + (c.commission || 0) - (count[c.niche + '/' + c.cat] || 0) * 6 + ((c.rating || 95) - 95);
  const eligible = (cand.pending || [])
    .filter(c => (c.orders || 0) >= CFG.publishMinOrders && (c.rating || 0) >= CFG.publishMinRating && (c.commission || 0) >= CFG.minCommission && c.link)
    .filter(c => fitsCategory(c.title, c.price, catRules(kwTree, c.niche, c.cat)))
    .filter(c => !site.products.some(p => String(p.id) === c.id || (p.cat === c.cat && similar(p.name, c.title))))
    .sort((a, b) => score(b) - score(a));
  // גיוון: מוצר אחד לכל קטגוריה, ועדיפות לתחומים שונים
  const picks = [], usedCats = new Set(), usedNiches = new Set();
  for (const pass of [0, 1]) for (const c of eligible) {
    if (picks.length >= quota * 3) break;
    const k = c.niche + '/' + c.cat;
    if (picks.includes(c) || usedCats.has(k) || (pass === 0 && usedNiches.has(c.niche))) continue;
    picks.push(c); usedCats.add(k); usedNiches.add(c.niche);
  }
  if (!picks.length) { log('אין כרגע מועמדים שעומדים בכל התנאים להוספה אוטומטית.'); return; }

  // בדיקה חוזרת מול AliExpress — רק מה שבאמת קיים עם קישור ועמלה עולה לאתר
  const details = await fetchDetails(picks.map(c => c.id));
  const ready = [];
  for (const c of picks) {
    const d = details.get(c.id);
    if (!d) { log(`  דילגתי (לא נמצא ב-API): ${c.title.slice(0, 60)}`); continue; }
    const price = bestPrice(d), cr = commission(d) ?? c.commission, link = d.promotion_link || c.link;
    if (!price || !link || !/^https:\/\/s\.click\.aliexpress\.com\//.test(link) || !(cr >= CFG.minCommission)) { log(`  דילגתי (אין מחיר/קישור/עמלה): ${c.title.slice(0, 60)}`); continue; }
    const conf = catRules(kwTree, c.niche, c.cat) || {};
    const title = d.product_title && similar(d.product_title, c.title) ? d.product_title : c.title;
    const feats = hebrewFeatures(title, c.cat);
    const lp = num(d.target_original_price);
    ready.push({
      id: c.id, name: cleanName(title), short: cleanName(title).split(' ').slice(0, 3).join(' '),
      cat: c.cat, niches: [c.niche], tag: conf.tag || (site.categories[c.cat] || {}).name || '',
      icon: (site.categories[c.cat] || {}).icon || '📦',
      badge: c.orders >= 1000 ? `🔥 ${soldLabel(c.orders)}` : '✨ חדש באתר',
      desc: (conf.pitch || '') + (feats.length ? ` כולל: ${feats.join(', ')}.` : ''),
      positive: c.rating ? Math.round(c.rating) : undefined, sold: soldLabel(c.orders),
      price: Math.round(price), ...(lp && lp > price * 1.05 ? { listPrice: Math.round(lp) } : {}),
      commission: cr, freeShip: true, image: d.product_main_image_url || c.image || '', link,
      active: true, auto: true, added: day,
    });
    if (ready.length >= quota) break;
  }
  if (!ready.length) { log('לא נמצא מוצר שעבר את הבדיקה החוזרת.'); return; }

  await commitChange(['data/products.json', 'data/candidates.json', 'data/bot-status.json'], `הוספה אוטומטית: ${ready.map(r => r.short).join(', ')}`, () => {
    const data = readJson(PRODUCTS(), null);
    const cd = readJson(path.join(REPO, 'data', 'candidates.json'), { pending: [] });
    const fresh = ready.filter(r => !data.products.some(p => String(p.id) === r.id));
    if (!fresh.length) return false;
    data.products.push(...fresh);
    data.updated = nowIso();
    cd.pending = (cd.pending || []).filter(c => !fresh.some(r => r.id === c.id));
    writeJson(PRODUCTS(), data);
    writeJson(path.join(REPO, 'data', 'candidates.json'), cd);
    writeStatus('publish', { at: nowIso(), ok: true, added: fresh.map(r => ({ id: r.id, name: r.name, niche: r.niches[0], cat: r.cat, price: r.price, commission: r.commission })) });
    return true;
  });
  state.published = state.published || {};
  state.published[day] = already + ready.length;
  Object.keys(state.published).sort().slice(0, -40).forEach(k => delete state.published[k]);
  if (!CFG.dryRun) writeJson(STATE_FILE, state);
  log(`🟢 נוספו לאתר ${ready.length} מוצרים:`);
  ready.forEach(r => log(`  [${r.niches[0]}/${r.cat}] ₪${r.price} · ${r.commission}% · ${r.name}`));
}

// ---------- test ----------
async function selfTest() {
  let ok = true;
  for (const k of ['ALI_APP_KEY', 'ALI_APP_SECRET', 'ALI_TRACKING_ID']) if (!E[k]) { log(`❌ חסר ${k} בקובץ ${ENV_FILE}`); ok = false; }
  if (!CFG.token && !CFG.sshKey) { log('❌ חסר חיבור ל-GitHub (מפתח או טוקן)'); ok = false; }
  if (!ok) return false;
  try {
    const r = await api('aliexpress.affiliate.product.query', { keywords: 'usb microphone', page_no: 1, page_size: 5, target_currency: 'ILS', target_language: 'EN', ship_to_country: 'IL', tracking_id: CFG.tracking });
    log(`✅ AliExpress API עובד (${products(r).length} תוצאות לדוגמה)`);
  } catch (e) {
    const m = String(e.message);
    if (/tracking/i.test(m)) log('❌ AliExpress: ה-Tracking ID לא נכון. צריך להעתיק אותו בדיוק כמו שהוא מופיע בפורטלים, בעמוד Tracking ID.');
    else if (/sign|appkey|app key|InvalidApp/i.test(m)) log('❌ AliExpress: ה-App Key או ה-App Secret לא נכונים.');
    else log('❌ AliExpress API:', m);
    ok = false;
  }
  try {
    if (CFG.token && !CFG.sshKey) {
    const r = await fetch(`https://api.github.com/repos/${CFG.repo}`, { headers: { Authorization: 'Bearer ' + CFG.token, 'User-Agent': 'dibi-finder' }, signal: AbortSignal.timeout(20000) });
    if (r.status === 401) { log('❌ GitHub: הטוקן לא תקין — כנראה לא הועתק שלם, או שנמחק. צריך ליצור טוקן חדש.'); return false; }
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.permissions && !j.permissions.push) { log(`❌ GitHub: לטוקן אין הרשאת כתיבה. בהגדרות הטוקן צריך Contents: Read and write, ולבחור את ${CFG.repo}.`); return false; }
    }
  } catch (_) { /* בדיקה משלימה בלבד */ }
  try {
    syncRepo();
    git(['push', '--dry-run', '--quiet', 'origin', 'HEAD:' + CFG.branch]);
    log('✅ GitHub: יש הרשאת כתיבה ל-' + CFG.repo);
  } catch (e) {
    const m = String(e.stderr || e.message);
    if (CFG.sshKey && /Permission denied|denied to deploy key|publickey|read-only|not allowed/i.test(m)) log('❌ GitHub: המפתח עוד לא נוסף, או שלא סומן Allow write access. מוסיפים אותו ב-github.com/' + CFG.repo + '/settings/keys');
    else log('❌ GitHub:', m.split('\n').filter(Boolean).slice(-1)[0]);
    ok = false;
  }
  return ok;
}

// ---------- main ----------
(async () => {
  const cmd = process.argv[2] || 'all';
  const lock = path.join(HOME, '.finder.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch (_) {
    const pid = +fs.readFileSync(lock, 'utf8');
    let alive = false; try { process.kill(pid, 0); alive = true; } catch (_) {}
    if (alive) { log('ריצה אחרת עדיין פעילה — יוצא.'); return; }
    fs.writeFileSync(lock, String(process.pid));
  }
  try {
    if (cmd === 'test') process.exitCode = (await selfTest()) ? 0 : 1;
    else {
      if (!CFG.key || !CFG.secret || !CFG.tracking) throw new Error(`חסרים מפתחות בקובץ ${ENV_FILE} — הריצו שוב את install.sh`);
      if (cmd === 'prices' || cmd === 'all') { try { await updatePrices(); } catch (e) { log('❌ מחירים:', e.message); await reportFailure('prices', e.message); process.exitCode = 1; } }
      if (cmd === 'find' || cmd === 'all') { try { await findProducts(); } catch (e) { log('❌ חיפוש:', e.message); await reportFailure('find', e.message); process.exitCode = 1; } }
      if (cmd === 'find' || cmd === 'all' || cmd === 'publish') {
        try { await publishProducts(readJson(path.join(REPO, 'finder', 'keywords.json'), {})); }
        catch (e) { log('❌ הוספה לאתר:', e.message); await reportFailure('publish', e.message); process.exitCode = 1; }
      }
      if (!['prices', 'find', 'all', 'publish'].includes(cmd)) log('פקודות: prices | find | publish | all | test');
    }
  } catch (e) {
    log('❌', e.message);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(lock); } catch (_) {}
  }
})();
