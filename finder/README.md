# dibi finder

בוט שרץ על שרת ה-Vultr ומעדכן את האתר דרך GitHub (Netlify מפרסם אוטומטית).

| מה | מתי | קובץ |
|---|---|---|
| עדכון מחירים, תמונות ועמלות לכל מוצרי האתר | כל 6 שעות | `data/products.json` |
| חיפוש מוצרים חדשים לפי `finder/keywords.json` | פעם ביום | `data/candidates.json` |

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
