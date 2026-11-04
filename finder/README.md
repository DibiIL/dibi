# dibi finder

בוט שרץ על שרת ה-Vultr ומעדכן את האתר דרך GitHub (Netlify מפרסם אוטומטית).

| מה | מתי | קובץ |
|---|---|---|
| עדכון מחירים, תמונות ועמלות לכל מוצרי האתר | כל 6 שעות | `data/products.json` |
| חיפוש מוצרים חדשים לפי `finder/keywords.json` | פעם ביום | `data/candidates.json` |
| הוספה אוטומטית לאתר של 3 המועמדים הטובים (אחרי בדיקה חוזרת מול ה-API) | פעם ביום, אחרי החיפוש | `data/products.json` |

**כללי הוספה אוטומטית:** קישור Affiliate של `s.click.aliexpress.com` עם ה-Tracking ID של האתר, עמלה של 5% לפחות,
200 הזמנות לפחות, 95% חוות דעת חיוביות לפחות, ושם שמתאים לכללי הקטגוריה (`need`/`not` ב-keywords.json).
מוצר אחד לכל קטגוריה ביום, עדיפות לקטגוריות שעדיין ריקות. המספר נשלט ב-`AUTO_ADD_PER_DAY` ב-.env (0 = רק רשימת אישור).
מוצרים שנוספו לבד מסומנים `auto: true`, והתיאור שלהם נבנה מתבנית (`pitch` + תכונות מהשם).

**התקנה / עדכון מפתחות** (בקונסול של Vultr):
```
bash <(curl -fsSL https://raw.githubusercontent.com/DibiIL/dibi/main/finder/install.sh)
```
המפתחות נשמרים רק בשרת, ב-`~/dibi-finder/.env`. הלוג: `tail -n 40 ~/dibi-finder/finder.log`.

## אישור מוצרים
1. נכנסים ל-`dibi.co.il/review.html`, מסמנים מוצרים ולוחצים "העתק בחירה".
2. מדביקים ל-Claude. Claude:
   - מעביר כל מוצר שנבחר מ-`pending` אל `products` ב-`data/products.json`
     (id, name, short, cat, niches, tag, icon, badge, desc בעברית, rating 0-5, sold, price, listPrice, image, link, active:true, added).
   - מוסיף ל-`rejected` (עם `id` ו-`model`) מוצרים שהמשתמש אמר שלא רוצה, כדי שהבוט לא יציע אותם שוב.
   - דוחף ל-main.

## מבנה `products.json`
- `niches[]` — תחומים (טאבים באתר), כל אחד עם רשימת `cats` לפי סדר תצוגה.
- `categories{}` — שם ואימוג'י לכל קטגוריה.
- `products[]` — מוצר יכול להופיע בכמה תחומים (`niches`). `active:false` מסתיר אותו.
  הבוט מסתיר לבד מוצר שלא חוזר מה-API שלוש בדיקות ברצף (`autoHidden`), ומחזיר אותו כשהוא חוזר.
