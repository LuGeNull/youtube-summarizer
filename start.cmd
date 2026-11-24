@echo off
rem Startet yt-watcher. Mit -Serve als Dienst fuer die Chrome-Erweiterung, ohne Schalter als
rem Beobachter des aktiven Browserfensters. Die Ausnahme von der Skript-Richtlinie gilt nur
rem fuer diesen einen Lauf, die Windows-Einstellung bleibt unveraendert.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0yt-watcher.ps1" %*
echo.
pause
