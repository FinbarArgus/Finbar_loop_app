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
                page.locator('.switch button', has_text='Blocking').click()
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
                # Status: usage, each agent with what it does, its entries, and a message box.
                page.goto(base + '#/status')
                page.wait_for_selector('.status-card .ulimit')
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
