// yt-watcher – Service-Worker: holt die Zusammenfassung beim lokalen Dienst ab.
// Kein Zustand, keine lang laufenden Anfragen (MV3-Worker werden jederzeit beendet).
'use strict';

const SERVICE_URL = 'http://localhost:47816/summary';
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Liefert immer ein Objekt mit String-Feld "state", wirft nie.
async function fetchSummary(videoId, force) {
  if (typeof videoId !== 'string' || !ID_RE.test(videoId)) {
    return { state: 'error', code: 'bad_id' };
  }
  let status;
  let text;
  try {
    const res = await fetch(`${SERVICE_URL}?v=${videoId}${force ? '&force=1' : ''}`, {
      method: force ? 'POST' : 'GET',
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
  // Nur Nachrichten der eigenen Erweiterung und nur den Typ "summary" annehmen
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'summary') return;
  fetchSummary(msg.videoId, msg.force === true).then(sendResponse);
  return true; // Antwort folgt asynchron
});
