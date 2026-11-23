"""Time switching between the app's top tabs against a fake GitHub API with a fixed delay per request.

    python tests/tab_speed.py --loop <data repo>/bin/loop [--delay 0.15] [--entries 60]

Uses app_check's fixture repo, adds Read entries (each with a zotero.json, as saved papers have), and
prints, per tab switch, the time from the click to the tab's content and the number of API requests.
"""
import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app_check import APP, CHROME, fake_github, make_fixture, serve  # noqa: E402

TABS = [('Mine', '#/mine', '.mrow'), ('Work', '#/list', '.card'), ('Status', '#/status', '.status-card'),
        ('Tree', '#/tree', '.gwrap svg'), ('Work', '#/list', '.card'),
        ('Mine', '#/mine', '.mrow'), ('Status', '#/status', '.status-card')]


async def run(loop_bin, delay, n_entries, width):
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as t:
        repo = make_fixture(loop_bin, Path(t), None)
        for k in range(n_entries):
            d = repo / 'personal' / f'read-{k:03d}'
            d.mkdir(parents=True)
            (d / 'entry.json').write_text(json.dumps({'id': f'read-{k:03d}', 'kind': 'read', 'priority': 'med', 'done': k % 3 == 0,
                                                      'created': '2026-11-01T00:00:00Z', 'title': f'Paper {k}', 'files': []}))
            (d / 'zotero.json').write_text(json.dumps({'key': f'K{k:07d}', 'title': f'Paper {k}'}))
        srv = serve(APP)
        base = f'http://127.0.0.1:{srv.server_address[1]}/index.html'
        fake = fake_github(repo)
        count = [0]

        async def slow(route):
            count[0] += 1
            await asyncio.sleep(delay)
            await fake(route)

        async with async_playwright() as p:
            browser = await p.chromium.launch(executable_path=CHROME if Path(CHROME).exists() else None)
            ctx = await browser.new_context(viewport={'width': width, 'height': 900})
            await ctx.add_init_script("localStorage.setItem('loop.token','test-token');localStorage.setItem('loop.repo','me/loop');")
            await ctx.route('https://api.github.com/**', slow)
            page = await ctx.new_page()
            await page.goto(base + '#/list')
            await page.wait_for_selector('.card')
            await page.wait_for_timeout(1500)
            rows = []
            for name, href, sel in TABS:
                count[0] = 0
                t0 = time.perf_counter()
                await page.click(f'.meta a[href="{href}"]')
                await page.wait_for_selector(f'#main {sel}')
                ms = (time.perf_counter() - t0) * 1000
                await page.wait_for_timeout(1500)     # let background refreshes finish before the next switch
                rows.append((name, ms, count[0]))
                print(f'{name:7s} {ms:7.0f} ms  {count[0]:3d} requests (incl. background, 1.5 s)')
            await browser.close()
        srv.shutdown()
        return rows


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--loop', required=True)
    ap.add_argument('--delay', type=float, default=0.15)
    ap.add_argument('--entries', type=int, default=60)
    ap.add_argument('--width', type=int, default=1280)
    a = ap.parse_args()
    asyncio.run(run(a.loop, a.delay, a.entries, a.width))
