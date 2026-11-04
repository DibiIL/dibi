#!/usr/bin/env bash
# בדיקה בלבד — מציג איך בוט הוואטסאפ מותקן בשרת. לא משנה כלום ולא מציג מפתחות או סיסמאות.
echo "=== DIBI CHECK ==="
echo "--- node: $(node -v 2>/dev/null) | pm2: $(command -v pm2 >/dev/null && echo yes || echo no)"
echo "--- processes:"; ps -eo pid,etime,cmd | grep -E "[n]ode|[c]hrom" | grep -v check.sh | cut -c1-140 | head -12
command -v pm2 >/dev/null && { echo "--- pm2:"; pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{JSON.parse(s).forEach(p=>console.log(p.name,p.pm2_env.status,p.pm2_env.pm_exec_path,p.pm2_env.pm_cwd))}catch(e){}})'; }
echo "--- services:"; systemctl list-units --type=service --no-legend 2>/dev/null | grep -iE "dibi|bot|whats|node" | cut -c1-100
echo "--- crontab:"; crontab -l 2>/dev/null | grep -v '^#' | sed -E 's/(TOKEN|SECRET|KEY)=[^ ]+/\1=***/g'
echo "--- whatsapp sessions:"; find /root /home /opt -maxdepth 4 -type d \( -name .wwebjs_auth -o -name .wwebjs_cache -o -name baileys_auth* -o -name auth_info* \) 2>/dev/null
for d in $(find /root /home /opt -maxdepth 4 -type d \( -name .wwebjs_auth -o -name "auth_info*" \) 2>/dev/null | xargs -r -n1 dirname | sort -u); do
  echo "--- bot dir: $d"; ls -1p "$d" | grep -v node_modules | head -30
  [ -f "$d/package.json" ] && grep -E '"(main|start|whatsapp-web.js|@whiskeysockets/baileys|node-cron)"' "$d/package.json"
  for f in "$d"/*.js; do [ -f "$f" ] || continue; echo "  [$f] $(wc -l <"$f") lines"; grep -nE "setInterval|cron|schedule|INTERVAL|MINUTES|HOUR|GROUP|g\.us|getChats|products|tracking|require\(" "$f" | sed -E 's/[0-9]{8,}@g\.us/<group>@g.us/g; s/(secret|token|key)[^,;]*/\1=***/Ig' | cut -c1-150 | head -25; done
done
echo "=== END ==="
