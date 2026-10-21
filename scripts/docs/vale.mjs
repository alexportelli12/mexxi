#!/usr/bin/env node
// Runs Vale for the `prose` check. The binary is not an npm dependency: the
// @vvago/vale package downloads it in a postinstall through GitHub's REST API,
// which allows 60 unauthenticated requests an hour per IP, so shared CI runners
// failed `npm ci` with a 403. This downloads the pinned release from the plain
// release URL instead, which that limit does not cover, only when the prose
// check first runs, and verifies the SHA-256 below before it keeps anything.
//
// To bump Vale, change VALE_VERSION and take the hashes from
// https://github.com/vale-cli/vale/releases/download/v<version>/vale_<version>_checksums.txt
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VALE_VERSION = "3.24.0";

// Keyed by `${process.platform}-${process.arch}`.
export const ASSETS = {
  "linux-x64": {
    name: `vale_${VALE_VERSION}_Linux_64-bit.tar.gz`,
    sha256: "867534ddb678abca7f214bc4706ead0922bd5252ffe8035fc227013f66c8b214",
  },
  "linux-arm64": {
    name: `vale_${VALE_VERSION}_Linux_arm64.tar.gz`,
    sha256: "104cbd349279e50c4cb40adb70adf345d93cc4a3a0191f9e68bdccb97086b582",
  },
  "darwin-x64": {
    name: `vale_${VALE_VERSION}_macOS_64-bit.tar.gz`,
    sha256: "eeb39e86f1daac27cc2a77fef3af1824d50559bdc22329fb25fb921c80c79472",
  },
  "darwin-arm64": {
    name: `vale_${VALE_VERSION}_macOS_arm64.tar.gz`,
    sha256: "87b513f26499f6657c15cf7175ba5b058a7c1ff2bb2d4e07265db2dd43451e44",
  },
  "win32-x64": {
    name: `vale_${VALE_VERSION}_Windows_64-bit.zip`,
    sha256: "3a8884774973b6f2826877e1c6388a5feae4704ef88a9a9c912c77ce186990f3",
  },
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOWNLOAD_BASE = "https://github.com/vale-cli/vale/releases/download";

export function assetFor(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(
      `No Vale ${VALE_VERSION} release for ${platform}-${arch}. Supported: ${Object.keys(ASSETS).join(", ")}.`,
    );
  }
  return asset;
}

export function binaryPath(cacheDir, platform = process.platform) {
  return path.join(cacheDir, platform === "win32" ? "vale.exe" : "vale");
}

// Returns the path of the cached Vale binary, downloading and verifying it
// first when it is missing. Nothing reaches `cacheDir` unless the hash matched.
export async function ensureVale({
  cacheRoot = path.join(repoRoot, "node_modules", ".cache", "vale"),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  baseUrl = `${DOWNLOAD_BASE}/v${VALE_VERSION}`,
  token = process.env.GITHUB_TOKEN,
} = {}) {
  const cacheDir = path.join(cacheRoot, VALE_VERSION, `${platform}-${arch}`);
  const binary = binaryPath(cacheDir, platform);
  if (existsSync(binary)) return binary;

  const asset = assetFor(platform, arch);
  const url = `${baseUrl}/${asset.name}`;
  // Sent only to the release host: fetch drops it when a redirect leaves the origin.
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetchImpl(url, { headers, redirect: "follow" });
  if (!response.ok) throw new Error(`Downloading ${url} failed with status ${response.status}.`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(
      `Checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}. Refusing to use it.`,
    );
  }

  // Extract beside the target and rename, so an interrupted run never leaves a
  // half-written binary where the cache check would trust it.
  await mkdir(path.dirname(cacheDir), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(cacheDir), ".staging-"));
  try {
    const archivePath = path.join(staging, asset.name);
    await writeFile(archivePath, archive);
    const extracted = path.join(staging, "out");
    await mkdir(extracted);
    // System tar (bsdtar on Windows 10+ and macOS, GNU tar on Linux) reads both formats.
    const result = spawnSync("tar", ["-xf", archivePath, "-C", extracted], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new Error(`Extracting ${asset.name} failed: ${result.error?.message ?? result.stderr}`);
    }
    if (!existsSync(binaryPath(extracted, platform))) {
      throw new Error(`${asset.name} did not contain ${path.basename(binary)}.`);
    }
    await rm(cacheDir, { recursive: true, force: true });
    await rename(extracted, cacheDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return binary;
}

async function main() {
  const binary = await ensureVale();
  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
