#!/usr/bin/env python3
"""Render the three required screenshots at a true 1440x900 viewport.

Chromium's `--window-size` flag does not give a 900px viewport in new headless
mode (it reports 779px once browser chrome is subtracted), which clips the last
card of the detail view. Driving the browser through Playwright sets the
viewport exactly, so what is captured is what the page lays out.

Network is blocked outright: the dashboard must stand on its own data.
"""
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

REPO = "/home/ubuntu/hermes-contest/tr-fresh"
PAGE = os.path.join(REPO, "out", "dashboard", "index.html")
OUT = os.path.join(REPO, "screenshots")
CHROME = "/home/ubuntu/.cloakbrowser/chromium-146.0.7680.177.4/chrome"
W, H = 1440, 900
# The rule says 300 to 350 KB. Stay inside a band that satisfies both readings of
# "KB" (1000 and 1024 bytes) so the size check cannot fail on interpretation.
LO, HI = 310_000, 348_000

# board: the ranked board itself. detail: one protocol's dossier. filtered: the
# board narrowed by category, with the filter state visible.
SHOTS = [
    ("board", "?view=board"),
    ("detail", "?view=detail&slug=polymarket-international"),
    ("filtered", "?view=board&cat=Basis+Trading&sort=implied"),
]


def fit_band(src: str, dest: str) -> int:
    """Re-encode into the byte band, keeping the full frame."""
    im = Image.open(src).convert("RGB")
    if im.size != (W, H):
        im = im.resize((W, H), Image.Resampling.LANCZOS)

    def encode(path: str, q: int) -> int:
        im.save(path, "JPEG", quality=q, optimize=True, progressive=True, subsampling=0)
        return os.path.getsize(path)

    scratch = dest + ".try"
    lo_q, hi_q = 40, 98
    chosen_q = None
    while lo_q <= hi_q:
        q = (lo_q + hi_q) // 2
        size = encode(scratch, q)
        if LO <= size <= HI:
            chosen_q = q
            break
        if size < LO:
            lo_q = q + 1
        else:
            hi_q = q - 1

    if chosen_q is None:
        chosen_q = 98
        while chosen_q > 40 and encode(scratch, chosen_q) > HI:
            chosen_q -= 1

    encode(dest, chosen_q)
    if os.path.exists(scratch):
        os.unlink(scratch)
    return os.path.getsize(dest)


def main() -> int:
    if not os.path.exists(PAGE):
        print(f"MISSING built page: {PAGE}", file=sys.stderr)
        return 1

    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith((".png", ".jpg", ".jpeg", ".try")):
            os.unlink(os.path.join(OUT, f))

    ok = True
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            args=["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1"],
        )
        ctx = browser.new_context(
            viewport={"width": W, "height": H}, device_scale_factor=1
        )
        # The page must not need the network: refuse every request that leaves file://
        ctx.route("**/*", lambda route: route.abort() if not route.request.url.startswith("file:") else route.continue_())

        page = ctx.new_page()
        for name, suffix in SHOTS:
            page.goto(f"file://{PAGE}{suffix}", wait_until="load")
            page.wait_for_timeout(900)  # let the data script paint
            geo = page.evaluate(
                """() => ({
                    ih: window.innerHeight,
                    sh: document.documentElement.scrollHeight,
                    rows: document.querySelectorAll('#view tbody tr').length,
                    view: document.body.getAttribute('data-view'),
                    errs: window.__errs || []
                })"""
            )
            raw = os.path.join(OUT, f"_{name}.png")
            page.screenshot(path=raw, full_page=False)
            dest = os.path.join(OUT, f"{name}.jpg")
            size = fit_band(raw, dest)
            os.unlink(raw)
            with Image.open(dest) as chk:
                w, h = chk.size
            inband = LO <= size <= HI
            ok = ok and inband and (w, h) == (W, H)
            print(
                f"{name:9s} {size:>8,} B  {w}x{h}  viewport={geo['ih']}  "
                f"scrollH={geo['sh']}  rows={geo['rows']}  "
                f"{'OK' if inband else 'OUT OF BAND'}"
            )
            if geo["errs"]:
                print(f"          JS errors: {geo['errs']}")

        browser.close()

    files = sorted(f for f in os.listdir(OUT) if f.endswith((".png", ".jpg", ".jpeg")))
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in files)
    print(f"\nfiles: {len(files)} {files}\ntotal: {total:,} B")
    return 0 if ok and len(files) == 3 else 2


if __name__ == "__main__":
    sys.exit(main())
