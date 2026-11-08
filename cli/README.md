# hls-dl — command-line HLS downloader

A CLI (interactive menu or one-shot commands) built on this repo's extension code (`M3u8Parser`, `FetchLoader`,
`CryptoDecryptor` from `src/background`, plus `src/core` use-cases). Paste a
link, get an `.mp4`.

## Install

Requires Node 20+ and `ffmpeg` on your PATH (used to mux video + audio).

```sh
cd cli
npm install
npm link        # puts `hls-dl` on your PATH
```

## Interactive mode

Run `hls-dl` with no arguments for a full-screen menu (same UX as `callrec`'s `rec`):

```
  ↓ hls-dl  download HLS videos from a link

  save to  ~/Downloads
  quality  ask each time
  ffmpeg   ✓ found

  ▸ ↓  Download from a link  link on clipboard
    ▤  Recent downloads  2
    ⚙  Settings
    ✕  Quit
```

- **Download** (`d`): paste a link (a link already on your clipboard is filled in), pick a
  quality and audio track, confirm the file name, then watch per-track progress bars with
  size, speed and time left. `esc` twice cancels and removes partial files.
- **Recent downloads** (`l`): `enter` plays, `o` shows in Finder, `f` opens the folder.
- **Settings** (`s`): save folder, default quality (ask / best / 1080 / 720 / 480 / smallest),
  parallel downloads, and a Referer header for sites that need one. Saved to
  `~/.config/hls-dl/config.json`; history is in `~/.config/hls-dl/history.json`.

## Direct mode

Pass URLs to skip the menu (good for scripts):

```sh
hls-dl "https://example.com/path/master.m3u8"
hls-dl -q 720 -o talk.mp4 "https://example.com/master.m3u8"
hls-dl --list "https://example.com/master.m3u8"         # show qualities
hls-dl -r "https://site.com/watch/123" "<m3u8 url>"     # send Referer/Origin
hls-dl -d ~/Movies url1.m3u8 url2.m3u8                  # batch
```

The URL can be a `.m3u8` playlist (master or media) or a web page whose HTML
contains a `.m3u8` link. For pages that load the player via JavaScript, grab
the `.m3u8` URL from DevTools → Network (filter "m3u8").

Supports TS and fMP4 segments, separate audio renditions, byte ranges and
AES-128 encryption. DRM (SAMPLE-AES / Widevine / FairPlay) is not supported.

Run `hls-dl --help` for all options.
