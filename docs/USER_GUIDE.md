# Nabu Browser — User Guide

**Version:** Prototype  
**Last updated:** June 2026

Nabu Browser is a desktop browser with a built-in **local AI workspace**. Pages are loaded through a secure proxy, and text from sites you visit is stored locally so the AI sidebar can answer questions about what you are reading—without sending your browsing data to cloud services.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Features](#features)
3. [How to Use](#how-to-use)
4. [Troubleshooting](#troubleshooting)
5. [Known Issues (Prototype)](#known-issues-prototype)
6. [Planned Future Features](#planned-future-features)
7. [AI Accuracy & Legal Notice](#ai-accuracy--legal-notice)

---

## Getting Started

### Requirements

- **Linux** (tested with WebKit2GTK via pywebview)
- **Python 3** with `pywebview` and `requests` installed
- **[Ollama](https://ollama.com/)** running locally on `http://127.0.0.1:11434`
- The model **`llama3.2:3b`** pulled in Ollama (`ollama pull llama3.2:3b`)

### Launching Nabu

From the repository root:

```bash
cd ai-browser
python main.py
```

On first launch you see the **Nabu Workspace** new-tab page. Open tabs and URLs from your last session are restored automatically when possible.

### Local AI status

The toolbar shows **Local AI Ready** (green pulsing dot) or **Local AI Offline** (gray dot). **Click the status button** to turn all AI features on or off:

- **Off:** Sidebar chat and research, tab organize, and `?` query translation are disabled. Plain search and browsing still work; `?` searches use your raw text without AI keyword expansion.
- **On:** Full AI features are available (requires Ollama running for responses).

### AI model (toolbar)

Next to **Local AI Ready**, the **model dropdown** lists models installed in Ollama (`ollama pull …`). The selection applies to `?` address-bar search, sidebar chat, tab organize, and the research agent. Your choice is saved in `nabu.db` and restored on restart. Use **Check Ollama** in System Logs if a model is missing.

---

## Features

| Feature | Description |
|--------|-------------|
| **Multi-tab browsing** | Open, switch, and close tabs. The last tab cannot be closed. |
| **New Tab workspace** | Search the web, or jump to quick links (Nabu GitHub, documentation, Ollama model search). |
| **Address bar routing** | Enter a URL, a plain search, or an AI-assisted search (see below). |
| **Python proxy loading** | Every page is fetched on your machine, then shown inside the browser viewport. This enables scraping and avoids many cross-origin limits. |
| **DuckDuckGo HTML search** | Plain-text and `?` queries use DuckDuckGo’s HTML results (no separate search engine account). |
| **AI query translation (`?`)** | Prefix a vague question with `?` (e.g. `? that paper about transformers from last year`). Ollama turns it into search keywords, then opens DuckDuckGo. |
| **AI sidebar — General Chat** | Ask questions; the assistant uses text from your **last five scraped pages** as context. |
| **AI sidebar — Objective Research Agent** | Enter a research goal; the agent searches, opens up to N pages (1–10, default 4), scrapes them, and writes a synthesized report. |
| **AI Organize Tabs** | Groups open tabs by topic using Ollama and colors clusters in the tab strip. |
| **Session restore** | Open tabs (URL, title, which was active) are saved in a local SQLite database and restored on restart. |
| **Browsing memory** | Full page text from proxied loads is stored locally for AI context and future history features. |
| **System Logs** | Sidebar tab with timestamped events (navigation, proxy, AI, session). Includes **Check Ollama** and **Restart Ollama** troubleshooting buttons. |
| **Back / Forward / Refresh** | Back and forward use in-iframe history where possible; refresh reloads the current URL through the proxy. |

---

## How to Use

### Address bar

| What you type | What happens |
|---------------|--------------|
| `github.com` or `https://example.com` | Opens the site through the proxy. |
| `capital of france` | DuckDuckGo HTML search for that phrase. |
| `? vague memory about solar panels` | Ollama extracts keywords → DuckDuckGo search. |
| `?` alone | Treated as a normal search for `?`, not AI intercept. |

Press **Enter** in the address bar to navigate.

### New Tab page

- Type in the search box and press **Enter** to search via DuckDuckGo.
- Click quick links to open preset URLs.

### Tabs

- **+** — New tab (blank workspace).
- Click a tab pill to switch.
- **×** on a pill — Close tab (not allowed on the last tab).
- **Organize** — AI groups tabs; pills are reordered and color-coded by cluster.

### AI sidebar

1. **AI Assistant** — Choose mode from the dropdown:
   - **General Chat** — Ask about pages you have loaded; uses recent scraped text.
   - **Objective Research Agent** — Set **Max pages** (1–10), enter a goal, send. Progress appears in chat; the final report appears when done. Only one agent run at a time.
2. **System Logs** — Read technical messages if something fails.
3. **Send** — **Enter** to send; **Shift+Enter** for a new line in the input.

### System Logs — Ollama troubleshooting

Open **System Logs** in the sidebar:

- **Check Ollama** — Verifies that Ollama responds at `http://127.0.0.1:11434` and that `llama3.2:3b` is installed. Results appear in the log panel.
- **Restart Ollama** — Best-effort restart (`systemctl --user restart ollama` when available, otherwise `pkill` + `ollama serve`). Confirms before running; may interrupt other apps using Ollama. Not available while the research agent is running.

### Following links on a page

Links inside the page are intercepted and routed through the same proxy pipeline, so the browser shell (toolbar, tabs, sidebar) stays visible.

### Context hint (⌗)

The address bar shows a **⌗** hint for future “explain selection” behavior. In the prototype it is visual only; highlighting text does not yet send it to the AI.

---

## Troubleshooting

| Problem | What to try |
|--------|-------------|
| **“Could not connect to local AI engine”** | Start Ollama: `ollama serve`. Pull the model: `ollama pull llama3.2:3b`. Confirm `http://localhost:11434` works in a browser. |
| **“Proxy unavailable” / blank error page** | Run the app with `python main.py` from `ai-browser` so the Python bridge loads. Do not open `ui/index.html` directly in a normal browser. |
| **AI Organize / Research does nothing** | Check **System Logs**. Ensure Ollama is running; research can take several minutes. |
| **Search returns no useful results** | Rephrase the query or use `?` for AI keyword expansion. Try a more specific phrase. |
| **Page looks broken (no CSS/images)** | Some sites block proxy user-agents or rely on scripts the sandbox limits. Refresh once; try the canonical HTTPS URL. |
| **Session did not restore** | If `nabu.db` was deleted or moved, tabs start fresh. Only tab metadata is restored—not in-iframe back/forward history. |
| **Research agent: “Could not find any search results”** | Check network. DuckDuckGo HTML layout may have changed; try a simpler research goal. |

---

## Known Issues (Prototype)

These are expected limitations of the current build, not necessarily bugs in your setup.

### UI layout glitches

On some **GTK / WebKit2GTK** builds, after loading a heavy page the toolbar, sidebar, or viewport can briefly mis-render (wrong size, hidden chrome). The app tries to reset shell visibility after each load; if the UI still looks wrong, **refresh the page** or **switch tabs** and back. A full restart fixes persistent glitches.

### DuckDuckGo “Are you a human?” / CAPTCHA

Because Nabu loads DuckDuckGo through an automated proxy (server-side `requests` and repeated searches), DuckDuckGo may sometimes show a **bot verification** or CAPTCHA page instead of results. This is more common after many searches in a short time. **Wait and try again**, use a **more specific URL** if you know the destination, or rephrase the query. There is no built-in CAPTCHA solver.

### AI or agent opens wrong / unavailable sites

The research agent picks URLs from DuckDuckGo HTML parsing. It may visit **dead links**, **paywalls**, or **pages with little text** (e.g. pure JavaScript apps). The agent may then report that it could not scrape content or produce a thin summary. **Lower max pages** or **narrow your research goal** for better results.

### Back and forward are limited

Navigation history lives inside the **current tab’s iframe** only. There is no global history UI. Back/forward may do nothing on a fresh tab or after a full proxy reload.

### Research agent interrupted by AI toggle

If you turn **Local AI** off while a research agent run is in progress, browsing/scraping may continue but synthesis stops with a notice. Start a new run after turning AI back on.

### Security and privacy notes (prototype)

- Page fetches use **`verify=False`** for HTTPS in the proxy (easier local dev; not ideal for production).
- Browsing text is stored in **`nabu.db`** next to the app—clear that file if you need to wipe local history.
- Injected pages run in a **sandboxed iframe** without `allow-same-origin`; complex sites may behave differently than in Chrome or Firefox.

### Sites that refuse to load in iframes

Some sites use frame-busting or strict policies. Nabu injects mitigations, but certain pages may still fail or redirect oddly. Use the direct URL in the address bar or try an alternative source.

---

## Planned Future Features

Roadmap items below are **not yet available** in the prototype; they describe what the team intends to build.

### Smart search and content

- **AI search intent summarization** — Short AI summary pinned above search results (Perplexity-style), from the top snippets.
- **Instant answers** — Direct answers for factual or conversion-style queries in a card above links.
- **Ad and tracker blocking** — Block known ad/tracker domains in the proxy for faster loads and cleaner scraping.

### Advanced AI workspace

- **Explain selection** — Right-click highlighted text → send to the AI sidebar.
- **Persistent highlights** — Save highlights per URL in SQLite and restore them when you revisit the page.
- **Summarize page (TL;DR)** — Toolbar button for a bulleted overlay summary without opening chat.

### History and memory

- **Semantic history search** — Search over full page text you have visited, not just titles/URLs.
- **Research notebook export** — Export session, agent findings, and tab summaries to Markdown or PDF.

---

## AI Accuracy & Legal Notice

### AI can be wrong (hallucination)

Nabu uses a **local language model** (default: `llama3.2:3b`). It can:

- Invent facts, citations, or URLs  
- Misread or ignore page context  
- Summarize incorrectly or omit important caveats  

**Do not rely on AI output for medical, legal, financial, or safety-critical decisions.** Verify important information against primary sources.

### Not professional advice

Chat and research reports are **informational only**. They are not legal, medical, investment, or professional advice.

### Copyright and terms of use

- You are responsible for how you use content from websites (**copyright**, terms of service, paywalls).  
- The proxy fetches and stores page text **on your device** for your personal use features; do not use Nabu to systematically scrape sites in violation of their terms.  
- AI-generated summaries may still incorporate copyrighted material; respect publisher rights when sharing exports (future feature).

### Data stays local (with caveats)

- **Ollama** runs on your machine; prompts are not sent to Nabu’s cloud (there is no Nabu cloud in this prototype).  
- **SQLite (`nabu.db`)** holds URLs, titles, and page text on disk—protect this file on shared computers.  
- **Third-party sites** (DuckDuckGo, pages you visit) still see proxy requests from your IP like any browser would.

### Prototype software

This build is a **prototype**: incomplete features, rough edges, and no warranty. Use at your own risk. Report issues to your project maintainers.

---

## Quick reference

| Action | How |
|--------|-----|
| Search | Type query in address bar → Enter |
| AI-assisted search | `?` + your vague query → Enter |
| Open URL | `example.com` or full `https://…` → Enter |
| New tab | **+** in tab strip |
| AI chat | Sidebar → General Chat → type → Enter |
| Research | Sidebar → Objective Research Agent → set max pages → Enter |
| View logs | Sidebar → System Logs |
| Organize tabs | **Organize** in tab bar |

For technical architecture and contribution guidelines, see [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md).
