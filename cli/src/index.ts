import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Fragment, Level } from "@hls-downloader/core/lib/entities";
import { M3u8Parser } from "../../src/background/src/services/m3u8-parser";
import { FetchLoader } from "../../src/background/src/services/fetch-loader";
import { CryptoDecryptor } from "../../src/background/src/services/crypto-decryptor";

const HELP = `hls-dl - download HLS (.m3u8) streams from the command line

Usage:
  hls-dl <url> [url...] [options]

<url> can be a .m3u8 playlist (master or media) or a web page that
contains a .m3u8 link in its HTML.

Options:
  -o, --output <file>      Output file (single URL only). Default: derived from URL
  -d, --dir <dir>          Output directory (default: current directory)
  -q, --quality <q>        best | worst | <height>, e.g. 720 (default: best)
  -a, --audio <lang>       Preferred audio language/name for separate audio tracks
  -l, --list               List available qualities/audio tracks and exit
  -H, --header <h>         Extra request header "Name: value" (repeatable)
  -r, --referer <url>      Shortcut for -H "Referer: <url>"
  -c, --concurrency <n>    Parallel segment downloads (default: 8)
      --retries <n>        Attempts per segment (default: 5)
      --keep-ts            Skip ffmpeg and keep raw .ts/.mp4 track files
  -h, --help               Show this help
`;

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

type Options = {
  output?: string;
  dir: string;
  quality: string;
  audio?: string;
  list: boolean;
  concurrency: number;
  retries: number;
  keepTs: boolean;
};

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function installHeaders(headers: Record<string, string>) {
  // The extension's FetchLoader calls global fetch; inject CLI headers there.
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const merged = new Headers(headers);
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
    return original(input, { ...init, headers: merged });
  };
}

async function resolvePlaylistUrl(url: string): Promise<{ text: string; uri: string }> {
  const res = await FetchLoader.fetchTextResponse(url, 3);
  if (res.text.trimStart().startsWith("#EXTM3U")) return res;

  // Not a playlist: treat it as a web page and look for an embedded .m3u8 link.
  const candidates = new Set<string>();
  const html = res.text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  for (const match of html.matchAll(/(?:https?:)?\/\/[^\s"'<>()\\]+?\.m3u8(?:\?[^\s"'<>()\\]*)?/g)) {
    candidates.add(new URL(match[0], res.uri).href);
  }
  for (const match of html.matchAll(/["'](\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?)["']/g)) {
    candidates.add(new URL(match[1], res.uri).href);
  }
  if (candidates.size === 0) {
    fail(
      "no .m3u8 playlist found at that URL. If the video loads via JavaScript, open the page with " +
        "DevTools > Network, filter for 'm3u8', and pass that link instead.",
    );
  }
  const list = [...candidates];
  const preferred = list.find((u) => /master|index|playlist/i.test(u)) ?? list[0];
  if (list.length > 1) {
    process.stderr.write(`Found ${list.length} playlists on page, using: ${preferred}\n`);
  }
  const playlist = await FetchLoader.fetchTextResponse(preferred, 3);
  if (!playlist.text.trimStart().startsWith("#EXTM3U")) {
    fail(`${preferred} did not return an HLS playlist`);
  }
  return playlist;
}

function describeStream(level: Level) {
  const res = level.height ? `${level.width ?? "?"}x${level.height}` : "audio/unknown";
  const kbps = level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : "";
  return [res, kbps, level.fps ? `${level.fps}fps` : ""].filter(Boolean).join("  ");
}

function pickStream(streams: Level[], quality: string): Level {
  // Audio-only variants have no resolution; skip them when real video exists.
  const video = streams.filter((s) => s.height);
  const sorted = [...(video.length ? video : streams)].sort(
    (a, b) => (a.height ?? 0) - (b.height ?? 0) || (a.bitrate ?? 0) - (b.bitrate ?? 0),
  );
  if (quality === "best") return sorted[sorted.length - 1];
  if (quality === "worst") return sorted[0];
  const target = Number.parseInt(quality, 10);
  if (!Number.isFinite(target)) fail(`invalid --quality "${quality}"`);
  const atOrBelow = sorted.filter((s) => (s.height ?? 0) <= target);
  return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : sorted[0];
}

function pickAudio(audios: Level[], stream: Level, preferred?: string): Level | undefined {
  const group = audios.filter((a) => a.groupId === stream.audioGroupId);
  if (group.length === 0) return undefined;
  if (preferred) {
    const p = preferred.toLowerCase();
    const hit = group.find(
      (a) => a.language?.toLowerCase().startsWith(p) || a.name?.toLowerCase().includes(p),
    );
    if (hit) return hit;
  }
  return group.find((a) => a.isDefault) ?? group[0];
}

async function downloadTrack(
  label: string,
  playlistUrl: string,
  outFile: string,
  opts: Options,
): Promise<void> {
  const { text, uri } = await FetchLoader.fetchTextResponse(playlistUrl, opts.retries);
  const encryption = M3u8Parser.inspectLevelEncryption(text, uri);
  const unsupported = encryption.methods.filter((m) => m !== "AES-128");
  if (unsupported.length) {
    fail(`${label} uses ${unsupported.join(", ")} encryption (DRM), which can't be downloaded`);
  }
  if (!/#EXT-X-ENDLIST/.test(text)) {
    process.stderr.write(`warning: ${label} looks like a live stream; downloading current window only\n`);
  }

  const fragments: Fragment[] = M3u8Parser.parseLevelPlaylist(text, uri);
  if (fragments.length === 0) fail(`${label} playlist has no segments`);

  const keys = new Map<string, Promise<ArrayBuffer>>();
  const getKey = (keyUri: string) => {
    if (!keys.has(keyUri)) keys.set(keyUri, FetchLoader.fetchArrayBuffer(keyUri, opts.retries));
    return keys.get(keyUri)!;
  };

  const out = createWriteStream(outFile);
  const done = new Map<number, Buffer>();
  let nextToWrite = 0;
  let completed = 0;
  let bytes = 0;
  let cursor = 0;
  const started = Date.now();

  const report = () => {
    const pct = ((completed / fragments.length) * 100).toFixed(1);
    const mb = (bytes / 1048576).toFixed(1);
    const speed = (bytes / 1048576 / Math.max((Date.now() - started) / 1000, 0.001)).toFixed(1);
    process.stderr.write(`\r${label}: ${completed}/${fragments.length} segments  ${pct}%  ${mb} MB  ${speed} MB/s   `);
  };

  const flush = async () => {
    while (done.has(nextToWrite)) {
      const chunk = done.get(nextToWrite)!;
      done.delete(nextToWrite);
      nextToWrite++;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
  };

  const worker = async () => {
    while (cursor < fragments.length) {
      const position = cursor++;
      const fragment = fragments[position];
      let data = await FetchLoader.fetchArrayBuffer(fragment.uri, opts.retries, fragment.byteRange);
      if (fragment.key.uri && fragment.key.iv) {
        data = await CryptoDecryptor.decrypt(data, await getKey(fragment.key.uri), fragment.key.iv);
      }
      done.set(position, Buffer.from(data));
      bytes += data.byteLength;
      completed++;
      report();
      await flush();
    }
  };

  report();
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, fragments.length) }, worker));
  await flush();
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  process.stderr.write("\n");
}

function hasFfmpeg() {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

function mux(video: string, audio: string | undefined, output: string): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", video];
  if (audio) args.push("-i", audio, "-map", "0:v:0?", "-map", "1:a:0");
  else args.push("-map", "0");
  args.push("-c", "copy", output);
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    proc.on("error", reject);
  });
}

function defaultName(playlistUri: string): string {
  const url = new URL(playlistUri);
  const parts = url.pathname.split("/").filter(Boolean).map((p) => p.replace(/\.m3u8$/i, ""));
  const generic = /^(index|master|playlist|manifest|video|stream|hls|chunklist.*|prog_index|\d+p?)$/i;
  const meaningful = [...parts].reverse().find((p) => !generic.test(p));
  const base = meaningful ?? `${url.hostname}-${Date.now()}`;
  return base.replace(/[^\w.-]+/g, "_").slice(0, 80) || "video";
}

function uniquePath(file: string) {
  if (!existsSync(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

async function downloadOne(inputUrl: string, opts: Options) {
  process.stderr.write(`\n==> ${inputUrl}\n`);
  const { text, uri } = await resolvePlaylistUrl(inputUrl);

  let videoUrl = uri;
  let audioLevel: Level | undefined;

  if (/#EXT-X-STREAM-INF/.test(text)) {
    const levels = M3u8Parser.parseMasterPlaylist(text, uri);
    const streams = levels.filter((l) => l.type === "stream");
    const audios = levels.filter((l) => l.type === "audio");

    if (opts.list) {
      console.log("Video qualities:");
      [...streams]
        .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0))
        .forEach((s) => console.log(`  ${describeStream(s)}`));
      if (audios.length) {
        console.log("Audio tracks:");
        audios.forEach((a) =>
          console.log(`  [${a.groupId}] ${a.name ?? ""}${a.language ? ` (${a.language})` : ""}${a.isDefault ? " default" : ""}`),
        );
      }
      return;
    }

    const stream = pickStream(streams, opts.quality);
    videoUrl = stream.uri;
    audioLevel = pickAudio(audios, stream, opts.audio);
    process.stderr.write(`Selected video: ${describeStream(stream)}\n`);
    if (audioLevel) {
      process.stderr.write(`Selected audio: ${audioLevel.name ?? ""} ${audioLevel.language ?? ""}\n`);
    }
  } else if (opts.list) {
    console.log("Single-quality media playlist (no variants to choose from).");
    return;
  }

  const dir = path.resolve(opts.dir);
  const finalPath = uniquePath(
    opts.output ? path.resolve(dir, opts.output) : path.join(dir, `${defaultName(uri)}.mp4`),
  );
  const useFfmpeg = !opts.keepTs && hasFfmpeg();
  if (!opts.keepTs && !useFfmpeg) {
    process.stderr.write("warning: ffmpeg not found; saving raw track files instead of .mp4\n");
  }

  const work = useFfmpeg ? mkdtempSync(path.join(tmpdir(), "hls-dl-")) : path.dirname(finalPath);
  const stem = path.parse(finalPath).name;
  const videoFile = path.join(work, useFfmpeg ? "video.ts" : `${stem}.video.ts`);
  const audioFile = audioLevel ? path.join(work, useFfmpeg ? "audio.ts" : `${stem}.audio.ts`) : undefined;

  try {
    await downloadTrack("video", videoUrl, videoFile, opts);
    if (audioLevel && audioFile) await downloadTrack("audio", audioLevel.uri, audioFile, opts);

    if (useFfmpeg) {
      process.stderr.write("Muxing with ffmpeg...\n");
      await mux(videoFile, audioFile, finalPath);
      console.log(finalPath);
    } else {
      console.log(videoFile);
      if (audioFile) console.log(audioFile);
    }
  } finally {
    if (useFfmpeg) rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      dir: { type: "string", short: "d", default: "." },
      quality: { type: "string", short: "q", default: "best" },
      audio: { type: "string", short: "a" },
      list: { type: "boolean", short: "l", default: false },
      header: { type: "string", short: "H", multiple: true, default: [] },
      referer: { type: "string", short: "r" },
      concurrency: { type: "string", short: "c", default: "8" },
      retries: { type: "string", default: "5" },
      "keep-ts": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (values.output && positionals.length > 1) fail("--output can only be used with a single URL");

  const headers: Record<string, string> = { "User-Agent": DEFAULT_UA };
  for (const h of values.header ?? []) {
    const i = h.indexOf(":");
    if (i <= 0) fail(`invalid header "${h}", expected "Name: value"`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (values.referer) {
    headers["Referer"] = values.referer;
    headers["Origin"] ??= new URL(values.referer).origin;
  }
  installHeaders(headers);

  const opts: Options = {
    output: values.output,
    dir: values.dir!,
    quality: values.quality!,
    audio: values.audio,
    list: values.list!,
    concurrency: Math.max(1, Number(values.concurrency) || 8),
    retries: Math.max(1, Number(values.retries) || 5),
    keepTs: values["keep-ts"]!,
  };

  let failures = 0;
  for (const url of positionals) {
    try {
      await downloadOne(url, opts);
    } catch (error) {
      failures++;
      process.stderr.write(`\nerror: ${url}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
