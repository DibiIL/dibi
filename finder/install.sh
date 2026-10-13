#!/usr/bin/env bash
# dibi finder — התקנה על השרת (Vultr). מריצים פקודה אחת:
#   bash <(curl -fsSL https://raw.githubusercontent.com/DibiIL/dibi/main/finder/install.sh)
set -e
DIR="$HOME/dibi-finder"
REPO_URL="https://github.com/DibiIL/dibi.git"
G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; N='\033[0m'
say(){ echo -e "${G}▶${N} $*"; }

echo -e "\n${G}=== dibi finder — התקנה ===${N}\n"

# 1. node + git
if ! command -v git >/dev/null 2>&1; then say "מתקין git…"; (apt-get update -qq && apt-get install -y -qq git) >/dev/null; fi
NODE="$(command -v node || true)"
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  say "מתקין Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  NODE="$(command -v node)"
fi
say "Node $("$NODE" -v) · $(git --version)"

# 2. קבצים
mkdir -p "$DIR"
if [ -d "$DIR/repo/.git" ]; then say "מעדכן את העותק של האתר…"; git -C "$DIR/repo" fetch -q origin main && git -C "$DIR/repo" reset -q --hard origin/main
else say "מוריד את האתר מ-GitHub…"; git clone -q "$REPO_URL" "$DIR/repo"; fi

# 3. מפתחות (.env)
ask(){ # ask <var> <prompt> <secret 0/1> <min length>
  local v=""
  while [ -z "$v" ]; do
    if [ "$3" = 1 ]; then read -rsp "$2: " v </dev/tty; echo; else read -rp "$2: " v </dev/tty; fi
    v="$(echo -n "$v" | tr -d '[:space:][:cntrl:]')"
    if [ -z "$v" ]; then echo -e "${R}  לא התקבל כלום — נסה להדביק שוב (לחיצה ימנית בעכבר).${N}"
    elif [ ${#v} -lt "${4:-1}" ]; then echo -e "${R}  התקבלו רק ${#v} תווים — זה קצר מדי, כנראה ההדבקה לא עבדה. נסה שוב עם לחיצה ימנית בעכבר.${N}"; v=""
    elif [ "$3" = 1 ]; then echo -e "${G}  ✓ התקבלו ${#v} תווים, מסתיים ב-...${v: -4}${N}"; fi
  done
  printf -v "$1" '%s' "$v"
}
set_env(){ # set_env KEY VALUE
  local tmp; tmp="$(mktemp)"; grep -v "^$1=" "$DIR/.env" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"; cat "$tmp" > "$DIR/.env"; rm -f "$tmp"; chmod 600 "$DIR/.env"
}
ask_keys=1
if [ -f "$DIR/.env" ]; then
  echo "כבר יש מפתחות שמורים. מה לעשות?"
  echo "  1) להשאיר הכל כמו שהוא"
  echo "  2) להחליף רק את ה-Tracking ID"
  echo "  3) להחליף רק את הטוקן של GitHub"
  echo "  4) להזין הכל מחדש"
  read -rp "הקלד מספר ולחץ Enter: " ch </dev/tty
  case "$ch" in
    1) ask_keys=0 ;;
    2) ask_keys=0; ONLY=T ;;
    3) ask_keys=0; ONLY=GT ;;
    *) ask_keys=1 ;;
  esac
fi
if [ "$ask_keys" = 1 ]; then
  echo -e "\n${Y}להדבקה: לחיצה ימנית בעכבר (לא Ctrl+V), ואז Enter.${N}"
  echo -e "${Y}את מה שמדביקים רואים על המסך. בסוף המסך יתנקה כדי שהמפתחות לא יישארו מוצגים.${N}\n"
  ask K  "1/4  AliExpress App Key" 0 5
  ask S  "2/4  AliExpress App Secret" 0 16
  ask T  "3/4  Tracking ID של האתר (לא של וואטסאפ)" 0
  ask GT "4/4  GitHub token (מתחיל ב-github_pat_)" 0 30
  clear
  umask 077
  cat > "$DIR/.env" <<ENV
ALI_APP_KEY=$K
ALI_APP_SECRET=$S
ALI_TRACKING_ID=$T
GITHUB_TOKEN=$GT
GITHUB_REPO=DibiIL/dibi
MIN_COMMISSION=5
MIN_ORDERS=100
MIN_RATING=90
ENV
  chmod 600 "$DIR/.env"
  say "המפתחות נשמרו ב-$DIR/.env (רק למשתמש הזה יש גישה)"
fi
if [ "${ONLY:-}" = T ]; then
  echo -e "${Y}להדבקה: לחיצה ימנית בעכבר, ואז Enter.${N}"
  ask T "Tracking ID של האתר (בדיוק כמו בפורטלים)" 0 2; set_env ALI_TRACKING_ID "$T"; clear; say "ה-Tracking ID עודכן"
elif [ "${ONLY:-}" = GT ]; then
  echo -e "${Y}להדבקה: לחיצה ימנית בעכבר, ואז Enter.${N}"
  ask GT "GitHub token (מתחיל ב-github_pat_)" 0 30; set_env GITHUB_TOKEN "$GT"; clear; say "הטוקן עודכן"
fi

# 4. בדיקה
echo
say "בודק חיבור ל-AliExpress ול-GitHub…"
if ! "$NODE" "$DIR/repo/finder/finder.js" test; then
  echo -e "\n${R}הבדיקה נכשלה.${N} מריצים שוב את פקודת ההתקנה ובוחרים n כדי להזין מפתחות מחדש."; exit 1
fi

# 5. תזמון אוטומטי (cron): מחירים כל 6 שעות, חיפוש מוצרים פעם ביום
RUN="cd $DIR && $NODE $DIR/repo/finder/finder.js"
LOGF="$DIR/finder.log"
( crontab -l 2>/dev/null | grep -v 'dibi-finder' || true
  echo "17 */6 * * * $RUN prices >> $LOGF 2>&1 # dibi-finder"
  echo "43 5 * * * $RUN find >> $LOGF 2>&1 # dibi-finder"
  echo "0 4 * * 0 tail -n 3000 $LOGF > $LOGF.tmp && mv $LOGF.tmp $LOGF # dibi-finder"
) | crontab -
say "תוזמן: מחירים כל 6 שעות · מוצרים חדשים כל יום"

# 6. ריצה ראשונה
echo
say "ריצה ראשונה (לוקח כדקה)…"
$RUN all 2>&1 | tee -a "$LOGF"
echo -e "\n${G}✅ הכל מוכן.${N} הבוט רץ לבד מעכשיו, גם כשהמחשב שלך כבוי."
echo "רשימת המוצרים לאישור: https://dibi.co.il/review.html"
echo "לראות מה הבוט עשה:  tail -n 40 $LOGF"
