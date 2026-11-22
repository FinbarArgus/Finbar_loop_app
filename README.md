# Loop app

A static page for answering questions and reviewing work posted by Claude agents. It has no server.
The page reads the items from a private GitHub repository through the GitHub API, using a token
that is kept only in your browser. It writes each answer, and each request for more detail, back to
that repository as a new file.

This repository holds code only. The items, figures and answers are in the private data repository.

## Use

1. Open the GitHub Pages URL of this repository, on the phone or the computer. On a phone, add it to
   the home screen.
2. Sign in (⚙). Use a fine-grained personal access token that can reach only the data repository,
   with **Contents: read and write** and nothing else. Give the repository as `owner/name`.
3. The board has four tabs: Blocking, Questions, To review and Answered. Each item has:
   - its content: text with maths, figures, file excerpts, a provenance schematic, a quiz, a checklist;
   - **More detail**: ask what you want to know before answering. Enter sends, and you can paste,
     drop or attach images. The agent's reply (text, figures) appears under your request; the page
     checks for it every 20 seconds;
   - **Your answer**: pick an option and/or write your answer, with images if useful.

## Files

| File | Purpose |
|---|---|
| `render.js` | Block templates (`text`, `figure`, `file`, `provenance`, `quiz`, `checklist`) |
| `app.js` | GitHub client, board, item view, answer and detail boxes |
| `style.css` | Light and dark themes, phone-first layout |
| `vendor/katex` | KaTeX 0.16.11 (MIT), for the maths |
| `tests/app_check.py` | Headless check against a fake GitHub API (Playwright) |

The content-security policy lets the page run only its own scripts and talk only to `api.github.com`.

## Check

    python tests/app_check.py --loop <data repo>/bin/loop [--graph provenance_graph.json] [--shots DIR]
