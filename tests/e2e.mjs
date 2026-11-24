// End-to-End-Test: echtes Chrome (stumm, Wegwerf-Profil) + Erweiterung + lokaler Dienst.
//
//   cd tests; npm install; node e2e.mjs
//
// Der Test startet und beendet den Dienst selbst (vorher einen laufenden Dienst schliessen),
// oeffnet echte YouTube-Seiten und loest dabei 2 bis 3 Zusammenfassungen aus. Bildschirmfotos
// landen in tests\out\. Umgebungsvariablen: HEADFUL=1 zeigt das Fenster, ONLY=cache,spa,regen,
// errors,layout waehlt Abschnitte, CHROME=<Pfad> nimmt ein anderes Chrome.
// Schlaegt hier etwas fehl, hat meist YouTube sein Seitengeruest geaendert (place() in content.js).
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const EXT = path.join(PROJECT, 'extension');
const CACHE = path.join(PROJECT, 'cache');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_ID = 'agmcclmiochojehoenhbneknhcemjlmj';
const HEADLESS = process.env.HEADFUL ? false : true;
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = (name) => ONLY.length === 0 || ONLY.includes(name);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

// ---------- Dienst ----------
let service = null;
let serviceLog = '';
async function health() {
  try { return await (await fetch('http://localhost:47816/health', { signal: AbortSignal.timeout(1500) })).json(); } catch { return null; }
}
async function startService() {
  service = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT, 'yt-watcher.ps1'), '-Serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => { serviceLog += d; process.stdout.write(String(d).replace(/^/gm, '      dienst| ').replace(/\| $/, '')); };
  service.stdout.on('data', onData); service.stderr.on('data', onData);
  for (let i = 0; i < 40; i++) { if (await health()) return; await sleep(250); }
  throw new Error('Dienst startet nicht');
}
function stopService() {
  if (service) spawnSync('taskkill', ['/PID', String(service.pid), '/T', '/F']);
  service = null;
}

// ---------- Browser ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ytw-e2e-'));
let browser, page, cdp, extCtx = null, mainFrameId = null;

async function extEval(expression) {
  for (let i = 0; i < 50 && extCtx === null; i++) await sleep(100);
  if (extCtx === null) throw new Error('Kein Kontext des Content-Skripts (Erweiterung nicht injiziert?)');
  const r = await cdp.send('Runtime.evaluate', { contextId: extCtx, expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('extEval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
const PROBE = `(() => {
  const h = document.getElementById('ytw-host');
  if (!h) return { host: false };
  const r = chrome.dom.openOrClosedShadowRoot(h);
  const box = r.querySelector('.box');
  const rect = h.getBoundingClientRect();
  return { host: true, parent: h.parentNode ? (h.parentNode.id || h.parentNode.tagName) : null,
    first: !!h.parentNode && h.parentNode.firstElementChild === h, place: h.dataset.place || '', dark: h.hasAttribute('dark'),
    state: box.dataset.state, status: r.querySelector('.status').textContent, collapsed: box.classList.contains('collapsed'),
    text: r.querySelector('.body').innerText, ts: r.querySelectorAll('button.ts').length,
    strong: r.querySelectorAll('strong').length, li: r.querySelectorAll('li').length,
    regenDisabled: r.querySelector('.btn').disabled,
    tsAtEnd: [...r.querySelectorAll('li')].filter((li) => li.lastElementChild && li.lastElementChild.matches('button.ts') && li.lastChild === li.lastElementChild && !/^\d/.test(li.textContent)).length,
    gapBelow: (() => { let e = h.nextElementSibling; while (e && e.getBoundingClientRect().height === 0) e = e.nextElementSibling;
      return e ? Math.round(e.getBoundingClientRect().top - box.getBoundingClientRect().bottom) : null; })(),
    fold: (() => { const b = r.querySelector('.fold-toggle'), a = r.querySelector('.fold');
      return b && a ? { label: b.textContent, hidden: a.hidden, shown: a.offsetHeight > 0, chars: a.textContent.length } : null; })(),
    scroll: (() => { const b = r.querySelector('.body');
      return { top: Math.round(b.scrollTop), client: b.clientHeight, full: b.scrollHeight, bar: b.offsetWidth - b.clientWidth,
        above: b.classList.contains('more-above'), below: b.classList.contains('more-below') }; })(),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    vw: innerWidth, styled: getComputedStyle(box).borderRadius };
})()`;
async function probe() { try { return await extEval(PROBE); } catch (e) { return { host: false, err: String(e.message) }; } }

// Beobachtet die Box und protokolliert jeden Zustandswechsel mit Zeit ab t0
async function watch(t0, until, maxMs, label) {
  const seen = [];
  let last = '';
  let p;
  while (Date.now() - t0 < maxMs) {
    p = await probe();
    const tag = p.host ? p.state : 'keine Box';
    if (tag !== last) { seen.push(`${tag}@${Date.now() - t0}ms`); last = tag; }
    if (until(p)) break;
    await sleep(100);
  }
  console.log(`      ${label}: ${seen.join(' > ')}`);
  return { p, seen };
}
async function shot(name) { await page.screenshot({ path: path.join(OUT, name + '.png') }); }
async function videoState() {
  return page.evaluate(() => {
    const v = document.querySelector('#movie_player video') || document.querySelector('video');
    const mp = document.querySelector('#movie_player');
    return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState, dur: v.duration, ad: !!mp && mp.classList.contains('ad-showing') } : null;
  });
}
async function gotoWatch(id) {
  const t0 = Date.now();
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (new URL(page.url()).hostname.startsWith('consent.')) {
    console.log('      Einwilligungsseite, lehne ab ...');
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /ablehnen|reject/i.test(x.textContent + x.getAttribute('aria-label'))); if (b) b.click(); });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }
  return t0;
}

async function main() {
  // sauberer Ausgangszustand im Cache
  for (const f of fs.readdirSync(CACHE)) if (f.endsWith('.err') || f.endsWith('.tmp')) fs.unlinkSync(path.join(CACHE, f));
  await startService();
  check('Dienst gestartet', true, JSON.stringify(await health()));

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: HEADLESS, pipe: true, enableExtensions: [EXT], userDataDir: profile,
    defaultViewport: { width: 1600, height: 900 },
    args: ['--mute-audio', '--lang=de-DE', '--no-first-run', '--no-default-browser-check', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required'],
  });
  console.log('      Chrome ' + (await browser.version()) + (HEADLESS ? ' (headless)' : ' (sichtbar)'));
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
  check('Erweiterung geladen, ID wie im Skript', swTarget.url().startsWith(`chrome-extension://${EXT_ID}/`), swTarget.url());

  // Netzwerk des Service-Workers mitschneiden: welche Kopfzeilen schickt Chrome wirklich?
  const swCdp = await swTarget.createCDPSession();
  const netLog = [];
  await swCdp.send('Network.enable');
  const reqs = new Map();
  swCdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { method: e.request.method, url: e.request.url }));
  swCdp.on('Network.requestWillBeSentExtraInfo', (e) => { const r = reqs.get(e.requestId) || {}; netLog.push({ ...r, origin: e.headers.Origin ?? e.headers.origin ?? '(keiner)', site: e.headers['Sec-Fetch-Site'] ?? e.headers['sec-fetch-site'] ?? '' }); });
  swCdp.on('Network.loadingFailed', (e) => netLog.push({ ...(reqs.get(e.requestId) || {}), failed: e.errorText, blocked: e.blockedReason || '', cors: e.corsErrorStatus?.corsError || '' }));

  page = (await browser.pages())[0] || (await browser.newPage());
  await browser.setCookie({ name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/', secure: true, expires: Math.floor(Date.now() / 1000) + 86400 });
  cdp = await page.createCDPSession();
  // Der Kasten steckt in einem geschlossenen Shadow-Root. Hinein kommt nur die Welt des
  // Content-Skripts (chrome.dom.openOrClosedShadowRoot), deshalb wird dort ausgewertet.
  cdp.on('Runtime.executionContextCreated', (e) => {
    const c = e.context;
    if (c.name === 'yt-watcher' && c.auxData && c.auxData.type === 'isolated' && (mainFrameId === null || c.auxData.frameId === mainFrameId)) extCtx = c.id;
  });
  cdp.on('Runtime.executionContextDestroyed', (e) => { if (e.executionContextId === extCtx) extCtx = null; });
  cdp.on('Runtime.executionContextsCleared', () => { extCtx = null; });
  mainFrameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  await cdp.send('Runtime.enable');
  const pageErrors = [];
  page.on('console', (m) => { if (/yt-watcher|ytw|TrustedHTML|Trusted Type/i.test(m.text())) pageErrors.push(m.type() + ': ' + m.text()); });

  // ---------- 1. Video aus dem Cache ----------
  if (want('cache')) {
    console.log('\n== 1. Seite laden, Video ist im Cache (W8Dl-TS9H2c)');
    const t0 = await gotoWatch('W8Dl-TS9H2c');
    const tDom = Date.now() - t0;
    const { p } = await watch(t0, (x) => x.host && x.state === 'done', 30000, `ab Seitenaufruf (DOM bereit nach ${tDom} ms)`);
    check('Kasten erscheint und zeigt die Zusammenfassung', p.host && p.state === 'done', `Status "${p.status}"`);
    check('Kasten sitzt oben in der rechten Spalte', p.parent === 'secondary' && p.first && p.place === 'column', `parent=${p.parent} first=${p.first} place=${p.place}`);
    check('Kasten ist sichtbar und rechts vom Video', p.rect.w > 250 && p.rect.h > 80 && p.rect.x > p.vw / 2, JSON.stringify(p.rect) + ` bei Fensterbreite ${p.vw}`);
    check('Styles im Shadow-Root wirken', p.styled === '12px', p.styled);
    check('Zeitstempel sind Schaltflaechen', p.ts >= 3, `${p.ts} Zeitstempel, ${p.li} Listenpunkte`);
    check('Zeitstempel stehen am Ende der Kernpunkte', p.tsAtEnd >= 3 && p.tsAtEnd >= p.li - 1, `${p.tsAtEnd} von ${p.li}`);
    check('kein rohes Markdown im Text', !/\*\*/.test(p.text), p.text.slice(0, 90).replace(/\n/g, ' / '));
    check('"neu erzeugen" ist aktiv', p.regenDisabled === false);
    await sleep(1500);
    await shot('1-cache');

    // Kurzfassung steht sofort da, Kernpunkte hinter einem Knopf; Textbereich begrenzt, ohne Scrollbalken
    const BODY = `chrome.dom.openOrClosedShadowRoot(document.getElementById('ytw-host')).querySelector('.body')`;
    check('Kurzfassung steht sofort da, ohne Abschnittsnamen davor', p.text.length > 150 && !/^(Kurzfassung|Summary)\b/.test(p.text) && !/Sponsor/.test(p.text), p.text.slice(0, 70).replace(/\n/g, ' / '));
    check('Kernpunkte sind zunaechst zugeklappt, Knopf vorhanden', !!p.fold && p.fold.hidden && !p.fold.shown && p.fold.label === 'Kernpunkte anzeigen' && p.li >= 3, JSON.stringify(p.fold));
    check('kein Scrollbalken', p.scroll.bar === 0, `${p.scroll.bar} px`);
    check('Abstand zwischen Kasten und der Spalte darunter', p.gapBelow >= 12, `${p.gapBelow} px`);
    await extEval(`${BODY}.querySelector('.fold-toggle').click()`);
    await sleep(200);
    let q = await probe();
    check('Klick zeigt die Kernpunkte, Knopf wechselt die Beschriftung', q.fold.shown && !q.fold.hidden && q.fold.label === 'Kernpunkte ausblenden', JSON.stringify(q.fold));
    check('aufgeklappt hoechstens 60 % der Fensterhoehe plus Kopfzeile', q.scroll.client <= 0.6 * 900 + 1 && q.rect.h < 0.6 * 900 + 80, `Textbereich ${q.scroll.client} px von ${q.scroll.full} px, Kasten ${q.rect.h} px`);
    check('Text laeuft ueber: unten wird ausgeblendet statt hart abgeschnitten', q.scroll.full > q.scroll.client && q.scroll.below && !q.scroll.above && q.scroll.bar === 0, JSON.stringify(q.scroll));
    await shot('1-kernpunkte-offen');
    await page.mouse.move(q.rect.x + q.rect.w / 2, q.rect.y + q.rect.h / 2);
    await page.mouse.wheel({ deltaY: 5000 });
    await sleep(400);
    q = await probe();
    check('Mausrad scrollt im Kasten bis ans Ende', q.scroll.top > 0 && q.scroll.above && !q.scroll.below, JSON.stringify(q.scroll));

    // Zeitstempel anklicken
    const v0 = await videoState();
    const target = await extEval(`(() => { const r = chrome.dom.openOrClosedShadowRoot(document.getElementById('ytw-host'));
      const b = [...r.querySelectorAll('button.ts')].find((x) => Number(x.dataset.t) >= 30); b.click(); return { t: Number(b.dataset.t), label: b.textContent }; })()`);
    await sleep(800);
    const v1 = await videoState();
    check(`Klick auf [${target.label}] springt im Video`, v1 && !v1.ad && Math.abs(v1.t - target.t) < 3, `vorher ${JSON.stringify(v0)}, nachher ${JSON.stringify(v1)}`);

    // Tasten in der Box duerfen den Player nicht steuern
    const before = await videoState();
    await extEval(`chrome.dom.openOrClosedShadowRoot(document.getElementById('ytw-host')).querySelector('.toggle').focus()`);
    await page.keyboard.press('Space');
    await sleep(500);
    const after = await videoState();
    const pc = await probe();
    check('Leertaste auf dem Einklapp-Knopf klappt die Box ein', pc.collapsed === true);
    check('... und schaltet dabei nicht Play/Pause um', before && after && before.paused === after.paused, `paused vorher ${before?.paused}, nachher ${after?.paused}`);
    await page.keyboard.press('Space');
    await sleep(300);
    check('zweite Leertaste klappt wieder aus', (await probe()).collapsed === false);
    await extEval(`${BODY}.querySelector('.fold-toggle').click()`);
    await sleep(200);
    const pf = await probe();
    check('zweiter Klick klappt die Kernpunkte wieder zu', pf.fold.hidden === true && pf.fold.label === 'Kernpunkte anzeigen' && !pf.scroll.below);
  }

  // ---------- 2. Wechsel innerhalb von YouTube ----------
  if (want('spa')) {
    console.log('\n== 2. Wechsel zum naechsten Video ohne Neuladen');
    if (!page.url().includes('/watch')) { await gotoWatch('W8Dl-TS9H2c'); await watch(Date.now(), (x) => x.host && x.state === 'done', 20000, 'Vorlauf'); }
    await page.evaluate(() => { window.__ytwMarker = 'bleibt'; });
    const next = await page.evaluate(() => {
      const cur = new URLSearchParams(location.search).get('v');
      const links = [...document.querySelectorAll('ytd-watch-flexy #secondary a[href^="/watch?v="]')];
      const a = links.find((x) => { const v = new URL(x.href).searchParams.get('v'); return v && v !== cur && !x.href.includes('list='); });
      if (!a) return null;
      a.click();
      return new URL(a.href).searchParams.get('v');
    });
    const t0 = Date.now();
    check('Link in der Empfehlungsspalte gefunden und geklickt', !!next, String(next));
    if (next) {
      const gone = await watch(t0, (x) => !x.host, 5000, 'alter Kasten');
      const tGone = Date.now() - t0;
      check('alter Kasten verschwindet sofort', !gone.p.host && tGone < 500, `${tGone} ms`);
      const pend = await watch(t0, (x) => x.host, 15000, 'neuer Kasten');
      const tPend = Date.now() - t0;
      check('neuer Kasten erscheint rund 1 s nach dem Wechsel', pend.p.host && tPend > 900 && tPend < 2500, `${tPend} ms, Zustand ${pend.p.state}, Text "${(pend.p.text || '').slice(0, 60)}"`);
      await shot('2-pending');
      const fin = await watch(t0, (x) => x.host && (x.state === 'done' || x.state === 'error'), 240000, `Video ${next}`);
      check('Zusammenfassung des neuen Videos kommt an', fin.p.host && fin.p.state === 'done', `${Math.round((Date.now() - t0) / 1000)} s, Zustand ${fin.p.state}: ${(fin.p.text || '').slice(0, 100).replace(/\n/g, ' / ')}`);
      check('Seite wurde dabei nicht neu geladen', (await page.evaluate(() => window.__ytwMarker)) === 'bleibt');
      check('Adresse zeigt das neue Video', page.url().includes(next), page.url());
      check('Kasten sitzt weiter oben in der rechten Spalte', fin.p.parent === 'secondary' && fin.p.first, `parent=${fin.p.parent} first=${fin.p.first}`);
      await shot('2-done');

      // zurueck (popstate): das erste Video kommt sofort aus dem Cache
      const tb = Date.now();
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      const back = await watch(tb, (x) => x.host && x.state === 'done', 15000, 'Zurueck-Taste');
      check('Zurueck: Kasten wechselt mit, sofort aus dem Cache', back.p.host && back.p.state === 'done' && Date.now() - tb < 5000, `${Date.now() - tb} ms`);
    }
  }

  // ---------- 3. neu erzeugen ----------
  if (want('regen')) {
    console.log('\n== 3. Knopf "neu erzeugen"');
    if (!page.url().includes('W8Dl-TS9H2c')) await gotoWatch('W8Dl-TS9H2c');
    await watch(Date.now(), (x) => x.host && x.state === 'done', 20000, 'Vorlauf');
    const createdBefore = JSON.parse(fs.readFileSync(path.join(CACHE, 'W8Dl-TS9H2c.json'), 'utf8')).created;
    await extEval(`chrome.dom.openOrClosedShadowRoot(document.getElementById('ytw-host')).querySelector('.btn').click()`);
    const t0 = Date.now();
    const pend = await watch(t0, (x) => x.host && x.state === 'pending', 3000, 'nach Klick');
    check('Klick schaltet auf "wird zusammengefasst", Knopf gesperrt', pend.p.state === 'pending' && pend.p.regenDisabled === true, (pend.p.text || '').slice(0, 60));
    const fin = await watch(t0, (x) => x.host && (x.state === 'done' || x.state === 'error'), 120000, 'neu erzeugen');
    const createdAfter = JSON.parse(fs.readFileSync(path.join(CACHE, 'W8Dl-TS9H2c.json'), 'utf8')).created;
    check('neue Zusammenfassung im Kasten und im Cache', fin.p.state === 'done' && createdAfter !== createdBefore, `${Math.round((Date.now() - t0) / 1000)} s; ${fin.p.text.slice(0, 80).replace(/\n/g, ' / ')}`);
    check('Dienst hat "Neu erzeugen" gesehen', /Neu erzeugen angefragt: W8Dl-TS9H2c/.test(serviceLog));
  }

  // ---------- 4. Fehlerfaelle ----------
  if (want('errors')) {
    console.log('\n== 4. Keine Untertitel / Dienst aus');
    // Fehlermarke "keine Untertitel" fuer ein echtes Video hinlegen (hat Vorrang vor dem Cache)
    fs.writeFileSync(path.join(CACHE, 'jNQXAC9IVRw.err'), JSON.stringify({ id: 'jNQXAC9IVRw', code: 'no_subtitles', message: 'Keine Untertitel in der Originalsprache gefunden.', created: new Date().toISOString() }));
    let t0 = await gotoWatch('jNQXAC9IVRw');
    let r = await watch(t0, (x) => x.host && x.state !== 'pending', 20000, 'keine Untertitel');
    check('"keine Untertitel" steht klar im Kasten', r.p.state === 'error' && /keine Untertitel/.test(r.p.text), r.p.text.replace(/\n/g, ' / '));
    check('"neu erzeugen" bleibt dabei moeglich', r.p.regenDisabled === false);
    await shot('4-keine-untertitel');
    fs.unlinkSync(path.join(CACHE, 'jNQXAC9IVRw.err'));

    stopService();
    await sleep(500);
    t0 = await gotoWatch('2ZU3j4GQ4K8');
    r = await watch(t0, (x) => x.host && x.state === 'offline', 20000, 'Dienst aus');
    check('Dienst aus: steht klar im Kasten, mit Startbefehl', r.p.state === 'offline' && /Dienst läuft nicht/.test(r.p.text) && /start\.cmd -Serve/.test(r.p.text), (r.p.text || '').replace(/\n/g, ' / '));
    await shot('4-offline');
    await startService();
    const t1 = Date.now();
    r = await watch(t1, (x) => x.host && x.state === 'done', 15000, 'Dienst wieder da');
    check('Dienst wieder gestartet: Kasten erholt sich von selbst', r.p.state === 'done', `${Date.now() - t1} ms nach dem Start`);
  }

  // ---------- 5. Layout ----------
  if (want('layout')) {
    console.log('\n== 5. Schmales Fenster und dunkles Design');
    if (!page.url().includes('/watch')) { await gotoWatch('2ZU3j4GQ4K8'); await watch(Date.now(), (x) => x.host && x.state === 'done', 20000, 'Vorlauf'); }
    await page.setViewport({ width: 900, height: 900 });
    let r = await watch(Date.now(), (x) => x.host && x.place === 'below', 6000, 'schmal');
    check('schmales Fenster: Kasten wandert unter das Video', r.p.place === 'below' && r.p.parent === 'below' && r.p.rect.w > 300, `place=${r.p.place} parent=${r.p.parent} ${JSON.stringify(r.p.rect)}`);
    await shot('5-schmal');
    await page.setViewport({ width: 1600, height: 900 });
    r = await watch(Date.now(), (x) => x.host && x.place === 'column', 6000, 'wieder breit');
    check('breites Fenster: Kasten wandert zurueck in die Spalte', r.p.place === 'column' && r.p.state === 'done' && r.p.ts > 0, `place=${r.p.place}, Inhalt erhalten: ${r.p.ts} Zeitstempel`);
    await page.evaluate(() => document.documentElement.setAttribute('dark', ''));
    r = await watch(Date.now(), (x) => x.host && x.dark, 4000, 'dunkel');
    check('dunkles Design wird uebernommen', r.p.dark === true);
    await shot('5-dunkel');
    await page.evaluate(() => document.documentElement.removeAttribute('dark'));

    // Startseite: kein Kasten
    await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    check('Startseite: kein Kasten', (await probe()).host === false);
  }

  // ---------- Auswertung Netzwerk ----------
  console.log('\n== Was Chrome an den Dienst geschickt hat (Service-Worker)');
  const kinds = new Map();
  for (const n of netLog) {
    const key = n.failed ? `FEHLGESCHLAGEN ${n.method || ''} ${n.failed} ${n.blocked} ${n.cors}` : `${n.method} Origin=${n.origin} Sec-Fetch-Site=${n.site}`;
    kinds.set(key, (kinds.get(key) || 0) + 1);
  }
  for (const [k, c] of kinds) console.log(`      ${c} x ${k}`);
  check('keine CORS-Voranfrage (OPTIONS) noetig', ![...kinds.keys()].some((k) => k.startsWith('OPTIONS')));
  check('Dienst hat keine Anfrage der Erweiterung abgelehnt', !/Abgelehnt/.test(serviceLog), (serviceLog.match(/Abgelehnt.*/g) || []).slice(0, 3).join(' | '));
  if (pageErrors.length) console.log('      Konsole: ' + pageErrors.slice(0, 5).join(' | '));
  check('keine Fehler der Erweiterung in der Seitenkonsole', pageErrors.length === 0);
}

try {
  await main();
} catch (e) {
  failed++;
  console.log('ABBRUCH: ' + (e.stack || e));
  try { await shot('abbruch'); } catch {}
} finally {
  try { await browser?.close(); } catch {}
  stopService();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  console.log(`\nFehlgeschlagen: ${failed}`);
  process.exit(failed ? 1 : 0);
}
