#!/usr/bin/env python3
"""Measure the real rendered geometry of each view at 1440x900.

Uses the dashboard's own built page, dumps the DOM after load, and reports the
scroll height plus the bottom edge of the last meaningful block so overflow is a
number rather than a guess.
"""
import json
import os
import re
import subprocess
import sys

REPO = "/home/ubuntu/hermes-contest/tr-fresh"
PAGE = os.path.join(REPO, "out", "dashboard", "index.html")
CHROME = "/home/ubuntu/.cloakbrowser/chromium-146.0.7680.177.4/chrome"

PROBE = """
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    function box(sel) {
      var e = document.querySelector(sel);
      if (!e) return null;
      var r = e.getBoundingClientRect();
      return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) };
    }
    var out = {
      view: document.body.getAttribute('data-view'),
      scrollH: document.documentElement.scrollHeight,
      bodyH: document.body.scrollHeight,
      winH: window.innerHeight,
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      rows: document.querySelectorAll('#view tbody tr').length,
      hero: box('.hero'),
      stats: box('.stats'),
      controls: box('.controls'),
      view: box('#view'),
      detail: box('.detail'),
      colL: box('.dcol'),
      colR: box('.dcol:nth-child(2)'),
      lastCardL: box('.dcol:first-child .card:last-child'),
      lastCardR: box('.dcol:nth-child(2) .card:last-child'),
      steps: document.querySelectorAll('.steps li').length,
      lastStep: box('.steps li:last-child'),
      tablewrap: box('.tablewrap'),
      lastRow: box('#view tbody tr:last-child'),
      foot: box('.foot'),
      errors: window.__errs || []
    };
    document.title = JSON.stringify(out);
  }, 1200);
});
</script>
"""

VIEWS = [
    ("board", "?view=board"),
    ("detail", "?view=detail&slug=polymarket-international"),
    ("filtered", "?view=board&cat=Lending&sort=implied"),
]


def main() -> int:
    src = open(PAGE, encoding="utf-8").read()
    probe_path = os.path.join(os.path.dirname(PAGE), "_measure.html")
    open(probe_path, "w", encoding="utf-8").write(src.replace("</body>", PROBE + "</body>"))

    for name, suffix in VIEWS:
        cmd = [
            CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
            "--hide-scrollbars", "--force-device-scale-factor=1",
            '--host-resolver-rules=MAP * ~NOTFOUND',
            "--window-size=1440,900", "--virtual-time-budget=6000",
            "--dump-dom", f"file://{probe_path}{suffix}",
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        m = re.search(r"<title>(.*?)</title>", r.stdout, re.S)
        if not m:
            print(f"{name}: NO TITLE (page failed to load)")
            continue
        raw = m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        try:
            d = json.loads(raw)
        except Exception:
            print(f"{name}: unparsable title {raw[:200]}")
            continue
        print(f"===== {name} =====")
        for k in ("scrollH", "winH", "overflow", "rows", "steps", "errors"):
            if k in d:
                print(f"  {k:12s} {d[k]}")
        for k in ("hero", "stats", "controls", "view", "detail", "colL", "colR",
                  "lastCardL", "lastCardR", "lastStep", "tablewrap", "lastRow", "foot"):
            if d.get(k):
                print(f"  {k:12s} top={d[k]['t']:5d} bottom={d[k]['b']:5d} h={d[k]['h']}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
