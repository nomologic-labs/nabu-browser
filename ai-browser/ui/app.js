/* ════════════════════════════════════════════════════════════════
   Nabu Browser — UI Shell  (Phase 1: Final)
   ════════════════════════════════════════════════════════════════ */

/* ── New Tab Page ───────────────────────────────────────────────
   Self-contained HTML injected as iframe srcdoc.
   Calls window.parent.loadUrl() for all navigation actions.
   ──────────────────────────────────────────────────────────────*/
const NEW_TAB_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;font-family:system-ui,-apple-system,sans-serif;background:#fcfaf7;color:#2b2621;-webkit-font-smoothing:antialiased;overflow:hidden}
  .canvas{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:48px;user-select:none}
  .eyebrow{font-size:11px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#a89f91;text-align:center;margin-bottom:4px}
  .title{font-size:40px;font-weight:300;letter-spacing:.03em;text-align:center;color:#2b2621}
  .title b{font-weight:700}
  .rule{width:44px;height:1px;background:#e6dfd3}
  .sub{font-size:13px;color:#7c7267;text-align:center;max-width:340px;line-height:1.7}
  /* ── Search Bar ─────────────────────────────────────────────── */
  .search-wrap{width:100%;display:flex;justify-content:center}
  .search-box{width:100%;max-width:500px;display:flex;align-items:center;gap:10px;background:#ffffff;border:1px solid #e6dfd3;border-radius:10px;padding:0 16px;box-shadow:0 1px 4px rgba(43,38,33,.06);transition:border-color .18s ease,box-shadow .18s ease}
  .search-box:focus-within{border-color:#d47a55;box-shadow:0 0 0 3px rgba(212,122,85,.18)}
  .search-icon{font-size:14px;color:#a89f91;flex-shrink:0;line-height:1}
  .search-input{flex:1;height:46px;background:transparent;border:none;outline:none;font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#2b2621}
  .search-input::placeholder{color:#a89f91}
  /* ── Quick Links ────────────────────────────────────────────── */
  .links{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .link{padding:9px 20px;border:1px solid #e6dfd3;border-radius:100px;background:#ffffff;color:#7c7267;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:8px;text-decoration:none;transition:border-color .15s ease,color .15s ease,box-shadow .15s ease;box-shadow:0 1px 3px rgba(43,38,33,.05)}
  .link:hover{border-color:#d47a55;color:#d47a55;box-shadow:0 2px 10px rgba(212,122,85,.14)}
  .link:active{transform:scale(.98)}
</style>
</head>
<body>
<div class="canvas">
  <div style="text-align:center">
    <div class="eyebrow">Nabu Browser</div>
    <div class="title">Nabu <b>Workspace</b></div>
  </div>
  <div class="rule"></div>
  <p class="sub">Your secure, local-AI augmented information repository.</p>

  <div class="search-wrap">
    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input
        class="search-input"
        type="text"
        placeholder="Search the web securely via Nabu…"
        autofocus
        onkeydown="if(event.key==='Enter'){const q=this.value.trim();if(q)window.parent.postMessage({type:'nabu-search',query:q},'*');}"
      >
    </div>
  </div>

  <div class="links">
    <a class="link" onclick="window.parent.postMessage({type:'nabu-navigate',url:'https://github.com/nomologic-labs/nabu-browser'},'*')">⚡ GitHub</a>
    <a class="link" onclick="window.parent.postMessage({type:'nabu-navigate',url:'https://github.com/nomologic-labs/nabu-browser/tree/main/docs'},'*')">📘 Documentation</a>
    <a class="link" onclick="window.parent.postMessage({type:'nabu-navigate',url:'https://ollama.com/search'},'*')">🤖 Ollama</a>
  </div>
</div>
</body>
</html>`;

/* ── Placeholder text per mode ──────────────────────────────── */
const MODE_PLACEHOLDERS = {
  chat:     'Ask Nabu anything…',
  research: 'Enter research objective target…',
};

/* ════════════════════════════════════════════════════════════════
   TAB MANAGER
   Owns the tab list (tabsList), active state (activeTabId), DOM
   rendering, and content loading. All tab operations go through
   this object.
   ════════════════════════════════════════════════════════════════ */
const tabs = {
  counter:     0,
  tabsList:    [],    // [{ id: number, title: string, url: string }]
  activeTabId: null,

  /** Convenience alias so internal code can use this.list or this.tabsList. */
  get list()       { return this.tabsList; },
  get activeId()   { return this.activeTabId; },
  set activeId(v)  { this.activeTabId = v; },

  /**
   * Creates a new tab, renders its pill, activates it, and loads
   * its content into the viewport iframe.
   * @param {string} title  Initial tab label (default: 'New Tab')
   * @param {string} url    URL to load (empty string = New Tab canvas)
   * @returns {number}      The new tab's id
   */
  create(title = 'New Tab', url = '') {
    const id      = ++this.counter;
    const prevId  = this.activeTabId;
    this.tabsList.push({ id, title, url });
    this._buildPill(id, title);
    this._activate(id, /* silent */ true);
    this._loadContent(url);
    app.log(`[Tabs Engine]: Spawned Tab ${id} — "${title}"`);
    // Persist: mark previous tab inactive, new tab active.
    if (prevId != null) {
      const prev = this.tabsList.find(t => t.id === prevId);
      if (prev) syncTabState(prevId, prev.url, prev.title, false);
    }
    syncTabState(id, url, title, true);
    return id;
  },

  /**
   * Switches the active tab. Updates DOM states, address bar, and
   * viewport content to match the selected tab's saved url.
   * @param {number} id
   */
  switch(id) {
    if (this.activeTabId === id) return;
    const prevId = this.activeTabId;
    const tab    = this.tabsList.find(t => t.id === id);
    if (!tab) return;
    this._activate(id, /* silent */ true);
    this._loadContent(tab.url);
    app.log(`[Tabs Engine]: Focus shifted to Tab ${id} — "${tab.title}"`);
    // Persist: mark previous tab inactive, new tab active.
    if (prevId != null) {
      const prev = this.tabsList.find(t => t.id === prevId);
      if (prev) syncTabState(prevId, prev.url, prev.title, false);
    }
    syncTabState(id, tab.url, tab.title, true);
  },

  /**
   * Closes a tab by id. Refuses to close the last remaining tab.
   * Activates the nearest available neighbour automatically.
   * @param {number} id
   */
  close(id) {
    if (this.tabsList.length <= 1) {
      app.log('[Tabs Engine]: Cannot close the last remaining tab.');
      return;
    }
    const idx = this.tabsList.findIndex(t => t.id === id);
    if (idx === -1) return;

    // Persist removal BEFORE touching the DOM so the backend record is
    // cleaned up even if the DOM operation throws.
    removeTabState(id);

    this.tabsList.splice(idx, 1);
    document.getElementById(`tab-pill-${id}`)?.remove();

    if (this.activeTabId === id) {
      const next = this.tabsList[Math.min(idx, this.tabsList.length - 1)];
      if (next) this.switch(next.id);
    }
    app.log(`[Tabs Engine]: Closed Tab ${id}`);
  },

  /** Updates the stored url for a tab. */
  setUrl(id, url) {
    const tab = this.tabsList.find(t => t.id === id);
    if (tab) tab.url = url;
  },

  /** Updates the stored title and its DOM label for a tab. */
  setTitle(id, title) {
    const tab = this.tabsList.find(t => t.id === id);
    if (tab) tab.title = title;
    const el = document.querySelector(`#tab-pill-${id} .tab-title`);
    if (el) el.textContent = title;
  },

  /* ── Private helpers ──────────────────────────────────────── */

  /**
   * Marks a tab as the active one in both state and DOM.
   * @param {number}  id
   * @param {boolean} silent  When true, skips emitting a log line
   *                          (the caller is responsible for its own message).
   */
  _activate(id, silent = false) {
    this.activeTabId = id;
    document.querySelectorAll('.tab-pill').forEach(p => p.classList.remove('active'));
    document.getElementById(`tab-pill-${id}`)?.classList.add('active');
    const tab = this.tabsList.find(t => t.id === id);
    const bar = document.getElementById('address-bar');
    const displayUrl = (tab?.url && tab.url !== 'about:blank') ? tab.url : '';
    if (bar) bar.value = displayUrl;
    app.state.currentUrl = tab?.url ?? '';
    if (!silent) {
      app.log(`[Tabs Engine]: Focus shifted to Tab ${id} — "${tab?.title ?? ''}"`);
    }
  },

  _loadContent(url) {
    const frame = document.getElementById('web-view');
    if (!frame) return;
    if (url && url !== 'about:blank') {
      // Route through the proxy — never assign frame.src directly, as that
      // triggers pywebview's GTK navigation handler and replaces the whole UI.
      loadUrl(url);
    } else {
      try { frame.removeAttribute('src'); } catch (_) {}
      frame.srcdoc = NEW_TAB_HTML;
    }
  },

  _buildPill(id, title) {
    const container = document.getElementById('tabs-header-container');
    if (!container) return;

    const pill = document.createElement('div');
    pill.className = 'tab-pill';
    pill.id        = `tab-pill-${id}`;
    pill.onclick   = () => this.switch(id);

    const favicon = document.createElement('span');
    favicon.className   = 'tab-favicon';
    favicon.textContent = '🌐';

    const titleEl = document.createElement('span');
    titleEl.className   = 'tab-title';
    titleEl.textContent = title;

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'tab-close';
    closeBtn.title       = 'Close tab';
    closeBtn.textContent = '×';
    closeBtn.onclick     = (e) => { e.stopPropagation(); this.close(id); };

    pill.append(favicon, titleEl, closeBtn);
    container.appendChild(pill);
  },

  /**
   * Rebuilds a tab from persisted session data WITHOUT triggering a
   * fresh proxy fetch. Used exclusively by restoreOrInit() on startup.
   *
   * Uses the exact `savedId` stored in the DB so the JS tab ID stays in
   * sync with the backend's `tab_id` column across restarts. The counter
   * is advanced past any restored ID so new tabs never collide.
   *
   * Inactive tabs get their pill rendered — content is loaded lazily when
   * the user switches to them. The active tab is activated immediately.
   *
   * Deliberately does NOT call syncTabState so we don't echo data back to
   * the backend that we just read from it.
   *
   * @param {string|number} savedId    tab_id value from the DB row.
   * @param {string}        title      Saved tab display title.
   * @param {string}        url        Saved tab URL (empty = New Tab canvas).
   * @param {boolean}       makeActive Whether to activate and load content.
   * @returns {number}                 The reconstructed tab's local id.
   */
  _restoreTab(savedId, title, url, makeActive) {
    const id = parseInt(savedId, 10);
    if (isNaN(id)) {
      console.warn('[Session UI] _restoreTab: non-numeric savedId skipped:', savedId);
      return null;
    }
    // Keep counter ahead of the highest restored ID so new tabs don't collide.
    if (id >= this.counter) this.counter = id;
    this.tabsList.push({ id, title, url });
    this._buildPill(id, title);
    if (makeActive) {
      this._activate(id, /* silent */ true);
      this._loadContent(url);
    }
    return id;
  },
};

/* ════════════════════════════════════════════════════════════════
   GLOBAL APP STATE & HELPERS
   ════════════════════════════════════════════════════════════════ */
const app = {
  state: {
    currentUrl:     '',
    sidebarMode:    'assistant',
    featureMode:    'chat',
    isAiOnline:     true,
    isAgentRunning: false,
    activeModel:    'llama3.2:3b',
  },

  /**
   * Appends a timestamped entry to the System Logs panel.
   * Always writes regardless of which sidebar view is active.
   * @param {string} message
   */
  log(message) {
    const box = document.getElementById('ai-log-box');
    if (!box) return;
    const ts   = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.textContent = `[${ts}]  ${message}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  },

  /**
   * Renders a chat bubble into the AI Assistant chat space.
   * @param {'user'|'assistant'} role
   * @param {string}             text
   */
  appendMessage(role, text) {
    const space = document.getElementById('chat-history-output');
    if (!space) return;
    const msg    = document.createElement('div');
    msg.className = `chat-message ${role}`;
    const bubble  = document.createElement('div');
    bubble.className   = 'bubble';
    bubble.textContent = text;
    msg.appendChild(bubble);
    space.appendChild(msg);
    space.scrollTop = space.scrollHeight;
  },
};

/* ── AI Status Toggle ───────────────────────────────────────── */

/** @returns {boolean} True when local AI features are allowed. */
function isAiOnline() {
  return app.state.isAiOnline;
}

/** Sync toolbar dot/label and disable AI-only controls. */
function applyAiStatusUI(online) {
  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const btn   = document.getElementById('ai-status-btn');

  if (online) {
    if (dot) {
      dot.style.background = '#2ecc71';
      dot.classList.add('pulse');
    }
    if (label) label.textContent = 'Local AI Ready';
    btn?.classList.remove('offline');
  } else {
    if (dot) {
      dot.style.background = '#95a5a6';
      dot.classList.remove('pulse');
    }
    if (label) label.textContent = 'Local AI Offline';
    btn?.classList.add('offline');
  }

  const organizeBtn = document.getElementById('ai-organize-tabs-btn');
  const sendBtn     = document.getElementById('send-chat-btn');
  const chatInput   = document.getElementById('ai-chat-input');
  const featureSel  = document.getElementById('feature-select');
  const modelSel    = document.getElementById('ai-model-select');

  if (organizeBtn) organizeBtn.disabled = !online;
  if (sendBtn) sendBtn.disabled = !online;
  if (chatInput) chatInput.disabled = !online;
  if (featureSel) featureSel.disabled = !online;
  if (modelSel) modelSel.disabled = !online;
}

/* ── Ollama model selection (toolbar) ───────────────────────── */

function _populateModelSelect(select, models, activeModel) {
  if (!select) return;
  const previous = activeModel || select.value;
  select.innerHTML = '';

  const list = Array.isArray(models) && models.length ? models.slice() : [];
  if (previous && !list.includes(previous)) {
    list.unshift(previous);
  }
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = previous || 'llama3.2:3b';
    opt.textContent = opt.value;
    select.appendChild(opt);
  } else {
    list.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  }

  if (previous && [...select.options].some(o => o.value === previous)) {
    select.value = previous;
  }
}

/**
 * Load installed models from Ollama and sync the toolbar dropdown.
 * Exposed for Python to call after Ollama restart.
 */
window.refreshModelSelect = async function refreshModelSelect() {
  const select = document.getElementById('ai-model-select');
  if (!select || !window.pywebview?.api?.list_ollama_models) return;

  try {
    const result = await window.pywebview.api.list_ollama_models();
    if (result?.status !== 'success') return;
    _populateModelSelect(select, result.models, result.active_model);
    if (result.active_model) {
      app.state.activeModel = result.active_model;
    }
  } catch (err) {
    console.warn('[Model Select] refresh failed:', err);
  }
};

async function initModelSelect() {
  const select = document.getElementById('ai-model-select');
  if (!select || !window.pywebview?.api?.list_ollama_models) return;

  await window.refreshModelSelect();

  if (window.pywebview?.api?.get_active_model) {
    try {
      const current = await window.pywebview.api.get_active_model();
      if (current?.model) {
        select.value = current.model;
        app.state.activeModel = current.model;
      }
    } catch (_) { /* keep list_ollama_models selection */ }
  }
}

async function onModelSelectChange() {
  const select = document.getElementById('ai-model-select');
  if (!select || !isAiOnline()) return;

  const model = select.value;
  if (!model) return;

  if (window.pywebview?.api?.set_active_model) {
    try {
      const result = await window.pywebview.api.set_active_model(model);
      if (result?.status === 'success') {
        app.state.activeModel = result.model ?? model;
        app.log(`[Local AI]: Model → ${app.state.activeModel}`);
      } else {
        app.log(`[Local AI]: Could not set model — ${result?.message ?? 'unknown error'}`);
      }
    } catch (err) {
      app.log(`[Local AI]: Model change failed — ${err?.message ?? err}`);
    }
  }
}

async function toggleAiStatus() {
  const nextOnline = !app.state.isAiOnline;
  app.state.isAiOnline = nextOnline;
  applyAiStatusUI(nextOnline);

  if (nextOnline) {
    app.log('Local AI: enabled ✓');
  } else {
    app.log('Local AI: disabled ✗');
  }

  if (window.pywebview?.api?.set_ai_enabled) {
    try {
      await window.pywebview.api.set_ai_enabled(nextOnline);
    } catch (err) {
      app.log(`[Local AI]: Could not sync state to backend — ${err?.message ?? err}`);
    }
  }
}

/* ── Tab Façade (public shorthand used by HTML onclick) ─────── */

/**
 * Opens a new blank tab showing the New Tab canvas.
 * Called by the "+" button in the tab strip.
 */
function openNewTab() {
  tabs.create();
}

/* ── Home Portal Search ─────────────────────────────────────── */

/**
 * Entry point called by the New Tab canvas search box via
 * window.parent.homePortalSearch(). Runs the query through the
 * standard navigation pipeline and emits a [Home Portal] log.
 * @param {string} query  Raw text from the canvas search input.
 */
function homePortalSearch(query) {
  const q = (query ?? '').trim();
  if (!q) return;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  app.log(`[Home Portal]: Query routed from active canvas area — "${q}"`);
  loadUrl(searchUrl);
}

/* ── AI Tab Organizing ──────────────────────────────────────── */

const TAB_CLUSTER_CLASS_PREFIX = 'tab-cluster-';
const TAB_CLUSTER_PALETTE_SIZE = 6;

/**
 * Reorders tab pills in the strip and applies cluster styling.
 * Called from Python via evaluate_js and from the organize button handler.
 * @param {Array<{category_name: string, associated_tab_ids: string[]}>} groupsPayload
 */
window.applyTabGroups = function applyTabGroups(groupsPayload) {
  if (!Array.isArray(groupsPayload) || groupsPayload.length === 0) return;

  const container = document.getElementById('tabs-header-container');
  const addBtn    = document.getElementById('add-tab-btn');
  if (!container || !addBtn) return;

  const knownIds = new Set(tabs.tabsList.map(t => String(t.id)));
  const ordered  = [];
  const placed   = new Set();

  groupsPayload.forEach((group, clusterIndex) => {
    const name = (group?.category_name || group?.name || 'Group').trim() || 'Group';
    const ids  = Array.isArray(group?.associated_tab_ids) ? group.associated_tab_ids : [];
    ids.forEach((rawId) => {
      const id = String(rawId);
      if (!knownIds.has(id) || placed.has(id)) return;
      placed.add(id);
      ordered.push({ id, clusterIndex, name });
    });
  });

  tabs.tabsList.forEach((t) => {
    const id = String(t.id);
    if (!placed.has(id)) ordered.push({ id, clusterIndex: -1, name: '' });
  });

  document.querySelectorAll('.tab-pill').forEach((pill) => {
    pill.classList.remove('tab-clustered');
    Array.from(pill.classList)
      .filter(c => c.startsWith(TAB_CLUSTER_CLASS_PREFIX))
      .forEach(c => pill.classList.remove(c));
    pill.removeAttribute('data-cluster');
    if (!pill.classList.contains('active')) pill.removeAttribute('title');
  });

  const rebuiltList = [];

  ordered.forEach(({ id, clusterIndex, name }) => {
    const pill = document.getElementById(`tab-pill-${id}`);
    if (pill) {
      container.insertBefore(pill, addBtn);
      if (clusterIndex >= 0) {
        const mod = clusterIndex % TAB_CLUSTER_PALETTE_SIZE;
        pill.classList.add('tab-clustered', `${TAB_CLUSTER_CLASS_PREFIX}${mod}`);
        pill.dataset.cluster = name;
        const label = pill.querySelector('.tab-title')?.textContent || '';
        pill.title = `${name}: ${label}`;
      }
    }
    const tab = tabs.tabsList.find(t => String(t.id) === id);
    if (tab) rebuiltList.push(tab);
  });

  if (rebuiltList.length === tabs.tabsList.length) {
    tabs.tabsList = rebuiltList;
  }

  app.log(
    `[Tabs Engine]: Organized ${ordered.length} tab(s) into ${groupsPayload.length} cluster(s).`
  );
};

async function triggerTabOrganize() {
  const btn = document.getElementById('ai-organize-tabs-btn');
  const defaultLabel = '🧩 Organize';

  if (!isAiOnline()) {
    app.log('[Tabs Engine]: Organize skipped — Local AI is turned off.');
    return;
  }

  if (!window.pywebview?.api?.classify_and_organize_tabs) {
    app.log('[Tabs Engine]: AI organize unavailable — pywebview bridge not ready.');
    return;
  }
  if (!tabs.tabsList.length) {
    app.log('[Tabs Engine]: No open tabs to organize.');
    return;
  }

  const tabsPayload = tabs.tabsList.map(t => ({
    id:    String(t.id),
    url:   t.url ?? '',
    title: t.title ?? 'New Tab',
  }));

  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-organizing');
    btn.textContent = 'Organizing...';
  }
  app.log('[Tabs Engine]: Sending tab metadata to local AI for clustering…');

  try {
    const result = await window.pywebview.api.classify_and_organize_tabs(
      JSON.stringify(tabsPayload)
    );
    if (result?.status === 'success' && Array.isArray(result.groups) && result.groups.length) {
      window.applyTabGroups(result.groups);
    } else {
      const msg = result?.message || 'Tab organization did not return clusters.';
      app.log(`[Tabs Engine]: Organize failed — ${msg}`);
    }
  } catch (err) {
    console.error('[Tabs Engine] organize error:', err);
    app.log(`[Tabs Engine]: Organize error — ${err?.message || err}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-organizing');
      btn.textContent = defaultLabel;
    }
  }
}

/* ── Sidebar View Toggle ────────────────────────────────────── */

function switchSidebarView(view) {
  document.querySelectorAll('.sidebar-view').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.sidebar-tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`view-${view}`)?.classList.remove('hidden');
  document.getElementById(`tab-${view}`)?.classList.add('active');
  app.state.sidebarMode = view;
  app.log(`Sidebar: switched to ${view === 'assistant' ? 'AI Assistant' : 'System Logs'} view`);
}

/* ── Ollama troubleshooting (System Logs) ───────────────────── */

async function runOllamaHealthCheck() {
  const btn = document.getElementById('ollama-health-btn');
  if (!window.pywebview?.api?.check_ollama_health) {
    app.log('[Ollama] Health check unavailable — Python bridge not ready.');
    return;
  }

  if (btn) btn.disabled = true;
  app.log('[Ollama] Running health check…');

  try {
    const result = await window.pywebview.api.check_ollama_health();
    const prefix = result?.healthy ? '✓' : '✗';
    app.log(`[Ollama] ${prefix} ${result?.message ?? 'No response from health check.'}`);
    if (result?.healthy && result?.models?.length) {
      const preview = result.models.slice(0, 6).join(', ');
      app.log(`[Ollama] Models: ${preview}${result.models.length > 6 ? '…' : ''}`);
    }
  } catch (err) {
    app.log(`[Ollama] ✗ Health check error — ${err?.message ?? err}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runOllamaRestart() {
  const btn = document.getElementById('ollama-restart-btn');

  if (app.state.isAgentRunning) {
    app.log('[Ollama] Restart blocked — wait for the research agent to finish.');
    return;
  }

  if (!window.pywebview?.api?.restart_ollama) {
    app.log('[Ollama] Restart unavailable — Python bridge not ready.');
    return;
  }

  const confirmed = window.confirm(
    'Restart the local Ollama service?\n\n' +
    'Other applications using Ollama may be interrupted. ' +
    'Progress will appear in System Logs.'
  );
  if (!confirmed) {
    app.log('[Ollama] Restart cancelled.');
    return;
  }

  if (btn) btn.disabled = true;
  app.log('[Ollama] Restart initiated…');

  try {
    const result = await window.pywebview.api.restart_ollama();
    if (result?.status === 'started') {
      app.log(`[Ollama] ${result.message ?? 'Restart in progress.'}`);
    } else {
      app.log(`[Ollama] ✗ ${result?.message ?? 'Could not start restart.'}`);
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    app.log(`[Ollama] ✗ Restart error — ${err?.message ?? err}`);
    if (btn) btn.disabled = false;
  }
}

/** Called from Python when the background Ollama restart worker exits. */
window.onOllamaRestartDone = function onOllamaRestartDone() {
  const btn = document.getElementById('ollama-restart-btn');
  if (btn) btn.disabled = false;
};

/* ── Feature Mode Dropdown ──────────────────────────────────── */

function onFeatureChange() {
  const select = document.getElementById('feature-select');
  const input  = document.getElementById('ai-chat-input');
  const researchOpts = document.getElementById('research-options');
  if (!select || !input) return;
  const mode = select.value;
  app.state.featureMode = mode;
  input.placeholder = MODE_PLACEHOLDERS[mode] ?? 'Ask Nabu anything…';
  researchOpts?.style && (researchOpts.style.display = mode === 'research' ? 'flex' : 'none');
  app.log(`Feature mode → ${mode === 'chat' ? '💬 General Chat' : '🔍 Research Agent'}`);
}

/* ── Sidebar Query Submission ───────────────────────────────── */

/** Active research-agent status bubble (updated in-place by Python). */
let _agentStatusBubble = null;

function _appendAgentStatusBubble(initialText) {
  const space = document.getElementById('chat-history-output');
  if (!space) return null;
  const thinkingMsg = document.createElement('div');
  thinkingMsg.className = 'chat-message assistant agent-status';
  const thinkingBubble = document.createElement('div');
  thinkingBubble.className = 'bubble';
  thinkingBubble.style.cssText = 'opacity:.55;font-style:italic';
  thinkingBubble.textContent = initialText;
  thinkingMsg.appendChild(thinkingBubble);
  space.appendChild(thinkingMsg);
  space.scrollTop = space.scrollHeight;
  _agentStatusBubble = thinkingBubble;
  return thinkingBubble;
}

/**
 * Opens a new browser tab and loads a URL through the proxy pipeline.
 * Called remotely by the Python research agent via evaluate_js.
 * @param {string} url
 * @returns {number|null}  New tab id
 */
window.agentOpenTab = function agentOpenTab(url) {
  const target = (url ?? '').trim();
  if (!target) return null;
  let title = 'Research';
  try { title = new URL(target).hostname; } catch (_) {}
  const id = tabs.create(title, target);
  app.log(`[Research Agent]: Opened tab ${id} → ${target}`);
  return id;
};

/** Push live status text into the sidebar while the agent runs. */
window.updateAgentStatus = function updateAgentStatus(message) {
  if (!_agentStatusBubble) {
    _appendAgentStatusBubble(message);
    return;
  }
  _agentStatusBubble.style.cssText = 'opacity:.55;font-style:italic';
  _agentStatusBubble.textContent = message;
  const space = document.getElementById('chat-history-output');
  if (space) space.scrollTop = space.scrollHeight;
  app.log(`[Research Agent]: ${message}`);
};

/** Replace the status bubble with the final synthesized report. */
window.displayAgentResult = function displayAgentResult(text) {
  if (!_agentStatusBubble) {
    app.appendMessage('assistant', text);
  } else {
    _agentStatusBubble.style.cssText = '';
    _agentStatusBubble.textContent = text;
  }
  const space = document.getElementById('chat-history-output');
  if (space) space.scrollTop = space.scrollHeight;
  app.log('[Research Agent]: Final report delivered.');
};

/** Reset agent session flags after the background loop finishes. */
window.finishAgentSession = function finishAgentSession() {
  app.state.isAgentRunning = false;
  _agentStatusBubble = null;
  app.log('[Research Agent]: Session complete.');
};

async function submitSidebarQuery() {
  const input = document.getElementById('ai-chat-input');
  const text  = input?.value.trim();
  if (!text) return;

  app.appendMessage('user', text);
  input.value = '';

  if (!isAiOnline()) {
    app.appendMessage(
      'assistant',
      'Local AI is turned off. Click “Local AI Offline” in the toolbar to turn it back on.'
    );
    app.log('[Sidebar]: Message blocked — Local AI is off.');
    return;
  }

  // ── Objective Research Agent mode ─────────────────────────────
  if (app.state.featureMode === 'research') {
    if (app.state.isAgentRunning) {
      app.appendMessage('assistant', 'A research agent session is already running.');
      return;
    }
    if (!window.pywebview?.api?.start_research_agent) {
      app.appendMessage('assistant', 'Research agent backend is not available.');
      return;
    }

    const maxPagesEl = document.getElementById('research-max-pages');
    const maxPages   = Math.max(1, Math.min(10, parseInt(maxPagesEl?.value, 10) || 4));

    app.state.isAgentRunning = true;
    _appendAgentStatusBubble('Agent starting…');
    app.log(`[Research Agent]: Goal submitted — "${text}" (max ${maxPages} pages)`);

    try {
      const result = await window.pywebview.api.start_research_agent(text, maxPages);
      if (result?.status !== 'started') {
        window.finishAgentSession();
        const errMsg = result?.message ?? 'Could not start the research agent.';
        if (_agentStatusBubble) {
          _agentStatusBubble.style.cssText = 'color:#c0392b';
          _agentStatusBubble.textContent = errMsg;
        } else {
          app.appendMessage('assistant', errMsg);
        }
        app.log(`[Research Agent]: Start failed — ${errMsg}`);
      }
    } catch (err) {
      window.finishAgentSession();
      const errMsg = err?.message ?? String(err);
      if (_agentStatusBubble) {
        _agentStatusBubble.style.cssText = 'color:#c0392b';
        _agentStatusBubble.textContent = `Error: ${errMsg}`;
      } else {
        app.appendMessage('assistant', `Error: ${errMsg}`);
      }
      app.log(`[Research Agent]: Bridge error — ${errMsg}`);
    }
    return;
  }

  // ── General Chat mode ─────────────────────────────────────────
  const space = document.getElementById('chat-history-output');
  const thinkingMsg = document.createElement('div');
  thinkingMsg.className = 'chat-message assistant';
  const thinkingBubble = document.createElement('div');
  thinkingBubble.className = 'bubble';
  thinkingBubble.style.cssText = 'opacity:.55;font-style:italic';
  thinkingBubble.textContent = 'Thinking…';
  thinkingMsg.appendChild(thinkingBubble);
  space?.appendChild(thinkingMsg);
  if (space) space.scrollTop = space.scrollHeight;

  app.log(`[Sidebar Chat]: Message submitted — "${text}"`);

  try {
    const result = await window.pywebview.api.send_sidebar_chat(text);
    thinkingBubble.style.cssText = '';
    thinkingBubble.textContent = result.response;
    app.log('[Sidebar Chat]: Response received from local LLM.');
  } catch (err) {
    thinkingBubble.style.cssText = 'color:#c0392b';
    thinkingBubble.textContent = `Error: ${err?.message ?? String(err)}`;
    app.log(`[Sidebar Chat]: Bridge error — ${err?.message ?? err}`);
  } finally {
    if (space) space.scrollTop = space.scrollHeight;
  }
}

/* ── Navigation ─────────────────────────────────────────────── */

let _routerBannerTimer = null;

/** Shows a short on-screen banner confirming the resolved navigation target. */
function showRouterSuccessBanner(targetUrl) {
  const message = `[Router Success]: Attempting to load URL: ${targetUrl}`;
  let banner = document.getElementById('router-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'router-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    document.getElementById('tabs-viewports-wrapper')?.append(banner);
  }
  Object.assign(banner.style, {
    position:      'absolute',
    bottom:        '14px',
    left:          '50%',
    transform:     'translateX(-50%)',
    zIndex:        '20',
    maxWidth:      'min(92%, 640px)',
    padding:       '10px 16px',
    borderRadius:  '8px',
    background:    'rgba(43, 38, 33, 0.92)',
    color:         '#fcfaf7',
    fontFamily:    'system-ui, -apple-system, sans-serif',
    fontSize:      '12px',
    fontWeight:    '500',
    lineHeight:    '1.45',
    boxShadow:     '0 4px 18px rgba(43, 38, 33, 0.22)',
    pointerEvents: 'none',
    textAlign:     'center',
    wordBreak:     'break-all',
  });
  banner.textContent = message;
  banner.hidden = false;
  clearTimeout(_routerBannerTimer);
  _routerBannerTimer = setTimeout(() => { banner.hidden = true; }, 4500);
}

/**
 * Patches a raw HTML string so that every navigation attempt inside the
 * sandboxed srcdoc iframe is routed back to the parent via postMessage
 * instead of triggering a direct iframe navigation (which pywebview's GTK
 * WebKit backend can escalate into a main-window navigation).
 *
 * Injected at the very start of <head> so it runs before any page scripts.
 * Overrides Location.prototype to neutralise JS-driven redirects.
 * Removes <meta http-equiv="refresh"> tags that could trigger soft-redirects.
 *
 * @param {string} html  Raw HTML returned by the proxy.
 * @returns {string}     HTML with the interceptor injected early in <head>.
 */
/**
 * Unwrap DuckDuckGo /l/?uddg=… tracking URLs to the real destination before
 * the proxy fetch. Search-result clicks always pass through DDG redirect hops.
 * @param {string} url
 * @returns {string}
 */
function resolveRedirectUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().includes('duckduckgo.com')) return url;
    const uddg = u.searchParams.get('uddg');
    if (uddg) {
      const target = decodeURIComponent(uddg);
      if (target.startsWith('http://') || target.startsWith('https://')) return target;
    }
  } catch (_) {}
  return url;
}

function injectNavigationInterceptor(html) {
  const script = `<script>
(function () {
  // ── Neutralise frame-busting (window.top !== window.self) ───────────────
  // Redirect stubs and many sites break out of iframes via window.top.location.
  // Spoof top/parent as self so those checks pass and navigation uses the
  // Location.prototype overrides below (postMessage → parent loadUrl).
  try {
    Object.defineProperty(window, 'top',         { get: function () { return window; }, configurable: true });
    Object.defineProperty(window, 'parent',      { get: function () { return window; }, configurable: true });
    Object.defineProperty(window, 'frameElement', { get: function () { return null; }, configurable: true });
  } catch (_) {}

  // ── Override Location.prototype to intercept all JS-driven navigation ──
  // WebKit2GTK does not expose 'href' as an own property of Location.prototype,
  // so getOwnPropertyDescriptor returns undefined and .get throws a TypeError.
  // Guard against this: derive a safe getter fallback before calling defineProperty.
  try {
    var _hrefDesc   = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    var _origHrefGet = (_hrefDesc && _hrefDesc.get) ? _hrefDesc.get : function () { return this.toString(); };
    Object.defineProperty(Location.prototype, 'href', {
      set: function (v) {
        try { window.parent.postMessage({ type: 'nabu-navigate', url: new URL(v + '', document.baseURI).href }, '*'); } catch (_) {}
      },
      get: _origHrefGet,
      configurable: true,
    });
  } catch (_) {}
  try {
    Location.prototype.assign  = function (url) {
      try { window.parent.postMessage({ type: 'nabu-navigate', url: new URL(url + '', document.baseURI).href }, '*'); } catch (_) {}
    };
    Location.prototype.replace = function (url) {
      try { window.parent.postMessage({ type: 'nabu-navigate', url: new URL(url + '', document.baseURI).href }, '*'); } catch (_) {}
    };
    Location.prototype.reload  = function () { /* no-op: reloads would re-navigate */ };
  } catch (_) {}

  // ── Strip meta-refresh as soon as nodes appear (before they can fire) ───
  var _stripRefresh = function () {
    document.querySelectorAll('meta[http-equiv]').forEach(function (m) {
      if ((m.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') m.remove();
    });
  };
  _stripRefresh();
  try {
    new MutationObserver(_stripRefresh).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
  document.addEventListener('DOMContentLoaded', _stripRefresh);

  // ── Intercept anchor clicks ─────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href === '#' || href.startsWith('#') || href.startsWith('javascript:')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    try {
      window.parent.postMessage({ type: 'nabu-navigate', url: new URL(href, document.baseURI).href }, '*');
    } catch (_) {}
  }, true);

  // ── Intercept form submissions ──────────────────────────────────────────
  document.addEventListener('submit', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var form   = e.target;
    var action = form.action || document.baseURI;
    var params = new URLSearchParams(new FormData(form)).toString();
    var url    = params ? action + (action.indexOf('?') === -1 ? '?' : '&') + params : action;
    window.parent.postMessage({ type: 'nabu-navigate', url: url }, '*');
  }, true);

  // ── Storage / cookie polyfill for null-origin sandbox ──────────────────
  // When the iframe runs without sandbox="allow-same-origin" it receives a
  // null/opaque origin.  Any access to localStorage, sessionStorage, or
  // document.cookie throws a SecurityError in that context.  Pages that hit
  // those errors during initialisation may fail to render their UI.
  // Install lightweight in-memory replacements before page scripts run so
  // that storage reads/writes succeed silently without exposing real data.
  try {
    var _mkStore = function () {
      var _d = {};
      return {
        getItem:    function (k) { return Object.prototype.hasOwnProperty.call(_d, k) ? _d[k] : null; },
        setItem:    function (k, v) { _d[String(k)] = String(v); },
        removeItem: function (k) { delete _d[String(k)]; },
        clear:      function () { var ks = Object.keys(_d); for (var i = 0; i < ks.length; i++) delete _d[ks[i]]; },
        key:        function (i) { return Object.keys(_d)[i] || null; },
        get length() { return Object.keys(_d).length; },
      };
    };

    var _lsOk = false;
    try { window.localStorage.getItem(''); _lsOk = true; } catch (_) {}
    if (!_lsOk) {
      var _lsPoly = _mkStore();
      try { Object.defineProperty(window, 'localStorage',   { get: function () { return _lsPoly; }, configurable: true }); } catch (_) {}
    }

    var _ssOk = false;
    try { window.sessionStorage.getItem(''); _ssOk = true; } catch (_) {}
    if (!_ssOk) {
      var _ssPoly = _mkStore();
      try { Object.defineProperty(window, 'sessionStorage', { get: function () { return _ssPoly; }, configurable: true }); } catch (_) {}
    }

    try { void document.cookie; } catch (_) {
      var _jar = '';
      try { Object.defineProperty(document, 'cookie', {
        get: function () { return _jar; },
        set: function (v) { _jar = _jar ? _jar + '; ' + String(v) : String(v); },
        configurable: true,
      }); } catch (_) {}
    }
  } catch (_) {}

})();
<\/script>`;

  // Inject right after the closing > of the opening <head> tag so the script
  // runs before any page scripts — handles <head>, <head lang="en">, etc.
  var lc      = html.toLowerCase();
  var headIdx = lc.indexOf('<head');
  if (headIdx !== -1) {
    var closeGt = html.indexOf('>', headIdx);
    var after   = closeGt !== -1 ? closeGt + 1 : headIdx + 5;
    return html.slice(0, after) + script + html.slice(after);
  }
  // Fallback: no <head> found — insert before </body> or append.
  var bodyIdx = lc.lastIndexOf('</body>');
  return bodyIdx !== -1 ? html.slice(0, bodyIdx) + script + html.slice(bodyIdx) : html + script;
}

/**
 * Central navigation function. Called by the address bar (Enter),
 * New Tab quick links, and New Tab search bar.
 *
 * Routes every request through the Python proxy endpoint
 * `load_and_scrape_url` and injects the returned HTML directly into
 * the viewport via srcdoc. Falls back to a direct iframe src load if
 * the proxy bridge is unavailable or throws.
 *
 * @param {string} url  Fully-qualified URL to load.
 */
async function loadUrl(url) {
  const frame = document.getElementById('web-view');
  const bar   = document.getElementById('address-bar');
  if (!frame) return;

  url = resolveRedirectUrl(url);

  app.log(`[Router]: Routing "${url}" through proxy…`);
  showRouterSuccessBanner(url);

  try {
    const result = await window.pywebview.api.load_and_scrape_url(url, tabs.activeId);

    // Reset the frame's security context before injecting new content.
    // Removing 'src' alone is not enough — the browser keeps the old cross-origin
    // policy until a reflow forces it to flush the stale navigation state.
    frame.removeAttribute('src');
    void frame.offsetWidth;   // synchronous reflow: clears old origin context
    frame.srcdoc = injectNavigationInterceptor(result.html);

    // Defensive shell-visibility reset: injecting srcdoc triggers a WebKit
    // repaint cycle that can — on some GTK WebKit2GTK builds — cause inline
    // style overrides on parent flex items to persist incorrectly.
    // Clearing any accidental inline display/height overrides on the shell
    // elements guarantees the toolbar, viewport, and sidebar stay visible.
    ['browser-window-root', 'navigation-toolbar', 'workspace-body',
     'tabs-viewports-wrapper', 'ai-chat-sidebar'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.removeProperty('display');
        el.style.removeProperty('height');
        el.style.removeProperty('visibility');
        el.style.removeProperty('opacity');
      }
    });

    const finalUrl   = result.url   ?? url;
    const finalTitle = result.title ?? (() => { try { return new URL(url).hostname; } catch (_) { return 'Page'; } })();

    document.getElementById('address-bar').value = finalUrl;
    app.state.currentUrl = finalUrl;

    if (tabs.activeId != null) {
      tabs.setUrl(tabs.activeId, finalUrl);
      tabs.setTitle(tabs.activeId, finalTitle);
      logNavigationToPython(tabs.activeId, finalUrl, finalTitle, result.text ?? '');
      // Persist the updated URL and title so the next restore reflects
      // the page the user actually navigated to.
      syncTabState(tabs.activeId, finalUrl, finalTitle, true);
    }

    if (result.status === 'error') {
      app.log(`[Proxy]: Page returned an error — "${finalTitle}" ← "${finalUrl}"`);
    } else {
      app.log(`[Proxy]: Loaded "${finalTitle}" ← "${finalUrl}"`);
    }
  } catch (err) {
    // Proxy bridge unavailable — show an inline error rather than setting
    // frame.src to a live URL, which would trigger pywebview's GTK navigation
    // handler and replace the entire browser UI with the target page.
    app.log(`[Proxy]: Bridge error — ${err?.message ?? err}. Cannot load page without proxy.`);
    const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return url; } })();
    frame.removeAttribute('src');
    frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>` +
      `<body style="font-family:system-ui;padding:2rem;color:#555;">` +
      `<h3 style="color:#c0392b;margin-bottom:.5rem">Proxy unavailable</h3>` +
      `<p>Cannot load <strong>${hostname}</strong> — the Python backend bridge is not reachable.</p>` +
      `</body></html>`;

    if (bar) bar.value = url;
    app.state.currentUrl = url;

    if (tabs.activeId != null) {
      tabs.setUrl(tabs.activeId, url);
      let resolvedTitle = 'Load Error';
      try { resolvedTitle = new URL(url).hostname; } catch (_) {}
      tabs.setTitle(tabs.activeId, resolvedTitle);
    }
  }
}

/**
 * Returns true when input should be treated as a navigable URL rather than a
 * search query. Matches:
 *   • Explicit protocol prefix  (http:// or https://)
 *   • localhost (with optional port / path)
 *   • Hostnames ending in a recognised TLD
 * Any input containing whitespace is always treated as a search phrase.
 */
function isWebDomain(input) {
  if (/\s/.test(input)) return false;
  // Explicit protocol → always a direct URL, no further checks needed.
  if (/^https?:\/\//i.test(input)) return true;
  const stripped = input.replace(/^https?:\/\//i, '');
  if (/^localhost(?::\d+)?(\/|$|\?|#)?$/i.test(stripped)) return true;
  const TLD = /\.(com|org|net|io|edu|gov|dev|co|uk|de|fr|jp|ca|au|app|ai|me|info|biz)(?::\d+)?(\/|$|\?|#)/i;
  const TLD_END = /\.(com|org|net|io|edu|gov|dev|co|uk|de|fr|jp|ca|au|app|ai|me|info|biz)$/i;
  return TLD.test(stripped) || TLD_END.test(stripped);
}

/**
 * Address-bar routing: AI intercept (?), direct navigation, or search fallback.
 * Called on Enter inside #address-bar.
 *
 * Every branch awaits loadUrl() so that async errors propagate into this
 * function's own try/catch scope and never become unhandled rejections that
 * can crash the webview JS context.
 */
async function handleNavigation() {
  const bar = document.getElementById('address-bar');
  if (!bar) return;

  const input = bar.value.trim();
  if (!input) return;

  bar.blur();

  // Branch A edge case — lone "?" is a search phrase, not an AI intercept
  if (input === '?') {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input)}`;
    await loadUrl(searchUrl);
    return;
  }

  // Branch A — AI intercept: leading ? with additional query text
  if (input.startsWith('?')) {
    const parsedQuery = input.slice(1).trim();
    const fallbackUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(parsedQuery)}`;

    if (!isAiOnline()) {
      app.log(`[AI Intercept]: Local AI off — searching without translation for "${parsedQuery}".`);
      await loadUrl(fallbackUrl);
      return;
    }

    app.log(`[AI Intercept]: Vague query "${parsedQuery}" registered.`);
    app.log('[Nabu Engine]: Consulting local LLM for context translation...');

    try {
      const result = await window.pywebview.api.translate_vague_query(parsedQuery);
      const keywords = result?.keywords ?? parsedQuery;
      if (result?.status === 'error' && result?.message?.includes('turned off')) {
        app.log('[AI Translator]: Local AI off — using raw query.');
        await loadUrl(fallbackUrl);
        return;
      }
      app.log(`[AI Translator]: Optimized keywords received -> "${keywords}"`);
      const optimizedUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keywords)}`;
      await loadUrl(optimizedUrl);
    } catch (err) {
      app.log(`[AI Translator]: Bridge error — ${err?.message ?? err}. Falling back to raw query.`);
      await loadUrl(fallbackUrl);
    }
    return;
  }

  // Branch B — direct URL: explicit protocol OR recognised domain pattern
  if (isWebDomain(input)) {
    const url = /^https?:\/\//i.test(input) ? input : 'https://' + input;
    await loadUrl(url);
    return;
  }

  // Branch C — plain text search: wrap as a DuckDuckGo query
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input)}`;
  await loadUrl(searchUrl);
}

function navBack() {
  console.log('Nav: back');
  app.log('Navigation: back');
  const frame = document.getElementById('web-view');
  try { frame.contentWindow.history.back(); } catch (_) {}
}

function navForward() {
  console.log('Nav: forward');
  app.log('Navigation: forward');
  const frame = document.getElementById('web-view');
  try { frame.contentWindow.history.forward(); } catch (_) {}
}

function navRefresh() {
  console.log('Nav: refresh');
  app.log('Navigation: refresh');
  const url = app.state.currentUrl;
  if (url && url !== 'about:blank') {
    loadUrl(url);
  } else {
    const frame = document.getElementById('web-view');
    if (frame) { try { frame.removeAttribute('src'); } catch (_) {} frame.srcdoc = NEW_TAB_HTML; }
  }
}

/* ── Python Bridge — Navigation Telemetry ───────────────────── */

/**
 * Forwards a successfully-resolved navigation event to the Python
 * storage backend via the pywebview JS↔Python bridge.
 *
 * Silently swallows all errors so a missing or unavailable bridge
 * never disrupts normal browsing. On success, a confirmation line
 * is written to the System Logs panel so the telemetry round-trip
 * can be verified visually during development.
 *
 * @param {number} tabId   Active tab id at the time of navigation.
 * @param {string} url     Fully-qualified URL that was loaded.
 * @param {string} title   Display title stored for the tab (hostname or fallback).
 */
async function logNavigationToPython(tabId, url, title, pageContent = '') {
  if (!window.pywebview?.api?.log_navigation) return;
  try {
    await window.pywebview.api.log_navigation(tabId, url, title, pageContent);
    app.log(`[Python Bridge]: Navigation logged → Tab ${tabId}  "${url}"`);
  } catch (_) {
    // Bridge unavailable or call rejected — fail silently.
  }
}

/* ── Python Bridge — Tab State Persistence ──────────────────── */

/**
 * Persists a single tab's current state to the Python storage backend.
 * Called after every create, switch, or proxy navigation event.
 * Fails silently so a missing bridge never blocks the UI.
 *
 * @param {number}  tabId     Tab's numeric id.
 * @param {string}  url       Tab's current URL (empty string for New Tab).
 * @param {string}  title     Tab's display title.
 * @param {boolean} isActive  Whether this tab is the currently focused one.
 */
async function syncTabState(tabId, url, title, isActive) {
  if (!window.pywebview?.api?.save_tab_state) return;
  // Normalise: backend must never receive an empty-string URL — use about:blank
  // so the row is valid and the restore loop can reconstruct a blank canvas.
  const safeUrl    = url    || 'about:blank';
  const safeTitle  = title  || 'New Tab';
  const activeFlag = Boolean(isActive);   // strict primitive, never undefined
  try {
    await window.pywebview.api.save_tab_state(tabId, safeUrl, safeTitle, activeFlag);
    console.log(`[Session UI] syncTabState: Tab ${tabId} saved — url="${safeUrl}", active=${activeFlag}`);
  } catch (err) {
    console.warn('[Session UI] syncTabState failed:', err);
  }
}

/**
 * Removes a tab's persisted state record when the tab is closed.
 * Called before the DOM node is removed so the backend stays consistent
 * even if a subsequent DOM operation throws.
 *
 * @param {number} tabId  Tab's numeric id to delete from storage.
 */
async function removeTabState(tabId) {
  if (!window.pywebview?.api?.remove_tab_state) return;
  try {
    await window.pywebview.api.remove_tab_state(tabId);
    console.log(`[Session UI] removeTabState: Tab ${tabId} removed from storage.`);
  } catch (err) {
    console.warn('[Session UI] removeTabState failed:', err);
  }
}

/* ── Python Bridge (preserved) ──────────────────────────────── */

async function testBridge() {
  const statusText = document.getElementById('status-text');
  if (statusText) statusText.innerText = 'Calling Python…';
  try {
    const response = await window.pywebview.api.test_connection('Hello Backend!');
    if (statusText) statusText.innerText = response;
    app.log(`Bridge test: ${response}`);
  } catch (err) {
    app.log(`Bridge test failed: ${err.message}`);
  }
}

async function askPythonForKeywords() {
  if (!isAiOnline()) {
    app.log('Keyword translation skipped — Local AI is turned off.');
    return;
  }
  const queryInput = document.getElementById('address-bar').value;
  app.log('AI translating query to search keywords…');
  try {
    const keywords = await window.pywebview.api.get_ai_keywords(queryInput);
    app.log(`Keywords resolved: ${keywords}`);
    loadUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(keywords)}`);
  } catch (err) {
    app.log(`Keyword translation failed: ${err.message}`);
  }
}

/* ── Session Restore ────────────────────────────────────────── */

/**
 * Attempts to recover the previous browsing session from the Python backend.
 *
 * Flow:
 *  1. Calls restore_session() on the bridge.
 *  2. If saved tabs are returned, rebuilds each pill via _restoreTab():
 *       • Inactive tabs get their pill and state stored; content is
 *         loaded lazily when the user switches to them.
 *       • The one active tab is activated and its content loaded now.
 *  3. If the result is empty (first launch or cleared session), falls back
 *     to a single blank New Tab canvas.
 *  4. Any bridge / network error also falls back to the blank tab so the
 *     browser is always usable even without a backend.
 */
function restoreOrInit() {
  app.log('[Session]: Checking for saved workspace…');
  console.log('[Session UI] restoreOrInit: bridge available =', !!window.pywebview?.api?.restore_session);

  if (!window.pywebview?.api?.restore_session) {
    app.log('[Session]: Bridge not available — starting fresh.');
    console.warn('[Session UI] restore_session not found on API; spawning blank tab.');
    tabs.create('New Tab', '');
    return;
  }

  window.pywebview.api.restore_session()
    .then(result => {
      console.log('[Session UI] restore_session raw response:', result);
      console.log('[Session UI] Restored tabs:', result?.tabs);

      // Scenario A — saved session exists
      if (result?.status === 'success' && result?.tabs?.length > 0) {
        app.log(`[Session]: Restoring ${result.tabs.length} tab(s) from last session.`);
        console.log('[Session UI] Scenario A — rebuilding', result.tabs.length, 'tab(s).');

        // Inactive tabs are processed first so the final _activate() call
        // always belongs to the active tab, leaving the correct one focused.
        const inactive  = result.tabs.filter(t => !t.is_active);
        const activeTab = result.tabs.find(t => t.is_active) ?? result.tabs[0];

        inactive.forEach(t => {
          console.log(`[Session UI] Restoring inactive tab — id=${t.tab_id}, url="${t.url}", title="${t.title}"`);
          tabs._restoreTab(t.tab_id, t.title || 'Tab', t.url || '', false);
        });

        console.log(`[Session UI] Restoring active tab — id=${activeTab.tab_id}, url="${activeTab.url}", title="${activeTab.title}"`);
        tabs._restoreTab(activeTab.tab_id, activeTab.title || 'Tab', activeTab.url || '', true);

        app.log('[Session]: Workspace restored successfully.');
      } else {
        // Scenario B — no saved rows or non-success status
        app.log('[Session]: No previous session found — starting fresh.');
        console.log('[Session UI] Scenario B — clean slate; spawning default blank tab.');
        tabs.create('New Tab', '');
      }
    })
    .catch(err => {
      app.log(`[Session]: Restore failed (${err?.message ?? err}) — starting fresh.`);
      console.error('[Session UI] restore_session threw:', err);
      tabs.create('New Tab', '');
    });
}

/* ── Shell Guard — MutationObserver ─────────────────────────── */

/**
 * Watches the two permanent shell roots for accidental child removal
 * caused by WebKit2GTK repaint cycles or rogue innerHTML assignments.
 * Any removed direct child is synchronously re-appended so the layout
 * never disappears from the DOM tree.
 */
function _installShellGuard() {
  const shellObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // Only react to removals of known permanent shell children.
        if (['navigation-toolbar', 'workspace-body',
             'tabs-viewports-wrapper', 'ai-chat-sidebar'].includes(node.id)) {
          console.error(`[Shell Guard]: #${node.id} removed — restoring.`);
          app.log(`[Shell Guard]: Critical element #${node.id} was removed and restored.`);
          mut.target.appendChild(node);
        }
      }
    }
  });

  const root        = document.getElementById('browser-window-root');
  const workspaceEl = document.getElementById('workspace-body');

  // Guard direct children of the root (navigation-toolbar, workspace-body)
  // and direct children of the workspace (tabs-viewports-wrapper, ai-chat-sidebar).
  if (root)        shellObserver.observe(root,        { childList: true });
  if (workspaceEl) shellObserver.observe(workspaceEl, { childList: true });
}

/* ── Boot ───────────────────────────────────────────────────── */

window.addEventListener('DOMContentLoaded', () => {
  app.log('Nabu Core initialized.');
  app.log('UI workspace ready.');
  app.log('Mode: General Chat.');

  applyAiStatusUI(app.state.isAiOnline);

  // Install DOM mutation guard — must run before any dynamic content loads.
  _installShellGuard();

  // Wire up address-bar keydown (no inline handler in HTML).
  const addressBar = document.getElementById('address-bar');
  if (addressBar) {
    addressBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleNavigation();
      }
    });
  }

  // Go button triggers the same navigation pipeline as Enter in the address bar.
  document.getElementById('go-btn')?.addEventListener('click', handleNavigation);

  // New tab button.
  document.getElementById('add-tab-btn')?.addEventListener('click', () => tabs.create());

  // AI status toggle (inline onclick removed from HTML).
  document.getElementById('ai-status-btn')?.addEventListener('click', toggleAiStatus);

  const modelSelect = document.getElementById('ai-model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', onModelSelectChange);
  }

  document.getElementById('ai-organize-tabs-btn')?.addEventListener('click', triggerTabOrganize);

  // Sidebar chat — event listeners wired in JS (no inline handlers in HTML).
  const sidebarInput   = document.getElementById('ai-chat-input');
  const sidebarSendBtn = document.getElementById('send-chat-btn');

  if (sidebarInput) {
    sidebarInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitSidebarQuery();
      }
    });
  }

  if (sidebarSendBtn) {
    sidebarSendBtn.addEventListener('click', () => submitSidebarQuery());
  }

  // Nav button event listeners.
  document.getElementById('back-btn')?.addEventListener('click', navBack);
  document.getElementById('forward-btn')?.addEventListener('click', navForward);
  document.getElementById('refresh-btn')?.addEventListener('click', navRefresh);

  document.getElementById('ollama-health-btn')?.addEventListener('click', runOllamaHealthCheck);
  document.getElementById('ollama-restart-btn')?.addEventListener('click', runOllamaRestart);

  // Receive navigation and search messages from the sandboxed web-view iframe.
  // We do NOT use a strict e.source identity check here: in pywebview's GTK
  // WebKit2GTK backend, e.source for a sandboxed null-origin iframe is often
  // null, which would silently drop every message. The nabu-* type namespace
  // is specific enough to avoid collisions with unrelated messages.
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'nabu-navigate' && e.data.url) {
      loadUrl(e.data.url);
    } else if (e.data?.type === 'nabu-search' && e.data.query) {
      homePortalSearch(e.data.query);
    }
  });

  // Session restore requires the pywebview bridge. Run immediately if it is
  // already available (common case), otherwise wait for the 'pywebviewready'
  // event that pywebview fires once the JS↔Python channel is open.
  const onBridgeReady = () => {
    if (window.pywebview?.api?.get_ai_enabled) {
      window.pywebview.api.get_ai_enabled()
        .then((res) => {
          if (res && typeof res.enabled === 'boolean') {
            app.state.isAiOnline = res.enabled;
            applyAiStatusUI(res.enabled);
          }
        })
        .catch(() => { /* keep default on */ });
    }
    initModelSelect().catch((err) => {
      console.warn('[Model Select] init failed:', err);
    });
    restoreOrInit();
  };

  if (window.pywebview?.api) {
    onBridgeReady();
  } else {
    window.addEventListener('pywebviewready', onBridgeReady, { once: true });
  }
});
