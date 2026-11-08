import { parseArgs } from "node:util";
import path from "node:path";
import {
  audioChoices, describeAudio, describeStream, findPlaylists, loadSource, pickAudio, pickStream, prepareTracks,
  preferredCandidate, requestHeaders, runDownload, setReferer, sortedStreams, defaultName, uniquePath, hasFfmpeg,
  type Level, type Source,
} from "./engine";

const HELP = `hls-dl - download HLS (.m3u8) streams from the command line

Usage:
  hls-dl                   interactive menu (paste a link, pick quality, watch progress)
  hls-dl <url> [url...]    download right away, no menu (scriptable)

<url> can be a .m3u8 playlist (master or media) or a web page that
contains a .m3u8 link in its HTML.

Options (for direct downloads):
  -o, --output <file>      Output file (single URL only). Default: derived from URL
  -d, --dir <dir>          Output directory (default: current directory)
  -q, --quality <q>        best | worst | <height>, e.g. 720 (default: best)
  -a, --audio <lang>       Preferred audio language/name for separate audio tracks
  -l, --list               List available qualities/audio tracks and exit
  -H, --header <h>         Extra request header "Name: value" (repeatable)
  -r, --referer <url>      Send Referer/Origin for this page
  -c, --concurrency <n>    Parallel segment downloads (default: 8)
      --retries <n>        Attempts per segment (default: 5)
      --keep-ts            Skip ffmpeg and keep raw .ts/.mp4 track files
  -h, --help               Show this help
`;

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

const log = (line: string) => process.stderr.write(line);

async function resolveSource(url: string): Promise<Source> {
  const found = await findPlaylists(url);
  if ("source" in found) return found.source;
  const pick = preferredCandidate(found.candidates);
  if (found.candidates.length > 1) log(`Found ${found.candidates.length} playlists on page, using: ${pick}\n`);
  return loadSource(pick);
}

async function downloadOne(inputUrl: string, opts: Options) {
  log(`\n==> ${inputUrl}\n`);
  const source = await resolveSource(inputUrl);

  let videoUri = source.uri;
  let audio: Level | undefined;

  if (source.kind === "master") {
    if (opts.list) {
      console.log("Video qualities:");
      sortedStreams(source.streams).forEach((st) => console.log(`  ${describeStream(st)}`));
      if (source.audios.length) {
        console.log("Audio tracks:");
        source.audios.forEach((a) => console.log(`  [${a.groupId}] ${describeAudio(a)}${a.isDefault ? " default" : ""}`));
      }
      return;
    }
    const stream = pickStream(source.streams, opts.quality);
    videoUri = stream.uri;
    audio = pickAudio(source.audios, stream, opts.audio);
    log(`Selected video: ${describeStream(stream)}\n`);
    if (audio) log(`Selected audio: ${describeAudio(audio)}\n`);
    if (audioChoices(source.audios, stream).length > 1 && !opts.audio) log(`(use -a <lang> to pick another audio track)\n`);
  } else if (opts.list) {
    console.log("Single-quality media playlist (no variants to choose from).");
    return;
  }

  const tracks = await prepareTracks(videoUri, audio, opts.retries);
  if (tracks.some((t) => t.live)) log("warning: live stream; downloading the current window only\n");

  const dir = path.resolve(opts.dir);
  const output = uniquePath(
    opts.output ? path.resolve(dir, opts.output) : path.join(dir, `${defaultName(source.uri)}.mp4`),
  );
  if (!opts.keepTs && !hasFfmpeg()) log("warning: ffmpeg not found; saving raw track files instead of .mp4\n");

  const started = Date.now();
  let bytes = 0;
  const { files, muxed } = await runDownload({
    tracks,
    output,
    keepTs: opts.keepTs,
    concurrency: opts.concurrency,
    retries: opts.retries,
    onPhase: (phase) => phase === "mux" && log("Muxing with ffmpeg...\n"),
    onProgress: (i, done, total, b) => {
      bytes += b;
      const pct = ((done / total) * 100).toFixed(1);
      const speed = (bytes / 1048576 / Math.max((Date.now() - started) / 1000, 0.001)).toFixed(1);
      log(`\r${tracks[i].kind}: ${done}/${total} segments  ${pct}%  ${(bytes / 1048576).toFixed(1)} MB  ${speed} MB/s   `);
      if (done === total) log("\n");
    },
  });
  files.forEach((f) => console.log(f));
  if (!muxed && !opts.keepTs) log("(install ffmpeg to get a single .mp4)\n");
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

  if (values.help) return void process.stdout.write(HELP);
  if (positionals.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { interactive } = await import("./interactive");
      return interactive();
    }
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }
  if (values.output && positionals.length > 1) throw new Error("--output can only be used with a single URL");

  for (const h of values.header ?? []) {
    const i = h.indexOf(":");
    if (i <= 0) throw new Error(`invalid header "${h}", expected "Name: value"`);
    requestHeaders[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (values.referer) setReferer(values.referer);

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

  // Ctrl-C exits; the engine's exit hook removes temp folders and partial files.
  process.on("SIGINT", () => process.exit(130));

  let failures = 0;
  for (const url of positionals) {
    try {
      await downloadOne(url, opts);
    } catch (error) {
      failures++;
      log(`\nerror: ${url}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  process.exitCode = failures ? 1 : 0;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
