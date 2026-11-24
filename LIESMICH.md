# yt-watcher

Zeigt zu jedem YouTube-Video, das in Chrome geöffnet wird, eine Zusammenfassung rechts neben dem
Video. Untertitel holt `yt-dlp`, die Zusammenfassung schreibt die Claude-CLI (Haiku, `--effort low`).
Alles läuft lokal: Die Chrome-Erweiterung fragt einen kleinen Dienst auf `localhost`.

## Starten

```
.\start.cmd -Serve -Background    # ohne Fenster, Meldungen in dienst.log
.\start.cmd -Stop                 # beendet den Dienst
.\start.cmd -Serve                # im Fenster, zum Zusehen (Beenden mit Strg+C)
```

Im Autostart liegt eine Verknüpfung `yt-watcher Dienst`, die den Dienst bei der Anmeldung ohne
Fenster startet (`Win+R`, `shell:startup`; zum Abschalten die Verknüpfung löschen). Der Dienst
taucht dann nicht in der Taskleiste auf; was er tut, steht in `dienst.log`
(mitlesen: `Get-Content dienst.log -Wait -Tail 20`).

Erweiterung einmalig laden: `chrome://extensions` → Entwicklermodus an → „Entpackte Erweiterung
laden“ → Ordner `extension\` wählen. Nach Änderungen an `extension\` dort auf „Neu laden“ klicken
und offene YouTube-Tabs mit F5 neu laden.

Prüfen, ob der Dienst läuft: <http://localhost:47816/health> im Browser öffnen.

## Was der Kasten zeigt

| Anzeige | Bedeutung |
|---|---|
| „Wird zusammengefasst … 12 s“ | Dienst arbeitet (meist 12 bis 20 s). Erscheint 1 s nach dem Öffnen, nur im sichtbaren Tab. |
| Kurzfassung | Steht immer da. Aus dem Cache kommt sie sofort. |
| „Kernpunkte anzeigen“ | Klappt die Liste auf. Am Ende jedes Punktes steht der Zeitstempel; ein Klick darauf springt im Video. Bei jedem Video zunächst zugeklappt. |
| „Einordnen“ | Nur auf Klick: Fable 5.2 beurteilt ohne Internet, wie belastbar das Video ist (Gesamturteil, bis zu 6 Behauptungen mit Urteil, Schwächen der Argumentation). Dauert 30 bis 60 s, wird gespeichert und heißt danach „Einordnung anzeigen“. |
| „Dieses Video hat keine Untertitel“ | Weder automatische Untertitel in Originalsprache noch hochgeladene. |
| „Der lokale Dienst läuft nicht“ | `start.cmd -Serve` starten; der Kasten erholt sich innerhalb von 5 s von selbst. |
| „neu erzeugen“ | Übergeht den Cache für dieses Video. Auch der Weg, einen Fehler sofort zu wiederholen. |

Die Einordnung stützt sich nur auf das Wissen des Modells. Bei aktuellen Ereignissen, neuen
Produkten und genauen Zahlen schreibt es deshalb „nicht prüfbar“ statt zu raten; eine Recherche
im Internet ersetzt sie nicht. Modell und Gründlichkeit stehen im Skript (`$AssessModel`,
`$AssessEffort`).

Der Textbereich ist höchstens 60 % der Fensterhöhe hoch und lässt sich mit dem Mausrad scrollen.
Einen Scrollbalken gibt es nicht; stattdessen blendet der Text an der Kante aus, an der es
weitergeht. Im schmalen Fenster (einspaltiges YouTube) sitzt der Kasten direkt unter dem Video.
Shorts werden nicht zusammengefasst, Werbung und Sponsoren kommen in der Zusammenfassung nicht vor.

## Dateien

| Pfad | Zweck |
|---|---|
| `yt-watcher.ps1` | Skript, Fassung 12. Einstellungen stehen oben im Block „Einstellungen“. |
| `start.cmd` | Starter (umgeht die Ausführungsrichtlinie nur für diesen einen Lauf). |
| `extension\` | Chrome-Erweiterung (Manifest V3): `background.js` spricht mit dem Dienst, `content.js` baut den Kasten. |
| `cache\<VideoId>.json` | fertige Zusammenfassung (Titel, Sprache, Text, Datum, Modell). Löschen = Video gilt als neu. |
| `cache\<VideoId>.err` | Fehlermarke des letzten Versuchs, gilt 30 Minuten, dann wird neu versucht. |
| `cache\<VideoId>.assess.json` | gespeicherte Einordnung (dazu `.assess.err` als Fehlermarke). |
| `dienst.log` | Meldungen des Dienstes. Ab 1 MB wird beim nächsten Start neu begonnen, die alte Datei heißt dann `dienst.log.alt`. |
| `tests\` | Tests für Dienst und Browser, siehe unten. |
| `zusammenfassungen.md` | Ausgabe des alten Beobachters. Der Dienst schreibt dort nichts mehr hinein (umschaltbar mit `$ArchiveToOutputFile = $true`). |

## Betriebsarten des Skripts

| Aufruf | Wirkung |
|---|---|
| `.\start.cmd -Serve` | Dienst für die Erweiterung; mit `-Background` ohne Fenster. |
| `.\start.cmd -Stop` | Beendet einen laufenden Dienst. |
| `.\start.cmd -Once <Adresse oder Video-ID>` | Fasst ein Video zusammen, ignoriert den Cache, schreibt in den Cache. |
| `.\start.cmd` | Alter Beobachter: liest das aktive Browserfenster aus und schreibt nach `zusammenfassungen.md` (Notepad++). Nicht gleichzeitig mit `-Serve` laufen lassen. |
| `.\start.cmd -TestUrl` | Zeigt nur, welches Video der Beobachter erkennt. |

## Dienst

- `GET /health` → Fassung, Modell, Auslastung.
- `GET /summary?v=<ID>` → `{"state":"done",…}`, `{"state":"pending","phase":"queued"|"running",…}` oder
  `{"state":"error","code":…,"message":…}`. Die erste Anfrage für ein unbekanntes Video startet die Arbeit.
- `POST /summary?v=<ID>&force=1` → erzeugt neu.
- `GET /assess?v=<ID>` → Einordnung: `done` (mit `text`), `pending`, `error` oder `none`. Startet nichts.
- `POST /assess?v=<ID>` → startet die Einordnung; mit `&force=1` auch trotz Cache oder Fehlermarke.

Es läuft immer nur ein Video, weitere warten (höchstens 8). Ein wartendes Video, nach dem 20 s
niemand mehr gefragt hat, wird verworfen: Beim Durchklicken wird nur zusammengefasst, was noch
offen ist. Die Arbeit macht ein Kindprozess desselben Skripts (`-Work`), seine Meldungen
erscheinen im Dienst-Fenster.

### Schutz

Jede Webseite kann Anfragen an `localhost` schicken, deshalb:

- `/summary` verlangt die Kopfzeile `X-YtWatcher: 1`. Eine Webseite kann sie nur nach einer
  CORS-Voranfrage senden, und der Dienst sendet nie CORS-Kopfzeilen. Das ist der eigentliche
  Schutz: Chrome schickt bei `GET` aus der Erweiterung gar keinen `Origin` mit (gemessen).
- Trägt eine Anfrage einen `Origin`, muss es die eigene Erweiterung sein. Deren ID ist über
  `"key"` in `manifest.json` festgelegt und steht als `$ExtensionId` im Skript.
- Der Dienst hört nur auf den Namen `localhost`; `127.0.0.1` oder fremde Host-Namen weist er ab.
- Video-IDs müssen genau 11 Zeichen aus `A-Z a-z 0-9 _ -` sein.
- Das Transkript ist fremder Text: Die CLI läuft ohne Werkzeuge (`--tools ""`,
  `--disallowedTools "*"`, `--strict-mcp-config`), in einem leeren Ordner, und bekommt die
  Anweisungen getrennt vom Transkript als System-Prompt. Die Erweiterung setzt die Zusammenfassung
  nur als Text ein, nie als HTML.

## Tests

```
pwsh -File tests\test-dienst.ps1              # Dienst muss laufen; kostet keine Claude-Aufrufe
pwsh -File tests\test-dienst.ps1 -Part live   # neues Video, nicht vorhandenes Video
pwsh -File tests\test-dienst.ps1 -Part force  # neu erzeugen, Warteschlange

cd tests; npm install; node e2e.mjs           # Dienst vorher beenden, der Test startet ihn selbst
```

`e2e.mjs` steuert das installierte Chrome (stumm, unsichtbar, eigenes Wegwerf-Profil), lädt die
Erweiterung und prüft auf echten YouTube-Seiten: Kasten erscheint, Wechsel ohne Neuladen,
Zeitstempel, „neu erzeugen“, keine Untertitel, Dienst aus und wieder an, schmales Fenster, dunkles
Design. Er löst dabei zwei bis drei echte Zusammenfassungen aus.

## Wenn etwas nicht geht

- **Kasten fehlt ganz:** Erweiterung in `chrome://extensions` aktiv? Nach einem Neuladen der
  Erweiterung den Tab mit F5 neu laden. Ändert YouTube sein Seitengerüst, schwebt der Kasten nach
  8 s oben rechts statt in der Spalte; dann `place()` in `content.js` anpassen (`node e2e.mjs`
  zeigt, was nicht mehr passt).
- **„Der lokale Dienst hat die Anfrage abgelehnt“:** Im Dienst-Fenster steht der Grund. Meist
  passt `$ExtensionId` nicht mehr zum `"key"` im Manifest.
- **„Untertitel konnten nicht abgerufen werden“:** Die Meldung von yt-dlp steht darunter. Bei
  HTTP 429 hat YouTube gedrosselt, später „neu erzeugen“. Sonst yt-dlp aktualisieren:
  `winget upgrade --id yt-dlp.yt-dlp -e`.
- **yt-dlp warnt vor fehlender JavaScript-Laufzeit:** Untertitel gehen derzeit auch ohne. Falls
  das einmal nicht mehr reicht: `winget install --id DenoLand.Deno -e`.
- **Port belegt:** `$Port` im Skript und die Zahl in `extension\background.js` und
  `extension\manifest.json` gemeinsam ändern.

## Voraussetzungen

Windows mit Windows PowerShell 5.1, Chrome, [yt-dlp](https://github.com/yt-dlp/yt-dlp)
(`winget install --id yt-dlp.yt-dlp -e`) und die angemeldete Claude-CLI (`claude --version` muss
laufen). Für die Tests zusätzlich PowerShell 7 und Node.js.

## Lizenz

MIT, siehe `LICENSE`.

## Fallen beim Ändern

- **Nur ASCII in `yt-watcher.ps1`.** Windows PowerShell 5.1 liest Dateien ohne BOM als ANSI,
  Umlaute zerbrechen Zeichenketten. (Die Dateien der Erweiterung sind UTF-8, dort sind Umlaute in Ordnung.)
- **Keine übersetzten Untertitel anfragen**, YouTube antwortet darauf schnell mit HTTP 429. Nur
  `<Sprache>-orig` oder vom Kanal hochgeladene Spuren.
- **Automatisch synchronisierte Videos** haben mehrere `xx-orig`-Spuren; gewählt wird über
  `%(language)s`. Nennt YouTube keine Sprache, gilt die Reihenfolge aus `$SubLangs`.
- **yt-dlp meldet ein nicht abrufbares Video nicht als Fehler** (wegen
  `--ignore-no-formats-error`), sondern mit dem Platzhalter-Titel `youtube video #<ID>`. Das Skript
  erkennt das daran.
- **Anweisungen nie zusammen mit dem Transkript in die Eingabe schreiben.** Das Modell hielt dann
  gelegentlich alles für fremden Text und verweigerte. Liefert es doch einmal etwas ohne
  Zeitstempel, versucht das Skript es genau ein zweites Mal.
- **Video-IDs unterscheiden Groß und Klein, Windows-Dateinamen nicht.** Deshalb steht die ID in
  der Cache-Datei und wird beim Lesen verglichen. Im Skript immer `-ceq`/`-cmatch` für IDs.
- **Video-IDs können mit `-` beginnen.** Der Dienst gibt sie dem Arbeitsprozess deshalb über die
  Umgebungsvariable `YTWATCH_WORK_ID`, nicht als Argument.
- **Die Erweiterung erkennt Kurzfassung und Kernpunkte am Aufbau, nicht an den Wörtern:** Text
  vor der ersten Aufzählung ist die Kurzfassung, ab der Aufzählung sind es die Kernpunkte. Die
  Abschnittsnamen schreibt das Modell in der Sprache des Videos („Summary“, „Key points“); als das
  Skript deutsche Namen bei englischem Inhalt verlangte, mischte das Modell gelegentlich die Sprachen.
- **Außenabstände am Host-Element des Kastens wirken nicht**, YouTubes CSS setzt sie auf 0. Der
  Abstand nach unten ist deshalb ein eigenes Element im Shadow-Root (`.gap`).
- **In der Erweiterung nie `innerHTML`.** YouTube erzwingt Trusted Types, und die Zusammenfassung
  ist Modellausgabe auf Basis fremden Textes.
