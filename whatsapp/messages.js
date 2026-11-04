'use strict';
/*
 * dibi — כתיבת הודעות דיל לקבוצת הוואטסאפ.
 * ההודעה מותאמת לשעה, ליום בשבוע, לחגים ולמבצעי AliExpress, עם טון רשמי אבל אנושי ומעט אימוג'ים.
 *
 *   const { compose } = require('./messages');
 *   compose(product, new Date(), state)  →  { text, kind }  או  null כשלא שולחים (למשל ביום הזיכרון)
 *
 * product = מוצר מ-data/products.json, עם waLink (קישור עם ה-Tracking ID של וואטסאפ).
 */

const TZ = 'Asia/Jerusalem';
const pick = (arr, avoid) => {
  const pool = arr.length > 1 && avoid ? arr.filter(x => x !== avoid) : arr;
  return pool[Math.floor(Math.random() * pool.length)];
};

// ---------- זמן ----------
function local(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23', day: 'numeric', month: 'numeric',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { hour: +parts.hour, weekday: parts.weekday, day: +parts.day, month: +parts.month };
}
function hebrewDate(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: TZ, day: 'numeric', month: 'long' })
    .formatToParts(date).map(x => [x.type, x.value]));
  return { day: +p.day, month: p.month };
}

// ---------- ימים מיוחדים ----------
// silent = לא שולחים דילים ביום הזה
function specialDay(date) {
  const h = hebrewDate(date), g = local(date);
  const wd = g.weekday;
  const is = (m, d) => h.month === m && h.day === d;
  const isAdarPurim = (h.month === 'Adar' || h.month === 'Adar II') && h.day === 14;

  // ימי אבל וזיכרון
  if (is('Tishri', 10)) return { silent: true, name: 'יום כיפור' };
  if (is('Av', 9)) return { silent: true, name: 'תשעה באב' };
  if (h.month === 'Nisan' && (h.day === 27 || (h.day === 26 && wd === 'Thu') || (h.day === 28 && wd === 'Mon'))) return { silent: true, name: 'יום השואה' };
  // יום הזיכרון ויום העצמאות (כולל ההזזות כשהם נופלים ליד שבת)
  if (h.month === 'Iyar') {
    const ind = (d, w) => (d === 5 && ['Tue', 'Wed', 'Thu'].includes(w)) || (d === 4 && w === 'Thu') || (d === 3 && w === 'Thu') || (d === 6 && w === 'Tue');
    if (ind(h.day + 1, nextWeekday(wd))) return { silent: true, name: 'יום הזיכרון' };
    if (ind(h.day, wd)) return { key: 'independence', title: '🇮🇱 דיל של יום העצמאות', line: 'חג עצמאות שמח! לכבוד היום בחרנו משהו מיוחד.' };
  }

  // חגים
  if (is('Tishri', 1) || is('Tishri', 2) || (h.month === 'Elul' && h.day >= 25)) return { key: 'rosh', title: '🍯 דיל לראש השנה', line: 'שנה טובה ומתוקה! לקראת השנה החדשה — ציוד לפרויקטים החדשים.' };
  if (h.month === 'Tishri' && h.day >= 15 && h.day <= 22) return { key: 'sukkot', title: '🌿 דיל של חול המועד', line: 'חג שמח! זמן פנוי בחג הוא זמן מצוין להתחיל משהו חדש.' };
  if ((h.month === 'Kislev' && h.day >= 25) || (h.month === 'Tevet' && h.day <= 2)) return { key: 'hanukkah', title: '🕎 דיל של חנוכה', line: 'חג אורים שמח! אם עוד מחפשים מתנה לחנוכה — הנה רעיון.' };
  if (isAdarPurim) return { key: 'purim', title: '🎭 דיל של פורים', line: 'פורים שמח! משלוח מנות קצת אחר השנה?' };
  if (h.month === 'Nisan' && h.day >= 14 && h.day <= 21) return { key: 'pesach', title: '🌸 דיל של פסח', line: 'חג פסח שמח! חופשת החג היא הזמן לשדרג את הציוד.' };
  if (is('Sivan', 6)) return { key: 'shavuot', title: '🌾 דיל של שבועות', line: 'חג שבועות שמח!' };

  // מבצעי AliExpress ותאריכי קניות
  if (g.month === 11 && g.day === 11) return { key: '1111', title: '🛍️ 11.11 ב-AliExpress', line: 'היום יום ההנחות הגדול של AliExpress — שווה לבדוק קופונים בעמוד המוצר.' };
  if (g.month === 11 && g.day >= 9 && g.day <= 10) return { key: 'pre1111', title: '🛍️ לקראת 11.11', line: 'בעוד כמה ימים מגיע 11.11 — יום ההנחות הגדול של AliExpress. כדאי לשים את זה ברשימה.' };
  if (isBlackFriday(date)) return { key: 'bf', title: '🖤 דיל של בלאק פריידי', line: 'בלאק פריידי ב-AliExpress — המחירים זזים מהר היום.' };
  if (g.month === 3 && g.day >= 26 && g.day <= 28) return { key: 'anniv', title: '🎉 מבצע יום ההולדת של AliExpress', line: 'AliExpress חוגגים יום הולדת, ובדרך כלל זה מגיע עם הנחות טובות.' };
  return null;
}
function nextWeekday(w) { const d = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; return d[(d.indexOf(w) + 1) % 7]; }
function isBlackFriday(date) {
  const g = local(date);
  if (g.month !== 11 || g.weekday !== 'Fri') return false;
  return g.day >= 23 && g.day <= 29; // יום שישי הרביעי של נובמבר
}

// ---------- כותרת לפי שעה ויום ----------
function slot(date) {
  const { hour, weekday } = local(date);
  if (weekday === 'Fri' && hour >= 12) return { key: 'fri', titles: ['☀️ דיל לסופ״ש', '☀️ לקראת השבת — דיל אחד שווה'], line: ['סופ״ש מתחיל, ובשבילנו זה זמן לבדוק ציוד חדש.', 'לפני שמתנתקים לסופ״ש — משהו קטן שווה בדיקה.'] };
  if (weekday === 'Sat' && hour >= 18) return { key: 'motsash', titles: ['🌙 מוצאי שבת עם דיל', '🌙 שבוע טוב!'], line: ['שבוע טוב לכולם! פותחים אותו עם דיל אחד שבחרנו.', 'שבוע טוב! לפני שמתחילים — הנה משהו ששווה לראות.'] };
  if (weekday === 'Sun' && hour < 12) return { key: 'sun', titles: ['☕ פותחים שבוע', '☕ בוקר של יום ראשון'], line: ['בוקר טוב ושבוע מוצלח! הדיל הראשון של השבוע:', 'שבוע חדש, ציוד חדש? הנה הצעה טובה להתחלה.'] };
  if (hour >= 6 && hour < 11) return { key: 'morning', titles: ['☕ דיל של בוקר', '☀️ בוקר טוב עם דיל'], line: ['בוקר טוב! עם הקפה הראשון — הנה מה שמצאנו היום.', 'בוקר טוב לכולם. דיל אחד, קצר ולעניין:'] };
  if (hour >= 11 && hour < 14) return { key: 'noon', titles: ['🕛 דיל של צהריים', '🥪 הפסקת צהריים עם דיל'], line: ['הפסקת צהריים? זה זמן טוב להציץ.', 'באמצע היום, משהו ששווה כמה שניות:'] };
  if (hour >= 14 && hour < 19) return { key: 'afternoon', titles: ['🌇 דיל של אחה״צ', '🌤️ אחה״צ טובים'], line: ['אחר הצהריים טובים! הנה הדיל של השעה:', 'מסיימים את היום? הנה משהו שבחרנו בשבילכם.'] };
  if (hour >= 19 && hour < 23) return { key: 'evening', titles: ['🌆 דיל של ערב', '🌆 ערב טוב'], line: ['ערב טוב! עכשיו, כשיש רגע לנשום — הדיל של הערב:', 'ערב טוב לכולם. זה הדיל שבחרנו להערב:'] };
  return { key: 'night', titles: ['🌙 דיל של לילה', '🌙 לינשופי הלילה'], line: ['לכל מי שעוד ער — הנה משהו ששווה לראות.', 'מאוחר, אבל דיל טוב לא מחכה לבוקר:'] };
}

// ---------- משפט פתיחה לפי סוג המוצר ----------
const INTROS = {
  mic: ['מי שמקליט מהבית יודע: חצי מהסאונד זה המיקרופון.', 'קול נקי עושה את כל ההבדל — בפודקאסט, בשיר ובשידור.'],
  'wireless-mic': ['לצלם בטלפון ולהישמע כמו באולפן? זה מתחיל במיקרופון.', 'לסרטונים, לראיונות וללייבים — סאונד ברור בלי כבלים.'],
  'mic-arm': ['שולחן מסודר ומיקרופון בגובה הנכון — שדרוג קטן שמרגישים כל יום.'],
  interface: ['רוצים להקליט בבית באיכות של אולפן? הכול מתחיל בממשק טוב.'],
  midi: ['לרעיון שעולה באמצע הלילה צריך משהו לנגן עליו.', 'למפיקים ולביטמייקרים — כלי שמזרז את העבודה.'],
  monitor: ['מיקס טוב מתחיל בשמיעה מדויקת.'],
  headphones: ['אוזניות טובות הן כלי עבודה, לא רק אביזר.'],
  'gaming-headset': ['לשמוע כל צעד במשחק ולדבר עם הקבוצה בבירור.'],
  mixer: ['כמה מקורות סאונד, שליטה אחת מסודרת.'],
  soundcard: ['לשידור חי עם אפקטים בלי להסתבך.'],
  guitar: ['לגיטריסטים בינינו — משהו לחזרות ולהופעות.'],
  'dj-controller': ['לסטים בבית, לאירועים ולמי שרוצה להתחיל לתקלט.'],
  turntable: ['יש משהו בסאונד של ויניל שאי אפשר להחליף.'],
  'dj-lights': ['תאורה נכונה הופכת סט רגיל להופעה.'],
  'dj-acc': ['לדיג׳ייז שזזים הרבה — סדר ונוחות בעמדה.'],
  capture: ['לשדר מהמצלמה או מהקונסולה ישר למחשב.'],
  editing: ['עריכה מהירה יותר = יותר זמן ליצור.'],
  lighting: ['תאורה טובה משדרגת כל צילום, גם בטלפון.'],
  tripod: ['צילום יציב הוא צילום שנראה מקצועי.'],
  camera: ['לשיחות, לשיעורים ולסטרימינג — תמונה חדה שמכבדת אותך.'],
  'action-cam': ['לטיולים, לספורט ולוולוגים — מצלמה שהולכת איתך לכל מקום.'],
  lens: ['זווית חדשה לצילום בלי להחליף טלפון.'],
  'creator-gear': ['ליוצרי תוכן — סטודיו קטן ומסודר בבית.'],
  projector: ['מסך ענק לסרטים ולמשחקים, על כל קיר בבית.'],
  display: ['עוד מסך = יותר מקום לעבוד, לערוך ולשחק.'],
  'screen-acc': ['עמדת עבודה נוחה מתחילה במסך בגובה הנכון.'],
  desk: ['עמדה מסודרת היא עמדה שנעים לשבת מולה.'],
};
const CLOSINGS = [
  'עוד ציוד נבחר מחכה באתר: dibi.co.il',
  'שאלות על המוצר? אפשר לכתוב לנו כאן בקבוצה.',
  'המחיר נבדק מול AliExpress לפני השליחה, ועשוי להשתנות.',
  'כל הדילים שלנו מרוכזים ב-dibi.co.il',
  'שווה לבדוק בעמוד המוצר אם יש קופון נוסף.',
];

const fmt = n => '₪' + Math.round(n).toLocaleString('en-US');
const firstSentence = t => String(t || '').split(/(?<=[.!?])\s|—/)[0].trim().replace(/\s*[—-]\s*$/, '');

function compose(p, date = new Date(), state = {}) {
  const sp = specialDay(date);
  if (sp && sp.silent) return null;
  const s = slot(date);
  const title = sp ? sp.title : pick(s.titles, state.lastTitle);
  const opener = sp ? sp.line : pick(s.line, state.lastOpener);
  const intro = pick(INTROS[p.cat] || ['בחרנו בשבילכם משהו ששווה לראות.'], state.lastIntro);
  const closing = pick(CLOSINGS, state.lastClosing);

  const proof = [];
  if (p.rating) proof.push(`דירוג ${p.rating}`);
  else if (p.positive) proof.push(`${p.positive}% חוות דעת חיוביות`);
  const sold = String(p.sold || '').replace(/[()]/g, '');
  if (sold) proof.push(sold);

  const lines = [
    `*${title}*`,
    '',
    opener,
    '',
    `*${p.name}*`,
    `${intro} ${firstSentence(p.desc)}.`.replace(/\.\.$/, '.'),
    '',
    `💰 *${fmt(p.price)}*${p.freeShip !== false ? ' · משלוח חינם לישראל' : ''}`,
    proof.length ? `⭐ ${proof.join(' · ')}` : null,
    '',
    `🔗 ${p.waLink || p.link}`,
    '',
    `_${closing}_`,
  ].filter(l => l !== null);

  // לא להשאיר שתי שורות ריקות ברצף
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return {
    text, kind: sp ? sp.key : s.key,
    state: { lastTitle: title, lastOpener: opener, lastIntro: intro, lastClosing: closing },
  };
}

module.exports = { compose, specialDay, slot, hebrewDate };

// הדגמה: node messages.js  → מדפיס הודעות לדוגמה משעות וימים שונים
if (require.main === module) {
  const data = require('../data/products.json');
  const prods = data.products.filter(p => p.active !== false);
  const when = ['2026-11-04T16:00:00Z', '2026-11-05T06:30:00Z', '2026-11-06T11:00:00Z', '2026-11-07T17:30:00Z', '2026-11-11T09:00:00Z', '2026-12-06T18:00:00Z'];
  let st = {};
  when.forEach((w, i) => {
    const m = compose(prods[(i * 5) % prods.length], new Date(w), st);
    st = m ? m.state : st;
    console.log(`\n===== ${new Date(w).toLocaleString('he-IL', { timeZone: TZ })} =====\n` + (m ? m.text : '(לא שולחים היום)'));
  });
}
