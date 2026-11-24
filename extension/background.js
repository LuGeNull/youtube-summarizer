// yt-watcher – Service-Worker: spricht mit dem lokalen Dienst.
// Kein Zustand, keine lang laufenden Anfragen (MV3-Worker werden jederzeit beendet).
'use strict';

const SERVICE = 'http://localhost:47816';
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Liefert immer ein Objekt mit String-Feld "state", wirft nie.
async function call(path, method, videoId, force) {
  if (typeof videoId !== 'string' || !ID_RE.test(videoId)) {
    return { state: 'error', code: 'bad_id' };
  }
  let status;
  let text;
  try {
    const res = await fetch(`${SERVICE}${path}?v=${videoId}${force ? '&force=1' : ''}`, {
      method,
      headers: { 'X-YtWatcher': '1' },
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(8000),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    // Dienst läuft nicht oder Zeitüberschreitung
    return { state: 'offline' };
  }
  try {
    const data = JSON.parse(text);
    // Der Dienst antwortet bei jedem Statuscode mit JSON samt "state": unverändert durchreichen
    if (data && typeof data === 'object' && typeof data.state === 'string') return data;
  } catch (e) {
    // kein JSON: unten als bad_response melden
  }
  return { state: 'error', code: 'bad_response', message: `HTTP ${status}` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Nur Nachrichten der eigenen Erweiterung annehmen
  if (sender.id !== chrome.runtime.id || !msg) return;
  if (msg.type === 'summary') {
    // Zusammenfassung: Nachfragen (GET) stößt die Arbeit schon an, force erzeugt neu
    const force = msg.force === true;
    call('/summary', force ? 'POST' : 'GET', msg.videoId, force).then(sendResponse);
    return true; // Antwort folgt asynchron
  }
  if (msg.type === 'assess') {
    // Einordnung: GET schaut nur nach, erst POST (Klick auf den Knopf) startet sie
    const force = msg.mode === 'force';
    const post = force || msg.mode === 'start';
    call('/assess', post ? 'POST' : 'GET', msg.videoId, force).then(sendResponse);
    return true;
  }
});
