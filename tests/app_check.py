"""Headless check of the loop app against a fake GitHub API backed by a fixture loop repo.

    python tests/app_check.py --loop <data repo>/bin/loop [--graph provenance_graph.json] [--shots DIR]

The fixture repo is made with `loop post` (LOOP_NO_GIT=1); api.github.com is served from it by
Playwright route interception, so answers, detail requests and images are really written. Checks, at
phone and computer width: the board, a question with figure, maths, table and file excerpt; option +
answer; a detail request with an image (Enter sends); the added detail (figure + text) shown in place;
a review with provenance, quiz (marking, reason, score, start again) and checklist; no console errors
and no sideways scrolling.
"""
import datetime as dt
import argparse
import base64
import hashlib
import http.server
import json
import re
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAJklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAPwZQCAAAQ7Nm1cAAAAASUVORK5CYII=')
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')


USAGE = """Current session: 43% used · resets Nov 23, 1:19pm (Pacific/Auckland)
Current week (all models): 57% used · resets Nov 26, 7am (Pacific/Auckland)
Current week (Fable): 92% used · resets Nov 26, 7am (Pacific/Auckland)

Last 24h · 663 requests · 17 sessions
  77%  Start fresh when you switch tasks · run /clear
"""


def loop(loop_bin, repo, *args):
    env = dict(os.environ, LOOP_REPO=str(repo), LOOP_NO_GIT='1', LOOP_JOBS_DIR=str(repo / 'nojobs'),
               LOOP_QUEUE=str(repo / 'noqueue.json'), LOOP_PROJECTS_DIR=str(repo / 'noprojects'),
               LOOP_FAKE_USAGE=USAGE)
    r = subprocess.run([sys.executable, str(loop_bin), *args], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def make_fixture(loop_bin, tmp, graph):
    repo = tmp / 'repo'
    repo.mkdir()
    (tmp / 'fig.png').write_bytes(PNG)
    q = {'title': 'Which step size for the run?', 'blocks': [
        {'type': 'text', 'md': 'The run uses $\\lambda \\in [10^{-3}, 10^{1}]$.\n\n$$\nE = \\frac{\\|x - \\hat x\\|}{\\|x\\|}\n$$\n\n'
                               '| step | error |\n|---|---|\n| 1e1 | 0.65 |\n| 1e3 | 0.71 |\n\n- **small** step\n- *large* step'},
        {'type': 'figure', 'src': 'fig.png', 'caption': 'Error by step size'},
        {'type': 'file', 'ref': 'src/solver/step.py:120', 'code': 'def fit(x):\n    return solve(x)\n', 'highlight': [121]}]}
    (tmp / 'q.json').write_text(json.dumps(q))
    loop(loop_bin, repo, 'post', 'question', '--from', 'HIGH-session-a', '--blocking',
         '--holds-up', 'the run', 'Which step size for the run?', '--option', 'Small step', '--option', 'Large step', '--spec', str(tmp / 'q.json'))
    show = [{'type': 'file', 'ref': 'a.py:3', 'code': 'x = 1\n'}]
    quiz = {'type': 'quiz', 'questions': [
        {'q': f'Question {k}?', 'show': show, 'options': [f'opt {c}{k}' for c in 'abcd'], 'correct': k,
         'why': f'reason {k}', 'ref': f'a.py:{k + 3}'} for k in range(4)]}
    blocks = []
    if graph:
        (tmp / 'graph.json').write_text(Path(graph).read_text())
        blocks.append({'type': 'provenance', 'graph': 'graph.json'})
    else:
        blocks.append({'type': 'provenance', 'output_dir': 'out/run1', 'commit': 'abc123', 'steps': [
            {'name': 'Model source', 'mark': 'inherited', 'does': 'BG model'},
            {'name': 'Fit k', 'mark': 'calibrated', 'does': 'fits k to obs A'},
            {'name': 'Set g', 'mark': 'set_by_hand', 'detail': 'g = 2, because the data lack it'}]})
    blocks += [{'type': 'text', 'md': 'What the PR does.'},
               {'type': 'diagram', 'title': 'What changed', 'nodes': [
                   {'id': 'a', 'title': 'workflow.json', 'mark': 'changed', 'lines': ['steps own their ids']},
                   {'id': 'b', 'title': 'run()', 'mark': 'added'},
                   {'id': 'c', 'title': 'old loader', 'mark': 'removed'}],
                'edges': [{'from': 'a', 'to': 'b', 'label': 'read by'}, {'from': 'a', 'to': 'c'}]},
               quiz,
               {'type': 'checklist', 'items': ['merge #1 first', 'CI green']}]
    (tmp / 'r.json').write_text(json.dumps({'title': 'PR 12 review guide', 'page': 'result', 'blocks': blocks}))
    loop(loop_bin, repo, 'post', 'review', '--from', 'HIGH-session-b', '--importance', 'med', '--spec', str(tmp / 'r.json'),
         '--link', 'https://github.com/org/repo/pull/12')
    loop(loop_bin, repo, 'post', 'question', 'A low one', '--from', 'LOW-x')
    loop(loop_bin, repo, 'post', 'review', 'Run under way', '--from', 'LOW-x', '--importance', 'low',
         '--stage', 'in-progress', '--link', 'https://example.org/run')
    batch = {'title': 'Two set-up choices', 'questions': [
        {'text': 'Which mesh?', 'options': ['coarse', {'label': 'fine', 'detail': 'slower'}]},
        {'text': 'Which solver?', 'options': ['implicit', 'explicit'],
         'blocks': [{'type': 'figure', 'src': 'fig.png', 'caption': 'cost'}]}]}
    (tmp / 'batch.json').write_text(json.dumps(batch))
    loop(loop_bin, repo, 'post', 'question', '--from', 'MED-y', '--spec', str(tmp / 'batch.json'))
    (repo / 'nojobs/aaaa0001').mkdir(parents=True)
    (repo / 'nojobs/aaaa0001/state.json').write_text(json.dumps({
        'name': 'HIGH-session-a', 'state': 'blocked', 'tempo': 'blocked', 'updatedAt': '2026-11-23T00:00:00Z',
        'detail': 'waiting on LOOP Q-0001 after drafting the run plan'}))
    loop(loop_bin, repo, 'status', '--force')
    (repo / 'state/people.json').write_text(json.dumps({'students': ['Ana', 'Ben', 'Cal']}))
    (repo / 'state/zotero_collections.json').write_text(json.dumps({'collections': [
        {'key': 'AAAA1111', 'id': 1, 'name': 'ROM'}, {'key': 'BBBB2222', 'id': 2, 'name': 'ROM / OpInf'}]}))
    return repo


def serve(directory):
    handler = lambda *a: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory))
    srv = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def blob_sha(data):
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def fake_github(repo):
    def handle(route):
        req = route.request
        u = urlparse(req.url)
        parts = [unquote(p) for p in u.path.split('/')]
        if req.headers.get('authorization') != 'Bearer test-token':
            return route.fulfill(status=401, body='{}')
        if '/git/trees/' in u.path:
            files = sorted(p for p in repo.rglob('*') if p.is_file() and '.loop' not in p.parts)
            blobs = [{'path': str(p.relative_to(repo)), 'type': 'blob', 'sha': blob_sha(p.read_bytes())} for p in files]
            root = hashlib.sha1(json.dumps(blobs).encode()).hexdigest()
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'sha': root, 'tree': blobs}))
        if parts[4] == 'contents' if len(parts) > 4 else False:
            rel = '/'.join(parts[5:])
            f = repo / rel
            if req.method == 'PUT':
                body = json.loads(req.post_data)
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(base64.b64decode(body['content']))
                return route.fulfill(status=201, content_type='application/json',
                                     body=json.dumps({'content': {'path': rel, 'sha': blob_sha(f.read_bytes())}}))
            if not f.is_file():
                return route.fulfill(status=404, body='{}')
            return route.fulfill(status=200, body=f.read_bytes(),
                                 content_type='image/png' if f.suffix == '.png' else 'application/json')
        return route.fulfill(status=404, body='{}')
    return handle


def check(page, cond, what, failures):
    ok = bool(cond)
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        failures.append(what)

PDF = b'%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'

# Records window.open and navigator.share instead of opening anything; `act` sets navigator.userActivation.isActive.
FILE_STUBS = """
window.__opens = []; window.__shared = []; window.__act = true;
window.open = (u) => { const r = { u, href: null }; window.__opens.push(r);
  return { close() { r.closed = true; }, location: { set href(v) { r.href = v; } } }; };
navigator.canShare = () => true;
navigator.share = async (d) => { window.__shared.push(d.files.map((f) => ({ name: f.name, type: f.type, size: f.size }))); };
Object.defineProperty(navigator, 'userActivation', { get: () => ({ isActive: window.__act }) });
"""
STANDALONE = """
const mm = window.matchMedia.bind(window);
window.matchMedia = (q) => q.includes('display-mode: standalone') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q);
"""


def check_file_links(browser, base, repo, vp, label, failures):
    """A Read entry's PDF opens from the tap that asked for it, typed application/pdf, while the download is slow:
    a browser tab opens a blank tab at once and points it at the file; the installed app shares the file."""
    (repo / 'personal' / 'read-pdf').mkdir(parents=True, exist_ok=True)
    (repo / 'personal' / 'read-pdf' / 'paper.pdf').write_bytes(PDF)
    (repo / 'personal' / 'read-pdf' / 'entry.json').write_text(json.dumps({
        'id': 'read-pdf', 'kind': 'read', 'title': 'PDF paper', 'priority': 'low', 'deadline': None, 'done': False,
        'created': '2026-01-01T00:00:00Z', 'files': ['paper.pdf']}))
    gh = fake_github(repo)

    # A slow PDF download. While `hold` is set, PDF requests wait in `held` until the test fulfils them, so a check that the
    # tap opened the tab before the download ended can't race it (a sleep here runs on the test's thread, inside click()).
    held, hold = [], [False]

    def slow(route):
        if urlparse(route.request.url).path.endswith('.pdf'):
            if hold[0]:
                held.append(route)
                return None
            time.sleep(0.8)
        return gh(route)

    def poll(page, js, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            v = page.evaluate(js)
            if v:
                return v
            time.sleep(0.05)
        return page.evaluate(js)

    for mode in ('tab', 'app'):
        ctx = browser.new_context(viewport=vp)
        ctx.add_init_script("localStorage.setItem('loop.token','test-token');localStorage.setItem('loop.repo','me/loop');")
        ctx.add_init_script(FILE_STUBS + (STANDALONE if mode == 'app' else ''))
        ctx.route('https://api.github.com/**', slow)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base + '#/manual/read')
        link = page.locator('.mrow', has_text='PDF paper').locator('a.flink')
        link.wait_for()
        if mode == 'tab':
            hold[0] = True
            link.click()
            first = page.evaluate('window.__opens.slice()')
            check(page, len(first) == 1 and first[0]['u'] == '' and first[0]['href'] is None,
                  f'{label} PDF link: a tab opens in the tap, before the slow download ends {first}', failures)
            hold[0] = False
            while held:
                gh(held.pop())
            href = poll(page, 'window.__opens[0] && window.__opens[0].href')
            typ = page.evaluate('(u) => fetch(u).then((r) => r.blob()).then((b) => [b.type, b.size])', href) if href else None
            check(page, href and href.startswith('blob:') and typ == ['application/pdf', len(PDF)],
                  f'{label} PDF link: the tab goes to the file, typed application/pdf {href} {typ}', failures)
            link.click()
            again = page.evaluate('window.__opens.slice()')
            check(page, len(again) == 2 and again[1]['u'] == href, f'{label} PDF link: a loaded file opens straight away {again}', failures)
        else:
            link.click()
            shared = poll(page, 'window.__shared.length && window.__shared')
            check(page, page.evaluate('window.__opens.length') == 0 and shared == [[{'name': 'paper.pdf', 'type': 'application/pdf', 'size': len(PDF)}]],
                  f'{label} PDF link (installed app): shares the file, no blob: window {shared}', failures)
            # The tap's activation ran out while the file loaded: the link asks for a second tap, which shares.
            page.reload()
            link.wait_for()
            page.evaluate('window.__act = false')
            link.click()
            poll(page, "document.querySelector('a.flink.ready')")
            check(page, link.inner_text() == 'paper.pdf: tap again to open' and page.evaluate('window.__shared.length') == 0,
                  f'{label} PDF link (installed app): "tap again" once the tap has expired {link.inner_text()!r}', failures)
            page.evaluate('window.__act = true')
            link.click()
            check(page, page.evaluate('window.__shared.length') == 1 and link.inner_text() == 'paper.pdf',
                  f'{label} PDF link (installed app): the second tap shares it', failures)
        check(page, not errors, f'{label} PDF link ({mode}): no page errors {errors}', failures)
        ctx.close()


def run(loop_bin, graph, shots):
    failures = []
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as t:
        tmp = Path(t)
        srv = serve(APP)
        base = f'http://127.0.0.1:{srv.server_address[1]}/index.html'
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME if Path(CHROME).exists() else None)
            for label, vp in (('phone', {'width': 390, 'height': 844}), ('computer', {'width': 1280, 'height': 900})):
                print(f'--- {label}')
                (tmp / label).mkdir()
                repo = make_fixture(loop_bin, tmp / label, graph)
                tmp_l = tmp / label
                ctx = browser.new_context(viewport=vp, has_touch=label == 'phone')
                ctx.add_init_script("localStorage.setItem('loop.token','test-token');localStorage.setItem('loop.repo','me/loop');")
                ctx.route('https://api.github.com/**', fake_github(repo))
                page = ctx.new_page()
                errors = []
                page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
                page.on('pageerror', lambda e: errors.append(str(e)))
                narrow = lambda: page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')

                page.goto(base + '#/list')
                page.wait_for_selector('.card')
                tabs = page.locator('.tabs a').all_inner_texts()
                perm_label = 'Perm' if label == 'phone' else 'Permission'
                check(page, [t.rstrip('0123456789') for t in tabs[:1]] == [perm_label] and [t[:4] for t in tabs[1:]] == ['Ques', 'Cont', 'Revi']
                      and tabs[1].endswith('31') and page.locator('.meta a[data-meta="permission"]').count() == 0,
                      f'Agents tabs: {perm_label} left of Questions/Content/Review (blocking count), not in the header {tabs}', failures)
                if shots:
                    page.locator('.tabs').screenshot(path=f'{shots}/{label}-agents-tabs.png')
                check(page, page.locator('.card .id').first.inner_text() == 'Q-0001', 'blocking question listed first', failures)
                page.locator('.switch button', has_text=re.compile(r'^Blocking')).click()
                page.wait_for_selector('.switch button.on >> text=Blocking')
                check(page, page.locator('.card').count() == 1, 'Blocking switch shows only blocking items', failures)
                page.locator('.switch button', has_text='All').click()
                page.wait_for_selector('.switch button.on >> text=All')
                check(page, narrow(), 'board: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-board.png', full_page=True)

                page.goto(base + '#/item/Q-0001')
                page.wait_for_selector('.figure img[src^="blob:"]')
                page.wait_for_function("document.querySelector('.figure img').naturalWidth > 0")
                check(page, page.locator('.katex').count() >= 2, 'maths rendered', failures)
                check(page, page.locator('table td').count() == 4, 'table rendered', failures)
                check(page, page.locator('.ln.hl').count() == 1, 'file excerpt with highlighted line', failures)
                check(page, 'the run' in page.locator('.holds').inner_text(), 'holds-up shown', failures)

                # More detail: text + image, Enter sends.
                box = page.locator('details.detail').last
                box.locator('input[type=file]').set_input_files(str(tmp_l / 'fig.png'))
                page.wait_for_selector('details.detail .thumb img')
                box.locator('textarea').fill(f'Show the errors ({label})')
                box.locator('textarea').press('Enter')
                page.wait_for_selector('.exchange .who.pending')
                reqs = sorted((repo / 'requests/Q-0001').glob('*.json'))
                imgs = sorted((repo / 'requests/Q-0001').glob('*.png'))
                check(page, reqs and json.loads(reqs[-1].read_text())['text'] == f'Show the errors ({label})',
                      'detail request written', failures)
                check(page, imgs and json.loads(reqs[-1].read_text())['images'] == [imgs[-1].name],
                      'detail request image written and named', failures)

                # The owning session adds detail; the page shows it in place.
                (tmp_l / 'resid.png').write_bytes(PNG)
                loop(loop_bin, repo, 'add-detail', 'Q-0001', '--request', reqs[-1].name,
                     '--text', f'Errors for {label} are below.', '--figure', str(tmp_l / 'resid.png'))
                page.evaluate('window.LoopApp.refresh()')
                page.wait_for_selector('.exchange .reply .figure img[src^="blob:"]')
                check(page, f'Errors for {label}' in page.locator('.exchange').last.inner_text(),
                      'added detail shown under the request', failures)

                # Answer: option + text.
                page.locator('.choice-btn', has_text='Large step').click()
                page.locator('.answer textarea').fill('Large, and note the error term.')
                page.locator('.answer button.primary').click()
                page.wait_for_selector('.given .choice')
                ans = sorted((repo / 'answers/Q-0001').glob('*.json'))
                a = json.loads(ans[-1].read_text()) if ans else {}
                check(page, a.get('choice') == 'Large step' and 'error term' in a.get('text', ''), 'answer written', failures)
                check(page, narrow(), 'question: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-question.png', full_page=True)

                page.goto(base + '#/item/R-0001')
                page.wait_for_selector('.pbox')
                if graph:
                    n = len(json.loads(Path(graph).read_text())['nodes'])
                    page.wait_for_function(f"document.querySelectorAll('.prov:not(.diagram) .pbox').length === {n}")
                    check(page, True, f'provenance graph: {n} boxes', failures)
                else:
                    check(page, page.locator('.prov:not(.diagram) .pbox').count() == 3, 'provenance steps', failures)
                    check(page, page.locator('.prov:not(.diagram) .pbox.set_by_hand').count() == 1, 'set-by-hand box marked', failures)
                check(page, page.locator('.pmeta code').count() >= 1, 'provenance names output/commit', failures)
                q0 = page.locator('.qcard').first
                q0.locator('.opt').nth(1).click()
                check(page, 'reason 0' in q0.locator('.why').inner_text() and 'a.py:3' in q0.locator('.why').inner_text(),
                      'quiz reason and ref shown', failures)
                check(page, q0.locator('.opt.right').count() == 1 and q0.locator('.opt.wrong').count() == 1,
                      'quiz marks right and wrong', failures)
                page.locator('.qcard').nth(1).locator('.opt').nth(1).click()
                check(page, page.locator('.score').inner_text().startswith('Score: 1 / 2'), 'running score', failures)
                page.locator('.score button').click()
                check(page, page.locator('.score').inner_text().startswith('Score: 0 / 0'), 'start again', failures)
                check(page, page.locator('.qcard details.detail').count() == 4, 'a detail box per quiz question', failures)
                qd = page.locator('.qcard details.detail').nth(2)
                qd.locator('summary').click()
                qd.locator('textarea').fill('Why C?')
                qd.locator('textarea').press('Enter')
                page.wait_for_selector('.exchange')
                rq = [json.loads(f.read_text()) for f in (repo / 'requests/R-0001').glob('*.json')]
                check(page, any(r.get('quiz') == 2 and r['text'] == 'Why C?' for r in rq), 'quiz detail request names its question', failures)
                page.locator('.choice-btn', has_text='Needs changes').click()
                page.locator('.answer button.primary').click()
                page.wait_for_selector('.given .choice')
                check(page, page.locator('.checklist input').count() == 2, 'checklist', failures)
                check(page, narrow(), 'review: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-review.png', full_page=True)

                # The review's diagram: three boxes with change marks, the removed one struck.
                page.goto(base + '#/item/R-0001')
                page.wait_for_selector('.diagram .pbox')
                check(page, page.locator('.diagram .pbox').count() == 3, 'diagram boxes', failures)
                check(page, page.locator('.diagram .pbox.removed.struck').count() == 1
                      and page.locator('.diagram .legend .mark').count() == 3, 'diagram change marks and legend', failures)
                check(page, 'old loader' in page.locator('.diagram .pbox').first.inner_text(), 'diagram lists edges to non-neighbours', failures)

                # A batch: one card per question, picks per question, a detail asked on question 2
                # answered inside its card, one send, then Next.
                page.goto(base + '#/item/Q-0003')
                page.wait_for_selector('.question .qtitle')
                cards = page.locator('.question')
                check(page, cards.count() == 2, 'batch: a card per question', failures)
                check(page, page.locator('.navrow a.next').count() == 1, 'Next in the header', failures)
                cards.nth(0).locator('.qnote').fill('coarse is fine for the test')
                cards.nth(1).locator('.choice-btn', has_text='explicit').click()
                check(page, page.locator('.question details.detail[open]').count() == 0, 'batch: detail boxes start closed', failures)
                cards.nth(1).locator('details.detail summary').click()
                cards.nth(1).locator('details.detail textarea').fill('Why is explicit cheaper here?')
                cards.nth(1).locator('details.detail textarea').press('Enter')
                page.wait_for_selector('.question >> nth=1 >> .exchange .who.pending')
                rq = [(f, json.loads(f.read_text())) for f in sorted((repo / 'requests/Q-0003').glob('*.json'))]
                check(page, rq and rq[-1][1].get('question') == 1, 'batch: detail request names its question', failures)
                loop(loop_bin, repo, 'add-detail', 'Q-0003', '--request', rq[-1][0].name, '--question', '1',
                     '--text', 'Explicit needs no Jacobian.')
                page.evaluate('window.LoopApp.refresh()')
                page.wait_for_selector('.question >> nth=1 >> .exchange .reply >> text=no Jacobian')
                check(page, cards.nth(0).locator('.exchange').count() == 0, 'batch: the reply sits under its own question', failures)
                check(page, cards.nth(1).locator('.choice-btn.on').count() == 1, 'batch: pick kept across the refresh', failures)
                page.locator('.answer button.primary').click()
                page.wait_for_selector('.after a')
                ans = [json.loads(f.read_text()) for f in sorted((repo / 'answers/Q-0003').glob('*.json'))]
                got = ans[-1]['answers'] if ans else []
                check(page, len(got) == 2 and got[0]['text'] == 'coarse is fine for the test' and got[0]['choice'] is None
                      and got[1]['choice'] == 'explicit', f'batch: one answer file with both answers {got}', failures)
                nxt = page.locator('.after a').get_attribute('href')
                page.locator('.after a').click()
                page.wait_for_function(f"location.hash === '{nxt}'")
                page.wait_for_selector('.item-head h2')
                check(page, nxt.startswith('#/item/') and nxt != '#/item/Q-0003', f'Next after sending goes to {nxt}', failures)
                check(page, narrow(), 'batch: no sideways scroll', failures)
                if shots:
                    page.goto(base + '#/item/Q-0003')
                    page.wait_for_selector('.question .qtitle')
                    page.screenshot(path=f'{shots}/{label}-batch.png', full_page=True)

                # LOOP takes the answers: fully answered items move to History; it opens on demand and
                # sends a revisit request about one item.
                loop(loop_bin, repo, 'pull')
                page.goto(base + '#/list')
                page.wait_for_selector('details.history')
                # The list draws from the cached tree first, then redraws once the background reload sees the pull.
                try:
                    page.locator('details.history > summary', has_text='Questions history (2)').wait_for(timeout=5000)
                except Exception:
                    pass
                check(page, 'Questions history (2)' in page.locator('details.history > summary').inner_text(),
                      'answered questions move to the Questions history', failures)
                check(page, page.locator('.tabs a').count() == 4, 'four tabs, history below', failures)
                page.goto(base + '#/list/content')
                page.wait_for_selector('.switch button >> text=In progress')
                labels = page.locator('.switch button').all_inner_texts()
                check(page, [x.split(' (')[0] for x in labels] == ['Blocking', 'Soon blocking', 'In progress', 'Ready', 'All'],
                      f'content filters {labels}', failures)
                page.locator('.switch button', has_text='In progress').click()
                page.wait_for_selector('.switch button.on >> text=In progress')
                check(page, page.locator('.card').count() == 1 and 'in progress' in page.locator('.card').inner_text(),
                      'In progress shows the in-progress entry', failures)
                page.locator('.switch button', has_text='Ready').click()
                page.wait_for_selector('.switch button.on >> text=Ready')
                check(page, page.locator('.card').count() == 0, 'Ready excludes it', failures)
                page.locator('.switch button', has_text='All').click()
                page.goto(base + '#/list/question')
                page.wait_for_selector('.switch button')
                page.goto(base + '#/list/pr')
                page.wait_for_selector('details.history > summary >> text=Review history')
                check(page, 'Review history (1)' in page.locator('details.history > summary').inner_text(),
                      'each tab has only its own history', failures)
                page.goto(base + '#/list/question')
                page.wait_for_selector('details.history')
                page.locator('details.history > summary').click()
                page.locator('details.hentry', has_text='Q-0003').locator('summary').click()
                page.wait_for_selector('details.hentry[open] .hq')
                h = page.locator('details.hentry[open]').inner_text()
                check(page, 'Which solver?' in h and 'explicit' in h and 'coarse is fine' in h,
                      'history entry shows each question and its answer', failures)
                rv = page.locator('details.hentry[open] details.revisit')
                rv.locator('summary').click()
                rv.locator('textarea').fill('Was explicit right after all?')
                rv.locator('textarea').press('Enter')
                page.wait_for_selector('details.hentry[open] details.revisit .status >> text=Sent')
                rq = [json.loads(f.read_text()) for f in (repo / 'requests/Q-0003').glob('*.json')]
                check(page, any(r.get('kind') == 'revisit' and r['text'] == 'Was explicit right after all?' for r in rq),
                      'revisit request written for that item', failures)
                # Back from an item goes to the view it was opened from (its board tab, Status), not the default tab; an item
                # opened straight from a link goes back to its own board tab.
                def back():
                    page.wait_for_selector('.navrow a.back')
                    b = page.locator('.navrow a.back')
                    return b.inner_text(), b.get_attribute('href')
                page.goto(base + '#/list/content')
                page.locator('.cards .card').first.click()
                got = back()
                content_item = page.url
                page.locator('.navrow a.back').click()
                page.wait_for_selector('.tabs a.on')
                check(page, got == ('← Content', '#/list/content') and page.locator('.tabs a.on').inner_text().startswith('Content'),
                      f'Back from a Content entry returns to Content {got}', failures)
                page.goto(base + '#/status')
                page.locator('.agent', has_text='HIGH-session-a').locator('.alinks a', has_text='Q-0001').first.click()
                got = back()
                check(page, got == ('← Status', '#/status'), f'Back from an item opened on Status returns to Status {got}', failures)
                page.goto(content_item)
                page.reload()
                got = back()
                check(page, got == ('← Content', '#/list/content'), f'Back from an item opened by link goes to its own tab {got}', failures)
                # Tasks: the ledger's task list by agent in role order, each with its status chip, age and source; filters;
                # done ones collapsed at the foot.
                import datetime as _dtt
                ago = lambda h: (_dtt.datetime.now(_dtt.timezone.utc) - _dtt.timedelta(hours=h)).isoformat()
                T = lambda i, title, who, status, **kw: {'id': i, 'title': title, 'for': who, 'by': 'LOOP', 'source': None, 'status': status,
                                                        'waiting_on': None, 'created': ago(30), 'updated': ago(2), 'note': None, **kw}
                open_q = next(i['id'] for i in json.loads((repo / 'index.json').read_text())['items'] if i['section'] == 'question')
                (repo / 'state/tasks.json').write_text(json.dumps([
                    T('T-0001', 'Write the methods section', 'MED-y', 'todo'),
                    T('T-0002', 'Fix the parser', 'IMPLEMENT-app', 'doing', source='https://github.com/o/Finbar_loop_app/pull/36'),
                    T('T-0003', 'Run the fit', 'HIGH-paper', 'waiting', waiting_on='Q-0001', source='Q-0001'),
                    T('T-0004', 'Draft the figure', 'HIGH-paper', 'doing'),
                    T('T-0005', 'Old work', 'HIGH-paper', 'done', updated=ago(24)),
                    T('T-0006', 'Ancient work', 'LOW-x', 'done', updated=ago(24 * 9)),
                    T('T-0007', 'Post the bundle', 'MED-y', 'waiting', waiting_on='T-0001'),
                    T('T-0008', 'Merge main in', 'MED-y', 'waiting', waiting_on='https://github.com/o/CUFLynx/pull/386'),
                    T('T-0009', 'Undraft', 'MED-y', 'waiting', waiting_on='CI on #388'),
                    T('T-0010', 'Merge CAM #89', 'HIGH-merge-coordination-3', 'waiting', waiting_on='CI on #89', pr='https://github.com/o/CAM/pull/89'),
                    T('T-0011', 'Release', 'MED-y', 'waiting', waiting_on='T-0010'),
                    T('T-0012', 'Pick the mesh', 'HIGH-paper', 'waiting', waiting_on=open_q)]))
                # Each agent's tasks sit under its live state (status.json): working now, blocked, idle.
                st_saved = (repo / 'state/status.json').read_text()
                st = json.loads(st_saved)
                st['agents'] = [r for r in st['agents'] if r['name'] not in ('HIGH-paper', 'IMPLEMENT-app', 'MED-y')] + [
                    {**st['agents'][0], 'name': 'HIGH-paper', 'state': 'working', 'why': '', 'items': []},
                    {**st['agents'][0], 'name': 'IMPLEMENT-app', 'state': 'blocked', 'why': 'waiting on Finbar', 'items': ['Q-0001']},
                    {**st['agents'][0], 'name': 'MED-y', 'state': 'stalled', 'why': 'idle: parked until asked', 'items': []}]
                (repo / 'state/status.json').write_text(json.dumps(st))
                page.goto(base + '#/tasks')
                page.reload()
                page.wait_for_selector('.tgroup')
                page.locator('.switch button', has_text='All').click()
                page.wait_for_selector('.switch button.on >> text=All')
                grp = page.locator('.tgroup').evaluate_all("(gs) => gs.map((g) => [g.dataset.agent, [...g.querySelectorAll('.trow')].map((r) => r.dataset.task + ' ' + r.querySelector('.tchip').textContent)])")
                check(page, page.locator('.meta a.on').inner_text() == 'Tasks' and grp == [
                    ['HIGH-paper', ['T-0004 doing', 'T-0003 waiting on Q-0001 (answered)', f'T-0012 waiting on {open_q}']],
                    ['IMPLEMENT-app', ['T-0002 doing']], ['HIGH-merge-coordination-3', ['T-0010 waiting on CI on #89']],
                    ['MED-y', ['T-0007 waiting on T-0001 (MED-y)', 'T-0008 waiting on CUFLynx #386 (not reviewed)', 'T-0009 waiting on CI on #388',
                               'T-0011 waiting on T-0010 (merge CAM #89)', 'T-0001 queued']]],
                      f'Tasks: grouped by live state, then role order, doing first, todo as queued, with chips {grp}', failures)
                secs = page.locator('.tsection').all_inner_texts()
                states = page.locator('.tgroup').evaluate_all("(gs) => gs.map((g) => g.querySelector('.tstate').textContent)")
                check(page, secs == ['Working now 1', 'Blocked 1', 'Idle 2'] and states == [
                    'working now', 'blocked on Q-0001', 'idle: not seen recently', 'idle: parked until asked'],
                      f'Tasks: sections by live state, each agent with its state {secs} {states}', failures)
                row = page.locator('.trow[data-task="T-0002"]').inner_text()
                check(page, 'Fix the parser' in row and 'Finbar_loop_app #36' in row and 'updated 2 h ago' in row
                      and page.locator('.trow[data-task="T-0003"] .tchip a[href="#/item/Q-0001"]').count() == 1,
                      f'Tasks: a task shows its age and links its source and the item it waits on {row!r}', failures)
                # A task waiting on another task, a PR or free text never links to a loop item (which would 404).
                chips = {i: page.locator(f'.trow[data-task="{i}"] .tchip a').evaluate_all("(as) => as.map((a) => a.getAttribute('href'))")
                         for i in ('T-0007', 'T-0008', 'T-0009')}
                check(page, chips == {'T-0007': ['#/tasks'], 'T-0008': ['https://github.com/o/CUFLynx/pull/386'], 'T-0009': []},
                      f'Tasks: what a task waits on links to the task, the PR or nothing {chips}', failures)
                page.locator('.trow[data-task="T-0007"] .tchip a').click()
                check(page, page.url.endswith('#/tasks') and 'GitHub said 404' not in page.locator('#main').inner_text()
                      and page.locator('.trow[data-task="T-0001"]').is_visible(),
                      'Tasks: clicking the task another one waits on stays on the Tasks tab', failures)
                done = page.locator('details.tdone')
                check(page, done.count() == 1 and done.get_attribute('open') is None and 'Done in the last 7 days (1)' in done.inner_text(),
                      'Tasks: done ones collapsed, only the last 7 days', failures)
                page.locator('.switch button', has_text='Waiting on me').click()
                page.wait_for_selector('.switch button.on >> text=Waiting on me')
                check(page, [r.get_attribute('data-task') for r in page.locator('.tgroup .trow').all()] == ['T-0012'],
                      'Tasks: "Waiting on me" is only open, unanswered items (T-0003 waits on an answered one)', failures)
                check(page, narrow(), 'Tasks: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-tasks.png', full_page=True)
                page.locator('.switch button', has_text='All').click()
                (repo / 'state/status.json').write_text(st_saved)
                # The Manual tab was called Mine: old links redirect.
                meta = page.locator('.meta a').all_inner_texts()
                check(page, meta[:3] == ['Agents', 'Tasks', 'Manual'], f'header tabs Agents, Tasks and Manual {meta}', failures)
                page.goto(base + '#/mine/write')
                page.wait_for_url('**#/manual/write')
                page.wait_for_selector('.tabs a.on[href="#/manual/write"]')
                check(page, page.locator('.meta a.on').inner_text() == 'Manual', 'an old #/mine/write link opens Manual > Write', failures)
                # Manual: drop a paper under High, pick its Zotero collection, set a deadline, tick it done.
                import datetime as _dt
                page.goto(base + '#/manual/read')
                page.wait_for_selector('.mgroup.prio-high .dropzone')
                check(page, page.locator('.mgroup').count() == 3, 'Read: High / Medium / Low groups', failures)
                (tmp_l / 'A_paper_to_read.png').write_bytes(PNG)
                page.locator('.mgroup.prio-high input[type=file]').set_input_files(str(tmp_l / 'A_paper_to_read.png'))
                form = page.locator('.mgroup > .newentry')
                form.locator('.colsel').wait_for()
                check(page, form.locator(':scope > label > input[type=text]').count() == 0 and form.locator('.autotitle').count() == 1,
                      'Read: no title box for a paper (the loop titles it from its record)', failures)
                form.locator('input[type=search]').fill('opinf')
                check(page, form.locator('.colsel option:not([hidden])').count() == 1, 'collection filter', failures)
                # a new collection from the form: requested, then selected once the loop has made it
                nc = form.locator('details.newcol')
                form.locator('.colsel').select_option('BBBB2222')
                nc.locator('summary').click()
                check(page, nc.locator('select').input_value() == 'BBBB2222', '"Inside" defaults to the chosen collection', failures)
                nc.locator('input[type=text]').fill('Beat maps')
                nc.locator('select').select_option('AAAA1111')
                nc.locator('button.primary').click()
                nc.locator('.status >> text=/will be made in Zotero within about a minute/').wait_for()
                reqs = [json.loads(f.read_text()) for f in (repo / 'zotero_requests').glob('*.json')]
                check(page, reqs and reqs[0] == {'name': 'Beat maps', 'parent_key': 'AAAA1111', 'parent_name': 'ROM'},
                      f'new collection requested {reqs}', failures)
                cols = json.loads((repo / 'state/zotero_collections.json').read_text())
                cols['collections'].append({'key': 'NEWC0001', 'id': None, 'name': 'ROM / Beat maps', 'pending': True})
                (repo / 'state/zotero_collections.json').write_text(json.dumps(cols))
                nc.locator('.status >> text=/^Made "ROM \\/ Beat maps" in Zotero/').wait_for(timeout=15000)
                check(page, form.locator('.colsel').input_value() == 'NEWC0001', 'new collection selected', failures)
                form.locator('.colsel').select_option('BBBB2222')
                form.locator(':scope > .row button.primary').click()
                page.wait_for_selector('.mrow >> text=A paper to read')
                ents = [json.loads(f.read_text()) for f in (repo / 'personal').glob('read-*/entry.json')]
                check(page, ents and ents[0]['priority'] == 'high' and ents[0]['zotero']['collection_id'] == 2
                      and ents[0]['title'] == 'A paper to read'
                      and ents[0]['files'] == ['A_paper_to_read.png'] and (repo / 'personal' / ents[0]['id'] / 'A_paper_to_read.png').exists(),
                      f'Read entry written with its file and collection {ents[:1]}', failures)
                check(page, 'to Zotero: ROM / OpInf' in page.locator('.mrow').first.inner_text(), 'Zotero badge', failures)
                soon = (_dt.date.today() + _dt.timedelta(days=2)).isoformat()
                page.locator('.mrow .due').first.click()
                page.locator('.mrow .datein').fill(soon)
                page.locator('.mrow .datein').dispatch_event('change')
                page.wait_for_selector('.mrow .due.soon')
                check(page, json.loads((repo / 'personal' / ents[0]['id'] / 'entry.json').read_text())['deadline'] == soon,
                      'deadline saved', failures)
                # a paper's Notes save as you type; its Summary shows what paper_summary attached
                row = page.locator('.mrow', has_text='A paper to read')
                row.locator('details.pextra', has_text='Notes').locator('summary').click()
                row.locator('textarea.pnotes').fill('uses a return map\nerror grows like k eta')
                page.wait_for_selector('.mrow .status >> text=/^Saved;/')
                check(page, (repo / 'personal' / ents[0]['id'] / 'notes.md').read_text() == 'uses a return map\nerror grows like k eta',
                      'paper notes saved', failures)
                (tmp_l / 'sum.json').write_text(json.dumps({'blocks': [{'type': 'callout', 'tone': 'note', 'md': 'It builds a beat map.'}]}))
                loop(loop_bin, repo, 'summary', ents[0]['id'], '--spec', str(tmp_l / 'sum.json'))
                page.goto(base + '#/manual/write')
                page.goto(base + '#/manual/read')
                page.wait_for_selector('.mrow details.pextra >> text=Summary')
                row = page.locator('.mrow', has_text='A paper to read')
                row.locator('details.pextra', has_text='Summary').locator('summary').click()
                page.wait_for_selector('.mrow .pextra aside.callout')
                check(page, 'It builds a beat map.' in row.inner_text(), 'paper summary shown', failures)
                page.goto(base + '#/manual/write')
                page.wait_for_selector('.newentry input[type=url]')
                page.locator('.mine > .newentry input[type=text]').fill('Paper 1 draft')
                page.locator('.mine > .newentry input[type=url]').fill('https://www.overleaf.com/project/abc')
                page.locator('.mine > .newentry button.primary').click()
                page.wait_for_selector('.mrow a[href="https://www.overleaf.com/project/abc"]')
                check(page, True, 'Write: Overleaf link added', failures)
                page.goto(base + '#/manual/student')
                page.wait_for_selector('.switch button >> text=Ben')
                page.locator('.switch button', has_text='Ben').click()
                page.wait_for_selector('.switch button.on >> text=Ben')
                page.wait_for_function("document.querySelectorAll('.mgroup').length === 1")
                page.locator('.mgroup details.addlink summary').click()
                page.locator('.mgroup details.addlink input[type=url]').fill('https://www.overleaf.com/project/thesis')
                page.locator('.mgroup details.addlink button.primary').click()
                page.wait_for_selector('.mrow a[href="https://www.overleaf.com/project/thesis"]')
                lk = [json.loads(f.read_text()) for f in (repo / 'personal').glob('student-*/entry.json')]
                check(page, lk and lk[0]['student'] == 'Ben' and lk[0]['link'].endswith('/thesis'), 'Students: a link for Ben', failures)
                page.locator('.mgroup input[type=file]').set_input_files(str(tmp_l / 'fig.png'))
                page.locator('.mgroup > .newentry button.primary').click()
                page.locator('.mrow').nth(1).wait_for()
                st = [json.loads(f.read_text()) for f in sorted((repo / 'personal').glob('student-*/entry.json'))]
                st = [x for x in st if x.get('files')]
                check(page, st and st[0]['student'] == 'Ben', 'Students: file filed under Ben', failures)
                page.locator('.mrow', has_text='fig').locator('input[type=checkbox]').check()
                page.wait_for_selector('details.history >> text=Done (1)')
                check(page, json.loads((repo / 'personal' / st[0]['id'] / 'entry.json').read_text())['done'], 'ticked done', failures)
                check(page, narrow(), 'Manual: no sideways scroll', failures)
                if shots:
                    page.goto(base + '#/manual/read')
                    page.wait_for_selector('.mrow')
                    page.screenshot(path=f'{shots}/{label}-mine.png', full_page=True)

                # Read: ticking done without a note asks for one; with a note it ticks and dates the tick.
                rj = lambda i: json.loads((repo / 'personal' / i / 'entry.json').read_text())
                def seed(eid, **kw):
                    (repo / 'personal' / eid).mkdir(parents=True, exist_ok=True)
                    e = {'id': eid, 'kind': 'read', 'priority': 'low', 'deadline': None, 'done': False,
                         'created': '2026-01-01T00:00:00Z', 'files': [], **kw}
                    (repo / 'personal' / eid / 'entry.json').write_text(json.dumps(e))
                seed('read-nonote', title='Unnoted paper', zotero={'name': 'ROM / OpInf'})
                # A saved paper: its key title as the heading, "journal · full title" below it in smaller text.
                seed('read-key', title='Smith2026Hopfit', title_from='record', key_title='Smith2026Hopfit', journal='J Clin Monit Comput',
                     full_title='HOPFIT: A neuro-cardiovascular monitoring framework')
                seed('read-typed', title='My own title', key_title='Smith2025Atlas', journal='Physiol Rep', full_title='An atlas')
                seed('read-norec', title='2011.03959v1', files=['2011.03959v1.pdf'], title_warning='no bibliographic record: title from file name')
                page.goto(base + '#/manual/read')
                page.reload()
                krow = page.locator('.mrow', has_text='Smith2026Hopfit')
                krow.wait_for()
                sub = krow.locator('.msub')
                small = page.evaluate("(r) => [parseFloat(getComputedStyle(r.querySelector('.mtitle')).fontSize), parseFloat(getComputedStyle(r.querySelector('.msub')).fontSize)]",
                                      krow.element_handle())
                check(page, krow.locator('.mtitle').inner_text() == 'Smith2026Hopfit'
                      and sub.inner_text() == 'J Clin Monit Comput · HOPFIT: A neuro-cardiovascular monitoring framework' and small[1] < small[0],
                      f'Read: key title as the heading, "journal · full title" below in smaller text {small}', failures)
                trow = page.locator('.mrow', has_text='My own title')
                check(page, trow.locator('.mtitle').inner_text() == 'My own title' and trow.locator('.msub').inner_text() == 'Physiol Rep · An atlas',
                      'Read: a typed title stays the heading', failures)
                check(page, page.locator('.mrow', has_text='Unnoted paper').locator('.msub').count() == 0, 'Read: no subtitle without a record', failures)
                wrow = page.locator('.mrow', has_text='2011.03959v1')
                check(page, wrow.locator('.mwarn').inner_text() == '⚠ no bibliographic record: title from file name'
                      and page.locator('.mrow', has_text='Smith2026Hopfit').locator('.mwarn').count() == 0,
                      'Read: a paper with no bibliographic record shows the warning', failures)
                if shots:
                    krow.screenshot(path=f'{shots}/{label}-read-key-title.png')

                # Add to paper lib: a paper saved to Zotero (item key known) gets a picker of the _work paper libraries,
                # its current ones ticked; saving writes one zotero_requests file; the loop's result updates the chips.
                cols_f = repo / 'state/zotero_collections.json'
                cols_f.write_text(json.dumps({'collections': json.loads(cols_f.read_text())['collections'] + [
                    {'key': 'WORK0000', 'id': None, 'name': '_work'}, {'key': 'WPAP0000', 'id': None, 'name': '_work / papers'},
                    {'key': 'WORKA000', 'id': None, 'name': '_work / papers / paper_a'},
                    {'key': 'WORKJ000', 'id': None, 'name': '_work / my_papers / journal'},
                    {'key': 'GRANT000', 'id': None, 'name': '_work / grants / amrf'}]}))
                seed('read-lib', title='Lib paper', zotero={'collection': 'BBBB2222', 'name': 'ROM / OpInf'})
                (repo / 'personal/read-lib/zotero.json').write_text(json.dumps({'status': 'saved', 'key': 'ITEM0001', 'work': ['WORKA000']}))
                seed('read-desk', title='Desktop paper', zotero={'collection': 'BBBB2222', 'name': 'ROM / OpInf'})
                (repo / 'personal/read-desk/zotero.json').write_text(json.dumps({'status': 'saved', 'via': 'desktop'}))
                page.reload()
                lrow = page.locator('.mrow', has_text='Lib paper')
                lrow.locator('.plibbtn').wait_for()
                check(page, lrow.locator('.badge.plib').all_inner_texts() == ['papers/paper_a'], 'Paper lib: chip for the library it is in', failures)
                check(page, page.locator('.mrow', has_text='Desktop paper').locator('.plibbtn').count() == 0,
                      'Paper lib: no button without a Zotero item key', failures)
                lrow.locator('.plibbtn').click()
                opts = lrow.locator('.plibopt')
                check(page, opts.all_inner_texts() == ['my_papers / journal', 'papers / paper_a']
                      and [o.locator('input').is_checked() for o in opts.all()] == [False, True],
                      f'Paper lib: picker lists papers and my_papers libraries, current one ticked {opts.all_inner_texts()}', failures)
                opts.nth(0).locator('input').check()
                opts.nth(1).locator('input').uncheck()
                lrow.locator('.plibpick input[type=text]').fill('Paper Three!')
                lrow.locator('.plibpick button', has_text='New paper lib').click()
                lrow.locator('.plibopt.new', has_text='papers / paper_three (new)').wait_for()
                check(page, narrow(), 'Paper lib: picker has no sideways scroll', failures)
                if shots:
                    lrow.screenshot(path=f'{shots}/{label}-paper-lib-picker.png')
                lrow.locator('.plibpick button.primary').click()
                lrow.locator('.plibpick .status', has_text='within about a minute').wait_for()
                reqs = [(f, json.loads(f.read_text())) for f in (repo / 'zotero_requests').glob('*.json')] if (repo / 'zotero_requests').exists() else []
                reqs = [(f, r) for f, r in reqs if r.get('kind') == 'work']
                check(page, [r for _, r in reqs] == [{'kind': 'work', 'entry': 'read-lib', 'add': ['WORKJ000'], 'remove': ['WORKA000'], 'new': ['paper_three']}],
                      f'Paper lib: one request: add, remove, new (lower_snake_case) {[r for _, r in reqs]}', failures)
                if reqs:
                    reqs[0][0].with_suffix('.result.json').write_text(json.dumps({'status': 'done', 'entry': 'read-lib', 'work': ['WORKJ000', 'NEWC0001']}))
                    (repo / 'personal/read-lib/zotero.json').write_text(json.dumps({'status': 'saved', 'key': 'ITEM0001', 'work': ['WORKJ000', 'NEWC0001']}))
                    cols_f.write_text(json.dumps({'collections': json.loads(cols_f.read_text())['collections'] + [
                        {'key': 'NEWC0001', 'id': None, 'name': '_work / papers / paper_three', 'pending': True}]}))
                    page.locator('.mrow', has_text='Lib paper').locator('.badge.plib', has_text='paper_three').wait_for(timeout=15000)
                    chips = page.locator('.mrow', has_text='Lib paper').locator('.badge.plib').all_inner_texts()
                    check(page, chips == ['my_papers/journal', 'papers/paper_three'], f'Paper lib: chips follow the loop result {chips}', failures)
                row = page.locator('.mrow', has_text='Unnoted paper')
                row.locator('.mcheck input').click()       # the app un-ticks it and asks for a note
                row.locator('.status.ask-note').wait_for()
                check(page, not rj('read-nonote')['done'] and not row.locator('.mcheck input').is_checked()
                      and row.locator('details.pextra', has_text='Notes').get_attribute('open') is not None,
                      'Read: ticking without a note opens Notes and does not tick', failures)
                row.locator('textarea.pnotes').fill('a note')
                page.wait_for_selector('.mrow .status >> text=/^Saved;/')
                row.locator('.mcheck input').check()
                page.wait_for_selector('details.history .mrow >> text=Unnoted paper', state='attached')
                check(page, rj('read-nonote')['done'] and rj('read-nonote').get('done_at'), 'Read: ticked with a note, done_at set', failures)

                # Write: draft v1 -> v2, submitted, DOI (normalised), citations shown, published moves it to Done.
                wid = [json.loads(f.read_text()) for f in (repo / 'personal').glob('write-*/entry.json')][0]['id']
                page.goto(base + '#/manual/write')
                row = page.locator('.mrow', has_text='Paper 1 draft')
                check(page, row.locator('.mcheck').count() == 0, 'Write: no single done tick', failures)
                row.locator('.wstate', has_text='Draft').locator('input').check()
                page.wait_for_selector('.mrow .wver >> text=v1')
                page.locator('.mrow', has_text='Paper 1 draft').locator('.wup').click()
                page.wait_for_selector('.mrow .wver >> text=v2')
                page.locator('.mrow', has_text='Paper 1 draft').locator('.wstate', has_text='Submitted').locator('input').check()
                page.locator('.mrow', has_text='Paper 1 draft').locator('.wstate', has_text='Submitted').locator('input:checked').wait_for()
                doi = '10.1016/j.cmpb.2026.109528'
                (repo / 'state' / 'citations.json').write_text(json.dumps({'dois': {doi: {'count': 12, 'status': 'ok'}}}))
                d = page.locator('.mrow', has_text='Paper 1 draft').locator('.wdoi')
                d.fill('https://doi.org/' + doi)
                d.dispatch_event('change')
                page.wait_for_selector('.mrow .badge >> text=12 citations')
                w = rj(wid)
                check(page, w['draft'] == 2 and w['submitted'] and w.get('submitted_at') and w['doi'] == doi and not w['done'],
                      f'Write: draft v2, submitted, DOI saved {w}', failures)
                page.locator('.mrow', has_text='Paper 1 draft').locator('.wstate', has_text='Published').locator('input').check()
                page.wait_for_selector('details.history >> text=Done (1)')
                w = rj(wid)
                check(page, w['published'] and w.get('published_at') and w['done'] and w.get('done_at'), 'Write: published is done', failures)

                # Delete (requests 6, 7): a confirm step (Cancel goes back), then delete_requests/<id>.json; the entry leaves
                # the lists at once and shows under Deleting (with the loop's reason while it waits) until the loop removes it.
                page.goto(base + '#/manual/read')
                drow = page.locator('.mrow', has_text='Desktop paper')
                drow.locator('.mdelbtn').click()
                ask = drow.locator('.mdelask')
                check(page, "Zotero's trash" in ask.inner_text() and not (repo / 'delete_requests/read-desk.json').exists(),
                      f'Delete: a paper in Zotero asks first, naming the trash: {ask.inner_text()!r}', failures)
                if shots:
                    drow.screenshot(path=f'{shots}/{label}-delete-confirm.png')
                ask.locator('button', has_text='Cancel').click()
                check(page, drow.locator('.mdelbtn').count() == 1 and drow.locator('.mdelask').count() == 0, 'Delete: Cancel goes back', failures)
                drow.locator('.mdelbtn').click()
                drow.locator('.mdelyes').click()
                page.locator('.mdeleting .mrow', has_text='Desktop paper').wait_for()
                req = json.loads((repo / 'delete_requests/read-desk.json').read_text())
                check(page, req['entry'] == 'read-desk' and req['kind'] == 'read'
                      and page.locator('.mgroup .mrow', has_text='Desktop paper').count() == 0,
                      f'Delete: request written, the paper leaves the list {req}', failures)
                (repo / 'delete_requests/read-desk.waiting').write_text(json.dumps({'status': 'waiting', 'why': 'Zotero unreachable'}))
                page.reload()
                page.locator('.mdeleting .status', has_text='Waiting: Zotero unreachable').wait_for()
                if shots:
                    page.locator('.mdeleting').screenshot(path=f'{shots}/{label}-deleting.png')
                shutil.rmtree(repo / 'personal/read-desk')                 # what `loop delete` does
                shutil.rmtree(repo / 'delete_requests')
                page.reload()
                page.locator('.mrow', has_text='Lib paper').wait_for()
                check(page, page.locator('.mdeleting').count() == 0 and page.locator('.mrow', has_text='Desktop paper').count() == 0,
                      'Delete: gone once the loop removed it', failures)
                seed('write-old', kind='write', title='Old essay', submitted=True)
                page.goto(base + '#/manual/write')
                orow = page.locator('.mrow', has_text='Old essay')
                orow.locator('.mdelbtn').click()
                check(page, 'animal leaves the tree' in orow.locator('.mdelask').inner_text(), 'Delete: a submitted Write entry says its animal leaves', failures)
                orow.locator('.mdelyes').click()
                page.locator('.mdeleting .mrow', has_text='Old essay').wait_for()
                check(page, json.loads((repo / 'delete_requests/write-old.json').read_text())['kind'] == 'write',
                      'Delete: a Write entry is deleted the same way', failures)
                shutil.rmtree(repo / 'personal/write-old')
                shutil.rmtree(repo / 'delete_requests')

                # A young tree (one paper so far, Q-0036): a few centimetres tall beside the fruit pile. The default view shows
                # a marker with its height over the trunk's foot; tapping it zooms onto the tree, its wood seen up close.
                page.goto(base + '#/tree')
                page.reload()
                page.wait_for_selector('.gview .sprout text')
                mk = page.locator('.gview .sprout text').text_content()
                check(page, re.fullmatch(r'tree: \d+ cm ↓', mk) is not None and 'cm' in page.locator('.ghead').inner_text(),
                      f'Young tree: a marker with its height in cm {mk!r}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-young-tree.png')
                # Zoomed onto the whole tree: the tree's drawing (wood, height scale, animal) inside the view and filling it
                # across or up, as far as it can be zoomed without cutting part of it off. Measured as a share of the view, since
                # a phone's narrow view fits the drawing's width and a computer's its height. The frame's margins leave it ~80% of the
                # view; before the tap it fills ~2%.
                fill = """() => { const v = document.querySelector('.gview').getBoundingClientRect();
                    const t = document.querySelector('.gview .tree').getBoundingClientRect();
                    const r = [...document.querySelectorAll('.gview .tree .hits [data-k="seg"]')].map((n) => n.getBoundingClientRect());
                    return { across: (t.right - t.left) / v.width, up: (t.bottom - t.top) / v.height, wood: r.length > 0,
                      inside: [t, ...r].every((b) => b.left >= v.left - 1 && b.right <= v.right + 1 && b.top >= v.top - 1 && b.bottom <= v.bottom + 1) }; }"""
                before = page.evaluate(fill)
                page.locator('.gview .hits [data-k="sprout"]').dispatch_event('click')
                vy = [float(x) for x in page.locator('.gview svg').first.get_attribute('viewBox').split()]
                wood = page.evaluate(fill)
                check(page, not page.locator('.gview .sprout text').is_visible(), 'Young tree: zoomed in, the marker is hidden', failures)
                check(page, max(before['across'], before['up']) < 0.2 and vy[2] < 12 and wood['wood'] and wood['inside']
                      and max(wood['across'], wood['up']) >= 0.6,
                      f'Young tree: tapping the marker zooms onto the whole tree {vy} {before} {wood}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-young-tree-zoom.png')
                page.locator('.gzoom button', has_text='Reset').click()
                page.goto(base + '#/list')
                # Tree: papers read on past days in two collections, one met deadline (a leaf), the animal.
                import datetime as _dt2
                for k, (name, days) in enumerate([('ROM / OpInf', 3), ('ROM / OpInf', 2), ('ROM / Beat maps', 2),
                                                  ('Physiology', 1), ('ROM', 1), (None, 0)]):
                    at = (_dt2.datetime.now() - _dt2.timedelta(days=days)).replace(hour=10).astimezone().isoformat()
                    dl = (_dt2.date.today() - _dt2.timedelta(days=days - 1)).isoformat() if k == 0 else None
                    seed(f'read-tree{k}', title=f'Tree paper {k}', done=True, done_at=at, deadline=dl,
                         **({'zotero': {'name': name}} if name else {}))
                # Deadline birds: one open (a gull flying in), one passed ten days ago and not done (a crow on the tree).
                seed('bird-soon', kind='other', title='Grant report', deadline=(_dt2.date.today() + _dt2.timedelta(days=5)).isoformat())
                seed('bird-late', kind='other', title='Referee report', deadline=(_dt2.date.today() - _dt2.timedelta(days=10)).isoformat())
                page.goto(base + '#/tree')
                # The tree draws from the cached repo tree first, then redraws once the background reload sees the
                # papers seeded above: wait for a seeded paper's segment, so the tap lands on the final drawing.
                page.wait_for_selector('.gview svg .hits [data-k="seg"][data-i="read-tree2"]', state='attached')
                check(page, page.locator('.meta a.on').inner_text() == 'Tree', 'Tree tab in the header', failures)
                head = page.locator('.ghead').inner_text()
                check(page, 'seedling' in head and 'papers' in head and 'days in a row' in head, f'Tree: stage, streak and counts {head!r}', failures)
                page.locator('.hits [data-k="seg"][data-i="read-tree2"]:not([data-b="trunk"])').first.dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                check(page, 'Tree paper 2' in info and 'ROM / Beat maps' in info and '1.2x' in info,
                      f'Tree: tapping a branch segment shows its paper and collection {info!r}', failures)
                check(page, page.locator('.hits .on').count() >= 1 and page.locator('.hits .on[data-b="trunk"]').count() == 0,
                      'Tree: the tapped paper lights up on its branches', failures)
                # The trunk (a paper's rise, or the paper in no collection) shows the topics read, not one paper.
                page.locator('.hits [data-k="seg"][data-i="read-tree2"][data-b="trunk"]').first.dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                topics = page.locator('.ginfo .gtopics li').all_inner_texts()
                check(page, 'what you have read' in info and 'Tree paper' not in info and len(topics) == 3
                      and topics[0].startswith('ROM 5 (71%)') and 'OpInf 3 · Beat maps 1' in topics[0]
                      and topics[1].startswith('Physiology 1') and topics[2].startswith('No collection 1'),
                      f'Tree: tapping the trunk shows the topics read {topics!r}', failures)
                check(page, page.locator('.hits .on').count() == page.locator('.hits [data-b="trunk"]').count(),
                      'Tree: the whole trunk lights up', failures)
                if shots:
                    page.locator('.ginfo').screenshot(path=f'{shots}/{label}-trunk-topics.png')
                page.locator(f'.hits [data-k="creature"][data-i="{wid}"]').dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                check(page, 'Paper 1 draft' in info and '12 citations' in info, f'Tree: tapping the animal shows its paper {info!r}', failures)
                log = page.locator('.glog').inner_text()
                check(page, 'Tree paper 0' in log and 'a leaf' in log and 'arrived' in log, 'Tree: growth log', failures)
                birds = page.evaluate("""() => ({
                  gull: !!document.querySelector('.gview .birds .bird[data-i="bird-soon"] line[stroke-dasharray]'),
                  above: (() => { const l = document.querySelector('.gview .birds .bird[data-i="bird-soon"] line');
                    return !!l && +l.getAttribute('y1') < +l.getAttribute('y2'); })(),
                  crowFlies: !!document.querySelector('.gview .birds .bird[data-i="bird-late"]'),
                  crow: !!document.querySelector('.gview .tree .hits [data-k="bird"][data-i="bird-late"]'),
                  legend: [...document.querySelectorAll('.hlegend span')].some((x) => x.textContent.startsWith('Birds')) })""")
                check(page, birds == {'gull': True, 'above': True, 'crowFlies': False, 'crow': True, 'legend': True},
                      f'Birds: an open deadline flies down to its crown node along a dashed line, a passed one perches on the tree {birds}', failures)
                page.locator('.gview .hits [data-k="bird"][data-i="bird-soon"]').dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                check(page, 'Grant report' in info and 'in 5 d' in info and 'flying in' in info, f'Birds: tapping a bird shows its deadline {info!r}', failures)
                page.locator('.gview .tree .hits [data-k="bird"][data-i="bird-late"]').dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                check(page, 'Referee report' in info and '10 d overdue' in info and 'crow' in info, f'Birds: tapping the crow shows the passed deadline {info!r}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-birds.png')
                # Real pointers on the young tree in the default view (Finbar's 1.9 m tree is ~4 px a paper on a phone): a tap (phone)
                # or a hover (computer) on each paper's own spot on a branch selects it, on the trunk selects the trunk, and a
                # point a finger's width off the tree still picks the tree, not the farm or nothing.
                page.locator('.gzoom button', has_text='Reset').click()
                segw = lambda: page.evaluate("""() => Math.max(...[...document.querySelectorAll('.gview .tree .hits [data-k="seg"]')]
                    .map((n) => n.getBoundingClientRect().width))""")
                page.evaluate("document.querySelectorAll('.gview .tree .hits [data-k=creature], .gview .tree .hits [data-k=bird]').forEach((n) => n.remove())")  # they cover this tree
                v = page.locator('.gview').bounding_box()
                if label == 'computer':
                    page.mouse.click(v['x'] + 3, v['y'] + 3)                                 # open ground: unpin
                segs = page.evaluate("""() => [...document.querySelectorAll('.gview .tree .hits [data-k="seg"]')].map((n) => {
                    const b = n.getBoundingClientRect(), x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
                    const t = document.elementFromPoint(x, y); const h = t && t.closest('[data-k]');
                    return { i: n.dataset.i, b: n.dataset.b, x, y, own: !!h && h.dataset.i === n.dataset.i, l: b.left, r: b.right, top: b.top, bottom: b.bottom }; })""")
                def point(x, y, tap=label == 'phone'):
                    if tap:
                        page.touchscreen.tap(x, y) if label == 'phone' else page.mouse.click(x, y)
                    else:
                        page.mouse.move(x, y)
                    on = page.evaluate("[...document.querySelectorAll('.gview .hits .on')].map((n) => n.dataset.k + ':' + (n.dataset.b === 'trunk' ? 'trunk' : n.dataset.i))")
                    return on[0] if on else None
                spots = {(s['i'], s['b']): s for s in segs if s['own']}
                got = {(i, b) for (i, b), s in spots.items() if point(s['x'], s['y']) in ((f'seg:{i}',) if b != 'trunk' else ('seg:trunk', 'branch:trunk'))}
                off = 12 if label == 'phone' else 7
                edge = max(segs, key=lambda s: s['r'])
                near = point(edge['r'] + off, (edge['top'] + edge['bottom']) / 2, tap=True)   # a click: hover never clears
                check(page, len(spots) >= 2 and got == set(spots) and near and near.split(':')[0] in ('seg', 'branch'),
                      f'Tree: each paper ({segw():.0f} px wide) is picked by a real {"tap" if label == "phone" else "hover"},'
                      f' and the tree {off} px off it {len(spots)} {sorted(set(spots) - got)} {near}', failures)
                page.locator('.gzoom button', has_text='Reset').click()                          # redraws, the animal back
                cr = page.locator(f'.gcreature[data-i="{wid}"]')
                cr.locator('input').fill('Hopper')
                cr.locator('select').select_option('owl')
                cr.locator('button.primary').click()
                page.wait_for_selector('.gview svg text >> text=Hopper')
                td = json.loads((repo / 'personal' / 'tree.json').read_text())
                check(page, td['creatures'][wid] == {'name': 'Hopper', 'animal': 'owl'} and td['seed'],
                      f'Tree: animal named, personal/tree.json written {td}', failures)
                page.locator('.gtools .wstate input').check()
                page.wait_for_selector('.gview svg text >> text=Beat maps')
                check(page, True, 'Tree: branch names shown', failures)
                page.locator('.gtools .wstate input').uncheck()
                page.wait_for_selector('.gview svg .hits')
                vb = lambda: page.evaluate("(() => { const b = document.querySelector('.gview svg').viewBox.baseVal; return [b.x, b.y, b.width, b.height]; })()")
                v0 = vb()
                page.locator('.gzoom button', has_text='+').click()
                check(page, vb()[2] < v0[2] * 0.75, f'Tree: zoom in {v0} -> {vb()}', failures)
                page.locator('.gzoom button', has_text='Reset').click()
                check(page, all(abs(a - b) < 0.05 for a, b in zip(vb(), v0)), f'Tree: Reset goes back to the first view {v0} {vb()}', failures)
                check(page, narrow(), 'Tree: no sideways scroll', failures)
                if shots:
                    page.locator('.gzoom button', has_text='Whole tree').click()
                    page.screenshot(path=f'{shots}/{label}-tree.png', full_page=True)
                    page.locator('.gzoom button', has_text='Reset').click()
                page.goto(base + '#/list')
                page.wait_for_selector('.card')
                if label == 'computer':
                    page.wait_for_selector('#gside .gmini svg')
                    check(page, 'seedling' in page.locator('#gside').inner_text(), 'wide screen: the tree in the side panel', failures)
                    if shots:
                        page.screenshot(path=f'{shots}/{label}-side.png')
                else:
                    check(page, not page.locator('#gside').is_visible(), 'phone: no side panel', failures)
                check(page, narrow(), 'board with the side panel: no sideways scroll', failures)

                # Status: usage, each agent with what it does, its entries, and a message box.
                page.goto(base + '#/status')
                page.wait_for_selector('.status-card .ulimit')
                check(page, 'A paper to read' in page.locator('.deadlines').inner_text()
                      and page.locator('.deadlines .dline.soon').count() == 1, 'Status warns of the upcoming deadline', failures)
                check(page, page.locator('.ulimit').count() == 3 and page.locator('.ufill.hi').count() == 1,
                      'usage bars (one near its limit)', failures)
                agent = page.locator('.agent', has_text='HIGH-session-a')
                check(page, 'Blocked' in page.locator('.status-card', has=agent).locator('h3').inner_text(),
                      'blocked agent under Blocked', failures)
                check(page, agent.locator('.alinks a', has_text='Q-0001').count() >= 1, 'blocked agent links its question', failures)
                check(page, 'drafting the run plan' in agent.inner_text(), 'what the agent is doing', failures)
                agent.locator('details.arecent summary').click()
                check(page, agent.locator('details.arecent a', has_text='Q-0001').count() == 1, "the agent's entries", failures)
                agent.locator('details.amsg summary').click()
                agent.locator('details.amsg textarea').fill('Do test 15 first.')
                agent.locator('details.amsg button.primary').click()
                page.wait_for_selector('details.amsg .status >> text=Sent')
                msgs = [json.loads(f.read_text()) for f in (repo / 'messages/aaaa0001').glob('*.json')]
                check(page, msgs and msgs[0]['text'] == 'Do test 15 first.' and msgs[0]['to'] == 'HIGH-session-a',
                      'message to the agent written', failures)
                check(page, narrow(), 'status: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-status.png', full_page=True)
                # Permission prompts: a `permission` item gets a badge and one-tap Approve/Deny; Status lists every decision.
                pid = loop(loop_bin, repo, 'post', 'question', '--from', 'HIGH-session-a', '--blocking',
                           'HIGH-session-a asks to run **Bash**. Flagged because: push to main/master.',
                           '--option', 'Approve', '--option', 'Deny')
                ip = repo / f'items/{pid}/item.json'
                it = json.loads(ip.read_text())
                it['title'] = 'Permission: Bash for HIGH-session-a: git push origin main'
                it['tags'] = ['permission']
                it['permission'] = {'request': 'r1', 'tool': 'Bash', 'target': 'git push origin main', 'cwd': '/w', 'reason': 'push to main/master'}
                it['questions'][0]['blocks'] = [{'type': 'text', 'md': '```\ngit push origin main\n```'}]
                ip.write_text(json.dumps(it))
                idx = json.loads((repo / 'index.json').read_text())
                for r in idx['items']:
                    if r['id'] == pid:
                        r['tags'], r['title'] = ['permission'], it['title']
                (repo / 'index.json').write_text(json.dumps(idx))
                (repo / 'state/permissions.json').write_text(json.dumps({'entries': [
                    {'id': 'r1', 'at': '2026-11-24T01:00:00Z', 'session': 'HIGH-session-a', 'tool': 'Bash', 'target': 'git push origin main',
                     'cwd': '/w', 'decision': 'asked', 'reason': 'push to main/master', 'by': 'rule'},
                    {'id': 'r0', 'at': '2026-11-24T00:59:00Z', 'session': 'LOW-x', 'tool': 'Read', 'target': '/w/' + 'long/' * 80 + 'a.py',
                     'cwd': '/w', 'decision': 'allow', 'reason': 'reads files', 'by': 'rule'}]
                    + [{'id': f'o{k}', 'at': '2026-11-23T00:00:00Z', 'session': 'MED-y', 'tool': 'Read', 'target': f'/w/{k}.py',
                        'cwd': '/w', 'decision': 'allow', 'reason': 'reads files', 'by': 'rule'} for k in range(12)]}))
                page.goto(base + '#/list/question')
                page.reload()
                page.locator('.card', has_text=pid).wait_for()
                check(page, page.locator('.card', has_text=pid).locator('.badge.perm').count() == 1, 'Permission: badge on its card', failures)
                page.goto(base + f'#/item/{pid}')
                page.wait_for_selector('.permbar .perm-yes')
                check(page, 'git push origin main' in page.locator('.question pre').first.inner_text(), 'Permission: the exact command shown', failures)
                page.locator('.permbar .perm-yes').dispatch_event('click')
                page.wait_for_selector('.permbar .status >> text=Approved')
                ans = [json.loads(f.read_text()) for f in (repo / f'answers/{pid}').glob('*.json')]
                check(page, len(ans) == 1 and ans[0]['choice'] == 'Approve' and ans[0]['answers'][0]['choice'] == 'Approve',
                      f'Permission: one tap writes the Approve answer {ans}', failures)
                check(page, page.locator('.permbar .perm-no').is_disabled(), 'Permission: no second answer after sending', failures)
                check(page, narrow(), 'permission item: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-permission.png', full_page=True)
                page.goto(base + '#/status')
                page.reload()
                page.wait_for_selector('.perms .permrow')
                rows = page.locator('.perms > .permrow')
                check(page, rows.count() == 12 and page.locator('.perms details.pmore .permrow').count() == 2,
                      f'Status: the latest 12 permission decisions, older folded ({rows.count()})', failures)
                check(page, 'asked you' in rows.nth(0).inner_text() and 'git push origin main' in rows.nth(0).inner_text()
                      and 'auto-approved' in rows.nth(1).inner_text(), 'Status: permission decisions newest first, labelled', failures)
                check(page, narrow(), 'status with permissions: no sideways scroll', failures)
                if shots:
                    page.locator('.perms').screenshot(path=f'{shots}/{label}-permissions.png')
                # The Permission view (ledger: status rows carry `permission`; patched in for the installed loop): hook
                # prompts, usage-guard denials (Approve sends the session an urgent "approve") and other dialogs.
                stp = repo / 'state/status.json'
                st = json.loads(stp.read_text())
                for r in st['agents']:
                    if r['name'] == 'HIGH-session-a':
                        r['permission'] = {'kind': 'dialog'}          # covered by its permission item: listed once
                guard = {'kind': 'guard', 'tool': 'Bash', 'target': 'python run_calibration.py --seeds 5',
                         'why': "USAGE GUARD: weekly usage is at 96%. Running a command needs the user's approval until the weekly reset.",
                         'since': '2026-11-24T00:00:00Z'}
                st['agents'] += [
                    {'name': 'MED-guarded', 'job': 'bbbb0002', 'state': 'blocked', 'why': 'waiting for approval: Bash python run_calibration.py --seeds 5',
                     'running': True, 'items': [], 'recent': [], 'updated': '2026-11-24T00:00:00Z', 'permission': guard},
                    {'name': 'LOW-dialog', 'job': 'bbbb0003', 'state': 'blocked', 'why': 'permission prompt in the session',
                     'running': True, 'items': [], 'recent': [], 'updated': '2026-11-24T00:00:00Z', 'permission': {'kind': 'dialog'}}]
                stp.write_text(json.dumps(st))
                page.reload()
                page.locator('.agent', has_text='MED-guarded').locator('a.permlink').click()
                page.wait_for_selector('.permwait')
                check(page, page.locator('.meta a.on').get_attribute('data-meta') == 'work' and page.locator('.tabs a.on').get_attribute('href') == '#/permission'
                      and page.locator('.tabs a.on .nb').inner_text() == '3',
                      'Permission: a tab under Agents, with its count, reached from a blocked Status row', failures)
                check(page, page.locator(f'.permwait[data-item="{pid}"]').count() == 1
                      and page.locator('.permwait[data-agent="HIGH-session-a"]').count() == 0,
                      'Permission: a hook prompt is listed once, as its item', failures)
                g = page.locator('.permwait[data-agent="MED-guarded"]')
                check(page, 'python run_calibration.py --seeds 5' in g.inner_text() and 'weekly usage is at 96%' in g.inner_text()
                      and 'usage guard' in g.inner_text(), 'Permission: a guard denial shows the session, the call and why', failures)
                check(page, 'answer it in the session' in page.locator('.permwait[data-agent="LOW-dialog"]').inner_text(),
                      'Permission: another dialog says to answer it in the session', failures)
                check(page, narrow(), 'permission view: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-permission-view.png', full_page=True)
                g.locator('.perm-yes').click()
                g.locator('.status', has_text='Approved').wait_for()
                sent = [json.loads(f.read_text()) for f in (repo / 'messages/bbbb0002').glob('*.json')]
                check(page, len(sent) == 1 and sent[0]['text'] == 'approve' and sent[0]['urgent'] is True and sent[0]['to'] == 'MED-guarded',
                      f'Permission: Approve sends the session an urgent "approve" {sent}', failures)
                # A PR-review bundle (ledger: spec "bundle"; the installed loop may predate it, so it is patched in): a row per PR
                # with its class and why, Approve all low, Changes with a note, sent as per-PR verdicts; Status shows triage accuracy.
                sec = lambda k: {'type': 'section', 'id': f'ca-{k}', 'title': f'CA #{k}', 'summary': f'what #{k} does',
                                 'blocks': [{'type': 'text', 'md': f'Review of #{k}.'}]}
                (repo.parent / 'bundle.json').write_text(json.dumps({'title': 'Bundle CA-3a',
                    'blocks': [{'type': 'text', 'md': 'Three PRs.'}] + [sec(k) for k in (650, 651, 652)]}))
                bid = loop(loop_bin, repo, 'post', 'review', '--from', 'HIGH-merge-coordination-3', '--category', 'pr',
                           '--spec', str(repo.parent / 'bundle.json'))
                bp = repo / f'items/{bid}/item.json'
                it = json.loads(bp.read_text())
                mkpr = lambda k, cls, why: {'repo': 'CA', 'pr': k, 'head': 'abc', 'url': f'https://github.com/org/ca/pull/{k}',
                                            'class': cls, 'why': why, 'class_facts': [], 'predicted_verdict': 'approve',
                                            'predicted_reason': 'r', 'author_session': 'IMPLEMENT-ca', 'review_section': f'ca-{k}'}
                it['bundle'] = {'id': 'CA-3a', 'title': 'CA-3a', 'prs': [mkpr(650, 'high', 'changes the solver API'),
                                                                         mkpr(651, 'low', 'docs only'), mkpr(652, 'low', 'a test only')]}
                it['page'] = 'pr-review'
                bp.write_text(json.dumps(it))
                page.goto(base + f'#/item/{bid}')
                page.reload()
                page.wait_for_selector('.bundle .bpr')
                rows = page.locator('.bundle .bpr')
                check(page, rows.count() == 3 and page.locator('.bundle .bpr.cls-high').count() == 1
                      and 'changes the solver API' in rows.nth(0).inner_text() and '0 of 3' in page.locator('.bundle').inner_text(),
                      'Bundle: a row per PR with its class and why', failures)
                page.locator('.bundle .bapprove-low').click()
                check(page, page.locator('.bundle .bpr.cls-low .v-approve.on').count() == 2
                      and page.locator('.bundle .bpr.cls-high .v-approve.on').count() == 0
                      and '2 verdicts chosen' in page.locator('.answer').inner_text(), 'Bundle: Approve all low marks only the low rows', failures)
                page.locator('.answer textarea').fill('Thanks.')
                page.locator('.bundle .bpr.cls-high .v-changes').click()
                page.locator('.bundle .bpr.cls-high textarea').fill('add a test')
                check(page, page.locator('.answer textarea').input_value() == 'Thanks.' and '3 verdicts chosen' in page.locator('.answer').inner_text(),
                      'Bundle: choosing a verdict keeps the comment typed', failures)
                page.locator('.bundle .bpr.cls-high .bsec').click()
                check(page, page.locator('details.section#ca-650').get_attribute('open') is not None
                      and page.locator('details.section#ca-651').get_attribute('open') is None, 'Bundle: Review ↓ opens its section', failures)
                page.locator('.answer button.primary').click()
                page.wait_for_selector('.bundle >> text=3 of 3 with your verdict')
                ans = [json.loads(f.read_text()) for f in (repo / f'answers/{bid}').glob('*.json')]
                check(page, len(ans) == 1 and ans[0]['text'] == 'Thanks.' and ans[0]['prs'] == [
                    {'repo': 'CA', 'pr': 650, 'verdict': 'changes', 'text': 'add a test'},
                    {'repo': 'CA', 'pr': 651, 'verdict': 'approve', 'text': ''},
                    {'repo': 'CA', 'pr': 652, 'verdict': 'approve', 'text': ''}], f'Bundle: one answer with a verdict per PR {ans}', failures)
                check(page, 'You sent: changes — add a test' in rows.nth(0).inner_text() and not page.locator('.bundle .bapprove-low').count(),
                      'Bundle: sent verdicts shown on their rows', failures)
                check(page, narrow(), 'bundle: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-bundle.png', full_page=True)
                (repo / 'state/pr_triage.json').write_text(json.dumps({'classes': {
                    'high': {'reviews': 1, 'answered': 1, 'change_requests': 1, 'agreed': 0, 'agreement': 0.0},
                    'low': {'reviews': 2, 'answered': 2, 'change_requests': 0, 'agreed': 2, 'agreement': 1.0}}, 'recent': []}))
                page.goto(base + '#/status')
                page.reload()
                page.wait_for_selector('.triage tr[data-class="low"]')
                check(page, page.locator('.triage tr[data-class="low"]').inner_text().split('\t')[-1].strip() == '100% (2/2)'
                      and '0% (0/1)' in page.locator('.triage tr[data-class="high"]').inner_text(), 'Status: triage accuracy per class', failures)
                # Drafts (Finbar 2026-11-24): unsent text survives a redraw by the item's poll, coming back to the tab after
                # 20 s (a full redraw), and leaving the view and coming back; a successful send clears it.
                def back_to_tab():
                    page.evaluate("() => { const real = Date.now; Date.now = () => real() + 60_000; document.dispatchEvent(new Event('visibilitychange')); Date.now = real; }")
                    page.wait_for_timeout(600)
                did = loop(loop_bin, repo, 'post', 'question', 'Which mesh for the draft test?', '--from', 'MED-y', '--option', 'coarse', '--option', 'fine')
                page.goto(base + f'#/item/{did}')
                page.reload()
                page.wait_for_selector('.answer textarea')
                page.locator('.answer textarea').fill('half a reply')
                page.locator('.question details.detail textarea').fill('half a detail request')
                page.locator('.question .qnote').fill('half a note')
                page.evaluate('window.LoopApp.refresh()')
                page.wait_for_timeout(400)
                back_to_tab()
                page.goto(base + '#/list')
                page.wait_for_selector('.card')
                page.goto(base + f'#/item/{did}')
                page.wait_for_selector('.answer textarea')
                kept = [page.locator('.answer textarea').input_value(), page.locator('.question details.detail textarea').input_value(),
                        page.locator('.question .qnote').input_value()]
                check(page, kept == ['half a reply', 'half a detail request', 'half a note'],
                      f'Drafts: an item\'s reply, detail request and note survive redraws and leaving the item {kept}', failures)
                page.locator('.answer button.primary').click()
                page.wait_for_selector('.answer .given')
                page.goto(base + '#/list')
                page.wait_for_selector('.card')
                page.goto(base + f'#/item/{did}')
                page.wait_for_selector('.answer .given')
                left = [page.locator('.answer textarea').input_value(), page.locator('.question .qnote').input_value(),
                        page.locator('.question details.detail textarea').input_value()]
                check(page, left == ['', '', 'half a detail request'],
                      f'Drafts: sending the answer clears its drafts, not the unsent detail request {left}', failures)
                page.goto(base + '#/status')
                page.wait_for_selector('details.amsg')
                agent = page.locator('.agent', has_text='HIGH-session-a').first
                agent.locator('details.amsg summary').click()
                agent.locator('details.amsg textarea').fill('a message half written')
                page.locator('.foot').click()                       # clicks off it
                back_to_tab()
                page.goto(base + '#/list')
                page.wait_for_selector('.card')
                page.goto(base + '#/status')
                page.wait_for_selector('details.amsg')
                agent = page.locator('.agent', has_text='HIGH-session-a').first
                check(page, agent.locator('details.amsg').get_attribute('open') is not None
                      and agent.locator('details.amsg textarea').input_value() == 'a message half written',
                      'Drafts: a message to an agent is kept (its box reopens) after clicking off, redraws and leaving Status', failures)
                agent.locator('details.amsg button.primary').click()
                page.wait_for_selector('details.amsg .status >> text=Sent')
                check(page, page.evaluate("() => localStorage.getItem('loop.draft.agent.HIGH-session-a.message')") is None,
                      'Drafts: sending the message clears its draft', failures)
                # The ant farm under the tree (LOOP the fruit pile at the trunk's foot, an anthome per session sized by
                # tokens, lights by role, a rock when blocked, ants when working, tunnels for messages).
                st = json.loads((repo / 'state/status.json').read_text())
                mk = lambda name, state, **kw: {'name': name, 'job': name[:8], 'state': state, 'running': state != 'stalled',
                                                'why': '', 'working_on': f'{name} at work', 'recent': [], 'items': [], **kw}
                st['agents'] = [mk('LOOP', 'working', loop=True), mk('HIGH-session-a', 'blocked', items=['Q-0001'], why='waiting on Finbar',
                                recent=[{'id': 'Q-0001', 'title': 'Which step size for the run?', 'tab': 'question', 'status': 'question', 'blocking_now': True}]),
                                mk('HIGH-paper', 'working'), mk('MED-y', 'stalled', idle_with_work=['T-0001'], maintenance_alerted='2026-11-27T03:05:00Z'), mk('LOW-x', 'working'), mk('IMPLEMENT-app', 'working')]
                for a, tok in zip(st['agents'], [9e6, 4e6, 2.5e7, 3e5, 1e6, 1.2e7]):
                    a['week_tokens'] = {'total': tok, 'output': tok * 0.01, 'input': tok * 0.002, 'cache_write': tok * 0.1, 'cache_read': tok * 0.888}
                st.setdefault('usage', {})['week_start'] = '2026-11-19T07:00:00+13:00'
                (repo / 'state/status.json').write_text(json.dumps(st))
                msgs = [{'at': f'2026-11-23T0{k}:00:00Z', 'from': fr, 'to': to, 'text': f'fixture message {k}'}
                        for k, (fr, to) in enumerate([('LOOP', 'HIGH-paper'), ('HIGH-paper', 'LOOP'), ('LOOP', 'HIGH-paper'),
                                                      ('IMPLEMENT-app', 'LOOP'), ('old-session', 'LOW-x')])]
                (repo / 'state/messages.json').write_text(json.dumps({'messages': msgs, 'pairs': [
                    {'a': 'HIGH-paper', 'b': 'LOOP', 'count': 3, 'last': msgs[2]['at']},
                    {'a': 'IMPLEMENT-app', 'b': 'LOOP', 'count': 1, 'last': msgs[3]['at']},
                    {'a': 'LOW-x', 'b': 'old-session', 'count': 1, 'last': msgs[4]['at']}]}))
                page.goto(base + '#/status')
                page.reload()
                page.locator('.agent', has_text='IMPLEMENT-app').wait_for()
                names = page.locator('.agent.working .arow b').all_inner_texts()
                check(page, names == ['LOOP', 'HIGH-paper', 'IMPLEMENT-app', 'LOW-x'], f'Status: sessions by role, IMPLEMENT between HIGH and LOW {names}', failures)
                dot = page.locator('.agent', has_text='IMPLEMENT-app').locator('.rdot').evaluate('(n) => getComputedStyle(n).backgroundColor')
                check(page, dot == 'rgb(63, 143, 224)', f'Status: IMPLEMENT has the blue of its anthome lights {dot}', failures)
                page.goto(base + '#/list')
                page.locator('.card .from .rdot').first.wait_for()
                who = page.locator('.card .from').first.inner_text()
                dot = page.locator('.card .from .rdot').first.evaluate('(n) => getComputedStyle(n).backgroundColor')
                want = {'HIGH': 'rgb(224, 72, 47)', 'IMPLEMENT': 'rgb(63, 143, 224)', 'MED': 'rgb(240, 169, 42)', 'LOW': 'rgb(95, 176, 74)'}
                check(page, dot == want.get(who.split('-')[0], 'rgb(164, 106, 214)'), f'Agents: a card shows its session in its role colour {who!r} {dot}', failures)
                # Board order: the poster's role first, then the item's importance. The index here is in importance order
                # only (as an older ledger writes it), so the app's own sort is what puts IMPLEMENT below HIGH, above MED.
                iid = loop(loop_bin, repo, 'post', 'question', 'An IMPLEMENT question', '--from', 'IMPLEMENT-app', '--importance', 'low')
                mid = loop(loop_bin, repo, 'post', 'question', 'A MED question', '--from', 'MED-q', '--importance', 'high')
                hid = loop(loop_bin, repo, 'post', 'question', 'A low HIGH question', '--from', 'HIGH-q', '--importance', 'low')
                idx = json.loads((repo / 'index.json').read_text())
                imp = {'high': 0, 'med': 1, 'low': 2}
                idx['items'].sort(key=lambda r: imp.get(r.get('importance'), 1))
                (repo / 'index.json').write_text(json.dumps(idx))
                page.goto(base + '#/list/question')
                page.reload()
                page.locator('.switch button', has_text='All').click()
                page.locator('.card', has_text=iid).wait_for()
                rank = ['LOOP', 'HIGH', 'IMPLEMENT', 'MED', 'LOW']
                froms = [t.split(' · ')[0].strip() for t in page.locator('.card .from').all_inner_texts()]
                ranks = [rank.index(f.split('-')[0]) if f.split('-')[0] in rank else 5 for f in froms]
                ids = [t.strip() for t in page.locator('.card .top .id').all_inner_texts()]
                check(page, ranks == sorted(ranks) and ids.index(hid) < ids.index(iid) < ids.index(mid),
                      f'Board: cards by role (LOOP, HIGH, IMPLEMENT, MED, LOW, other), IMPLEMENT below a low HIGH item, above a high MED one {froms}', failures)
                check(page, page.locator('.card', has_text=iid).locator('.imp').text_content() == 'low', 'Board: the item keeps its own importance label', failures)
                # The ant farm under the tree: #/hills opens the Tree tab, whose scene holds the farm.
                page.goto(base + '#/hills')
                page.wait_for_selector('.gview .farm .hits [data-k="hill"]')
                check(page, page.evaluate('location.hash') == '#/tree' and page.locator('.meta a.on').inner_text() == 'Tree'
                      and page.locator('.meta a', has_text='Hills').count() == 0, '#/hills opens the Tree tab; no Hills tab', failures)
                F = '.gview .farm'
                check(page, page.locator(f'{F} [data-k="hill"]').count() == 7, 'Farm: one hill per agent, and one for an agent only in the messages', failures)
                # Idle with work (a task to do, neither working nor blocked): a "!" over MED-y's anthill; tapped, its tasks and
                # when the maintainer was told.
                bang = page.evaluate("[...document.querySelectorAll('.gview .idlebang')].map((g) => +g.dataset.h)")
                check(page, len(bang) == 1, f'Idle with work: one "!" over an anthill {bang}', failures)
                page.locator(f'{F} .hits g[data-k="hill"][data-i="{bang[0]}"] rect').first.dispatch_event('click')
                idle = page.locator('.hinfo .idlework').inner_text()
                check(page, 'MED-y' in page.locator('.hinfo').inner_text() and 'T-0001 Write the methods section' in idle
                      and 'Maintenance alerted at' in idle, f'Idle with work: tapping it shows its tasks and the alert {idle!r}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-idle-badge.png')
                # LOOP's food pile is the tasks queued for the agents (status.json usage.food, from the ledger's task list);
                # tapped, it names them per session and links to the Tasks tab; with none it is gone.
                fruit = lambda: page.evaluate("""() => [...document.querySelectorAll('.gview .farm rect')]
                    .filter((r) => ['#c8553d', '#e39a3b', '#9a3d2c'].includes(r.getAttribute('fill'))).length""")
                def food_is(total, per):
                    stf = json.loads((repo / 'state/status.json').read_text())
                    stf['usage']['food'] = {'total': total, 'per_session': per}
                    (repo / 'state/status.json').write_text(json.dumps(stf))
                def sky_at(age_s=0, **u):
                    (repo / 'state/usage.json').write_text(json.dumps({'resets': 'Nov 26, 7am (Pacific/Auckland)', 'at': int(time.time()) - age_s, **u}))
                    page.reload()
                    page.wait_for_selector('.gview .farm .hits [data-k="hill"]')
                food_is(5, {'HIGH-paper': 3, 'IMPLEMENT-app': 2})
                sky_at(pct=26, held=False, override=False)
                page.locator(f'{F} .hits g[data-k="hill"][data-i="0"] rect').last.dispatch_event('click')
                lab = page.locator('.hinfo .ausage.food').inner_text()
                check(page, lab.startswith('5 tasks queued for the agents (HIGH-paper 3, IMPLEMENT-app 2)') and fruit() > 0
                      and page.locator('.hinfo .ausage.food a[href="#/tasks"]').count() == 1,
                      f'Farm: the food pile is the tasks queued for the agents, linked to the task list {lab!r}', failures)
                food_is(0, {})
                sky_at(pct=26, held=False, override=False)
                page.locator(f'{F} .hits g[data-k="hill"][data-i="0"] rect').last.dispatch_event('click')
                lab = page.locator('.hinfo .ausage.food').inner_text()
                check(page, fruit() == 0 and lab.startswith('Nothing queued: give them something to do'), f'Farm: nothing queued, no pile {lab!r}', failures)
                # The maintainer (status.json usage.maintainer) is a dung beetle underground under the hill it works with;
                # tapped, who it works with and why; when it moves, it walks there along the gallery.
                def beetle_at(at):
                    stf = json.loads((repo / 'state/status.json').read_text())
                    stf['usage']['maintainer'] = {'name': 'Maintenance-Dung-Beetle', 'at': at, 'why': 'restarting it',
                                                  'since': dt.datetime.now(dt.timezone.utc).isoformat(), 'source': 'said'}
                    (repo / 'state/status.json').write_text(json.dumps(stf))
                beetle_at('MED-y')
                sky_at(pct=26, held=False, override=False)
                bx = page.evaluate("+document.querySelector('.gview .beetle').dataset.x")
                page.locator(f'{F} .hits [data-k="beetle"]').dispatch_event('click')
                bi = page.locator('.hinfo').inner_text()
                check(page, page.locator('.gview .beetle').count() == 1 and 'Working with MED-y: restarting it' in bi and 'it said so' in bi
                      and 'the maintainer, a dung beetle' in bi, f'Beetle: under the hill it works with; tapped, who and why {bi!r}', failures)
                page.keyboard.press('Escape')
                beetle_at('HIGH-paper')
                sky_at(pct=26, held=False, override=False)
                walk = page.evaluate("""() => { const g = document.querySelector('.gview .beetle');
                  return [g.dataset.at, +g.dataset.x, g.style.transition, g.style.transform]; }""")
                check(page, walk[0] == 'HIGH-paper' and walk[1] != bx and 'transform' in walk[2] and float(walk[3][10:].split('px')[0]) == walk[1],
                      f'Beetle: it walks from MED-y to its new hill {walk}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-beetle.png')
                sky_at(pct=26, held=False, override=False)
                walk = page.evaluate("() => document.querySelector('.gview .beetle').style.transition")
                check(page, walk == '', f'Beetle: no walk while it stays put {walk!r}', failures)
                food_is(5, {'HIGH-paper': 3, 'IMPLEMENT-app': 2})
                sky_at(pct=26, held=False, override=False)
                # Day: a sun with the weekly percentage above it; tapped (a phone) or hovered (a computer), every usage figure.
                sun = page.evaluate("""() => { const s = document.querySelector('.gview svg .sun circle'), l = document.querySelector('.gview svg .sunlabel');
                  return { sun: !!s, label: l && l.textContent, night: !!document.querySelector('.gview svg.scene.night') }; }""")
                check(page, sun == {'sun': True, 'label': '26%', 'night': False}, f'Sky: a sun labelled with the weekly usage {sun}', failures)
                # The 5-hour usage (status.json usage.limits "Session", 43%) is a cloud over the sun; the sky turns overcast.
                cl = page.evaluate("""() => { const l = document.querySelector('.gview svg .cloud .cloudlabel');
                  return { label: l && l.textContent, sky: document.querySelector('.gview svg.scene > rect').getAttribute('fill') }; }""")
                check(page, cl['label'] == '5h 43%' and cl['sky'] not in ('#f3f2ea', None), f'Sky: a cloud with the 5-hour usage over the sun, the sky greyer {cl}', failures)
                page.locator('.gzoom button', has_text='Reset').click()
                page.keyboard.press('Escape')                                            # unpin the food's info: a hover never replaces a pinned one
                b = page.locator('.gview .hits [data-k="sky"]').bounding_box()
                if label == 'phone':
                    page.touchscreen.tap(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
                else:
                    page.mouse.move(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
                page.wait_for_selector('.ginfo .skyinfo')
                info = page.locator('.ginfo').inner_text()
                check(page, all(x in info for x in ('Weekly usage 26% · resets Nov 26 7am', '43%', 'resets Nov 23', 'Hold off', 'Guard on',
                                                    'Woken by Urgent messages none')),
                      f'Sky: {"tapping" if label == "phone" else "hovering"} the sun shows every usage figure {info!r}', failures)
                if shots:
                    page.locator('.ginfo').screenshot(path=f'{shots}/{label}-sky-info.png')
                page.locator('.gview .hits [data-k="sky"]').dispatch_event('click')     # pinned
                page.keyboard.press('Escape')
                check(page, page.locator('.ginfo .skyinfo').count() == 0, 'Sky: Escape closes the usage panel', failures)
                # Over 95% with the guard overridden (`usage-guard off`: not held): night with a lamp, nobody asleep.
                sky_at(pct=97, held=False, override=True)
                lit = page.evaluate("""() => ({ night: !!document.querySelector('.gview svg.scene.night'), lamp: !!document.querySelector('.gview svg .lamp'),
                  moon: !!document.querySelector('.gview svg .moon'), sun: !!document.querySelector('.gview svg .sun'), zz: document.querySelectorAll('.gview .zz').length })""")
                check(page, lit == {'night': True, 'lamp': True, 'moon': True, 'sun': False, 'zz': 0}, f'Sky: overridden past 95%, night with a lamp {lit}', failures)
                page.locator('.gview .hits [data-k="sky"]').first.dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                check(page, 'Weekly usage 97%' in info and 'Guard overridden' in info and 'lamp lit' in info, f'Sky: the moon\'s panel says the guard is overridden {info!r}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-lamp.png')
                # Held (the usage guard tripped): a banner on every tab; send buttons stay enabled.
                (repo / 'state/usage.json').write_text(json.dumps({'pct': 95, 'resets': 'Nov 26, 7am (Pacific/Auckland)', 'at': int(time.time()), 'held': True}))
                hb = []
                for where in ('#/list', '#/status'):
                    page.goto(base + where)
                    page.reload()
                    page.wait_for_selector('#held:not([hidden])')
                    hb.append(page.locator('#held').inner_text())
                check(page, all(t == 'Weekly usage at 95%: messages, answers and papers are saved and reach the agents after the reset (Nov 26, 7am).' for t in hb)
                      and page.locator('details.amsg button.primary').first.is_enabled(), f'Held: the banner on every tab, sending still on {hb}', failures)
                ag = page.locator('.agent', has_text='HIGH-paper').first
                ag.locator('details.amsg summary').click()
                ag.locator('details.amsg textarea').fill('urgent one')
                ag.locator('details.amsg input.urgent').check()
                jb = next(x['job'] for x in json.loads((repo / 'state/status.json').read_text())['agents'] if x['name'] == 'HIGH-paper')
                old = set((repo / 'messages' / jb).glob('*.json')) if (repo / 'messages' / jb).exists() else set()
                ag.locator('details.amsg button.primary').click()
                ag.locator('details.amsg .status', has_text='Sent').wait_for()
                new = [json.loads(f.read_text()) for f in set((repo / 'messages' / jb).glob('*.json')) - old]
                check(page, len(new) == 1 and new[0].get('urgent') is True and new[0]['text'] == 'urgent one',
                      f'Held: a message ticked Urgent is saved as urgent {new}', failures)
                # Night while held: z's from every anthill, ants still; an urgent message woke HIGH-paper (working), so its
                # z's stop and its ants move. A woken session that is idle sleeps again (scene.test.js).
                (repo / 'state/usage.json').write_text(json.dumps({'pct': 95, 'resets': 'Nov 26, 7am (Pacific/Auckland)', 'at': int(time.time()),
                                                                   'held': True, 'woken': ['HIGH-paper']}))
                page.goto(base + '#/tree')
                page.reload()
                page.wait_for_selector('.gview svg.scene.night .zz')
                night = page.evaluate("""async () => {
                  const hills = [...document.querySelectorAll('.gview .farm .hits g[data-k="hill"]')].length;
                  const zz = [...document.querySelectorAll('.gview .zz')].map((g) => +g.dataset.h);
                  const pose = () => Object.fromEntries([...document.querySelectorAll('.gview .ant[data-h]')]
                    .map((g) => [`${g.dataset.h}.${g.dataset.a}`, g.getAttribute('transform')]));
                  const a = pose();
                  await new Promise((r) => setTimeout(r, 400));
                  const b = pose();
                  const moved = [...new Set(Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => +k.split('.')[0]))];
                  const ants = [...new Set(Object.keys(a).map((k) => +k.split('.')[0]))];
                  return { hills, zz, moved, ants, legend: [...document.querySelectorAll('.hlegend span')].some((x) => x.textContent.startsWith('Night')) };
                }""")
                awake = [i for i in range(night['hills']) if i not in night['zz']]
                check(page, len(awake) == 1 and night['moved'] == awake and len(night['ants']) > 1 and night['legend'],
                      f'Night: z\'s from every anthill but the woken one, whose ants alone move {night}', failures)
                page.locator(f'.gview .farm .hits g[data-k="hill"][data-i="{awake[0]}"] rect').last.dispatch_event('click')
                txt = page.locator('.hinfo').inner_text()
                check(page, 'HIGH-paper' in txt and 'Awake: woken by an urgent message' in txt, f'Night: the woken anthill is HIGH-paper, awake {txt[:120]!r}', failures)
                page.locator(f'.gview .farm .hits g[data-k="hill"][data-i="{night["zz"][-1]}"] rect').last.dispatch_event('click')
                check(page, 'Asleep: the usage hold is on' in page.locator('.hinfo').inner_text(), 'Night: an asleep anthill says so', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-night.png')
                (repo / 'state/usage.json').write_text(json.dumps({'pct': 50, 'resets': 'x', 'at': int(time.time()), 'held': False}))
                page.reload()
                page.wait_for_timeout(500)
                page.goto(base + '#/status')
                page.wait_for_selector('details.amsg')
                page.wait_for_timeout(500)
                check(page, page.locator('#held').is_hidden() and page.locator('input.urgent').count() == 0,
                      'Held: no banner and no Urgent tick when not held', failures)
                page.goto(base + '#/tree')
                page.wait_for_selector('.gview .farm .hits [data-k="hill"]')
                check(page, page.locator('.gview svg.scene.night, .gview .zz, .gview .ant[data-still]').count() == 0,
                      'Day again once the hold lifts: no night, no z\'s, no still ants', failures)
                sky_at(age_s=3 * 3600, pct=50, held=False)
                page.locator('.gview .hits [data-k="sky"]').dispatch_event('click')
                lab = page.locator('.ginfo .ausage').first.inner_text()
                check(page, page.locator('.gview svg .sunlabel').text_content() == '50%?' and lab.startswith('Weekly usage unknown (last 50%, 3 h ago)'),
                      f'Sky: a usage figure over 2 h old is a faded sun, "unknown" {lab!r}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-sun.png')
                (repo / 'state/usage.json').unlink()
                page.reload()
                page.wait_for_selector('.gview .farm .hits [data-k="hill"]')
                # It opens on the farm: every hill, home and path inside the view, the view inside the screen.
                out = page.evaluate("""() => { scrollTo(0, 0);
                    const v = document.querySelector('.gview').getBoundingClientRect();
                    const bad = [...document.querySelectorAll('.gview .farm [data-k]')].map((n) => {
                      const r = n.getBoundingClientRect();
                      return [n.dataset.k, n.dataset.i, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
                    }).filter(([, , l, t, r, b]) => l < v.left - 1 || t < v.top - 1 || r > v.right + 1 || b > v.bottom + 1);
                    if (v.bottom > innerHeight + 1) bad.push(['view', Math.round(v.bottom), innerHeight]);
                    return bad; }""")
                check(page, not out, f'Farm: every hill and path in the first view, the view on one screen {out}', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-scene-screen.png')
                ys = page.evaluate(f"Object.fromEntries([...document.querySelectorAll('{F} text')].map((t) => [t.textContent, t.getBoundingClientRect().top]))")
                check(page, all(ys['LOOP'] < y for n, y in ys.items() if n != 'LOOP'), f'Farm: LOOP the food on the surface, the homes below {ys}', failures)
                # The tree stands beside LOOP's fruit pile, in the gap before the first anthill to its right, on the surface.
                foot = page.evaluate("""() => {
                    const segs = [...document.querySelectorAll('.gview .tree .hits [data-k="branch"], .gview .tree .hits [data-k="seg"]')].map((n) => n.getBoundingClientRect());
                    const low = segs.reduce((a, r) => (r.bottom > a.bottom ? r : a));
                    const loop = document.querySelector('.gview .farm .hits g[data-k="hill"][data-i="0"] rect').getBoundingClientRect();
                    const next = Math.min(...[...document.querySelectorAll('.gview .farm .hits g[data-k="hill"]:not([data-i="0"])')]
                      .map((g) => g.getBoundingClientRect().left).filter((x) => x > loop.right));
                    return { x: (low.left + low.right) / 2, y: low.bottom, l: loop.left, r: loop.right, next, b: loop.bottom, h: loop.height }; }""")
                clear = 0.15 * (foot['r'] - foot['l'])
                check(page, foot['r'] + clear < foot['x'] < foot['next'] - clear and abs(foot['y'] - foot['b']) < 0.15 * foot['h'],
                      f'Scene: the trunk stands beside the fruit pile, before the next anthill {foot}', failures)
                glows = page.evaluate(f"[...document.querySelectorAll('{F} .glow')].map((c) => [c.dataset.role, c.getAttribute('fill')])")
                roles = {r: c for r, c in glows}
                check(page, roles.get('high') == '#e0482f' and roles.get('implement') == '#3f8fe0' and roles.get('low') == '#5fb04a' and 'med' not in roles,
                      f'Farm: lights in the role colour, off when stalled {roles}', failures)
                widths = page.evaluate(f"Object.fromEntries([...document.querySelectorAll('{F} .hits g[data-k=hill]')].map((g) => [g.dataset.i, g.lastElementChild.getBoundingClientRect().width]))")
                names = page.evaluate(f"[...document.querySelectorAll('{F} text')].map((t) => t.textContent)")
                wd = {names[int(i)]: w for i, w in widths.items()}
                check(page, wd['HIGH-paper'] > wd['IMPLEMENT-app'] > wd['HIGH-session-a'] > wd['LOW-x'] > wd['MED-y'],
                      f'Farm: anthomes sized by tokens since the weekly reset {wd}', failures)
                # Hover (tap on a phone) an anthome for its usage, the food inside it for its focus.
                hp = names.index('HIGH-paper')
                home = page.locator(f'{F} .hits g[data-k="hill"][data-i="{hp}"] rect').last
                food = page.locator(f'{F} .hits [data-k="food"][data-i="{hp}"]')
                if label == 'computer':
                    home.hover(position={'x': 2, 'y': 2}, force=True)
                else:
                    home.dispatch_event('click')
                info = page.locator('.hinfo').inner_text()
                check(page, 'HIGH-paper' in info and '25M tokens' in info and 'since the weekly reset' in info and 'cache reads' in info,
                      f'Farm: {"hovering" if label == "computer" else "tapping"} an anthome shows its usage {info!r}', failures)
                if label == 'computer':
                    food.hover(force=True)
                else:
                    food.dispatch_event('click')
                info = page.locator('.hinfo').inner_text()
                check(page, 'current focus' in info and 'HIGH-paper at work' in info,
                      f'Farm: {"hovering" if label == "computer" else "tapping"} the food shows its focus {info!r}', failures)
                if shots:
                    page.locator('.hinfo').scroll_into_view_if_needed()
                    page.screenshot(path=f'{shots}/{label}-scene-focus.png')
                    page.evaluate('scrollTo(0, 0)')
                n_ants = page.locator(f'{F} .ant[data-h]').count()
                check(page, n_ants == 6 + 5 + 2 + 5, f'Farm: ants on the working hills only ({n_ants})', failures)   # LOOP, HIGH, LOW, IMPLEMENT (large)
                check(page, page.locator(f'{F} [data-k="path"]').count() == 3 and page.locator(f'{F} .ant[data-p]').count() == 3 + 1 + 1,
                      'Farm: a path per pair that messaged, ants on them', failures)
                page.locator(f'{F} [data-k="path"][data-i="0"]').dispatch_event('click')
                info = page.locator('.hinfo').inner_text()
                check(page, 'HIGH-paper ↔ LOOP' in info and 'fixture message 2' in info and '1 of 3' in info,
                      f'Farm: tapping a path shows its latest message {info!r}', failures)
                if label == 'computer':
                    home.hover(position={'x': 2, 'y': 2}, force=True)
                    check(page, 'fixture message 2' in page.locator('.hinfo').inner_text(), 'Farm: a tapped tunnel stays while the mouse crosses other hills', failures)
                page.locator('.hinfo button', has_text='older').click()
                check(page, 'fixture message 1' in page.locator('.hinfo').inner_text(), 'Farm: ◀ older', failures)
                page.locator('.hinfo button', has_text='newer').click()
                check(page, 'fixture message 2' in page.locator('.hinfo').inner_text(), 'Farm: newer ▶', failures)
                if shots:
                    page.locator('.hinfo').scroll_into_view_if_needed()
                    page.screenshot(path=f'{shots}/{label}-scene-path.png')
                    page.evaluate('scrollTo(0, 0)')
                # Tapping an anthome opens "Message <agent>" (Finbar 2026-11-24): the Status box, its send and its draft (shared
                # with Status by the agent's name). Zoom, pan and redraws keep it open with the text; send reaches that agent.
                ha = names.index('HIGH-session-a')
                ha_job = next(a['job'] for a in json.loads((repo / 'state/status.json').read_text())['agents'] if a['name'] == 'HIGH-session-a')
                page.locator(f'{F} .hits g[data-k="hill"][data-i="{ha}"] rect').last.dispatch_event('click')
                mb = page.locator('.hinfo details.amsg[data-agent="HIGH-session-a"]')
                check(page, mb.count() == 1 and mb.get_attribute('open') is not None and 'Message HIGH-session-a' in mb.inner_text(),
                      'Farm: tapping an anthome opens a message box for that agent', failures)
                mb.locator('textarea').fill('from the tree')
                page.locator('.gzoom button', has_text='+').click()
                page.evaluate("""() => document.querySelector('.gview').dispatchEvent(new WheelEvent('wheel',
                    { deltaY: 120, shiftKey: true, bubbles: true, cancelable: true }))""")
                page.evaluate('window.LoopApp.route({ quiet: true })')
                page.wait_for_selector('.hinfo details.amsg[data-agent="HIGH-session-a"] textarea')
                mb = page.locator('.hinfo details.amsg[data-agent="HIGH-session-a"]')
                fits = page.evaluate("""() => { const r = document.querySelector('.hinfo details.amsg').getBoundingClientRect();
                    return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; }""")
                check(page, mb.get_attribute('open') is not None and mb.locator('textarea').input_value() == 'from the tree' and fits,
                      'Farm: the message box stays open with its text through zoom, pan and a redraw, and fits the screen', failures)
                if shots:
                    page.locator('.hinfo').scroll_into_view_if_needed()
                    page.screenshot(path=f'{shots}/{label}-scene-message.png')
                    page.evaluate('scrollTo(0, 0)')
                page.goto(base + '#/status')
                page.wait_for_selector('details.amsg[data-agent="HIGH-session-a"] textarea')
                check(page, page.locator('details.amsg[data-agent="HIGH-session-a"] textarea').input_value() == 'from the tree',
                      'Farm: the draft is shared with the Status tab', failures)
                page.goto(base + '#/tree')
                page.wait_for_selector('.hinfo details.amsg[data-agent="HIGH-session-a"] textarea')
                before_msgs = set((repo / 'messages' / ha_job).glob('*.json')) if (repo / 'messages' / ha_job).exists() else set()
                page.locator('.hinfo details.amsg button.primary').click()
                page.wait_for_selector('.hinfo details.amsg .status >> text=Sent')
                sent = [json.loads(f.read_text()) for f in set((repo / 'messages' / ha_job).glob('*.json')) - before_msgs]
                check(page, len(sent) == 1 and sent[0]['to'] == 'HIGH-session-a' and sent[0]['text'] == 'from the tree',
                      f'Farm: Send from the anthome delivers to that agent {sent}', failures)
                page.locator('.gview svg').first.dispatch_event('click')          # open ground: unpin
                page.locator('.gzoom button', has_text='Reset').click()
                check(page, page.locator(f'{F} rect[fill="#686a66"]').count() > 0, 'Farm: a rock on the blocked hill', failures)
                t0 = page.locator(f'{F} .ant').first.get_attribute('transform')
                page.wait_for_timeout(400)
                check(page, page.locator(f'{F} .ant').first.get_attribute('transform') != t0, 'Farm: the ants move', failures)
                # Zoom and pan. The page itself never zooms: the view takes Ctrl+wheel (a trackpad pinch) and two fingers.
                box = page.locator('.gview').bounding_box()
                wheel = lambda x, y: page.evaluate(f"""() => {{ const v = document.querySelector('.gview');
                    const ev = new WheelEvent('wheel', {{ deltaY: -200, ctrlKey: true, clientX: {x}, clientY: {y}, bubbles: true, cancelable: true }});
                    v.dispatchEvent(ev); return ev.defaultPrevented; }}""")
                # First zoom until the view is shorter than the scene: a view taller than the scene keeps its foot on the
                # farm's floor, so a zoom there moves the view up and down by design.
                vh = vb()                                                                     # the opening view
                mid = lambda v: v[1] + v[3] / 2
                for _ in range(6):                     # until shorter than the scene: a zoom then keeps the centre still
                    a = vb()
                    wheel(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
                    if abs(mid(vb()) - mid(a)) < 0.3 or vb()[2] < 40:
                        break
                v0 = vb()
                cx, cy = box['x'] + box['width'] * 0.3, box['y'] + box['height'] * 0.8      # a point in the farm
                world = lambda v: (v[0] + (cx - box['x']) * v[2] / box['width'], v[1] + (cy - box['y']) * v[2] / box['width'])
                took = wheel(cx, cy)
                v1 = vb()
                w0, w1 = world(v0), world(v1)
                check(page, took and v1[2] < v0[2] * 0.8 and abs(w0[0] - w1[0]) < 0.3 and abs(w0[1] - w1[1]) < 0.3,
                      f'Scene: Ctrl+wheel zooms toward the pointer, not the page {v0} -> {v1}', failures)
                took = page.evaluate("""() => { const v = document.querySelector('.gview');
                    const ev = new WheelEvent('wheel', { deltaY: 120, shiftKey: true, bubbles: true, cancelable: true });
                    v.dispatchEvent(ev); return ev.defaultPrevented; }""")
                v2 = vb()
                check(page, took and v2[0] > v1[0] and v2[1] == v1[1] and v2[2] == v1[2], f'Scene: Shift+wheel pans sideways {v1} -> {v2}', failures)
                if label == 'computer':
                    before = page.locator('.hinfo').inner_text()
                    page.mouse.move(cx, cy)
                    page.mouse.down()
                    page.mouse.move(cx + 10, cy + 60, steps=4)
                    page.mouse.up()
                    v3 = vb()
                    check(page, v3[1] < v2[1] and v3[0] < v2[0], f'Scene: a mouse drag pans (down shows what is above) {v2} -> {v3}', failures)
                    check(page, page.locator('.hinfo').inner_text() == before, 'Scene: a drag is not a tap', failures)
                else:
                    # Two fingers spreading apart: the view zooms in about their midpoint and the page does not.
                    took = page.evaluate(f"""() => {{ const v = document.querySelector('.gview'), r = v.getBoundingClientRect();
                        const t = (id, x) => new Touch({{ identifier: id, target: v, clientX: r.left + x, clientY: r.top + 100 }});
                        let prevented = true;
                        for (const [type, d] of [['touchstart', 40], ['touchmove', 60], ['touchmove', 90]]) {{
                          const ev = new TouchEvent(type, {{ touches: [t(1, 150 - d), t(2, 150 + d)], bubbles: true, cancelable: true }});
                          v.dispatchEvent(ev); prevented = prevented && ev.defaultPrevented; }}
                        v.dispatchEvent(new TouchEvent('touchend', {{ touches: [], bubbles: true, cancelable: true }}));
                        return prevented; }}""")
                    v3 = vb()
                    check(page, took and v3[2] < v2[2] * 0.6, f'Scene: two fingers pinch-zoom the view, not the page {v2} -> {v3}', failures)
                page.locator('.gzoom button', has_text='Whole tree').click()
                vt = vb()
                check(page, vt[1] < v0[1], f'Scene: "Whole tree" frames the tree above the farm {v0} -> {vt}', failures)
                page.locator('.gzoom button', has_text='Reset').click()
                check(page, all(abs(a - b) < 0.05 for a, b in zip(vb(), vh)), f'Scene: Reset goes back to the farm {vb()}', failures)
                blocked = page.evaluate(f"[...document.querySelectorAll('{F} text')].findIndex((t) => t.textContent.startsWith('HIGH-session'))")
                page.locator(f'{F} [data-k="hill"][data-i="{blocked}"]').dispatch_event('click')
                info = page.locator('.hinfo').inner_text()
                check(page, 'HIGH-session-a' in info and 'blocked' in info and 'Waiting on' in info, f'Farm: tap a blocked hill {info!r}', failures)
                check(page, narrow(), 'Scene: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-scene.png', full_page=True)
                if label == 'computer':
                    check(page, not page.locator('#gside').is_visible(), 'Scene: no side panel (the tree is on the page)', failures)
                page.locator('.hinfo a', has_text='Q-0001').first.click()
                page.wait_for_selector('.item-head h2')
                check(page, 'Which step size' in page.locator('.item-head h2').inner_text(), 'Farm: the item it waits on opens', failures)
                # An answer typed only in the general box: no empty per-question rows; it answers a one-question item.
                out = loop(loop_bin, repo, 'post', 'question', 'Plain question for the general box?', '--from', 'HIGH-a')
                qid = re.search(r'Q-\d{4}', out).group(0)
                page.goto(base + f'#/item/{qid}')
                page.reload()
                page.wait_for_selector('.answer textarea')
                page.locator('.answer textarea').fill('Only the general box.')
                page.locator('.answer button.primary').click()
                page.wait_for_selector('.given')
                ans = [json.loads(f.read_text()) for f in sorted((repo / 'answers' / qid).glob('*.json'))]
                got = ans[-1].get('answers') if ans else None
                check(page, got == [{'question': 0, 'asked': 'Plain question for the general box?', 'choice': None, 'text': 'Only the general box.'}],
                      f'answer from the general box only: one row for the question, no empty rows {got}', failures)
                loop(loop_bin, repo, 'pull')
                check(page, json.loads((repo / 'items' / qid / 'item.json').read_text())['status'] == 'answered',
                      'answer from the general box counts as answered', failures)
                check(page, not errors, f'no console errors {errors}', failures)
                ctx.close()
                check_file_links(browser, base, repo, vp, label, failures)

            ctx = browser.new_context()
            page = ctx.new_page()
            page.goto(base)
            page.wait_for_selector('.settings')
            check(page, page.locator('.settings input').count() == 3, 'no token: sign-in shown', failures)
            browser.close()
        srv.shutdown()
    print(f'{len(failures)} failure(s)')
    return 1 if failures else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--loop', required=True)
    ap.add_argument('--graph')
    ap.add_argument('--shots')
    a = ap.parse_args()
    if a.shots:
        os.makedirs(a.shots, exist_ok=True)
    sys.exit(run(Path(a.loop).resolve(), a.graph, a.shots))
