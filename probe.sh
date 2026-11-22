#!/bin/bash
# Rebuild out/, add a layout probe page, and dump geometry for each view.
set -e
cd /home/ubuntu/hermes-contest/tr-fresh
MAKEFUN_OUTPUT_DIR=out node main.ts --input /tmp/trk/token-radar-01-kit/input/snapshot.json >/dev/null 2>&1 || true
python3 - <<'PY'
src = open('dashboard/index.html').read()
probe = '<script src="probe.js"></script>\n'
open('out/dashboard/probe.js','w').write(open('probe.js').read())
open('out/dashboard/probe.html','w').write(src.replace('</body>', probe + '</body>'))
PY
for v in "$@"; do
  echo "=== $v"
  timeout 90 /snap/bin/chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --host-resolver-rules="MAP * ~NOTFOUND" --window-size=1440,900 --virtual-time-budget=3000 \
    --dump-dom "file://$PWD/out/dashboard/probe.html?$v" 2>/dev/null \
    | python3 -c "
import sys,re,html,json
d=sys.stdin.read()
m=re.search(r'<title>(.*?)</title>', d, re.S)
if not m: print('NO TITLE'); sys.exit()
print(json.dumps(json.loads(html.unescape(m.group(1))), indent=1))
"
done
