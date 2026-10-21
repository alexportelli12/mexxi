import { cleanOutput, git, run } from "./git.mjs";

// A repository opts in to baseline reuse by committing .mexxi.json, which names
// the CI check that runs its full `npm run verify`. Verifika's own schema
// rejects extra keys, so the opt-in lives in this small file instead; it is read
// from the base commit, so only what the default branch already holds counts.
export const OPT_IN_FILE = ".mexxi.json";

const SHA = /^[0-9a-f]{40}$/i;

async function namedCheck(root, baseSha) {
  const result = await git(root, ["show", `${baseSha}:${OPT_IN_FILE}`], { allowedExitCodes: [0, 128] });
  if (result.code !== 0) return { reason: `${OPT_IN_FILE} is not committed on the default branch` };
  try {
    const { ciCheck } = JSON.parse(result.stdout);
    if (typeof ciCheck === "string" && ciCheck.trim()) return { check: ciCheck.trim() };
  } catch {
    return { reason: `${OPT_IN_FILE} is not valid JSON` };
  }
  return { reason: `${OPT_IN_FILE} does not name a ciCheck` };
}

// Decides whether the baseline `npm run verify` can be cited instead of rerun.
// Only a completed, successful run of the named check on exactly baseSha
// qualifies. Everything else (no opt-in, a gh failure, a pending, failed or
// differently-pinned run) reports why and leaves the baseline to run locally.
export async function provenBaseline(root, baseSha) {
  const { check, reason } = await namedCheck(root, baseSha);
  if (!check) return { reused: false, reason };
  let parsed;
  try {
    const result = await run("gh", [
      "api",
      `repos/{owner}/{repo}/commits/${baseSha}/check-runs?check_name=${encodeURIComponent(check)}&filter=latest&per_page=100`,
    ], { cwd: root, timeout: 30_000 });
    parsed = JSON.parse(cleanOutput(result));
  } catch (error) {
    return { reused: false, check, reason: `CI check state unavailable: ${error.message.split("\n")[0]}` };
  }
  const runs = (Array.isArray(parsed?.check_runs) ? parsed.check_runs : [])
    .filter((candidate) => candidate?.name === check && SHA.test(candidate?.head_sha ?? "")
      && candidate.head_sha.toLowerCase() === baseSha.toLowerCase())
    .sort((a, b) => b.id - a.id);
  const latest = runs[0];
  if (!latest) return { reused: false, check, reason: `no ${check} run on ${baseSha}` };
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    return { reused: false, check, reason: `${check} on ${baseSha} is ${latest.status === "completed" ? latest.conclusion : latest.status}` };
  }
  return { reused: true, check, sha: latest.head_sha, url: latest.html_url ?? null, runId: latest.id, completedAt: latest.completed_at ?? null };
}
