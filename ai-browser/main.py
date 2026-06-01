import os
import re
import sys
import sqlite3
import time
from urllib.parse import parse_qs, unquote, urlparse

import requests
import webview


class NabuAPI:

    def __init__(self):
        # 1. Setup local database paths
        # getattr(sys, '_MEIPASS', ...) resolves to PyInstaller's temp unpack
        # directory when running as a compiled bundle, and falls back to the
        # script's own directory during normal development execution.
        self.base_dir = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        self.db_path = os.path.join(self.base_dir, "nabu.db")

        # 2. Setup Ollama endpoint
        self.ollama_url = "http://127.0.0.1:11434/api/generate"

        # 3. Initialize the database immediately on boot
        self._init_db()
        print(f"[Nabu Backend] Connected to local memory bank at: {self.db_path}")

    def test_connection(self, message):
        """A simple function to verify the bridge works"""
        print(f"[Python received from UI]: {message}")
        return "Backend is connected and listening!"

    def get_ai_keywords(self, vague_query):
        """Feature 1: Quick test to see if Ollama responds"""
        prompt = f"Convert this memory into 2-3 search keywords. Output ONLY keywords: '{vague_query}'"
        try:
            response = requests.post(
                self.ollama_url,
                json={"model": "llama3.2:3b", "prompt": prompt, "stream": False},
                timeout=10
            )
            return response.json().get("response", "").strip()
        except Exception as e:
            return f"Error connecting to Ollama: {str(e)}"

    def translate_vague_query(self, query):
        """
        Feature 4.1: Takes a vague memory string, prompts Ollama to extract 2-3 
        precise search engine keywords, and logs the action to SQLite.
        """
        query = str(query).strip()
        if not query:
            return {"status": "error", "keywords": "", "message": "Query was empty"}

        # System prompt ensuring Ollama acts purely as an optimization tool
        prompt = (
            "You are a search engine optimization engine. Convert the following vague memory "
            "or description into 2 to 3 highly precise, space-separated search keywords. "
            "Output ONLY the raw search keywords. Do not include introductory text, punctuation, "
            f"or formatting. Memory: '{query}'"
        )

        try:
            # 1. Fire the request to your local Ollama generation api
            response = requests.post(self.ollama_url, json={
                "model": "llama3.2:3b",  # Updated target model
                "prompt": prompt, 
                "stream": False
            }, timeout=10) # 10-second timeout to prevent UI freezes
            
            ai_output = response.json().get("response", "").strip()
            
            # FALLBACK: If Ollama responds with an empty string, default back to original query
            if not ai_output:
                print("[AI Translator Warning] Ollama returned an empty string. Falling back to raw query.")
                ai_output = query
            
            # 2. Log this transaction to your database for internal context tracking
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO browsing_history (tab_id, url, title, timestamp)
                VALUES (?, ?, ?, ?)
            ''', ("ai_engine", f"ai_intent://{query}", f"AI Keywords: {ai_output}", time.time()))
            conn.commit()
            conn.close()

            print(f"[AI Translator] Success: '{query}' -> '{ai_output}'")
            return {"status": "success", "keywords": ai_output}

        except Exception as e:
            print(f"[AI Translator Error] Fail: {str(e)}")
            # Fallback to the original user query so the browser doesn't break if Ollama is asleep
            return {"status": "error", "keywords": query, "message": str(e)}

    def _init_db(self):
        """Creates nabu.db tables if they don't exist yet."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        # Browsing history — full page_content for AI sidebar context
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS browsing_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tab_id TEXT,
                url TEXT NOT NULL,
                title TEXT,
                page_content TEXT,
                timestamp REAL NOT NULL
            )
        """
        )

        # Active tab session — one row per open tab, restored on next boot
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS active_tabs (
                tab_id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT,
                is_active INTEGER DEFAULT 0
            )
        """
        )

        conn.commit()
        conn.close()

    def log_navigation(self, tab_id, url, title="New Tab", page_content=""):
        """
        Exposed Python Bridge method. Now accepts 'page_content' string payload
        from the frontend scraper to save full text context into SQLite.
        """
        url = str(url).strip()
        title = str(title).strip()
        page_content = str(page_content).strip()

        if not url or url == "about:blank":
            return {"status": "skipped", "reason": "empty_url"}

        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            now = time.time()

            # Insert all metadata along with the full webpage body content
            cursor.execute(
                """
                INSERT INTO browsing_history (tab_id, url, title, page_content, timestamp)
                VALUES (?, ?, ?, ?, ?)
            """,
                (str(tab_id), url, title, page_content, now),
            )

            conn.commit()
            conn.close()

            print(
                f"[Database Log] Saved page metadata + ({len(page_content)} chars text content) for: {url}"
            )
            return {"status": "success", "logged": url}

        except Exception as e:
            print(f"[Database Error] Failed writing history record: {str(e)}")
            return {"status": "error", "message": str(e)}

    def send_sidebar_chat(self, user_message):
        """
        Sidebar Chat Assistant. Reads recent browsing history AND the full 
        webpage text content from SQLite, presenting it to Ollama as context.
        """
        user_message = str(user_message).strip()
        if not user_message:
            return {"status": "error", "response": "Message was empty."}

        # 1. Fetch the last 5 history items including full text body content
        history_context = ""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            # We look at the top 5 pages to keep the AI context window highly dense and fast
            cursor.execute(
                """
                SELECT url, title, page_content FROM browsing_history 
                WHERE tab_id != 'ai_engine' AND page_content IS NOT NULL AND page_content != ''
                ORDER BY timestamp DESC LIMIT 5
            """
            )
            rows = cursor.fetchall()
            conn.close()

            if rows:
                history_context = "THE USER IS CURRENTLY LOOKING AT THE FOLLOWING WEBPAGE CONTENTS:\n"
                for row in rows:
                    history_context += f"--- START OF PAGE ---\n"
                    history_context += f"URL: {row[0]}\nTITLE: {row[1]}\n"
                    # Trim individual page content to the first 1500 characters 
                    # to keep local processing speeds incredibly fast for llama3.2:3b
                    snippet = row[2][:1500]
                    history_context += f"PAGE TEXT CONTENT CONTEXT:\n{snippet}\n"
                    history_context += f"--- END OF PAGE ---\n\n"
        except Exception as db_err:
            print(f"[Sidebar Context Error] Failed fetching history: {str(db_err)}")

        # 2. Build the deeply informed system prompt
        system_instructions = (
            "You are Nabu's built-in AI Sidebar Assistant, deeply integrated into the user's browser.\n"
            "You have direct access to read the actual text contents of the web pages the user is "
            "browsing, provided below. Use this inner page text context to synthesize summaries, "
            "answer technical questions, analyze text, or find specific details directly from what "
            "they are reading. Keep your answers conversational, concise, and accurate to the text.\n\n"
            f"{history_context}"
        )

        full_prompt = f"{system_instructions}\nUser Question: {user_message}\nAssistant:"

        try:
            response = requests.post(
                self.ollama_url,
                json={
                    "model": "llama3.2:3b",
                    "prompt": full_prompt,
                    "stream": False,
                },
                timeout=30,
            )

            ai_response = response.json().get("response", "").strip()
            return {"status": "success", "response": ai_response}

        except Exception as e:
            print(f"[Sidebar Chat Error] Failed to generate: {str(e)}")
            return {
                "status": "error",
                "response": f"Could not connect to local AI engine: {str(e)}",
            }
    @staticmethod
    def _unwrap_duckduckgo_redirect(url):
        """Decode DuckDuckGo /l/?uddg=… tracking URLs to the real destination."""
        try:
            parsed = urlparse(url)
            if "duckduckgo.com" not in parsed.netloc.lower():
                return url
            params = parse_qs(parsed.query)
            if params.get("uddg"):
                target = unquote(params["uddg"][0])
                if target.startswith("http://") or target.startswith("https://"):
                    return target
        except Exception:
            pass
        return url

    @staticmethod
    def _is_duckduckgo_interstitial(final_url, raw_html):
        """True when the response is a redirect hop, not a SERP or real site."""
        try:
            parsed = urlparse(final_url)
            host = parsed.netloc.lower()
            path = parsed.path.lower()
            if "duco.duckduckgo.com" in host:
                return True
            if host.endswith("duckduckgo.com") and "/l/" in path:
                return True
            if host.endswith("duckduckgo.com") and "/html/" in path:
                return False
            if host.endswith("duckduckgo.com") and (
                "window.top.location" in raw_html
                or "window.location.replace" in raw_html
                or re.search(r'<meta[^>]+http-equiv=["\']refresh["\']', raw_html, re.I)
            ):
                return True
        except Exception:
            pass
        return False

    @staticmethod
    def _extract_redirect_target_from_html(raw_html):
        """Pull destination URL from DDG JS/meta-refresh redirect stubs."""
        patterns = [
            r"uddg=([^&\"'\s<>]+)",
            r'window\.top\.location(?:\.href)?\s*=\s*["\']([^"\']+)["\']',
            r'window\.location(?:\.replace|\.href)?\s*\(\s*["\']([^"\']+)["\']',
            r'window\.location(?:\.href)?\s*=\s*["\']([^"\']+)["\']',
            r'<meta[^>]+http-equiv=["\']refresh["\'][^>]+content=["\'][^"\']*url=([^"\']+)',
        ]
        for pattern in patterns:
            match = re.search(pattern, raw_html, re.I)
            if not match:
                continue
            target = unquote(match.group(1))
            if target.startswith("http://") or target.startswith("https://"):
                if "duckduckgo.com" not in urlparse(target).netloc.lower():
                    return target
        return None

    @staticmethod
    def _strip_meta_refresh(html):
        return re.sub(
            r'<meta[^>]+http-equiv=["\']refresh["\'][^>]*>',
            "",
            html,
            flags=re.I,
        )

    def load_and_scrape_url(self, url):
        """
        Feature 5.1: Local Python Proxy. Downloads a webpage on the backend,
        extracts its inner readable text, commits it to SQLite, and returns 
        the HTML contents directly to bypass CORS restrictions.
        
        Fixes: Missing protocols, strict SSL test blocks, anti-bot user-agents, 
        and broken asset paths via <base href> injection.
        """
        url = str(url).strip()
        if not url or url == "about:blank":
            return {"status": "error", "html": "<h1>Invalid URL</h1>", "text": ""}

        # FIX 1: Auto-inject protocol headers if missing
        if not url.startswith("http://") and not url.startswith("https://"):
            url = "https://" + url

        # Unwrap DDG tracking URLs before fetch (search-result clicks).
        url = self._unwrap_duckduckgo_redirect(url)

        print(f"[Proxy Engine] Intercepting request for: {url}")

        try:
            # FIX 2: Modern Chrome signature header to prevent websites from blocking the proxy
            headers = {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
            
            # FIX 3: verify=False prevents strict SSL handshakes from crashing local proxy routines
            response = requests.get(url, headers=headers, timeout=10, verify=False)
            raw_html = response.text

            # Use the final URL after all HTTP redirects (e.g. duco.duckduckgo.com → en.wikipedia.org).
            # The original `url` may be a redirect intermediary; using it as <base href> would make
            # every relative asset path (CSS, JS, images) resolve to the wrong server.
            final_url = response.url

            # DDG often returns a JS/meta-refresh stub that requests cannot follow.
            # Re-fetch the decoded destination so the iframe never runs frame-busting scripts.
            if self._is_duckduckgo_interstitial(final_url, raw_html):
                target = self._extract_redirect_target_from_html(raw_html)
                if target:
                    print(f"[Proxy Engine] DDG interstitial resolved → {target}")
                    response = requests.get(target, headers=headers, timeout=10, verify=False)
                    raw_html = response.text
                    final_url = response.url

            # 2. Extract a clean readable text body representation
            # Remove script and style elements entirely
            clean_text = re.sub(r'<(script|style).*?>([\s\S]*?)</\1>', ' ', raw_html)
            # Strip all remaining HTML brackets
            clean_text = re.sub(r'<.*?>', ' ', clean_text)
            # Collapse excess whitespace down to single space characters
            clean_text = re.sub(r'\s+', ' ', clean_text).strip()

            # 3. Pull an approximate page title from the HTML content
            title_match = re.search(r'<title>(.*?)</title>', raw_html, re.IGNORECASE)
            page_title = title_match.group(1).strip() if title_match else "Scraped Tab View"

            # FIX 4: Patch broken CSS stylesheets, images, and fonts by injecting a <base> tag.
            # This forces the iframe to resolve relative asset paths directly from the website's live servers.
            # Use final_url (post-redirect) so paths resolve against the correct origin.
            base_tag = f'<head><base href="{final_url}">'
            modified_html = raw_html.replace('<head>', base_tag, 1)

            # FIX 5: Forcefully inject an iframe containment reset style directly into the page source.
            # Prevents the page's own html/body from expanding beyond the iframe's allocated viewport,
            # which would otherwise push Nabu's navigation chrome off-screen.
            iframe_containment_style = """
<style>
    html, body {
        max-height: 100vh !important;
        overflow: auto !important;
        margin: 0 !important;
        padding: 0 !important;
    }
</style>
"""
            modified_html = modified_html.replace('</head>', f'{iframe_containment_style}</head>', 1)
            modified_html = self._strip_meta_refresh(modified_html)

            # 4. Commit the scraped page to the browsing history store.
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO browsing_history (tab_id, url, title, timestamp) VALUES (?, ?, ?, ?)",
                ("proxy", url, page_title, time.time()),
            )
            conn.commit()
            conn.close()
            print(f"[Proxy Engine] Scraped and stored: {page_title} ({final_url})")

            return {
                "status":  "success",
                "html":    modified_html,
                "url":     final_url,
                "title":   page_title,
                "text":    clean_text,
            }

        except Exception as e:
            print(f"[Proxy Engine] Failed to fetch {url}: {str(e)}")
            error_html = f"""<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;color:#c0392b;">
<h2>Proxy Error</h2><p>Could not load <code>{url}</code></p><pre>{str(e)}</pre>
</body></html>"""
            return {
                "status": "error",
                "html":   error_html,
                "url":    url,
                "title":  "Load Error",
                "text":   str(e),
            }

    def save_tab_state(self, tab_id, url, title, is_active):
        """Feature 6.1: Saves or updates an open tab's structural layout state in SQLite."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO active_tabs (tab_id, url, title, is_active)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(tab_id) DO UPDATE SET
                    url = excluded.url,
                    title = excluded.title,
                    is_active = excluded.is_active
            """,
                (str(tab_id), str(url), str(title), 1 if is_active else 0),
            )
            conn.commit()
            conn.close()
            return {"status": "success"}
        except Exception as e:
            print(f"[Session Error] Failed saving state row: {str(e)}")
            return {"status": "error", "message": str(e)}

    def remove_tab_state(self, tab_id):
        """Removes a tab record from database when closed by the user."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute("DELETE FROM active_tabs WHERE tab_id = ?", (str(tab_id),))
            conn.commit()
            conn.close()
            return {"status": "success"}
        except Exception as e:
            print(f"[Session Error] Failed deleting state row: {str(e)}")
            return {"status": "error"}

    def restore_session(self):
        """Fetches the last recorded active workspace layout row states on startup."""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute("SELECT tab_id, url, title, is_active FROM active_tabs")
            rows = cursor.fetchall()
            conn.close()
            
            # Reformat row objects into structural dictionary payloads for JS consumption
            sessions = []
            for row in rows:
                sessions.append({
                    "tab_id": row[0],
                    "url": row[1],
                    "title": row[2],
                    "is_active": bool(row[3])
                })
            return {"status": "success", "tabs": sessions}
        except Exception as e:
            print(f"[Session Error] Recovery failed: {str(e)}")
            return {"status": "error", "tabs": []}


# --- Execution Pipeline ---

# Instantiate our unified backend API
api = NabuAPI()

# Create the desktop window pointing to our local UI file.
# Use api.base_dir so the path resolves correctly both in dev and as a
# PyInstaller bundle where the CWD is not guaranteed to be the app root.
window = webview.create_window(
    title="AI Browser Prototype",
    url=os.path.join(api.base_dir, "ui", "index.html"),
    js_api=api,  # Exposes all methods inside NabuAPI to JS
    width=1100,
    height=750,
)

# Start the application loop (This locks execution while the window runs)
webview.start(debug=True)