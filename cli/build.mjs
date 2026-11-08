import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreSrc = path.resolve(here, "../src/core/src");

// The extension imports compiled core from `@hls-downloader/core/lib/*`;
// point those imports at the TypeScript sources so no workspace build is needed.
const coreSourcePlugin = {
  name: "core-source",
  setup(b) {
    b.onResolve({ filter: /^@hls-downloader\/core\/lib(\/.*)?$/ }, (args) => {
      const sub = args.path.replace(/^@hls-downloader\/core\/lib\/?/, "");
      return b.resolve("./" + (sub || "index"), {
        resolveDir: coreSrc,
        kind: args.kind,
      });
    });
  },
};

await build({
  entryPoints: [path.join(here, "src/index.ts")],
  outfile: path.join(here, "dist/hls-dl.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  nodePaths: [path.join(here, "node_modules")],
  plugins: [coreSourcePlugin],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
