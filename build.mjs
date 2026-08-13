// Builds standalone single-file bundles for hosts/install paths that cannot
// resolve the shared core import (manual extension-dir installs).
// The omp/pi plugin-package routes use the TypeScript sources directly.
import { build } from "esbuild";

const shared = { bundle: true, logLevel: "warning" };

await build({
	...shared,
	platform: "node",
	format: "esm",
	entryPoints: ["adapters/omp/file-size-guard.ts"],
	outfile: "dist/omp/file-size-guard.js",
});

// pi's extension loader uses a CJS require stack.
await build({
	...shared,
	platform: "node",
	format: "cjs",
	entryPoints: ["adapters/pi/file-size-guard.ts"],
	outfile: "dist/pi/file-size-guard.cjs",
});

await build({
	...shared,
	platform: "node",
	format: "esm",
	entryPoints: ["adapters/opencode/file-size-guard.ts"],
	outfile: "dist/opencode/file-size-guard.js",
});

await build({
	...shared,
	platform: "node",
	format: "esm",
	banner: { js: "#!/usr/bin/env node" },
	entryPoints: ["bin/fsg.ts"],
	outfile: "dist/bin/fsg.js",
});

console.log("dist built: omp (esm), pi (cjs), opencode (esm), cli (bin/fsg.js)");
