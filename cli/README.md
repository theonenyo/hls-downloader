# hls-dl — command-line HLS downloader

A CLI built on this repo's extension code (`M3u8Parser`, `FetchLoader`,
`CryptoDecryptor` from `src/background`, plus `src/core` use-cases). Paste a
link, get an `.mp4`.

## Install

Requires Node 20+ and `ffmpeg` on your PATH (used to mux video + audio).

```sh
cd cli
npm install
npm link        # puts `hls-dl` on your PATH
```

## Usage

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
