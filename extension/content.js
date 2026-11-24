// yt-watcher – Content-Script: zeigt auf YouTube-Watch-Seiten eine Box mit der KI-Zusammenfassung.
// HARTE REGEL: keine HTML-String-Senken – Inhalte entstehen nur über createElement/textContent/append.
(() => {
  'use strict';

  // Schutz gegen doppelte Injektion
  if (window.__ytwLoaded) return;
  window.__ytwLoaded = true;

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  // [m:ss], [mm:ss], [h:mm:ss], auch Bereiche wie [1:20-2:05]; Gruppe 1 = erste Zeit (Sprungziel)
  const TS_RE = /\[(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?:\s*[-–—]\s*\d{1,2}:[0-5]\d(?::[0-5]\d)?)?\]/g;
  const BOLD_RE = /\*\*(.+?)\*\*/g;
  const BULLET_RE = /^[-*•]\s+(.+)$/;
  // Kernpunkt, der mit einem Zeitstempel beginnt: Gruppe 1 = Zeitstempel samt Klammern, Gruppe 3 = Text
  const LEAD_TS_RE = new RegExp('^(' + TS_RE.source + ')\\s*[-–—:]?\\s*(.+)$');
  // Abschnittsname aus höchstens zwei Wörtern vor dem eigentlichen Text: "Kurzfassung: …", "**Summary:** …"
  const LABEL_LEAD_RE = /^[*#\s]*[^\s:.!?*#]+(?:\s[^\s:.!?*#]+)?:\s*\**\s*/;

  const ERROR_TEXT = {
    no_subtitles: 'Dieses Video hat keine Untertitel – keine Zusammenfassung möglich.',
    ytdlp: 'Die Untertitel konnten nicht abgerufen werden.',
    claude: 'Das Zusammenfassen ist fehlgeschlagen.',
    timeout: 'Das Zusammenfassen hat zu lange gedauert und wurde abgebrochen.',
    worker: 'Im lokalen Dienst ist ein interner Fehler aufgetreten.',
    forbidden: 'Der lokale Dienst hat die Anfrage abgelehnt.',
    bad_id: 'Die Video-ID ist ungültig.',
    bad_response: 'Der lokale Dienst hat eine unerwartete Antwort geliefert.',
  };

  const CSS = `
    :host { all: initial; display: block;
      --ytw-bg: rgba(0,0,0,0.05); --ytw-solid: #f2f2f2; --ytw-fg: #0f0f0f; --ytw-fg2: #606060; --ytw-acc: #065fd4; }
    :host([dark]) {
      --ytw-bg: rgba(255,255,255,0.1); --ytw-solid: #272727; --ytw-fg: #f1f1f1; --ytw-fg2: #aaa; --ytw-acc: #3ea6ff; }
    :host([data-place="float"]) { position: fixed; top: 72px; right: 16px; width: 380px; z-index: 2200; margin: 0; }
    .box { box-sizing: border-box; background: var(--ytw-bg); color: var(--ytw-fg); border-radius: 12px;
      padding: 12px 14px; font: 400 14px/20px Roboto, Arial, sans-serif; }
    :host([data-place="float"]) .box { background: var(--ytw-solid); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
    /* Abstand nach unten als eigenes Element: einen Aussenabstand am Host setzt YouTubes CSS auf 0 */
    .gap { height: 16px; }
    :host([data-place="float"]) .gap { display: none; }
    .head { display: flex; align-items: center; gap: 8px; }
    .label { font-weight: 500; }
    .status { flex: 1; min-width: 0; color: var(--ytw-fg2); font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spinner { display: none; flex: none; box-sizing: border-box; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid var(--ytw-fg2); border-top-color: transparent; animation: ytw-spin 0.8s linear infinite; }
    .box[data-state="pending"] .spinner { display: block; }
    @keyframes ytw-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-style: dotted; border-top-color: var(--ytw-fg2); } }
    button { font: inherit; margin: 0; border: 0; background: none; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--ytw-acc); outline-offset: 1px; }
    .btn { flex: none; padding: 4px 10px; border-radius: 14px; font-size: 12px; line-height: 16px; color: var(--ytw-acc); }
    .btn:hover:not(:disabled) { background: var(--ytw-bg); }
    .btn:disabled { color: var(--ytw-fg2); opacity: 0.6; cursor: default; }
    .toggle { padding: 4px 8px; color: var(--ytw-fg2); }
    .toggle::before { content: ''; display: inline-block; width: 6px; height: 6px; border: solid currentColor;
      border-width: 0 2px 2px 0; transform: translateY(-2px) rotate(45deg); }
    .box.collapsed .toggle::before { transform: rotate(-45deg); }
    /* Begrenzte Hoehe, scrollbar per Mausrad, aber ohne sichtbaren Balken. Stattdessen blendet
       der Text an der Kante aus, an der es noch weitergeht. */
    .body { margin-top: 8px; max-height: 60vh; overflow-y: auto; scrollbar-width: none; overflow-wrap: anywhere; }
    .body.more-below { mask-image: linear-gradient(to bottom, #000 calc(100% - 32px), transparent); }
    .body.more-above { mask-image: linear-gradient(to top, #000 calc(100% - 32px), transparent); }
    .body.more-above.more-below {
      mask-image: linear-gradient(to bottom, transparent, #000 32px, #000 calc(100% - 32px), transparent); }
    .fold-toggle { display: inline-block; margin: 0; padding: 6px 12px; border-radius: 16px;
      background: var(--ytw-bg); color: var(--ytw-fg); font-size: 13px; line-height: 18px; font-weight: 500; }
    .fold-toggle:hover { color: var(--ytw-acc); }
    .fold { margin-top: 8px; }
    .fold[hidden] { display: none; }
    .fold > :last-child { margin-bottom: 0; }
    .box.collapsed .body { display: none; }
    .body p, .body ul { margin: 0 0 8px; }
    .body ul { padding-left: 18px; }
    .body li { margin-bottom: 4px; }
    .body > :last-child { margin-bottom: 0; }
    strong, .h { font-weight: 700; }
    .sub { color: var(--ytw-fg2); font-size: 12px; line-height: 16px; }
    .mono { font-family: Consolas, 'Roboto Mono', monospace; }
    .ts { padding: 0; color: var(--ytw-acc); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .ts:hover { text-decoration: underline; }
  `;

  let videoId = null;      // aktuell erkannte Video-ID (null = keine Watch-Seite)
  let token = 0;           // steigt bei jedem Videowechsel; veraltete Callbacks/Timer erkennen sich daran
  let startTimer = 0;
  let pollTimer = 0;
  let tickTimer = 0;
  let visHandler = null;   // wartender visibilitychange-Listener
  let dead = false;        // Erweiterungskontext ungültig
  let shown = false;       // Box wird für das aktuelle Video angezeigt
  let state = '';          // pending | done | error | offline | dead
  let pend = {};           // letzte pending-Antwort des Dienstes
  let pendEl = null;
  let startedAt = 0;
  let missTicks = 0;       // Ticks in Folge ohne Einhängepunkt
  let collapsed = false;
  let host = null;
  let root = null;         // geschlossener Shadow-Root, nur hier erreichbar
  let box, statusEl, regenBtn, toggleBtn, bodyEl;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- Video-Erkennung ----------

  function currentId() {
    if (location.pathname !== '/watch') return null;
    const v = new URLSearchParams(location.search).get('v');
    return v && ID_RE.test(v) ? v : null;
  }

  function clearTimers() {
    clearTimeout(startTimer);
    clearTimeout(pollTimer);
    if (visHandler) document.removeEventListener('visibilitychange', visHandler);
    visHandler = null;
  }

  // Billig, wenn sich nichts geändert hat; sonst alles zum alten Video verwerfen.
  function check() {
    const id = currentId();
    if (id === videoId) return;
    videoId = id;
    token++;
    clearTimers();
    shown = false;
    if (host) {
      host.remove();
      bodyEl.replaceChildren();
    }
    if (id && !dead) scheduleStart(token);
  }

  // Die 1000 ms zählen nur im sichtbaren Tab (Hintergrund-Tabs lösen nichts aus).
  function scheduleStart(t) {
    if (document.visibilityState !== 'visible') {
      visHandler = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', visHandler);
        visHandler = null;
        if (t === token) scheduleStart(t);
      };
      document.addEventListener('visibilitychange', visHandler);
      return;
    }
    startTimer = setTimeout(() => {
      if (t !== token) return;
      // Tab inzwischen wieder im Hintergrund: erneut auf Sichtbarkeit warten
      if (document.visibilityState !== 'visible') return scheduleStart(t);
      if (!host) build();
      shown = true;
      startedAt = Date.now();
      missTicks = -1; // der Sofortversuch in place() zählt nicht als Tick
      showPending({});
      place();
      request(false, t);
    }, 1000);
  }

  function tick() {
    check();
    if (!shown) return;
    // Eine laufende Anfrage käme nach dem Neuladen der Erweiterung evtl. nie zurück
    if ((state === 'pending' || state === 'offline') && !extAlive()) return contextLost('Kontext ungültig');
    place();
    if (state === 'pending') updatePending();
    updateFade(); // Fenstergröße oder Layout können sich geändert haben
  }

  // ---------- Anfragen an den Service-Worker ----------

  function extAlive() {
    try {
      return !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  function request(force, t) {
    try {
      chrome.runtime.sendMessage({ type: 'summary', videoId, force }, (res) => {
        let err = null;
        try {
          err = chrome.runtime.lastError || null;
        } catch (e) {
          err = e;
        }
        if (t !== token) return;
        if (!err) handle(res, force, t);
        // Erweiterung noch da, nur der Service-Worker wurde mitten in der Anfrage beendet: nochmal
        else if (extAlive()) schedulePoll(2000, force, t);
        else contextLost(err);
      });
    } catch (e) {
      contextLost(e);
    }
  }

  function schedulePoll(ms, force, t) {
    pollTimer = setTimeout(() => {
      if (t === token) request(force, t);
    }, ms);
  }

  function handle(res, force, t) {
    const st = res && typeof res.state === 'string' ? res.state : '';
    if (st === 'pending') {
      showPending(res);
      schedulePoll(2000, false, t);
    } else if (st === 'error' && res.code === 'busy') {
      // Warteschlange voll: wie pending behandeln; force bleibt erhalten, weil nichts angenommen wurde
      showPending({ busy: true });
      schedulePoll(5000, force, t);
    } else if (st === 'offline') {
      showOffline();
      schedulePoll(5000, force, t);
    } else if (st === 'done' && typeof res.summary === 'string') {
      const frag = document.createDocumentFragment();
      renderSummary(res.summary, frag);
      setState('done', typeof res.model === 'string' ? res.model : '', frag);
    } else {
      showError(st === 'error' ? res : { code: 'bad_response' });
    }
  }

  function contextLost(err) {
    console.debug('[yt-watcher] Verbindung zur Erweiterung verloren:', err);
    dead = true;
    token++;
    clearTimers();
    clearInterval(tickTimer);
    if (shown) {
      setState('dead', '', el('p', '', 'Die Erweiterung wurde neu geladen. Bitte diese Seite neu laden (F5).'));
    }
  }

  // ---------- Zustände der Box ----------

  function setState(s, statusText, ...nodes) {
    state = s;
    box.dataset.state = s;
    statusEl.textContent = statusText;
    regenBtn.disabled = s !== 'done' && s !== 'error';
    bodyEl.replaceChildren(...nodes);
    bodyEl.scrollTop = 0;
    updateFade();
  }

  // Zeigt an der oberen/unteren Kante an, ob dort noch Text folgt (es gibt keinen Scrollbalken).
  function updateFade() {
    bodyEl.classList.toggle('more-above', bodyEl.scrollTop > 2);
    bodyEl.classList.toggle('more-below', bodyEl.scrollTop + bodyEl.clientHeight < bodyEl.scrollHeight - 2);
  }

  function showPending(info) {
    pend = info;
    pendEl = el('p');
    setState('pending', '', pendEl);
    updatePending();
  }

  function updatePending() {
    const pos = Number(pend.position);
    if (pend.busy) {
      pendEl.textContent = 'Der Dienst ist ausgelastet – neuer Versuch in Kürze …';
    } else if (pend.phase === 'queued' && pos > 1) {
      pendEl.textContent = `In der Warteschlange (Platz ${pos}) …`;
    } else {
      pendEl.textContent = `Wird zusammengefasst … ${Math.floor((Date.now() - startedAt) / 1000)} s`;
    }
  }

  function showOffline() {
    const cmd = el('p', '', 'Starten mit: ');
    cmd.append(el('span', 'mono', 'start.cmd -Serve'));
    setState('offline', 'offline',
      el('p', '', 'Der lokale Dienst läuft nicht.'),
      cmd,
      el('p', 'sub', 'Es wird automatisch alle 5 Sekunden erneut versucht.'));
  }

  function showError(res) {
    const known = Object.hasOwn(ERROR_TEXT, res.code);
    const nodes = [el('p', '', known ? ERROR_TEXT[res.code] : 'Unbekannter Fehler beim Zusammenfassen.')];
    if (res.code !== 'no_subtitles' && typeof res.message === 'string' && res.message) {
      nodes.push(el('p', 'sub', res.message));
    }
    setState('error', 'Fehler', ...nodes);
  }

  // ---------- Zusammenfassung rendern (nur DOM-Knoten) ----------

  // Zeile, die nur ein Abschnittsname ist: "Kernpunkte:", "**Key points:**", "## Summary"
  function isLabel(line) {
    const marked = /^#{1,6}\s/.test(line) || /^\*\*.*\*\*$/.test(line) || /:[*\s]*$/.test(line);
    const core = line.replace(/^[*#\s]+/, '').replace(/[*:\s]+$/, '');
    return marked && core.length > 0 && core.length <= 40 && !/[.!?]/.test(core);
  }

  function paragraph(line, parent) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const p = el('p', heading ? 'h' : '');
    inline(heading ? heading[1] : line, p);
    parent.append(p);
  }

  // Aufbau der Zusammenfassung: Fließtext (Kurzfassung), dann eine Liste (Kernpunkte). Die
  // Kurzfassung steht immer da, die Kernpunkte stecken hinter einem Knopf und sind zunächst zugeklappt.
  // Erkannt wird das am Aufbau, nicht an den Abschnittsnamen: die schreibt das Modell je nach Sprache.
  function renderSummary(text, container) {
    const lines = text.split(/\r?\n/).map((s) => s.trim())
      // ältere Cache-Einträge enthalten noch einen Sponsor-Abschnitt; der wird nicht mehr gezeigt
      .filter((s) => !/^[*#\s]*Werbung\/Sponsor/i.test(s));
    const firstBullet = lines.findIndex((s) => BULLET_RE.test(s));
    let target = container;
    let start = 0;
    if (firstBullet > 0) {
      start = firstBullet;
      // Abschnittsnamen fallen weg: "Kurzfassung" ist der Kasten selbst, "Kernpunkte" steht auf dem Knopf
      const body = lines.slice(0, firstBullet).filter((s) => s && !isLabel(s));
      if (body.length) body[0] = body[0].replace(LABEL_LEAD_RE, '') || body[0];
      for (const line of body) paragraph(line, container);
      const btn = el('button', 'fold-toggle', 'Kernpunkte anzeigen');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      target = el('div', 'fold');
      target.hidden = true;
      container.append(btn, target);
    }
    let list = null;
    for (const line of lines.slice(start)) {
      const bullet = BULLET_RE.exec(line);
      if (bullet) {
        // aufeinanderfolgende Aufzählungszeilen landen in derselben Liste
        if (!list) {
          list = el('ul');
          target.append(list);
        }
        const li = el('li');
        // Das Modell setzt den Zeitstempel an den Anfang; angezeigt wird er am Ende des Punktes
        const lead = LEAD_TS_RE.exec(bullet[1]);
        if (lead) {
          inline(lead[3], li);
          li.append(' ');
          stamps(lead[1], li);
        } else {
          inline(bullet[1], li);
        }
        list.append(li);
        continue;
      }
      list = null;
      if (line) paragraph(line, target);
    }
  }

  // **fett** -> <strong>; ein einzelnes ** ohne Partner bleibt wörtlich stehen.
  function inline(text, parent) {
    let last = 0;
    for (const m of text.matchAll(BOLD_RE)) {
      stamps(text.slice(last, m.index), parent);
      const strong = el('strong');
      stamps(m[1], strong);
      parent.append(strong);
      last = m.index + m[0].length;
    }
    stamps(text.slice(last), parent);
  }

  // Zeitstempel in eckigen Klammern -> Schaltfläche, alles andere bleibt reiner Text.
  function stamps(text, parent) {
    let last = 0;
    for (const m of text.matchAll(TS_RE)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const btn = el('button', 'ts', m[0].slice(1, -1));
      btn.type = 'button';
      btn.dataset.t = String(m[1].split(':').reduce((sum, part) => sum * 60 + Number(part), 0));
      parent.append(btn);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function seek(seconds) {
    const player = document.querySelector('#movie_player');
    if (player && player.classList.contains('ad-showing')) return; // während Werbung nicht springen
    const video = document.querySelector('#movie_player video') || document.querySelector('video');
    if (!video || !Number.isFinite(seconds)) return;
    video.currentTime = Number.isFinite(video.duration) ? Math.min(seconds, video.duration) : seconds;
  }

  // ---------- Box aufbauen und einhängen ----------

  function applyCollapsed() {
    box.classList.toggle('collapsed', collapsed);
    toggleBtn.title = collapsed ? 'Ausklappen' : 'Einklappen';
    toggleBtn.setAttribute('aria-label', toggleBtn.title);
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  function build() {
    host = el('div');
    host.id = 'ytw-host';
    root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.append(el('style', '', CSS));
    }

    statusEl = el('span', 'status');
    regenBtn = el('button', 'btn', 'neu erzeugen');
    regenBtn.type = 'button';
    regenBtn.title = 'Cache übergehen und dieses Video neu zusammenfassen';
    toggleBtn = el('button', 'btn toggle');
    toggleBtn.type = 'button';
    bodyEl = el('div', 'body');
    const head = el('div', 'head');
    head.append(el('span', 'label', 'Zusammenfassung'), el('span', 'spinner'), statusEl, regenBtn, toggleBtn);
    box = el('div', 'box');
    box.append(head, bodyEl);
    root.append(box, el('div', 'gap'));

    try {
      collapsed = localStorage.getItem('ytw-collapsed') === '1';
    } catch (e) {
      // localStorage gesperrt: Standard (ausgeklappt) bleibt
    }
    applyCollapsed();

    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      applyCollapsed();
      updateFade();
      try {
        localStorage.setItem('ytw-collapsed', collapsed ? '1' : '0');
      } catch (e) {
        // nicht speicherbar: gilt dann nur für diese Seite
      }
    });

    // Nur in done/error aktiv; dort läuft weder eine Anfrage noch ein Poll-Timer.
    regenBtn.addEventListener('click', () => {
      if (!shown || !videoId) return;
      clearTimeout(pollTimer);
      startedAt = Date.now();
      showPending({});
      request(true, token);
    });

    // Ein delegierter Listener für alle Zeitstempel
    root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button.ts');
      if (btn) return seek(Number(btn.dataset.t));
      const tgl = ev.target.closest('button.fold-toggle');
      if (tgl) {
        const area = tgl.nextElementSibling;
        const open = area.hidden; // war zu, wird jetzt geöffnet
        area.hidden = !open;
        tgl.textContent = open ? 'Kernpunkte ausblenden' : 'Kernpunkte anzeigen';
        tgl.setAttribute('aria-expanded', String(open));
        updateFade();
      }
    });
    bodyEl.addEventListener('scroll', updateFade, { passive: true });

    // YouTube-Hotkeys (Leertaste, k, j, l …) nicht auslösen, wenn der Fokus in der Box liegt
    for (const type of ['keydown', 'keyup', 'keypress']) {
      host.addEventListener(type, (ev) => ev.stopPropagation());
    }
  }

  // Einhängepunkt bestimmen und den Host nur umhängen, wenn er nicht schon dort sitzt.
  function place() {
    host.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
    const flexy = document.querySelector('ytd-watch-flexy');
    let target = null;
    let where = '';
    if (flexy && !flexy.hidden) {
      const secondary = flexy.querySelector('#columns > #secondary') || flexy.querySelector('#secondary');
      if (secondary && secondary.offsetWidth > 0) {
        target = secondary;
        where = 'column';
      } else {
        target = flexy.querySelector('#below'); // schmales Fenster, einspaltiges Layout
        where = 'below';
      }
    }
    if (target) {
      missTicks = 0;
      if (host.parentNode !== target) target.prepend(host);
    } else if (++missTicks >= 8) {
      // nichts gefunden: schwebend am Body, bis ein Einhängepunkt auftaucht
      where = 'float';
      if (host.parentNode !== document.body) document.body.append(host);
    } else {
      return;
    }
    if (host.dataset.place !== where) host.dataset.place = where;
  }

  // ---------- Start ----------

  document.addEventListener('yt-navigate-start', check); // alter Kasten weg, sobald die Adresse wechselt
  document.addEventListener('yt-navigate-finish', check);
  window.addEventListener('popstate', check);
  tickTimer = setInterval(tick, 1000); // zugleich Rückfall, falls ein Navigationsereignis fehlt
  check();
})();
