// Download engine shared by the plain CLI and the interactive app. Never prints; reports through callbacks.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Fragment, Level } from "@hls-downloader/core/lib/entities";
import { M3u8Parser } from "../../src/background/src/services/m3u8-parser";
import { FetchLoader } from "../../src/background/src/services/fetch-loader";
import { CryptoDecryptor } from "../../src/background/src/services/crypto-decryptor";

export type { Level };

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export class CancelledError extends Error {
  constructor() {
    super("Download cancelled");
    this.name = "CancelledError";
  }
}

// MARK: request headers

// Sent with every request. The extension's FetchLoader calls global fetch, so the headers are injected there.
export const requestHeaders: Record<string, string> = { "User-Agent": DEFAULT_UA };

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const merged = new Headers(requestHeaders);
  new Headers(init.headers).forEach((value, key) => merged.set(key, value));
  return originalFetch(input, { ...init, headers: merged });
};

export function setReferer(referer?: string) {
  delete requestHeaders["Referer"];
  delete requestHeaders["Origin"];
  if (!referer) return;
  requestHeaders["Referer"] = referer;
  requestHeaders["Origin"] = new URL(referer).origin;
}

// MARK: cleanup

// Temp folders and half-written outputs are removed even if the process is killed mid-download.
const cleanupPaths = new Set<string>();
process.on("exit", () => {
  for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
});

// MARK: playlists

export type Source =
  | { kind: "master"; uri: string; streams: Level[]; audios: Level[] }
  | { kind: "media"; uri: string };

const isPlaylist = (text: string) => text.trimStart().startsWith("#EXTM3U");

function sourceFrom(text: string, uri: string): Source {
  if (!/#EXT-X-STREAM-INF/.test(text)) return { kind: "media", uri };
  const levels = M3u8Parser.parseMasterPlaylist(text, uri);
  return {
    kind: "master",
    uri,
    streams: levels.filter((l) => l.type === "stream"),
    audios: levels.filter((l) => l.type === "audio"),
  };
}

// A playlist URL yields its source; any other page is searched for embedded .m3u8 links.
export async function findPlaylists(
  url: string,
): Promise<{ source: Source } | { candidates: string[] }> {
  const res = await FetchLoader.fetchTextResponse(url, 3);
  if (isPlaylist(res.text)) return { source: sourceFrom(res.text, res.uri) };

  const candidates = new Set<string>();
  const html = res.text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  for (const match of html.matchAll(/(?:https?:)?\/\/[^\s"'<>()\\]+?\.m3u8(?:\?[^\s"'<>()\\]*)?/g)) {
    candidates.add(new URL(match[0], res.uri).href);
  }
  for (const match of html.matchAll(/["'](\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?)["']/g)) {
    candidates.add(new URL(match[1], res.uri).href);
  }
  if (candidates.size === 0) {
    throw new Error(
      "No .m3u8 playlist found at that link. If the video loads via JavaScript, open the page with " +
        "DevTools > Network, filter for 'm3u8', and use that link instead.",
    );
  }
  return { candidates: [...candidates] };
}

export const preferredCandidate = (candidates: string[]) =>
  candidates.find((u) => /master|index|playlist/i.test(u)) ?? candidates[0];

export async function loadSource(url: string): Promise<Source> {
  const res = await FetchLoader.fetchTextResponse(url, 3);
  if (!isPlaylist(res.text)) throw new Error(`${url} did not return an HLS playlist`);
  return sourceFrom(res.text, res.uri);
}

// MARK: picking renditions

export function describeStream(level: Level) {
  const res = level.height ? `${level.width ?? "?"}x${level.height}` : "audio only";
  const kbps = level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : "";
  return [res, kbps, level.fps ? `${level.fps}fps` : ""].filter(Boolean).join("  ");
}

export function describeAudio(level: Level) {
  return [level.name, level.language && `(${level.language})`, level.channels && `${level.channels}ch`]
    .filter(Boolean)
    .join(" ");
}

// Best first. Audio-only variants have no resolution; they're dropped when real video exists.
export function sortedStreams(streams: Level[]): Level[] {
  const video = streams.filter((s) => s.height);
  return [...(video.length ? video : streams)].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
  );
}

export function pickStream(streams: Level[], quality: string): Level {
  const sorted = sortedStreams(streams);
  if (quality === "best") return sorted[0];
  if (quality === "worst") return sorted[sorted.length - 1];
  const target = Number.parseInt(quality, 10);
  if (!Number.isFinite(target)) throw new Error(`invalid quality "${quality}"`);
  return sorted.find((s) => (s.height ?? 0) <= target) ?? sorted[sorted.length - 1];
}

export const audioChoices = (audios: Level[], stream: Level) =>
  audios.filter((a) => a.groupId === stream.audioGroupId);

export function pickAudio(audios: Level[], stream: Level, preferred?: string): Level | undefined {
  const group = audioChoices(audios, stream);
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

// MARK: tracks

export type Track = {
  kind: "video" | "audio";
  uri: string;
  fragments: Fragment[];
  live: boolean;
  fmp4: boolean;
};

async function prepareTrack(kind: Track["kind"], url: string, retries: number, signal?: AbortSignal): Promise<Track> {
  const { text, uri } = await FetchLoader.fetchTextResponse(url, retries, signal);
  const encryption = M3u8Parser.inspectLevelEncryption(text, uri);
  const unsupported = encryption.methods.filter((m) => m !== "AES-128");
  if (unsupported.length) {
    throw new Error(`The ${kind} uses ${unsupported.join(", ")} encryption (DRM), which can't be downloaded.`);
  }
  const fragments = M3u8Parser.parseLevelPlaylist(text, uri);
  if (fragments.length === 0) throw new Error(`The ${kind} playlist has no segments.`);
  return { kind, uri, fragments, live: !/#EXT-X-ENDLIST/.test(text), fmp4: /#EXT-X-MAP/.test(text) };
}

export async function prepareTracks(
  videoUri: string,
  audio: Level | undefined,
  retries: number,
  signal?: AbortSignal,
): Promise<Track[]> {
  const tracks = [prepareTrack("video", videoUri, retries, signal)];
  if (audio) tracks.push(prepareTrack("audio", audio.uri, retries, signal));
  return Promise.all(tracks);
}

type TrackOptions = { concurrency: number; retries: number; signal?: AbortSignal };

// Segments download in parallel but are written to `file` strictly in order.
async function downloadTrack(
  track: Track,
  file: string,
  opts: TrackOptions,
  onSegment: (bytes: number) => void,
): Promise<void> {
  const ctl = new AbortController();
  const stop = () => ctl.abort(new CancelledError());
  if (opts.signal?.aborted) stop();
  opts.signal?.addEventListener("abort", stop, { once: true });

  const out = createWriteStream(file);
  out.on("error", (e) => ctl.abort(e));
  const keys = new Map<string, Promise<ArrayBuffer>>();
  const getKey = (keyUri: string) => {
    if (!keys.has(keyUri)) keys.set(keyUri, FetchLoader.fetchArrayBuffer(keyUri, opts.retries, null, ctl.signal));
    return keys.get(keyUri)!;
  };

  const { fragments } = track;
  const done = new Map<number, Buffer>();
  let nextToWrite = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < fragments.length) {
      ctl.signal.throwIfAborted();
      const position = cursor++;
      const fragment = fragments[position];
      let data = await FetchLoader.fetchArrayBuffer(fragment.uri, opts.retries, fragment.byteRange, ctl.signal);
      if (fragment.key.uri && fragment.key.iv) {
        data = await CryptoDecryptor.decrypt(data, await getKey(fragment.key.uri), fragment.key.iv);
      }
      ctl.signal.throwIfAborted();
      done.set(position, Buffer.from(data));
      while (done.has(nextToWrite)) {
        out.write(done.get(nextToWrite)!);
        done.delete(nextToWrite++);
      }
      onSegment(data.byteLength);
    }
  };

  const workers = Array.from({ length: Math.min(opts.concurrency, fragments.length) }, () =>
    worker().catch((e) => {
      ctl.abort(e); // one failed segment stops the others
      throw e;
    }),
  );
  const results = await Promise.allSettled(workers);
  opts.signal?.removeEventListener("abort", stop);
  await new Promise<void>((resolve) => {
    if (out.closed) return resolve();
    out.once("close", () => resolve());
    out.end();
  });
  if (opts.signal?.aborted) throw new CancelledError();
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

// MARK: muxing

export const hasFfmpeg = () => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function mux(video: string, audio: string | undefined, output: string, signal?: AbortSignal): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", video];
  if (audio) args.push("-i", audio, "-map", "0:v:0?", "-map", "1:a:0");
  else args.push("-map", "0");
  args.push("-c", "copy", output);
  return new Promise((resolve, reject) => {
    let stderr = "";
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], signal });
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (e) => reject(signal?.aborted ? new CancelledError() : e));
    proc.on("exit", (code) => {
      if (signal?.aborted) return reject(new CancelledError());
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().split("\n").slice(-2).join(" ")}`));
    });
  });
}

export function durationOf(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    let text = "";
    const proc = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    proc.stdout.on("data", (d) => (text += d));
    proc.on("error", () => resolve(null));
    proc.on("exit", () => {
      const n = Number.parseFloat(text);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

// MARK: full download

export type RunOptions = TrackOptions & {
  tracks: Track[];
  output: string; // final .mp4 path
  keepTs?: boolean;
  onProgress?: (trackIndex: number, done: number, total: number, bytes: number) => void;
  onPhase?: (phase: "download" | "mux") => void;
};

// Downloads every track, then muxes them into `output`. Returns the files written.
export async function runDownload(opts: RunOptions): Promise<{ files: string[]; muxed: boolean }> {
  const useFfmpeg = !opts.keepTs && hasFfmpeg();
  const { dir, name } = path.parse(opts.output);
  const work = useFfmpeg ? mkdtempSync(path.join(tmpdir(), "hls-dl-")) : dir;
  const trackFiles = opts.tracks.map((t) =>
    path.join(work, `${useFfmpeg ? t.kind : `${name}.${t.kind}`}${t.fmp4 ? ".mp4" : ".ts"}`),
  );
  const pending = useFfmpeg ? [work, opts.output] : trackFiles;
  pending.forEach((p) => cleanupPaths.add(p));

  try {
    opts.onPhase?.("download");
    for (const [i, track] of opts.tracks.entries()) {
      let done = 0;
      opts.onProgress?.(i, 0, track.fragments.length, 0);
      await downloadTrack(track, trackFiles[i], opts, (bytes) =>
        opts.onProgress?.(i, ++done, track.fragments.length, bytes),
      );
    }
    if (!useFfmpeg) {
      trackFiles.forEach((f) => cleanupPaths.delete(f));
      return { files: trackFiles, muxed: false };
    }
    opts.onPhase?.("mux");
    await mux(trackFiles[0], trackFiles[1], opts.output, opts.signal);
    cleanupPaths.delete(opts.output);
    return { files: [opts.output], muxed: true };
  } finally {
    // Whatever is still pending is incomplete (or the temp folder): remove it now.
    for (const p of pending) {
      if (cleanupPaths.delete(p)) rmSync(p, { recursive: true, force: true });
    }
  }
}

// MARK: file names

export function defaultName(playlistUri: string): string {
  const url = new URL(playlistUri);
  const parts = url.pathname.split("/").filter(Boolean).map((p) => p.replace(/\.m3u8$/i, ""));
  const generic = /^(index|master|playlist|manifest|video|stream|hls|chunklist.*|prog_index|\d+p?)$/i;
  const meaningful = [...parts].reverse().find((p) => !generic.test(p));
  const base = meaningful ?? `${url.hostname}-${Date.now()}`;
  return base.replace(/[^\w.-]+/g, "_").slice(0, 80) || "video";
}

export function uniquePath(file: string) {
  if (!existsSync(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let i = 2; ; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}
