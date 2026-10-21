import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { ASSETS, VALE_VERSION, assetFor, ensureVale } from "./vale.mjs";

const temporary = [];
const scratch = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mexxi-vale-"));
  temporary.push(directory);
  return directory;
};
after(() =>
  Promise.all(temporary.map((directory) => rm(directory, { recursive: true, force: true }))),
);

// A tarball holding a fake `vale` script, and the asset table pointed at its hash.
async function fakeRelease(platform = "linux", arch = "x64") {
  const directory = await scratch();
  await writeFile(path.join(directory, "vale"), "#!/bin/sh\necho fake\n");
  const name = assetFor(platform, arch).name.replace(/\.zip$/, ".tar.gz");
  execFileSync("tar", ["-czf", path.join(directory, name), "-C", directory, "vale"]);
  return readFile(path.join(directory, name));
}

const respondWith =
  (body, calls = []) =>
  async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status: 200 });
  };

test("every supported platform maps to a release asset with a SHA-256", () => {
  assert.equal(assetFor("linux", "x64").name, `vale_${VALE_VERSION}_Linux_64-bit.tar.gz`);
  assert.equal(assetFor("darwin", "arm64").name, `vale_${VALE_VERSION}_macOS_arm64.tar.gz`);
  assert.equal(assetFor("win32", "x64").name, `vale_${VALE_VERSION}_Windows_64-bit.zip`);
  for (const asset of Object.values(ASSETS)) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
});

test("an unsupported platform is rejected with the supported list", () => {
  assert.throws(() => assetFor("freebsd", "x64"), /No Vale .* for freebsd-x64.*linux-x64/);
  assert.throws(() => assetFor("win32", "arm64"), /win32-arm64/);
});

test("a checksum mismatch rejects and leaves no cached binary", async (t) => {
  if (process.platform === "win32") return t.skip("fake tarball asserts POSIX layout");
  const cacheRoot = await scratch();
  await assert.rejects(
    ensureVale({
      cacheRoot,
      platform: "linux",
      arch: "x64",
      fetchImpl: respondWith("not the real archive"),
    }),
    /Checksum mismatch/,
  );
  assert.deepEqual(await readdir(cacheRoot), []);
});

test("a failed download rejects without caching", async () => {
  const cacheRoot = await scratch();
  await assert.rejects(
    ensureVale({
      cacheRoot,
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => new Response("rate limited", { status: 403 }),
    }),
    /status 403/,
  );
  assert.deepEqual(await readdir(cacheRoot), []);
});

test("a verified download is extracted once, then reused without downloading", async (t) => {
  if (process.platform === "win32") return t.skip("fake tarball asserts POSIX layout");
  const archive = await fakeRelease();
  const hash = createHash("sha256").update(archive).digest("hex");
  const original = ASSETS["linux-x64"].sha256;
  ASSETS["linux-x64"].sha256 = hash; // the fake archive stands in for the pinned release
  t.after(() => {
    ASSETS["linux-x64"].sha256 = original;
  });

  const cacheRoot = await scratch();
  const calls = [];
  const options = {
    cacheRoot,
    platform: "linux",
    arch: "x64",
    fetchImpl: respondWith(archive, calls),
    token: "secret",
  };
  const binary = await ensureVale(options);
  assert.ok(existsSync(binary));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/github\.com\/vale-cli\/vale\/releases\/download\//);
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");

  assert.equal(await ensureVale(options), binary);
  assert.equal(calls.length, 1, "the second call must reuse the cache");
  assert.deepEqual(await readdir(path.join(cacheRoot, VALE_VERSION)), ["linux-x64"]);
});
