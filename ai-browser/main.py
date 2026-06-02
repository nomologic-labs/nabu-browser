import json
import os
import re
import shutil
import subprocess
import sys
import sqlite3
import threading
import time
from urllib.parse import parse_qs, unquote, urlparse

import requests
import webview


class NabuAPI:
    DEFAULT_MODEL = "llama3.2:3b"

    def __init__(self):
        # 1. Setup local database paths
        # getattr(sys, '_MEIPASS', ...) resolves to PyInstaller's temp unpack
        # directory when running as a compiled bundle, and falls back to the
        # script's own directory during normal development execution.
        self.base_dir = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        self.db_path = os.path.join(self.base_dir, "nabu.db")

        # 2. Setup Ollama endpoint
        self.ollama_root = "http://127.0.0.1:11434"
        self.ollama_url = f"{self.ollama_root}/api/generate"
        self._ollama_restart_in_progress = False

        # 3. Initialize the database immediately on boot
        self._init_db()

        # Set after webview.create_window(); used by the research agent for evaluate_js.
        self.window = None

        # User-toggleable gate for all Ollama-backed features (toolbar "Local AI" button).
        self._ai_enabled = True
        self._active_model = self.DEFAULT_MODEL
        self._ai_lock = threading.Lock()
        self._load_active_model_setting()

        print(f"[Nabu Backend] Connected to local memory bank at: {self.db_path}")
        print(f"[Nabu Backend] Active Ollama model: {self._active_model}")

    def _ai_is_enabled(self):
        with self._ai_lock:
            return self._ai_enabled

    def set_ai_enabled(self, enabled):
        """Sync backend AI gate with the toolbar toggle."""
        with self._ai_lock:
            self._ai_enabled = bool(enabled)
            state = self._ai_enabled
        print(f"[Nabu Backend] Local AI {'enabled' if state else 'disabled'}")
        return {"status": "success", "enabled": state}

    def get_ai_enabled(self):
        with self._ai_lock:
            return {"status": "success", "enabled": self._ai_enabled}

    def _get_active_model(self):
        with self._ai_lock:
            return self._active_model

    def get_active_model(self):
        return {"status": "success", "model": self._get_active_model()}

    def set_active_model(self, model_name):
        """Persist and use the selected Ollama model for all AI features."""
        model_name = str(model_name).strip()
        if not model_name:
            return {"status": "error", "message": "Model name was empty."}
        with self._ai_lock:
            self._active_model = model_name
        self._persist_setting("active_model", model_name)
        print(f"[Nabu Backend] Active Ollama model → {model_name}")
        return {"status": "success", "model": model_name}

    def _fetch_installed_model_names(self):
        try:
            response = requests.get(f"{self.ollama_root}/api/tags", timeout=5)
            response.raise_for_status()
            payload = response.json()
            names = [
                str(m.get("name", "")).strip()
                for m in payload.get("models", [])
                if isinstance(m, dict) and m.get("name")
            ]
            return sorted(set(names), key=str.lower)
        except Exception as exc:
            print(f"[Ollama] Could not list models: {exc}")
            return []

    def list_ollama_models(self):
        """Return installed model tags and the currently selected model."""
        models = self._fetch_installed_model_names()
        active = self._get_active_model()
        if active and active not in models:
            models = sorted(set(models) | {active}, key=str.lower)
        return {
            "status": "success",
            "models": models,
            "active_model": active,
        }

    def _model_is_installed(self, model_name, installed_names):
        if not model_name:
            return False
        if model_name in installed_names:
            return True
        return any(
            name == model_name or name.startswith(f"{model_name}:")
            for name in installed_names
        )

    def _ollama_generate(self, prompt, timeout=30):
        """Run a single non-streaming generate call with the active model."""
        model = self._get_active_model()
        response = requests.post(
            self.ollama_url,
            json={"model": model, "prompt": prompt, "stream": False},
            timeout=timeout,
        )
        response.raise_for_status()
        return response.json().get("response", "").strip()

    def _ui_log(self, message):
        """Append a line to the System Logs panel from Python."""
        if self.window is None:
            return
        payload = json.dumps(str(message))
        self._eval_js(f"typeof app !== 'undefined' && app.log({payload})")

    def check_ollama_health(self):
        """Probe Ollama HTTP API and report whether the configured model is present."""
        try:
            response = requests.get(f"{self.ollama_root}/api/tags", timeout=5)
            response.raise_for_status()
            payload = response.json()
            models = [
                str(m.get("name", "")).strip()
                for m in payload.get("models", [])
                if isinstance(m, dict)
            ]
            selected = self._get_active_model()
            has_selected = self._model_is_installed(selected, models)
            if has_selected:
                message = (
                    f"Ollama is reachable at {self.ollama_root}. "
                    f"Selected model “{selected}” is available."
                )
            else:
                listed = ", ".join(models[:5]) if models else "(none)"
                message = (
                    f"Ollama is running but “{selected}” was not found. "
                    f"Installed: {listed}. Run: ollama pull {selected}"
                )
            return {
                "status": "success",
                "healthy": True,
                "has_required_model": has_selected,
                "required_model": selected,
                "models": models,
                "message": message,
            }
        except requests.ConnectionError:
            selected = self._get_active_model()
            return {
                "status": "error",
                "healthy": False,
                "has_required_model": False,
                "required_model": selected,
                "models": [],
                "message": (
                    f"Cannot connect to Ollama at {self.ollama_root}. "
                    "Start it with: ollama serve"
                ),
            }
        except Exception as exc:
            selected = self._get_active_model()
            return {
                "status": "error",
                "healthy": False,
                "has_required_model": False,
                "required_model": selected,
                "models": [],
                "message": f"Health check failed: {exc}",
            }

    def restart_ollama(self):
        """Best-effort Ollama restart on a background thread (non-blocking)."""
        if self._ollama_restart_in_progress:
            return {"status": "error", "message": "An Ollama restart is already in progress."}
        threading.Thread(target=self._restart_ollama_worker, daemon=True).start()
        return {"status": "started", "message": "Ollama restart started. Watch System Logs for progress."}

    def _run_subprocess(self, cmd, timeout=20):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            detail = (result.stdout or "") + (result.stderr or "")
            return result.returncode == 0, detail.strip()
        except Exception as exc:
            return False, str(exc)

    def _wait_for_ollama(self, deadline_seconds=45):
        deadline = time.time() + deadline_seconds
        while time.time() < deadline:
            try:
                response = requests.get(f"{self.ollama_root}/api/tags", timeout=3)
                if response.status_code == 200:
                    return True
            except requests.RequestException:
                pass
            time.sleep(1)
        return False

    def _restart_ollama_worker(self):
        self._ollama_restart_in_progress = True
        try:
            self._ui_log("[Ollama] Restart requested…")

            restarted = False
            if shutil.which("systemctl"):
                ok, detail = self._run_subprocess(
                    ["systemctl", "--user", "restart", "ollama"],
                    timeout=40,
                )
                if ok:
                    self._ui_log("[Ollama] systemctl --user restart ollama succeeded.")
                    restarted = True
                elif detail:
                    self._ui_log(f"[Ollama] systemctl restart skipped: {detail[:200]}")

            if not restarted:
                if shutil.which("pkill"):
                    self._run_subprocess(["pkill", "-x", "ollama"], timeout=5)
                    time.sleep(1.5)
                    self._ui_log("[Ollama] Stopped existing ollama process(es).")

                ollama_bin = shutil.which("ollama")
                if not ollama_bin:
                    self._ui_log(
                        "[Ollama] ✗ Could not find “ollama” in PATH. "
                        "Install Ollama or restart it manually."
                    )
                    return

                try:
                    subprocess.Popen(
                        [ollama_bin, "serve"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        start_new_session=True,
                    )
                    self._ui_log("[Ollama] Launched: ollama serve")
                    restarted = True
                except Exception as exc:
                    self._ui_log(f"[Ollama] ✗ Failed to start ollama serve: {exc}")
                    return

            self._ui_log("[Ollama] Waiting for API to become ready…")
            if self._wait_for_ollama(45):
                health = self.check_ollama_health()
                self._ui_log(f"[Ollama] ✓ {health.get('message', 'Ready.')}")
                self._eval_js(
                    "typeof window.refreshModelSelect === 'function' && window.refreshModelSelect()"
                )
            else:
                self._ui_log(
                    "[Ollama] ✗ Timed out waiting for API. "
                    "Try: ollama serve  (or systemctl --user start ollama)"
                )
        except Exception as exc:
            self._ui_log(f"[Ollama] ✗ Restart error: {exc}")
        finally:
            self._ollama_restart_in_progress = False
            self._eval_js(
                "typeof window.onOllamaRestartDone === 'function' && window.onOllamaRestartDone()"
            )

    def test_connection(self, message):
        """A simple function to verify the bridge works"""
        print(f"[Python received from UI]: {message}")
        return "Backend is connected and listening!"

    def get_ai_keywords(self, vague_query):
        """Feature 1: Quick test to see if Ollama responds"""
        if not self._ai_is_enabled():
            return "Local AI is turned off."
        prompt = f"Convert this memory into 2-3 search keywords. Output ONLY keywords: '{vague_query}'"
        try:
            return self._ollama_generate(prompt, timeout=10)
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
        if not self._ai_is_enabled():
            return {
                "status": "error",
                "keywords": query,
                "message": "Local AI is turned off",
            }

        # System prompt ensuring Ollama acts purely as an optimization tool
        prompt = (
                "You are a conceptual search optimization engine. Convert the following vague memory, "
                "description, or question into the single most accurate entity, product, or term name. "
                "Look past the words and identify the exact thing the user is trying to find.\n\n"
                "Examples:\n"
                "- 'laptop from apple' -> macbook\n"
                "- 'popular open source Linux based os' -> ubuntu\n"
                "- 'python library for mathematical graphing' -> matplotlib\n"
                "- 'a writing instrument that uses ink' -> pen\n"
                "- 'an open source text editor developed by microsoft' -> vscode\n\n"
                "Output ONLY the final raw term or name. Do not include introductory text, quotes, "
                "punctuation, explanations, or markdown code blocks.\n"
                f"Memory description: '{query}'"
            )

        try:
            ai_output = self._ollama_generate(prompt, timeout=10)
            
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

    def process_inline_writing(self, instruction):
        """
        In-Website Writer: generate copy for a ?aiwrite placeholder on the active page.
        """
        instruction = str(instruction).strip()
        if not instruction:
            return {"status": "error", "text": "", "message": "Instruction was empty."}
        if not self._ai_is_enabled():
            return {
                "status": "error",
                "text": "",
                "message": "Local AI is turned off",
            }

        prompt = (
            "You are an inline copywriting assistant built directly into a web browser text field. "
            "Your task is to write content that perfectly matches the user's specific text "
            "generation instructions.\n\n"
            f'Instructions: "{instruction}"\n\n'
            "Output ONLY the direct text requested by the user. Do not include any introductory "
            "commentary, conversational pleasantries, wrapping quotation marks, or markdown blocks "
            "outside of the absolute requested draft copy."
        )

        try:
            ai_output = self._ollama_generate(prompt, timeout=30)
            if not ai_output:
                return {
                    "status": "error",
                    "text": "",
                    "message": "Ollama returned an empty response.",
                }

            print(f"[In-Website Writer] Generated copy for instruction: '{instruction[:120]}'")
            return {"status": "success", "text": ai_output}

        except Exception as e:
            print(f"[In-Website Writer Error] {e}")
            return {"status": "error", "text": "", "message": str(e)}

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

        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """
        )

        conn.commit()
        conn.close()

    def _load_active_model_setting(self):
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                ("active_model",),
            )
            row = cursor.fetchone()
            conn.close()
            if row and row[0]:
                with self._ai_lock:
                    self._active_model = str(row[0]).strip()
        except Exception as exc:
            print(f"[Settings] Could not load active_model: {exc}")

    def _persist_setting(self, key, value):
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO app_settings (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (str(key), str(value)),
            )
            conn.commit()
            conn.close()
        except Exception as exc:
            print(f"[Settings] Failed to persist {key}: {exc}")

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
        if not self._ai_is_enabled():
            return {
                "status": "error",
                "response": (
                    "Local AI is turned off. Click “Local AI Offline” in the toolbar "
                    "to turn it back on."
                ),
            }

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
            ai_response = self._ollama_generate(full_prompt, timeout=30)
            return {"status": "success", "response": ai_response}

        except Exception as e:
            print(f"[Sidebar Chat Error] Failed to generate: {str(e)}")
            return {
                "status": "error",
                "response": f"Could not connect to local AI engine: {str(e)}",
            }

    @staticmethod
    def _extract_json_array_from_llm(text):
        """Strip markdown fences and parse the first JSON array from an LLM reply."""
        cleaned = (text or "").strip()
        fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.I)
        if fence:
            cleaned = fence.group(1).strip()
        start = cleaned.find("[")
        end = cleaned.rfind("]")
        if start != -1 and end > start:
            cleaned = cleaned[start : end + 1]
        return json.loads(cleaned)

    def _normalize_tab_groups(self, groups, tab_ids):
        """Ensure groups are well-formed and every tab id appears exactly once."""
        if not isinstance(groups, list):
            raise ValueError("AI response was not a JSON array")

        normalized = []
        assigned = set()
        tab_id_set = {str(t) for t in tab_ids}

        for item in groups:
            if not isinstance(item, dict):
                continue
            name = str(item.get("category_name") or item.get("name") or "Group").strip() or "Group"
            raw_ids = item.get("associated_tab_ids") or item.get("tab_ids") or []
            if not isinstance(raw_ids, list):
                continue
            ids = []
            for raw in raw_ids:
                tid = str(raw).strip()
                if tid in tab_id_set and tid not in assigned:
                    assigned.add(tid)
                    ids.append(tid)
            if ids:
                normalized.append({"category_name": name, "associated_tab_ids": ids})

        missing = [tid for tid in tab_ids if str(tid) not in assigned]
        if missing:
            normalized.append(
                {"category_name": "Other", "associated_tab_ids": [str(t) for t in missing]}
            )
        return normalized

    def classify_and_organize_tabs(self, tabs_json):
        """
        Send open-tab metadata to Ollama for topical clustering, then apply
        the resulting groups in the tab strip via evaluate_js.
        """
        try:
            if not self._ai_is_enabled():
                return {
                    "status": "error",
                    "message": "Local AI is turned off",
                    "groups": [],
                }
            tabs = json.loads(tabs_json or "[]")
            if not isinstance(tabs, list) or not tabs:
                return {"status": "error", "message": "No tabs to organize", "groups": []}

            tab_ids = []
            tab_lines = []
            for tab in tabs:
                if not isinstance(tab, dict):
                    continue
                tid = str(tab.get("id", "")).strip()
                if not tid:
                    continue
                tab_ids.append(tid)
                title = str(tab.get("title") or "Untitled").strip()
                url = str(tab.get("url") or "").strip()
                tab_lines.append(f'- id: "{tid}", title: "{title}", url: "{url}"')

            if not tab_ids:
                return {"status": "error", "message": "No valid tab ids", "groups": []}

            system_prompt = (
                "You are a browser tab organization engine. Analyze the following list of "
                "open browser tab titles and URLs. Group them logically into clusters based on "
                "shared topics, industries, or tasks (e.g., \"Research\", \"Shopping\", "
                "\"Development\", \"Entertainment\").\n\n"
                "Return ONLY a valid JSON array of objects representing the categories, where "
                'each category object has a "category_name" string and an "associated_tab_ids" '
                "array of strings matching the IDs provided. Do not return any introductory "
                "prose or markdown code blocks outside of the JSON payload.\n\n"
                "Open tabs:\n" + "\n".join(tab_lines)
            )

            ai_output = self._ollama_generate(system_prompt, timeout=90)
            if not ai_output:
                raise ValueError("Ollama returned an empty response")

            parsed = self._extract_json_array_from_llm(ai_output)
            groups = self._normalize_tab_groups(parsed, tab_ids)

            print(f"[Tab Organizer] Grouped {len(tab_ids)} tab(s) into {len(groups)} cluster(s)")
            return {"status": "success", "groups": groups}

        except json.JSONDecodeError as exc:
            print(f"[Tab Organizer] JSON parse error: {exc}")
            return {"status": "error", "message": f"Invalid AI JSON: {exc}", "groups": []}
        except Exception as exc:
            print(f"[Tab Organizer] Error: {exc}")
            return {"status": "error", "message": str(exc), "groups": []}

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

    def load_and_scrape_url(self, url, tab_id=None):
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
            store_tab_id = str(tab_id) if tab_id is not None else "proxy"
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO browsing_history (tab_id, url, title, page_content, timestamp)
                VALUES (?, ?, ?, ?, ?)
                """,
                (store_tab_id, final_url, page_title, clean_text, time.time()),
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

    # ── Objective Research Agent ─────────────────────────────────────

    def start_research_agent(self, goal, max_pages=4):
        """Spawn the autonomous research loop on a background worker thread."""
        goal = str(goal).strip()
        if not goal:
            return {"status": "error", "message": "Research goal was empty."}
        if not self._ai_is_enabled():
            return {"status": "error", "message": "Local AI is turned off"}
        if self.window is None:
            return {"status": "error", "message": "Browser window is not ready."}

        max_pages = max(1, min(int(max_pages), 10))
        threading.Thread(
            target=self._run_agent_loop,
            args=(goal, max_pages),
            daemon=True,
        ).start()
        print(f"[Research Agent] Started — goal='{goal}', max_pages={max_pages}")
        return {"status": "started", "max_pages": max_pages}

    def _eval_js(self, js_code):
        """Safely invoke JavaScript on the UI thread's webview."""
        if self.window is None:
            return None
        try:
            return self.window.evaluate_js(js_code)
        except Exception as exc:
            print(f"[Research Agent] evaluate_js failed: {exc}")
            return None

    def _agent_ui_status(self, message):
        payload = json.dumps(str(message))
        self._eval_js(f"window.updateAgentStatus && window.updateAgentStatus({payload})")

    def _agent_ui_result(self, text):
        payload = json.dumps(str(text))
        self._eval_js(f"window.displayAgentResult && window.displayAgentResult({payload})")

    def _agent_ui_finish(self):
        self._eval_js("window.finishAgentSession && window.finishAgentSession()")

    def _generate_research_search_query(self, goal):
        """Ask Ollama for a single clean search-engine query string."""
        if not self._ai_is_enabled():
            return goal
        prompt = (
            "You are a search query optimizer. Given a high-level research goal, "
            "output ONLY one concise search-engine query string (no quotes, no explanation, "
            "no punctuation beyond what a search engine expects). "
            f"Research goal: {goal}"
        )
        try:
            query = self._ollama_generate(prompt, timeout=30)
            query = re.sub(r'^["\']+|["\']+$', "", query)
            query = query.split("\n")[0].strip()
            return query or goal
        except Exception as exc:
            print(f"[Research Agent] Search query generation failed: {exc}")
            return goal

    def _fetch_search_result_urls(self, query, limit=10):
        """Run a DuckDuckGo HTML search and extract destination URLs."""
        search_url = f"https://html.duckduckgo.com/html/?q={requests.utils.quote(query)}"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
        }
        try:
            response = requests.get(search_url, headers=headers, timeout=15, verify=False)
            html = response.text
        except Exception as exc:
            print(f"[Research Agent] Search fetch failed: {exc}")
            return []

        urls = []
        seen = set()
        patterns = [
            r'class="result__a"[^>]+href="([^"]+)"',
            r'class="result-link"[^>]+href="([^"]+)"',
            r'href="(//duckduckgo\.com/l/\?uddg=[^"]+)"',
            r'href="(https?://duckduckgo\.com/l/\?uddg=[^"]+)"',
        ]
        for pattern in patterns:
            for match in re.finditer(pattern, html, re.I):
                href = match.group(1)
                if href.startswith("//"):
                    href = "https:" + href
                target = self._unwrap_duckduckgo_redirect(href)
                host = urlparse(target).netloc.lower()
                if not target.startswith("http"):
                    continue
                if "duckduckgo.com" in host:
                    continue
                if target in seen:
                    continue
                seen.add(target)
                urls.append(target)
                if len(urls) >= limit:
                    return urls
        return urls

    @staticmethod
    def _url_host_key(url):
        """Normalize a URL to a comparable host key (strip www.)."""
        try:
            host = urlparse(url).netloc.lower()
            return host[4:] if host.startswith("www.") else host
        except Exception:
            return str(url).lower()

    def _wait_for_scraped_content(self, since_ts, tab_id=None, expected_url=None, timeout=12):
        """Poll SQLite until the proxy commits fresh page_content for this visit."""
        deadline = time.time() + timeout
        tab_key = None
        if tab_id is not None:
            try:
                tab_key = str(int(float(tab_id)))
            except (TypeError, ValueError):
                tab_key = str(tab_id)
        expected_host = self._url_host_key(expected_url) if expected_url else None

        while time.time() < deadline:
            try:
                conn = sqlite3.connect(self.db_path)
                cursor = conn.cursor()
                row = None

                if tab_key is not None:
                    cursor.execute(
                        """
                        SELECT url, title, page_content FROM browsing_history
                        WHERE tab_id = ?
                          AND timestamp >= ?
                          AND page_content IS NOT NULL
                          AND page_content != ''
                        ORDER BY timestamp DESC
                        LIMIT 1
                        """,
                        (tab_key, since_ts),
                    )
                    row = cursor.fetchone()

                if (not row or not row[2]) and expected_host:
                    cursor.execute(
                        """
                        SELECT url, title, page_content FROM browsing_history
                        WHERE timestamp >= ?
                          AND page_content IS NOT NULL
                          AND page_content != ''
                          AND tab_id != 'ai_engine'
                          AND lower(url) LIKE ?
                        ORDER BY timestamp DESC
                        LIMIT 1
                        """,
                        (since_ts, f"%{expected_host}%"),
                    )
                    row = cursor.fetchone()

                if not row or not row[2]:
                    cursor.execute(
                        """
                        SELECT url, title, page_content FROM browsing_history
                        WHERE timestamp >= ?
                          AND page_content IS NOT NULL
                          AND page_content != ''
                          AND tab_id != 'ai_engine'
                        ORDER BY timestamp DESC
                        LIMIT 1
                        """,
                        (since_ts,),
                    )
                    row = cursor.fetchone()

                conn.close()
                if row and row[2]:
                    return {"url": row[0], "title": row[1], "text": row[2]}
            except Exception as exc:
                print(f"[Research Agent] DB poll error: {exc}")
            time.sleep(0.5)
        return None

    def _open_agent_tab(self, url):
        """Tell the UI to spawn a visible tab and load the URL through the proxy."""
        url_js = json.dumps(url)
        return self._eval_js(f"window.agentOpenTab && window.agentOpenTab({url_js})")

    def _run_agent_loop(self, goal, max_pages):
        """Autonomous multi-turn browse → scrape → synthesize loop."""
        collected = []
        try:
            if not self._ai_is_enabled():
                self._agent_ui_result(
                    "Local AI was turned off. Enable it from the toolbar to run the research agent."
                )
                return

            self._agent_ui_status("Agent thinking… generating search query")
            search_query = self._generate_research_search_query(goal)
            print(f"[Research Agent] Search query: {search_query}")

            self._agent_ui_status(f"Agent searching: \"{search_query}\"")
            candidate_urls = self._fetch_search_result_urls(search_query, limit=max_pages + 4)
            if not candidate_urls:
                self._agent_ui_result(
                    "Could not find any search results. Check your network connection "
                    "or try rephrasing your research goal."
                )
                return

            visit_urls = candidate_urls[:max_pages]
            for idx, url in enumerate(visit_urls, start=1):
                self._agent_ui_status(f"Agent browsing page {idx}/{max_pages}…")
                visit_started = time.time()
                tab_id = self._open_agent_tab(url)
                time.sleep(3.5)

                page = self._wait_for_scraped_content(
                    since_ts=visit_started - 1.0,
                    tab_id=tab_id,
                    expected_url=url,
                )
                if not page:
                    print(f"[Research Agent] No scraped content for {url}")
                    continue

                snippet = page["text"][:4000]
                collected.append(
                    {
                        "url": page["url"],
                        "title": page["title"],
                        "text": snippet,
                    }
                )
                print(
                    f"[Research Agent] Collected {len(snippet)} chars from "
                    f"{page['url']}"
                )

            if not collected:
                self._agent_ui_result(
                    "The agent visited pages but could not scrape readable text. "
                    "Try again or reduce the number of pages."
                )
                return

            if not self._ai_is_enabled():
                self._agent_ui_result(
                    "Local AI was turned off before synthesis could finish."
                )
                return

            self._agent_ui_status("Agent synthesizing final research report…")
            sources_block = ""
            for i, src in enumerate(collected, start=1):
                sources_block += (
                    f"\n--- SOURCE {i}: {src['title']} ({src['url']}) ---\n"
                    f"{src['text']}\n"
                )

            synthesis_prompt = (
                "You are an elite research assistant. Based on the text scraped from "
                "these multiple web sources, write a definitive, comprehensive final "
                f"essay/summary addressing the core goal: '{goal}'.\n"
                "Structure the response clearly. At the end, include a 'Sources Visited' "
                "section listing every URL with a one-line description of what each "
                "source contributed.\n\n"
                f"SCRAPED WEB CONTENT:{sources_block}\n\n"
                "Final Research Report:"
            )

            try:
                final_text = self._ollama_generate(synthesis_prompt, timeout=120)
            except Exception as exc:
                print(f"[Research Agent] Synthesis failed: {exc}")
                final_text = (
                    f"Synthesis failed ({exc}). Raw notes from {len(collected)} page(s):\n\n"
                    + sources_block
                )

            if not final_text:
                final_text = (
                    "The local AI returned an empty synthesis. "
                    f"Collected text from {len(collected)} source(s) is stored in Nabu memory."
                )

            self._agent_ui_result(final_text)

        except Exception as exc:
            print(f"[Research Agent] Loop error: {exc}")
            self._agent_ui_result(f"Research agent encountered an error: {exc}")
        finally:
            self._agent_ui_finish()


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
api.window = window

# Start the application loop (This locks execution while the window runs)
webview.start(debug=True)
