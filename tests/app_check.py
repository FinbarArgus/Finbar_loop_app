"""Headless check of the loop app against a fake GitHub API backed by a fixture loop repo.

    python tests/app_check.py --loop <data repo>/bin/loop [--graph provenance_graph.json] [--shots DIR]

The fixture repo is made with `loop post` (LOOP_NO_GIT=1); api.github.com is served from it by
Playwright route interception, so answers, detail requests and images are really written. Checks, at
phone and computer width: the board, a question with figure, maths, table and file excerpt; option +
answer; a detail request with an image (Enter sends); the added detail (figure + text) shown in place;
a review with provenance, quiz (marking, reason, score, start again) and checklist; no console errors
and no sideways scrolling.
"""
import argparse
import base64
import http.server
import json
import re
import os
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


def fake_github(repo):
    def handle(route):
        req = route.request
        u = urlparse(req.url)
        parts = [unquote(p) for p in u.path.split('/')]
        if req.headers.get('authorization') != 'Bearer test-token':
            return route.fulfill(status=401, body='{}')
        if '/git/trees/' in u.path:
            paths = [str(p.relative_to(repo)) for p in repo.rglob('*') if p.is_file() and '.loop' not in p.parts]
            return route.fulfill(status=200, content_type='application/json',
                                 body=json.dumps({'tree': [{'path': p, 'type': 'blob'} for p in paths]}))
        if parts[4] == 'contents' if len(parts) > 4 else False:
            rel = '/'.join(parts[5:])
            f = repo / rel
            if req.method == 'PUT':
                body = json.loads(req.post_data)
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(base64.b64decode(body['content']))
                return route.fulfill(status=201, content_type='application/json', body='{}')
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
                ctx = browser.new_context(viewport=vp)
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
                check(page, [t[:4] for t in tabs] == ['Ques', 'Cont', 'Revi'] and tabs[0].endswith('31'),
                      f'board tabs Questions/Content/Review, with the blocking count {tabs}', failures)
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
                check(page, 'Questions history (2)' in page.locator('details.history > summary').inner_text(),
                      'answered questions move to the Questions history', failures)
                check(page, page.locator('.tabs a').count() == 3, 'three tabs, history below', failures)
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
                # Mine: drop a paper under High, pick its Zotero collection, set a deadline, tick it done.
                import datetime as _dt
                page.goto(base + '#/mine/read')
                page.wait_for_selector('.mgroup.prio-high .dropzone')
                check(page, page.locator('.mgroup').count() == 3, 'Read: High / Medium / Low groups', failures)
                page.locator('.mgroup.prio-high input[type=file]').set_input_files(str(tmp_l / 'fig.png'))
                form = page.locator('.mgroup > .newentry')
                form.locator('.colsel').wait_for()
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
                form.locator(':scope > label > input[type=text]').fill('A paper to read')
                form.locator(':scope > .row button.primary').click()
                page.wait_for_selector('.mrow >> text=A paper to read')
                ents = [json.loads(f.read_text()) for f in (repo / 'personal').glob('read-*/entry.json')]
                check(page, ents and ents[0]['priority'] == 'high' and ents[0]['zotero']['collection_id'] == 2
                      and ents[0]['files'] == ['fig.png'] and (repo / 'personal' / ents[0]['id'] / 'fig.png').exists(),
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
                page.goto(base + '#/mine/write')
                page.goto(base + '#/mine/read')
                page.wait_for_selector('.mrow details.pextra >> text=Summary')
                row = page.locator('.mrow', has_text='A paper to read')
                row.locator('details.pextra', has_text='Summary').locator('summary').click()
                page.wait_for_selector('.mrow .pextra aside.callout')
                check(page, 'It builds a beat map.' in row.inner_text(), 'paper summary shown', failures)
                page.goto(base + '#/mine/write')
                page.wait_for_selector('.newentry input[type=url]')
                page.locator('.mine > .newentry input[type=text]').fill('Paper 1 draft')
                page.locator('.mine > .newentry input[type=url]').fill('https://www.overleaf.com/project/abc')
                page.locator('.mine > .newentry button.primary').click()
                page.wait_for_selector('.mrow a[href="https://www.overleaf.com/project/abc"]')
                check(page, True, 'Write: Overleaf link added', failures)
                page.goto(base + '#/mine/student')
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
                check(page, narrow(), 'Mine: no sideways scroll', failures)
                if shots:
                    page.goto(base + '#/mine/read')
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
                page.goto(base + '#/mine/read')
                page.reload()
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
                page.goto(base + '#/mine/write')
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

                # Tree: papers read on past days in two collections, one met deadline (a leaf), the animal.
                import datetime as _dt2
                for k, (name, days) in enumerate([('ROM / OpInf', 3), ('ROM / OpInf', 2), ('ROM / Beat maps', 2),
                                                  ('Physiology', 1), ('ROM', 1), (None, 0)]):
                    at = (_dt2.datetime.now() - _dt2.timedelta(days=days)).replace(hour=10).astimezone().isoformat()
                    dl = (_dt2.date.today() - _dt2.timedelta(days=days - 1)).isoformat() if k == 0 else None
                    seed(f'read-tree{k}', title=f'Tree paper {k}', done=True, done_at=at, deadline=dl,
                         **({'zotero': {'name': name}} if name else {}))
                page.goto(base + '#/tree')
                page.wait_for_selector('.gview svg .hits [data-k="seg"]')
                check(page, page.locator('.meta a.on').inner_text() == 'Tree', 'Tree tab in the header', failures)
                head = page.locator('.ghead').inner_text()
                check(page, 'seedling' in head and 'papers' in head and 'days in a row' in head, f'Tree: stage, streak and counts {head!r}', failures)
                page.locator('.hits [data-k="seg"][data-i="read-tree2"]').first.dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                check(page, 'Tree paper 2' in info and 'ROM / Beat maps' in info and '1.2x' in info,
                      f'Tree: tapping a segment shows its paper and collection {info!r}', failures)
                check(page, page.locator('.hits .on').count() >= 1, 'Tree: the tapped paper lights up', failures)
                page.locator(f'.hits [data-k="creature"][data-i="{wid}"]').dispatch_event('click')
                info = page.locator('.ginfo').inner_text()
                check(page, 'Paper 1 draft' in info and '12 citations' in info, f'Tree: tapping the animal shows its paper {info!r}', failures)
                log = page.locator('.glog').inner_text()
                check(page, 'Tree paper 0' in log and 'a leaf' in log and 'arrived' in log, 'Tree: growth log', failures)
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
                w0 = page.evaluate("document.querySelector('.gview svg').clientWidth")
                page.locator('.gzoom button', has_text='+').click()
                check(page, page.evaluate("document.querySelector('.gview svg').clientWidth") > w0, 'Tree: zoom in', failures)
                check(page, narrow(), 'Tree: no sideways scroll', failures)
                if shots:
                    page.locator('.gzoom button', has_text='Fit').click()
                    page.screenshot(path=f'{shots}/{label}-tree.png', full_page=True)
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
                # Hills: every agent an anthill (size by priority, rock when blocked, ants when working), the tree beside.
                st = json.loads((repo / 'state/status.json').read_text())
                mk = lambda name, state, **kw: {'name': name, 'job': name[:8], 'state': state, 'running': state != 'stalled',
                                                'why': '', 'working_on': f'{name} at work', 'recent': [], 'items': [], **kw}
                st['agents'] = [mk('LOOP', 'working', loop=True), mk('HIGH-session-a', 'blocked', items=['Q-0001'], why='waiting on Finbar',
                                recent=[{'id': 'Q-0001', 'title': 'Which step size for the run?', 'tab': 'question', 'status': 'question', 'blocking_now': True}]),
                                mk('HIGH-paper', 'working'), mk('MED-y', 'stalled'), mk('LOW-x', 'working'), mk('IMPLEMENT-app', 'working')]
                (repo / 'state/status.json').write_text(json.dumps(st))
                msgs = [{'at': f'2026-11-23T0{k}:00:00Z', 'from': fr, 'to': to, 'text': f'fixture message {k}'}
                        for k, (fr, to) in enumerate([('LOOP', 'HIGH-paper'), ('HIGH-paper', 'LOOP'), ('LOOP', 'HIGH-paper'),
                                                      ('IMPLEMENT-app', 'LOOP'), ('old-session', 'LOW-x')])]
                (repo / 'state/messages.json').write_text(json.dumps({'messages': msgs, 'pairs': [
                    {'a': 'HIGH-paper', 'b': 'LOOP', 'count': 3, 'last': msgs[2]['at']},
                    {'a': 'IMPLEMENT-app', 'b': 'LOOP', 'count': 1, 'last': msgs[3]['at']},
                    {'a': 'LOW-x', 'b': 'old-session', 'count': 1, 'last': msgs[4]['at']}]}))
                page.goto(base + '#/hills')
                page.wait_for_selector('.hview svg .hits [data-k="hill"]')
                check(page, page.locator('.meta a.on').inner_text() == 'Hills', 'Hills tab in the header', failures)
                check(page, page.locator('.hview [data-k="hill"]').count() == 7, 'Hills: one hill per agent, and one for an agent only in the messages', failures)
                n_ants = page.locator('.hview .ant[data-h]').count()
                check(page, n_ants == 6 + 5 + 2 + 3, f'Hills: ants on the working hills only ({n_ants})', failures)
                check(page, page.locator('.hview [data-k="path"]').count() == 3 and page.locator('.hview .ant[data-p]').count() == 3 + 1 + 1,
                      'Hills: a path per pair that messaged, ants on them', failures)
                page.locator('.hview [data-k="path"][data-i="0"]').dispatch_event('click')
                info = page.locator('.hinfo').inner_text()
                check(page, 'HIGH-paper ↔ LOOP' in info and 'fixture message 2' in info and '1 of 3' in info,
                      f'Hills: tapping a path shows its latest message {info!r}', failures)
                page.locator('.hinfo button', has_text='older').click()
                check(page, 'fixture message 1' in page.locator('.hinfo').inner_text(), 'Hills: ◀ older', failures)
                page.locator('.hinfo button', has_text='newer').click()
                check(page, 'fixture message 2' in page.locator('.hinfo').inner_text(), 'Hills: newer ▶', failures)
                if shots:
                    page.locator('.hinfo').scroll_into_view_if_needed()
                    page.screenshot(path=f'{shots}/{label}-hills-path.png')
                check(page, page.locator('.hview svg rect[fill="#686a66"]').count() > 0, 'Hills: a rock on the blocked hill', failures)
                check(page, page.locator('.treecol svg').count() == 1, 'Hills: the growth tree beside the hills', failures)
                t0 = page.locator('.hview .ant').first.get_attribute('transform')
                page.wait_for_timeout(400)
                check(page, page.locator('.hview .ant').first.get_attribute('transform') != t0, 'Hills: the ants move', failures)
                blocked = page.evaluate("[...document.querySelectorAll('.hview text')].findIndex((t) => t.textContent.startsWith('HIGH-session'))")
                page.locator(f'.hview [data-k="hill"][data-i="{blocked}"]').dispatch_event('click')
                info = page.locator('.hinfo').inner_text()
                check(page, 'HIGH-session-a' in info and 'blocked' in info and 'Waiting on' in info, f'Hills: tap a blocked hill {info!r}', failures)
                check(page, narrow(), 'Hills: no sideways scroll', failures)
                if shots:
                    page.screenshot(path=f'{shots}/{label}-hills.png', full_page=True)
                if label == 'computer':
                    check(page, not page.locator('#gside').is_visible(), 'Hills: no side panel (the tree is on the page)', failures)
                page.locator('.hinfo a', has_text='Q-0001').first.click()
                page.wait_for_selector('.item-head h2')
                check(page, 'Which step size' in page.locator('.item-head h2').inner_text(), 'Hills: the item it waits on opens', failures)
                check(page, not errors, f'no console errors {errors}', failures)
                ctx.close()

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
