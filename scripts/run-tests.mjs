import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testsDirectory = join(projectRoot, "tests");
const outputDirectory = await mkdtemp(join(tmpdir(), "delivery-status-api-tests-"));

try {
  const entryPoints = (await readdir(testsDirectory))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => join(testsDirectory, file));

  if (entryPoints.length === 0) {
    throw new Error("No tests matching tests/*.test.ts were found");
  }

  await build({
    entryPoints,
    outdir: outputDirectory,
    bundle: true,
    platform: "node",
    format: "esm",
    sourcemap: "inline",
    logLevel: "silent",
  });

  const testFiles = (await readdir(outputDirectory))
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => join(outputDirectory, file));

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...testFiles], {
      cwd: projectRoot,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Test runner terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
