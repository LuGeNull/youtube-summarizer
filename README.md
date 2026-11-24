# youtube-summarizer (yt-watcher)

Shows an AI summary next to every YouTube video you open in Chrome: a short summary right away,
key points with clickable timestamps on demand. Everything runs locally. A small Chrome extension
asks a PowerShell service on `localhost`, which fetches the subtitles with
[yt-dlp](https://github.com/yt-dlp/yt-dlp) and lets the Claude CLI (Haiku) write the summary.

Zeigt neben jedem YouTube-Video in Chrome eine KI-Zusammenfassung. Die ausführliche Anleitung
(Deutsch) steht in **[LIESMICH.md](LIESMICH.md)**.

## Requirements

- Windows with Windows PowerShell 5.1 and Chrome
- yt-dlp: `winget install --id yt-dlp.yt-dlp -e`
- Claude CLI, installed and signed in (`claude --version` must work)

## Quick start

```
git clone https://github.com/LuGeNull/youtube-summarizer.git
cd youtube-summarizer
.\start.cmd -Serve -Background
```

Then load the extension once: `chrome://extensions` → enable developer mode → "Load unpacked" →
choose the `extension` folder. Open a YouTube video; the box appears in the right column about a
second later.

Stop the service with `.\start.cmd -Stop`. Its messages go to `dienst.log`.

## Notes

- Each opened video costs one Claude call (Haiku) on your own account.
- The "Einordnen" button asks a larger model (Fable) how well the video's claims hold up, from
  the model's own knowledge and without web access. It only runs when you click it.
- The service only listens on `localhost` and rejects requests from web pages; details in
  [LIESMICH.md](LIESMICH.md), section "Schutz".
- The user interface and the code comments are in German. Summaries are written in the language
  of the video.

## License

MIT, see [LICENSE](LICENSE).
