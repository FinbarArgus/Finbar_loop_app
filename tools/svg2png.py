"""PNG of each SVG given, as Chrome draws it (emoji included): python tools/svg2png.py a.svg b.svg [--width 900]."""
import argparse
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')

ap = argparse.ArgumentParser()
ap.add_argument('svgs', nargs='+')
ap.add_argument('--width', type=int, default=900)
a = ap.parse_args()
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME if Path(CHROME).exists() else None)
    page = b.new_page(viewport={'width': a.width, 'height': 400}, device_scale_factor=2)
    for s in a.svgs:
        page.set_content('<body style="margin:0;background:#f4f8f1;color:#1d2433">'
                         f'<div id="t" style="width:{a.width}px">{Path(s).read_text()}</div></body>')
        page.locator('#t svg').evaluate("e => { e.style.width = '100%'; e.style.height = 'auto'; e.style.display = 'block'; }")
        page.locator('#t').screenshot(path=str(Path(s).with_suffix('.png')))
    b.close()
