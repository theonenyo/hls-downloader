// Interactive full-screen app: paste a link, pick a quality, watch it download. Same UX as callrec's `rec`.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  s, Frame, onKeys, select, input, withSpinner, wrap, hideCursor, showCursor, enterScreen, leaveScreen,
} from "./term.mjs";
import {
  CancelledError, audioChoices, defaultName, describeAudio, describeStream, durationOf, findPlaylists, hasFfmpeg,
  loadSource, pickAudio, pickStream, prepareTracks, preferredCandidate, runDownload, setReferer, sortedStreams,
  uniquePath, type Level, type Source, type Track,
} from "./engine";

const out = process.stdout;
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".config", "hls-dl");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.json");
const tilde = (p: string) => (p === HOME || p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p);
const untilde = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, HOME));

// MARK: config + history

type Config = { dir: string; quality: string; concurrency: number; referer?: string };
type HistoryEntry = { file: string; source: string; at: number };

const DEFAULTS: Config = { dir: path.join(HOME, "Downloads"), quality: "ask", concurrency: 8 };
const readJson = <T>(file: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
};

const app = {
  cfg: { ...DEFAULTS, ...readJson<Partial<Config>>(CONFIG_FILE, {}) } as Config,
  ffmpeg: hasFfmpeg(),
  notice: [] as string[], // lines from the last action, shown under the menu header
  abort: null as AbortController | null,
};
const saveConfig = () => writeJson(CONFIG_FILE, app.cfg);
const history = () => readJson<HistoryEntry[]>(HISTORY_FILE, []).filter((h) => fs.existsSync(h.file));
const remember = (entry: HistoryEntry) => writeJson(HISTORY_FILE, [entry, ...history()].slice(0, 50));

// Ordered list: numeric-looking object keys would otherwise sort ahead of "ask".
const QUALITIES: Array<[string, string]> = [
  ["ask", "ask each time"], ["best", "best available"], ["1080", "1080p or lower"], ["720", "720p or lower"],
  ["480", "480p or lower"], ["worst", "smallest"],
];
const qualityLabel = (q: string) => QUALITIES.find(([k]) => k === q)?.[1] ?? q;

// MARK: formatting

const clock = (secs: number) => {
  const t = Math.max(0, Math.round(secs));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const humanSize = (bytes: number) =>
  bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB`
    : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const shortUrl = (u: string, max = 58) => {
  const t = u.replace(/^https?:\/\//, "");
  return t.length > max ? t.slice(0, 24) + "…" + t.slice(-(max - 25)) : t;
};
const errorLines = (msg: string) => ["", ...msg.split("\n").flatMap((l) => wrap(l, 4, "  ✗ ").map(s.red))];

function clipboardUrl(): string {
  if (process.platform !== "darwin") return "";
  const text = spawnSync("pbpaste", { encoding: "utf8" }).stdout?.trim() ?? "";
  return /^https?:\/\/\S+$/.test(text) ? text : "";
}

// MARK: download flow

const title = (t: string, sub?: string) => () => ["", `  ${s.bold(t)}${sub ? "  " + s.gray(sub) : ""}`];

// Each step returns null when the user backs out; the flow then returns to the menu quietly.
async function downloadFlow(): Promise<string[]> {
  const clip = clipboardUrl();
  const url = await input({
    header: () => [
      ...title("Paste a video link")(),
      `  ${s.gray(".m3u8 playlist, or a web page that contains one")}`,
      ...(clip ? [`  ${s.green("✓")} ${s.gray("filled in from your clipboard")}`] : []),
    ],
    value: clip,
    placeholder: "https://…",
    footer: "enter download · ctrl-u clear · esc back",
    validate: (t: string) => (/^https?:\/\/\S+$/.test(t) ? "" : "That doesn't look like a link (it should start with http:// or https://)."),
  });
  if (!url) return [];

  let source: Source;
  try {
    const found = await withSpinner("Fetching…", findPlaylists(url));
    if ("source" in found) source = found.source;
    else {
      let pick = found.candidates[0];
      if (found.candidates.length > 1) {
        const c = await select({
          header: title("This page has several playlists", "pick one"),
          items: found.candidates.map((u) => ({ label: shortUrl(u), value: u })),
          start: found.candidates.indexOf(preferredCandidate(found.candidates)),
        });
        if (!c || c === "quit") return [];
        pick = c.value;
      }
      source = await withSpinner("Fetching playlist…", loadSource(pick));
    }
  } catch (e) {
    return errorLines((e as Error).message);
  }

  let videoUri = source.uri;
  let audio: Level | undefined;
  let chosen = "single quality";
  if (source.kind === "master") {
    const streams = sortedStreams(source.streams);
    let stream = streams[0];
    if (app.cfg.quality === "ask" && streams.length > 1) {
      const c = await select({
        header: title("Pick a quality", `${streams.length} available`),
        items: streams.map((st, n) => ({ label: describeStream(st), hint: n === 0 ? "best" : "", value: st })),
      });
      if (!c || c === "quit") return [];
      stream = c.value;
    } else if (app.cfg.quality !== "ask") {
      stream = pickStream(source.streams, app.cfg.quality);
    }
    videoUri = stream.uri;
    chosen = describeStream(stream);

    const audios = audioChoices(source.audios, stream);
    const distinct = new Set(audios.map(describeAudio));
    if (distinct.size > 1) {
      const fallback = pickAudio(source.audios, stream);
      const c = await select({
        header: title("Pick an audio track"),
        items: audios.map((a) => ({ label: describeAudio(a) || "track", hint: a.isDefault ? "default" : "", value: a })),
        start: Math.max(0, audios.indexOf(fallback!)),
      });
      if (!c || c === "quit") return [];
      audio = c.value;
    } else {
      audio = pickAudio(source.audios, stream);
    }
  }

  const name = await input({
    header: title("Save as", `in ${tilde(app.cfg.dir)}`),
    value: defaultName(source.uri),
    footer: "enter save · ctrl-u clear · esc back",
    validate: (t: string) => (t && !t.includes("/") ? "" : "Pick a file name (no slashes)."),
  });
  if (!name) return [];

  let tracks: Track[];
  try {
    tracks = await withSpinner("Reading segment lists…", prepareTracks(videoUri, audio, 5));
  } catch (e) {
    return errorLines((e as Error).message);
  }

  fs.mkdirSync(app.cfg.dir, { recursive: true });
  const output = uniquePath(path.join(app.cfg.dir, name.replace(/\.mp4$/i, "") + ".mp4"));
  const result = await downloadScreen(tracks, output, chosen);
  if (result.ok) remember({ file: result.files[0], source: url, at: Date.now() });
  return result.lines;
}

// MARK: download screen

const BAR = 26;
function progressBar(done: number, total: number) {
  const filled = total ? Math.round((done / total) * BAR) : 0;
  const paint = done >= total && total ? s.green : s.cyan;
  return paint("█".repeat(filled)) + s.gray("░".repeat(BAR - filled));
}

type Result = { ok: true; files: string[]; lines: string[] } | { ok: false; lines: string[] };

async function downloadScreen(tracks: Track[], output: string, chosen: string): Promise<Result> {
  const ctl = new AbortController();
  app.abort = ctl;
  const frame = new Frame();
  const state = {
    phase: "download" as "download" | "mux",
    done: tracks.map(() => 0),
    bytes: 0,
    started: Date.now(),
    confirmUntil: 0,
    rate: [] as Array<[number, number]>, // recent [time, bytes] samples for the speed readout
  };
  const totalSegs = tracks.reduce((n, t) => n + t.fragments.length, 0);

  const render = () => {
    const now = Date.now();
    const doneSegs = state.done.reduce((a, b) => a + b, 0);
    const elapsed = (now - state.started) / 1000;
    const lines = [""];
    if (state.phase === "mux") {
      const sp = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(now / 80) % 10];
      lines.push(`  ${s.cyan(sp)} ${s.bold("Joining video + audio")}  ${s.gray("ffmpeg, no re-encoding")}`);
    } else {
      const on = Math.floor(now / 500) % 2 === 0;
      lines.push(`  ${on ? s.bold(s.cyan("↓")) : s.cyan("↓")} ${s.bold(s.cyan("DOWNLOADING"))}  ${s.bold(clock(elapsed))}  ${s.gray(chosen)}`);
    }
    lines.push("");
    tracks.forEach((t, i) => {
      const total = t.fragments.length;
      const pct = `${Math.floor((state.done[i] / total) * 100)}%`.padStart(4);
      lines.push(`  ${t.kind.padEnd(6)} ${progressBar(state.done[i], total)} ${pct}  ${s.gray(`${state.done[i]}/${total}`)}`);
    });

    const recent = state.rate.filter(([t]) => now - t < 3000);
    const window = recent.length > 1 ? (recent[recent.length - 1][0] - recent[0][0]) / 1000 : 0;
    const speed = window > 0.5 ? recent.slice(1).reduce((n, [, b]) => n + b, 0) / window : 0;
    const left = doneSegs > 0 && doneSegs < totalSegs ? (elapsed / doneSegs) * (totalSegs - doneSegs) : 0;
    const stats = [humanSize(state.bytes), speed ? `${humanSize(speed)}/s` : "", left ? `~${clock(left)} left` : ""];
    lines.push("", `  ${s.gray(stats.filter(Boolean).join(" · "))}`, `  ${s.gray("→ " + tilde(output))}`);

    if (tracks.some((t) => t.live)) {
      lines.push(...wrap("Live stream: only what's in the playlist right now gets saved.", 4, "  ⚠ ").map(s.yellow));
    }
    lines.push("", now < state.confirmUntil
      ? `  ${s.bold(s.yellow("Cancel this download? press esc again"))}`
      : `  ${s.bold("esc")} ${s.gray("cancel")}`);
    frame.draw(lines);
  };

  hideCursor();
  const tick = setInterval(render, 100);
  const offKeys = onKeys((name: string) => {
    if (!["escape", "ctrl-c", "q"].includes(name)) return;
    if (Date.now() < state.confirmUntil) ctl.abort();
    else state.confirmUntil = Date.now() + 2500;
    render();
  });

  let result: Result;
  try {
    const { files, muxed } = await runDownload({
      tracks, output, concurrency: app.cfg.concurrency, retries: 5, signal: ctl.signal,
      onPhase: (phase) => { state.phase = phase; },
      onProgress: (i, done, _total, bytes) => {
        state.done[i] = done;
        state.bytes += bytes;
        if (bytes) state.rate.push([Date.now(), bytes]);
        if (state.rate.length > 400) state.rate.splice(0, 200);
      },
    });
    const size = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    const secs = muxed ? await durationOf(files[0]) : null;
    const lines = [
      "",
      `  ${s.bold(s.green("■ Saved"))}  ${s.bold(path.basename(files[0]))}`,
      `    ${s.gray([secs != null ? clock(secs) : "", humanSize(size), tilde(path.dirname(files[0]))].filter(Boolean).join(" · "))}`,
    ];
    if (!muxed) lines.push(...wrap("ffmpeg isn't installed, so video and audio were saved as separate raw files (brew install ffmpeg).", 6, "    ⚠ ").map(s.yellow));
    out.write("\x07"); // terminal bell: done
    result = { ok: true, files, lines };
  } catch (e) {
    result = e instanceof CancelledError
      ? { ok: false, lines: ["", `  ${s.yellow("■ Cancelled")}  ${s.gray("nothing was saved")}`] }
      : { ok: false, lines: errorLines(`Download failed: ${(e as Error).message}`) };
  } finally {
    clearInterval(tick);
    offKeys();
    frame.clear();
    showCursor();
    app.abort = null;
  }
  return result;
}

// MARK: recent downloads

async function recentScreen() {
  const items = history().slice(0, 14);
  const frame = new Frame();
  const durations = new Map<string, number>();
  let i = 0, closed = false;

  const render = () => {
    if (closed) return;
    const lines = ["", `  ${s.bold("Recent downloads")}`, ""];
    if (!items.length) lines.push(`  ${s.gray("Nothing here yet. Go download something!")}`);
    items.forEach((it, n) => {
      const on = n === i;
      const name = path.basename(it.file);
      const dur = durations.has(it.file) ? clock(durations.get(it.file)!) : "…";
      const when = new Date(it.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      lines.push(`  ${on ? s.cyan("▸") : " "} ${on ? s.bold(s.cyan(name)) : name}  ${s.gray(`${when}  ${dur.padStart(7)}  ${humanSize(fs.statSync(it.file).size)}`)}`);
    });
    if (items[i]) lines.push("", `  ${s.gray("from " + shortUrl(items[i].source))}`);
    lines.push("", `  ${s.gray("↑↓ browse · enter ▶ play · o show in Finder · f open folder · esc back")}`);
    frame.draw(lines);
  };

  hideCursor();
  render();
  items.forEach((it) => durationOf(it.file).then((d) => { if (d != null) { durations.set(it.file, d); render(); } }));

  await new Promise<void>((resolve) => {
    const off = onKeys((name: string) => {
      if (name === "up" || name === "k") i = Math.max(0, i - 1);
      else if (name === "down" || name === "j") i = Math.min(items.length - 1, i + 1);
      else if (name === "return" && items[i]) spawn("open", [items[i].file], { stdio: "ignore" });
      else if (name === "o" && items[i]) spawn("open", ["-R", items[i].file], { stdio: "ignore" });
      else if (name === "f") spawn("open", [items[i] ? path.dirname(items[i].file) : app.cfg.dir], { stdio: "ignore" });
      else if (name === "escape" || name === "q" || name === "ctrl-c") { off(); return resolve(); }
      render();
    });
  });
  closed = true;
  frame.clear();
  showCursor();
}

// MARK: settings

async function settingsScreen() {
  let last = 0;
  for (;;) {
    const c = await select({
      header: title("Settings", tilde(CONFIG_FILE)),
      start: last,
      items: [
        { label: "Save folder", hint: tilde(app.cfg.dir), value: "dir" },
        { label: "Quality", hint: qualityLabel(app.cfg.quality), value: "quality" },
        { label: "Parallel segment downloads", hint: String(app.cfg.concurrency), value: "concurrency" },
        { label: "Referer header", hint: app.cfg.referer ? shortUrl(app.cfg.referer, 40) : "none", value: "referer" },
        { label: "Back", value: "back" },
      ],
    });
    if (!c || c === "quit" || c.value === "back") return;
    last = ["dir", "quality", "concurrency", "referer"].indexOf(c.value);

    if (c.value === "dir") {
      const v = await input({ header: title("Save folder"), value: tilde(app.cfg.dir), validate: (t: string) => (t ? "" : "Enter a folder.") });
      if (v) app.cfg.dir = untilde(v);
    } else if (c.value === "quality") {
      const keys = QUALITIES.map(([k]) => k);
      const q = await select({
        header: title("Quality"),
        items: keys.map((k) => ({ label: (k === app.cfg.quality ? "✓ " : "  ") + qualityLabel(k), value: k })),
        start: Math.max(0, keys.indexOf(app.cfg.quality)),
      });
      if (q && q !== "quit") app.cfg.quality = q.value;
    } else if (c.value === "concurrency") {
      const opts = [4, 8, 16, 32];
      const q = await select({
        header: title("Parallel segment downloads", "more is faster, but some servers throttle"),
        items: opts.map((n) => ({ label: (n === app.cfg.concurrency ? "✓ " : "  ") + n, value: n })),
        start: Math.max(0, opts.indexOf(app.cfg.concurrency)),
      });
      if (q && q !== "quit") app.cfg.concurrency = q.value;
    } else {
      const v = await input({
        header: () => [...title("Referer header")(), `  ${s.gray("The page the video plays on. Some sites refuse downloads without it.")}`, `  ${s.gray("Leave empty to turn it off.")}`],
        value: app.cfg.referer ?? "",
        placeholder: "https://site.com/watch/…",
        validate: (t: string) => (!t || /^https?:\/\/\S+$/.test(t) ? "" : "Should start with http:// or https://"),
      });
      if (v !== null) { app.cfg.referer = v || undefined; setReferer(app.cfg.referer); }
    }
    saveConfig();
  }
}

// MARK: main menu

function menuHeader() {
  const lines = [
    "",
    `  ${s.bold(s.cyan("↓"))} ${s.bold("hls-dl")}  ${s.gray("download HLS videos from a link")}`,
    "",
    `  ${s.gray("save to")}  ${tilde(app.cfg.dir)}`,
    `  ${s.gray("quality")}  ${qualityLabel(app.cfg.quality)}`,
    `  ${s.gray("ffmpeg ")}  ${app.ffmpeg ? s.green("✓ found") : s.yellow("not found: video and audio stay separate (brew install ffmpeg)")}`,
  ];
  if (app.cfg.referer) lines.push(`  ${s.gray("referer")}  ${shortUrl(app.cfg.referer, 48)}`);
  lines.push(...app.notice);
  return lines;
}

export async function interactive() {
  // Closing the terminal mid-download cancels cleanly; the engine removes partial files on exit.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      app.abort?.abort();
      leaveScreen();
      showCursor();
      process.exit(130);
    });
  }
  setReferer(app.cfg.referer);
  enterScreen();
  let last = 0;
  try {
    for (;;) {
      const count = history().length;
      const clip = clipboardUrl();
      const c = await select({
        header: menuHeader,
        start: last,
        footer: "↑↓ move · enter select · d download · l list · s settings · q quit",
        items: [
          { label: "↓  Download from a link", key: "d", value: "download", hint: clip ? "link on clipboard" : "press d" },
          { label: "▤  Recent downloads", key: "l", value: "list", hint: count ? String(count) : "" },
          { label: "⚙  Settings", key: "s", value: "settings" },
          { label: "✕  Quit", value: "quit" },
        ],
      });
      if (!c || c === "quit" || c.value === "quit") return;
      app.notice = [];
      if (c.value === "download") { last = 0; app.notice = await downloadFlow(); }
      else if (c.value === "list") { last = 1; await recentScreen(); }
      else if (c.value === "settings") { last = 2; await settingsScreen(); }
    }
  } finally {
    leaveScreen();
    out.write(`\n  ${s.gray("bye 👋")}\n\n`);
  }
}
