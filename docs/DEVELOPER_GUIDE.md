# Nabu Browser — Developer Guide

**Version:** Prototype  
**Last updated:** June 2026

This document describes how Nabu Browser is structured, how features are implemented, and how to extend the project safely. **Do not modify the `ai-browser/` application package as part of documentation work**—treat it as the canonical runtime; this guide lives alongside it under `docs/`.

---

## Table of Contents

1. [Overview](#overview)
2. [Repository Layout](#repository-layout)
3. [Architecture](#architecture)
4. [Backend (`main.py`)](#backend-mainpy)
5. [Frontend (`ui/`)](#frontend-ui)
6. [Data Layer](#data-layer)
7. [Feature Walkthroughs](#feature-walkthroughs)
8. [JS ↔ Python Bridge](#js--python-bridge)
9. [Security & Sandboxing](#security--sandboxing)
10. [Development Setup](#development-setup)
11. [Guidelines for Further Development](#guidelines-for-further-development)
12. [Roadmap Alignment](#roadmap-alignment)

---

## Overview

Nabu Browser is a **pywebview** desktop app:

- **Shell UI:** HTML/CSS/JS (`ai-browser/ui/`)
- **Backend:** Python `NabuAPI` class exposed as `window.pywebview.api`
- **LLM:** HTTP calls to local **Ollama** (`/api/generate`, model `llama3.2:3b`)
- **Persistence:** SQLite **`nabu.db`** beside `main.py`

All web content is loaded by **`load_and_scrape_url`**: Python fetches HTML with `requests`, strips text, patches HTML (`<base>`, containment CSS, meta-refresh removal), stores text in SQLite, returns HTML to JS. JS injects it into a **sandboxed iframe** via `srcdoc` plus an inline navigation interceptor—never `iframe.src = https://…` for external pages (that would navigate the whole pywebview window on GTK).

```
┌─────────────────────────────────────────────────────────────┐
│  pywebview window (WebKit2GTK)                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  index.html + app.js + style.css  (parent / shell)     │  │
│  │  ┌─────────────┐  ┌────────────────────────────────┐ │  │
│  │  │ AI sidebar  │  │  #web-view iframe (srcdoc)      │ │  │
│  │  │ chat/logs   │  │  proxied page + injected script │ │  │
│  │  └─────────────┘  └────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│         │ window.pywebview.api.*                             │
│         ▼                                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  NabuAPI (main.py) — proxy, Ollama, SQLite, agent    │  │
│  └───────────────────────────────────────────────────────┘  │
│         │ requests          │ sqlite3        │ threading    │
│         ▼                   ▼                ▼               │
│     Internet            nabu.db          Ollama :11434       │
└─────────────────────────────────────────────────────────────┘
```

---

## Repository Layout

```
nabu-browser/
├── docs/                    # This documentation (safe to edit)
│   ├── USER_GUIDE.md
│   └── DEVELOPER_GUIDE.md
└── ai-browser/              # Application — do not change for doc-only tasks
    ├── main.py              # NabuAPI, webview entry, agent thread
    ├── nabu.db              # SQLite (created at runtime)
    └── ui/
        ├── index.html       # Shell markup, shell navigation guard
        ├── app.js           # Tabs, navigation, bridge, iframe injection
        └── style.css        # Layout (CSS grid shell)
```

There is no root `README` or `requirements.txt` in the current tree; dependencies are implied: **`pywebview`**, **`requests`**, stdlib **`sqlite3`**.

---

## Architecture

### Design principles

1. **Shell never navigates away** — Parent `Location.prototype` redirects top-level `href`/`assign`/`replace` to `loadUrl()`. Iframe uses `postMessage({ type: 'nabu-navigate', url })` instead of real top navigation.
2. **Proxy-first loading** — Single choke point: `load_and_scrape_url` for scrape + DB write + HTML return.
3. **Local AI** — All LLM calls are synchronous HTTP POSTs to Ollama from Python (no streaming in UI).
4. **SQLite as memory** — `browsing_history.page_content` powers sidebar context and the research agent’s poll loop.

### UI layout (CSS Grid)

`#app-container`: row 1 = `#navigation-toolbar`, row 2 = `#workspace-body`.  
`#workspace-body`: column 1 = `#ai-chat-sidebar`, column 2 = `#tabs-viewports-wrapper` (see `index.html` comments; sidebar is on the left in markup).

`app.js` installs a **MutationObserver** shell guard to re-append removed `#navigation-toolbar`, `#workspace-body`, etc., if WebKit drops nodes during repaint.

---

## Backend (`main.py`)

### Class: `NabuAPI`

| Method | Role |
|--------|------|
| `test_connection(message)` | Bridge smoke test |
| `get_ai_keywords(vague_query)` | Legacy/simple keyword extraction via Ollama |
| `translate_vague_query(query)` | Address-bar `?` flow; logs `ai_intent://…` to history; returns `{ status, keywords }` |
| `log_navigation(tab_id, url, title, page_content)` | Extra history insert from JS (proxy also writes) |
| `send_sidebar_chat(user_message)` | Chat with last 5 non-empty `page_content` rows (1500 chars each) |
| `classify_and_organize_tabs(tabs_json)` | Ollama → JSON tab groups → returned to JS (`applyTabGroups`) |
| `load_and_scrape_url(url, tab_id)` | **Core proxy** — fetch, DDG interstitial handling, text extract, DB insert, return `{ html, url, title, text, status }` |
| `save_tab_state` / `remove_tab_state` / `restore_session` | `active_tabs` CRUD |
| `start_research_agent(goal, max_pages)` | Spawns daemon thread → `_run_agent_loop` |

### Proxy details (`load_and_scrape_url`)

- Normalizes URL (add `https://` if missing).
- Unwraps DuckDuckGo `/l/?uddg=` URLs.
- `requests.get(..., verify=False, timeout=10)` with Chrome-like User-Agent.
- If response is DDG interstitial (`duco.duckduckgo.com`, JS redirect stubs), re-fetch extracted target.
- Text: strip `<script>`/`<style>`, tags, collapse whitespace.
- HTML: inject `<base href="final_url">`, iframe containment `<style>`, strip meta refresh.
- Inserts row into `browsing_history`.

### DuckDuckGo helpers

- `_unwrap_duckduckgo_redirect`, `_is_duckduckgo_interstitial`, `_extract_redirect_target_from_html`, `_strip_meta_refresh`
- Research search: `_fetch_search_result_urls` parses HTML result links.

### Research agent (`_run_agent_loop`)

1. `_generate_research_search_query(goal)` — Ollama  
2. `_fetch_search_result_urls` — DDG HTML  
3. For each URL (up to `max_pages`): `_open_agent_tab` → `evaluate_js('window.agentOpenTab(url)')` → sleep → `_wait_for_scraped_content` (polls SQLite)  
4. Synthesis prompt over collected snippets (4000 chars each) → `_agent_ui_result`  
5. `_agent_ui_finish` → JS clears `isAgentRunning`

Threading: **daemon thread**; UI updates via `window.evaluate_js`.

### Ollama configuration

- URL: `http://127.0.0.1:11434/api/generate`
- Model: **`llama3.2:3b`** (hardcoded in all `json={"model": ...}` payloads)
- Timeouts: 10–120s depending on endpoint

### Entry point

```python
api = NabuAPI()
window = webview.create_window(
    title="AI Browser Prototype",
    url=os.path.join(api.base_dir, "ui", "index.html"),
    js_api=api,
    width=1100, height=750,
)
api.window = window
webview.start(debug=True)
```

`base_dir` uses `sys._MEIPASS` when frozen with PyInstaller.

---

## Frontend (`ui/`)

### `index.html`

- **First script:** shell `Location.prototype` override → calls `window.loadUrl(v)` when iframe code hits `window.top.location` (via sandbox + parent routing).
- **Iframe `#web-view`:** `sandbox="allow-scripts allow-forms allow-popups"` — **no** `allow-same-origin`, **no** `allow-top-navigation` (prevents pywebview GTK from replacing entire UI).

### `app.js` modules (conceptual)

| Area | Responsibility |
|------|----------------|
| `NEW_TAB_HTML` | Injected `srcdoc` for blank tabs; `postMessage` for search/navigate |
| `tabs` | Tab list, pills, `create`/`switch`/`close`, `_restoreTab`, `syncTabState` |
| `app` | `log()`, `appendMessage()`, `state` |
| `loadUrl(url)` | Calls `load_and_scrape_url`, sets `srcdoc`, shell visibility reset, tab URL/title sync |
| `injectNavigationInterceptor(html)` | Prepends script: frame-busting spoof, `Location` → `postMessage`, meta-refresh strip, click/submit handlers, in-memory `localStorage` polyfill |
| `handleNavigation()` | URL vs search vs `?` AI intercept |
| `submitSidebarQuery()` | Chat vs research agent |
| `restoreOrInit()` | On `pywebviewready`, restore `active_tabs` |
| Agent hooks | `window.agentOpenTab`, `updateAgentStatus`, `displayAgentResult`, `finishAgentSession` |

### Navigation branches (`handleNavigation`)

- `?` only → search for `?`
- `?…` → `translate_vague_query` → DDG
- `isWebDomain(input)` → HTTPS URL
- else → DDG search

### Message bus

Parent listens for:

- `{ type: 'nabu-navigate', url }` → `loadUrl`
- `{ type: 'nabu-search', query }` → `homePortalSearch`

No strict `e.source` check (GTK often sets `source` to `null` for sandboxed iframes).

---

## Data Layer

### File: `nabu.db` (SQLite)

**`browsing_history`**

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `tab_id` | TEXT | Tab id, `proxy`, `ai_engine`, etc. |
| `url` | TEXT | Final URL after redirects |
| `title` | TEXT | |
| `page_content` | TEXT | Stripped plain text |
| `timestamp` | REAL | `time.time()` |

**`active_tabs`**

| Column | Type | Notes |
|--------|------|-------|
| `tab_id` | TEXT PK | Numeric string from JS counter |
| `url` | TEXT | `about:blank` for new tab |
| `title` | TEXT | |
| `is_active` | INTEGER | 0/1 |

Sidebar chat excludes `tab_id = 'ai_engine'`. AI translator logs synthetic URLs `ai_intent://{query}`.

---

## Feature Walkthroughs

### End-to-end: user opens a URL

1. `handleNavigation` or `loadUrl`  
2. `pywebview.api.load_and_scrape_url(url, tabs.activeId)`  
3. Python fetch + scrape + INSERT history  
4. JS: `frame.srcdoc = injectNavigationInterceptor(result.html)`  
5. `tabs.setUrl/setTitle`, `logNavigationToPython`, `syncTabState`

### End-to-end: sidebar chat

1. `send_sidebar_chat`  
2. SELECT last 5 rows with non-empty `page_content`  
3. Build system prompt + user question → Ollama  
4. Return `{ status, response }` → bubble text

### End-to-end: tab organize

1. JS collects `{ id, title, url }[]` → `classify_and_organize_tabs(JSON)`  
2. Ollama returns JSON array; `_normalize_tab_groups`  
3. JS `applyTabGroups` reorders DOM pills and applies `tab-cluster-*` classes

### End-to-end: research agent

1. `start_research_agent` starts thread  
2. `agentOpenTab` → `tabs.create('Agent', url)` → `loadUrl`  
3. Proxy writes history; `_wait_for_scraped_content` polls by `tab_id` / host / latest  
4. Synthesis → `displayAgentResult`

---

## JS ↔ Python Bridge

- Access: `window.pywebview.api.<method>(args)`  
- Ready event: `pywebviewready` (session restore waits for this)  
- Optional chaining: `window.pywebview?.api?.method` in hot paths  
- Python → JS: `api.window.evaluate_js("window.foo && window.foo(...)")`  

**Convention:** New backend methods go on `NabuAPI` and are called from `app.js`. Keep method names `snake_case` (Python) and map cleanly in JS.

**Do not** rely on navigating `window.location` in the shell for loading pages.

---

## Security & Sandboxing

| Topic | Implementation |
|-------|------------------|
| iframe isolation | Null/opaque origin without `allow-same-origin` |
| Top navigation | Blocked at sandbox; JS redirects → `postMessage` |
| Frame busting | Spoof `window.top`/`parent` in injected script; parent Location override |
| SSL | `verify=False` in proxy (prototype tradeoff) |
| XSS in scraped HTML | Still executes in iframe with `allow-scripts`; treat proxy as displaying untrusted HTML |

---

## Development Setup

```bash
# Install dependencies (example)
pip install pywebview requests

# Ollama
ollama pull llama3.2:3b
ollama serve

# Run from ai-browser directory
cd ai-browser
python main.py
```

`webview.start(debug=True)` enables devtools where supported.

### Debugging tips

- Watch terminal for `[Proxy Engine]`, `[Research Agent]`, `[AI Translator]` logs.  
- Use sidebar **System Logs** for UI-side tracing.  
- Inspect `nabu.db` with `sqlite3 nabu.db` to verify `page_content` length.  
- If shell disappears, check for code paths that set `iframe.src` to external URLs.

---

## Guidelines for Further Development

### Adding a new AI feature

1. Add `NabuAPI` method in `main.py` (Ollama prompt + error handling + fallbacks).  
2. Call from `app.js`; log via `app.log()`.  
3. If it needs page text, read from `browsing_history` or extend schema with a migration in `_init_db`.  
4. Keep prompts bounded (sidebar already truncates to 1500 chars/page).

### Adding a new UI panel

1. Extend `index.html` inside `#workspace-body` or sidebar—preserve grid structure.  
2. Style in `style.css` using existing CSS variables (`--accent`, etc.).  
3. Wire events in `DOMContentLoaded` in `app.js` (avoid inline handlers for consistency).

### Search / instant answer (roadmap)

- Hook after DDG fetch in Python or post-process `result.html` before return.  
- Prefer mutating HTML in one place (`load_and_scrape_url` or a dedicated `enhance_serp(html, query)`).

### Ad/tracker blocking (roadmap)

- Implement in `load_and_scrape_url` or pywebview request hooks; maintain a blocklist module; strip blocked URLs from HTML before inject.

### Explain selection / highlights (roadmap)

- Selection: `mouseup` in injected interceptor → `postMessage` to parent → prefill `#ai-chat-input`.  
- Highlights: new table `highlights(url, start, end, text)` + reinject spans on `loadUrl` success.

### Semantic history (roadmap)

- Embed `page_content` chunks (local embedding model or FTS5); search API on `NabuAPI`.

### Exports (roadmap)

- New method `export_research_session(format)` reading history + chat + `active_tabs`.

### Code style (match existing code)

- Minimal abstraction; inline prompts unless shared.  
- Silent catch on bridge optional calls; log errors in Python with `print`.  
- Prefer extending `load_and_scrape_url` over duplicate fetch logic.  
- Thread long work (agent); never block `webview` UI thread in Python callbacks.

### Testing checklist

- [ ] Ollama stopped → graceful error strings  
- [ ] DDG search + click result link  
- [ ] `?` query fallback when Ollama empty  
- [ ] Session restore with multiple tabs  
- [ ] Research agent with `max_pages=1` and `=10`  
- [ ] Organize with 1 tab and 5+ tabs  
- [ ] Site with heavy JS (expect partial/broken render)

---

## Roadmap Alignment

| Planned feature | Suggested touchpoints |
|-----------------|----------------------|
| AI SERP summary | `load_and_scrape_url` or DDG-specific postprocessor; Ollama on top 3 snippets |
| Instant answer | Query classifier + `_fetch_search_result_urls` or structured APIs |
| Ad/tracker block | `requests` session hooks / HTML rewrite in proxy |
| Explain selection | `injectNavigationInterceptor` + sidebar input API |
| Persistent highlights | SQLite migration + reinject in `loadUrl` |
| Page TL;DR | Toolbar button → `send_sidebar_chat`-like endpoint → overlay DOM in shell |
| Semantic history | New table/index; search endpoint; UI in sidebar or address bar |
| Notebook export | `NabuAPI.export_*` aggregating `browsing_history` + chat logs |

---

## Related documentation

- [USER_GUIDE.md](./USER_GUIDE.md) — End-user features, troubleshooting, legal notice.

---

*This guide describes the prototype as implemented in `ai-browser/`. When behavior changes, update both docs accordingly without coupling doc edits to unrelated application refactors.*
