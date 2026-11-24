@echo off
rem Startet den YouTube-Beobachter. Die Ausnahme gilt nur fuer diesen einen Lauf,
rem die Windows-Einstellung fuer Skripte bleibt unveraendert.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0yt-watcher.ps1" %*
echo.
pause
