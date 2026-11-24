# Prueft den laufenden Dienst (vorher .\start.cmd -Serve). Braucht PowerShell 7:
#
#   pwsh -File tests\test-dienst.ps1                 Antworten und Schutzregeln, kostet keine Claude-Aufrufe
#   pwsh -File tests\test-dienst.ps1 -Part live      neues Video, nicht vorhandenes Video (1 Aufruf)
#   pwsh -File tests\test-dienst.ps1 -Part force     neu erzeugen und Warteschlange (2 Aufrufe)
param([ValidateSet('static', 'live', 'force')][string]$Part = 'static')
$cache = Join-Path (Split-Path $PSScriptRoot -Parent) 'cache'
$base = 'http://localhost:47816'
$ext  = 'chrome-extension://agmcclmiochojehoenhbneknhcemjlmj'
$script:fail = 0

function Req([string]$Method, [string]$Url, [hashtable]$Headers = @{}) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-WebRequest -Method $Method -Uri $Url -Headers $Headers -SkipHttpErrorCheck -TimeoutSec 15
    $sw.Stop()
    $json = $null
    try { $json = $r.Content | ConvertFrom-Json } catch { }
    [pscustomobject]@{ Status = [int]$r.StatusCode; Json = $json; Ms = $sw.ElapsedMilliseconds; Headers = $r.Headers; Raw = $r.Content }
}
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    if (-not $Ok) { $script:fail++ }
    '{0}  {1}{2}' -f $(if ($Ok) { 'OK  ' } else { 'FAIL' }), $Name, $(if ($Detail) { "  [$Detail]" } else { '' })
}
$h = @{ 'X-YtWatcher' = '1' }

if ($Part -eq 'static') {
    $r = Req GET "$base/health"
    Check 'health 200, Fassung 11' ($r.Status -eq 200 -and $r.Json.version -eq '11' -and $r.Json.state -eq 'ok') $r.Raw
    Check 'health ohne CORS-Kopfzeilen' (-not ($r.Headers.Keys -match '^Access-Control'))

    $r = Req GET "$base/summary?v=W8Dl-TS9H2c"
    Check 'summary ohne X-YtWatcher -> 403' ($r.Status -eq 403 -and $r.Json.code -eq 'forbidden') $r.Raw

    foreach ($bad in @('abc', 'W8Dl-TS9H2cX', 'W8Dl-TS9H2%0A', 'W8Dl-TS9H2c%0A', 'W8Dl%2FTS9H2c', '..%2F..%2Fx.json', '')) {
        $r = Req GET "$base/summary?v=$bad" $h
        Check "ungueltige ID '$bad' -> 400" ($r.Status -eq 400 -and $r.Json.code -eq 'bad_id') "$($r.Status) $($r.Raw)"
    }
    $r = Req GET "$base/summary" $h
    Check 'ID fehlt -> 400' ($r.Status -eq 400)

    $r = Req GET "$base/summary?v=W8Dl-TS9H2c" ($h + @{ Origin = 'https://evil.example' })
    Check 'fremder Origin (Webseite) -> 403' ($r.Status -eq 403 -and $r.Json.code -eq 'forbidden') $r.Raw
    $r = Req GET "$base/summary?v=W8Dl-TS9H2c" ($h + @{ Origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    Check 'fremder Origin (andere Erweiterung) -> 403' ($r.Status -eq 403)
    $r = Req GET "$base/summary?v=W8Dl-TS9H2c" ($h + @{ Origin = 'null' })
    Check "Origin 'null' -> 403" ($r.Status -eq 403)
    $r = Req GET "$base/health" @{ Origin = 'https://www.youtube.com' }
    Check 'health mit fremdem Origin -> 403' ($r.Status -eq 403)

    $r = Req GET "$base/summary?v=W8Dl-TS9H2c" ($h + @{ Origin = $ext })
    Check 'eigene Erweiterung, Cache-Treffer -> done' ($r.Status -eq 200 -and $r.Json.state -eq 'done' -and $r.Json.summary.Length -gt 200) "$($r.Ms) ms, Titel: $($r.Json.title)"
    Check 'done ohne CORS-Kopfzeilen' (-not ($r.Headers.Keys -match '^Access-Control'))
    Check 'Content-Type JSON utf-8' ("$($r.Headers['Content-Type'])" -match 'application/json; charset=utf-8')
    $r = Req GET "$base/summary?v=pyDPACni7SY" $h
    Check 'Umlaute im Cache kommen heil an' ($r.Json.state -eq 'done' -and $r.Json.summary -match '[äöüÄÖÜß]') "$($r.Ms) ms, Titel: $($r.Json.title)"

    $r = Req OPTIONS "$base/summary?v=W8Dl-TS9H2c" @{ Origin = 'https://evil.example'; 'Access-Control-Request-Method' = 'GET'; 'Access-Control-Request-Headers' = 'x-ytwatcher' }
    Check 'CORS-Voranfrage einer Webseite wird nicht erlaubt' ($r.Status -ge 400 -and -not ($r.Headers.Keys -match '^Access-Control')) "$($r.Status)"
    $r = Req OPTIONS "$base/summary?v=W8Dl-TS9H2c" $h
    Check 'OPTIONS ohne Origin -> 405' ($r.Status -eq 405)

    $r = Req GET "$base/summary?v=W8Dl-TS9H2c&force=1" $h
    Check 'force=1 mit GET -> 405' ($r.Status -eq 405) $r.Raw
    $r = Req POST "$base/summary?v=W8Dl-TS9H2c&force=1"
    Check 'force ohne Kopfzeile -> 403' ($r.Status -eq 403)
    $r = Req GET "$base/irgendwas" $h
    Check 'unbekannter Pfad -> 404' ($r.Status -eq 404)
    $r = Req DELETE "$base/summary?v=W8Dl-TS9H2c" $h
    Check 'DELETE -> 405' ($r.Status -eq 405)

    $r = Req GET 'http://127.0.0.1:47816/health'
    Check 'anderer Host-Name (127.0.0.1) wird abgewiesen' ($r.Status -eq 400) "$($r.Status)"
    $r = Req GET "$base/health" @{ Host = 'evil.example:47816' }
    Check 'gefaelschter Host (DNS-Rebinding) wird abgewiesen' ($r.Status -eq 400) "$($r.Status)"

    $r = Req GET "$base/health"
    Check 'nach allem: nichts gestartet, Warteschlange leer' ($r.Json.busy -eq $false -and $r.Json.queued -eq 0) $r.Raw
}

function Wait-State([string]$Id, [int]$MaxSec = 150) {
    # Fragt wie die Erweiterung alle 2 s nach, bis der Zustand nicht mehr 'pending' ist
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $seen = New-Object System.Collections.Generic.List[string]
    while ($sw.Elapsed.TotalSeconds -lt $MaxSec) {
        $r = Req GET "$base/summary?v=$Id" $h
        $tag = if ($r.Json.state -eq 'pending') { "$($r.Json.phase)$(if ($r.Json.position) { '#' + $r.Json.position })" } else { $r.Json.state }
        if ($seen.Count -eq 0 -or $seen[$seen.Count - 1] -ne $tag) { $seen.Add($tag) }
        if ($r.Json.state -ne 'pending') { return [pscustomobject]@{ Json = $r.Json; Sec = [math]::Round($sw.Elapsed.TotalSeconds, 1); Seen = ($seen -join ' > ') } }
        Start-Sleep -Seconds 2
    }
    return [pscustomobject]@{ Json = $null; Sec = $MaxSec; Seen = ($seen -join ' > ') + ' > ZEITLIMIT' }
}

if ($Part -eq 'live') {
    # Neues Video: pending -> done
    $id = 'jNQXAC9IVRw'
    Remove-Item (Join-Path $cache "$id.*"), (Join-Path $cache 'aaaaaaaaaaa.err'), (Join-Path $cache 'w8dl-ts9h2c.err') -ErrorAction SilentlyContinue
    $w = Wait-State $id
    Check "neues Video $id" ($w.Json.state -in @('done', 'error')) "$($w.Sec) s, $($w.Seen), $($w.Json.code) $($w.Json.message)"
    if ($w.Json.state -eq 'done') { "---`n$($w.Json.title)`n$($w.Json.summary)`n---" }
    $r = Req GET "$base/summary?v=$id" $h
    Check 'danach sofort aus dem Cache' ($r.Json.state -eq $w.Json.state) "$($r.Ms) ms"

    # Nicht vorhandenes Video: Fehler von yt-dlp
    $w = Wait-State 'aaaaaaaaaaa'
    Check 'nicht vorhandenes Video -> error ytdlp' ($w.Json.state -eq 'error' -and $w.Json.code -eq 'ytdlp') "$($w.Sec) s, $($w.Seen), $($w.Json.message)"
    $r = Req GET "$base/summary?v=aaaaaaaaaaa" $h
    Check 'Fehlermarke gilt weiter, kein neuer Versuch' ($r.Json.state -eq 'error' -and (Req GET "$base/health").Json.busy -eq $false) "$($r.Ms) ms"

    # Gleiche ID in anderer Schreibweise darf nicht den Cache-Eintrag liefern (Dateisystem ignoriert Gross/Klein)
    $r = Req GET "$base/summary?v=w8dl-ts9h2c" $h
    Check 'andere Schreibweise ist ein anderes Video' ($r.Json.state -eq 'pending') $r.Raw
    $w = Wait-State 'w8dl-ts9h2c'
    $r = Req GET "$base/summary?v=W8Dl-TS9H2c" $h
    Check 'Original bleibt done' ($r.Json.state -eq 'done') "Zwilling: $($w.Json.state) $($w.Json.code)"
}

if ($Part -eq 'force') {
    # Warteschlange: neu erzeugen fuer zwei Videos gleichzeitig, eins laeuft, eins wartet
    $a = 'W8Dl-TS9H2c'; $b = '2ZU3j4GQ4K8'
    $before = (Req GET "$base/summary?v=$a" $h).Json.created
    $r1 = Req POST "$base/summary?v=$a&force=1" $h
    $r2 = Req POST "$base/summary?v=$b&force=1" $h
    Check 'force A -> pending' ($r1.Json.state -eq 'pending') $r1.Raw
    Check 'force B -> pending' ($r2.Json.state -eq 'pending') $r2.Raw
    Start-Sleep -Milliseconds 600
    $s1 = (Req GET "$base/summary?v=$a" $h).Json; $s2 = (Req GET "$base/summary?v=$b" $h).Json
    Check 'nur eines laeuft, das andere wartet' (@($s1.phase, $s2.phase) -contains 'running' -and @($s1.phase, $s2.phase) -contains 'queued') "A=$($s1.phase) B=$($s2.phase)#$($s2.position)$($s1.position)"
    # beide weiter abfragen wie zwei offene Tabs
    $sw = [System.Diagnostics.Stopwatch]::StartNew(); $da = $null; $db = $null
    while ($sw.Elapsed.TotalSeconds -lt 180 -and (-not $da -or -not $db)) {
        $x = (Req GET "$base/summary?v=$a" $h).Json; if ($x.state -ne 'pending' -and -not $da) { $da = $x; "A fertig nach $([math]::Round($sw.Elapsed.TotalSeconds,1)) s: $($x.state)" }
        $y = (Req GET "$base/summary?v=$b" $h).Json; if ($y.state -ne 'pending' -and -not $db) { $db = $y; "B fertig nach $([math]::Round($sw.Elapsed.TotalSeconds,1)) s: $($y.state)" }
        Start-Sleep -Seconds 2
    }
    Check 'A neu erzeugt (neues Datum)' ($da.state -eq 'done' -and $da.created -ne $before) "$before -> $($da.created)"
    Check 'B neu erzeugt' ($db.state -eq 'done')
    "--- neue Fassung A ---`n$($da.summary)"
}

"`nFehlgeschlagen: $script:fail"
