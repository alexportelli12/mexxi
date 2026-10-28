// Text patterns behind every metric. The ones marked "retro" are copied from
// scripts/retro/session_retro.py, which /irrifletti and
// docs/where-the-problems-come-from.md use, so the numbers stay comparable;
// patterns.test.mjs fails if a copy drifts from the Python source. The rest are
// new to this research and are defined in METHOD.md.

// retro: ZSH_PITFALL_RE
export const ZSH_PITFALL = /\(eval\):\d+: (no matches found|bad pattern|parse error|bad substitution|=+ not found)/;
// retro: EXIT_CODE_RE
export const EXIT_CODE = /Exit code ([1-9]\d*)/;
// retro: MASKED_FAILURE_RE
export const MASKED_FAILURE = /(?i:\bexit(?:ed)?(?: code| status)?\W{1,3}[1-9])|\bFAIL(?:ED)?\b|\b[1-9]\d* (?:failed|failing)\b|\bfail [1-9]|error TS\d+|npm ERR!|\u2716|\u2717/;
// retro: VERIFY_RE
export const VERIFY = /(?:^|[;&|(]\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:verify|test|build|lint|typecheck|check|e2e)\b|(?:npx\s+)?(?:vitest|jest|pytest|tsc|eslint|ruff|mypy|vfk|verifika|playwright test|prettier)\b|cargo (?:test|build|clippy)\b|go (?:test|build|vet)\b|shopify theme check\b)/;
// retro: FOLLOW_UP_RE
export const FOLLOW_UP = /^\s*(<pasted_content[^>]*>\s*)?(follow[- ]up|review fixes|one more|small follow|phase \d+ looks)/i;
// retro: CORRECTION_RE
export const CORRECTION = /^\s*(no|nope|nah|stop|wait)\b|\bwrong\b|\bthat'?s not\b|\bthat is not\b|\bI said\b|\bI asked\b|\bdid ?n[o']t ask\b|\bnot what I\b|\bwhy did you\b|\bundo\b|\brevert (that|this|it)\b|\bstill (broken|failing|not)\b|\bdoesn'?t work\b/i;
// retro: ERRORISH_RE
export const ERRORISH = /error|fail|not found|denied|cannot|can't|unable|invalid|refus|missing|exceeded|no such|not a |fatal/i;
// retro: CATEGORY_PATTERNS (timeout, missing_package, command_not_found)
export const CATEGORY = {
  timeout: /timed out|Timeout \d+ms exceeded|ETIMEDOUT|deadline exceeded/i,
  missingPackage: /ModuleNotFoundError|No module named|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|package .* (is )?not (found|installed)|Unable to locate package|could not find .*executable|E404|npm ERR! 404/i,
  commandNotFound: /command not found|not found in PATH|No such file or directory.*(bin|exec)|is not recognized as/i,
};
// retro: ERROR_FAMILIES["edit_before_read"], the harness's own refusal
export const EDIT_REFUSED = /File has not been read yet|modified since read/;

// New: a server could not bind its port.
export const PORT_CLASH = /EADDRINUSE|address already in use|\bport \d+ is (?:already )?in use|is already used, make sure that nothing is running on the port/i;

// New: the reply claims checks pass. Anchored on a check noun followed closely
// by a passing verb, or a few fixed phrases.
export const DONE_CLAIM = /\b(?:all\s+)?(?:(?:unit|e2e|the)\s+)?(?:tests?|checks?|specs?|verify|verification|lint(?:ing)?|typecheck|type-check|build|gates?|suite)\b[^.\n]{0,40}?(?:\bpass(?:es|ed|ing)?\b|\bgreen\b|\bsucceed(?:s|ed)?\b|\b(?:is|are|was|were|comes back|came back) clean\b)|\ball green\b/i;
// New: the same sentence negates or hedges the claim ("tests don't pass yet").
export const CLAIM_NEGATED = /n't\b|\b(?:not|never|no|fail(?:s|ed|ing)?|until|once|before|if|whether|should|will|would|could|may|might|to make|then|but|except|baseline|preflight|previously|earlier|on main)\b|'ll\b/i;
// New: a partial count such as "5 of 6 checks pass" is a report, not a claim.
export const PARTIAL_COUNT = /\b(\d+)\s*(?:of|\/)\s*(\d+)\b/g;

// New: edits outside the work itself (scratch files, evidence, pull-request
// bodies, agent memory) do not make earlier checks stale.
export const SIDE_FILE = /^\/tmp\/|\/scratchpad\/|\.evidence\/|\/\.claude\/|\/memory\/|(?:^|\/)(?:pr-body|commit-msg|request|contract)[\w.-]*\.(?:md|txt)$/;

// New: a prompt that asks for rework. Used only on prompts that follow a reply
// claiming the work was done (see METHOD.md).
export const REWORK = /\b(?:fix|redo|re-do|still|again|broken|doesn'?t work|didn'?t work|not working|wrong|missing|you missed|forgot|regress\w*|revert)\b/i;
// New: a reply says the work is finished, with or without a checks claim.
export const DONE_REPLY = /\b(?:done|finished|complete[d]?|implemented|fixed|ready for review|pull request (?:is )?(?:open|ready)|PR (?:is )?(?:open|ready)|opened (?:a |the )?(?:draft )?(?:pull request|PR))\b/i;

// New: a check's outcome read back from a log or output file, as agents do
// for background runs (`tail .../tasks/<id>.output`). ibni's JSON, verifika's
// summary line and node:test's footer are recognised.
export const CHECK_OUTCOME_PASS = /"operation":\s*"verify"[\s\S]{0,600}?"passed":\s*true|\bPASS \d+\/\d+|^\S*\s*fail 0$|^\s*Tests\s+(\d+) passed \(\1\)|TOTAL: \d+ SUCCESS|\bVERIFY (?:PASS|OK|SUCCESS)|^\s*\d+ passed \([\d.]+m?s\)$/m;
// New: failure shown in a check's output whose call still exited 0. Narrower
// than MASKED_FAILURE, whose bare FAIL also matches test names and logs.
export const CHECK_OUTPUT_FAILED = /(?i:\bexit(?:ed)?(?: code| status)?\W{1,3}[1-9])|\b[1-9]\d* (?:failed|failing)\b|error TS\d+|npm ERR!|^\S*\s*fail [1-9]\d*$/m;

// verifika's and verify-runner's per-check lines: two or more ticks and no cross.
export const CHECK_TICKS = /✓ [\w:-]+\s+✓ [\w:-]+/;
export const CHECK_CROSS = /[✖✗✘]/;
export const CHECK_OUTCOME_FAIL = /"operation":\s*"verify"[\s\S]{0,600}?"passed":\s*false|\bFAIL \d+\/\d+|^\S*\s*fail [1-9]\d*$|TOTAL: \d+ FAILED|\bVERIFY FAIL|^\s*\d+ failed$/m;

// New: runs whose success also counts as verification for a done claim,
// beyond the retro's VERIFY: ibni's own gate and evidence steps, Angular's CLI,
// local binaries, npx with flags and repository check or build scripts. CI
// polling (gh pr checks) is left out: it exits non-zero while checks are
// pending, which would read as a failure.
export const EXTRA_VERIFY = /(?:^|[;&|(]\s*)(?:(?:ibni|implementation-workspace) (?:verify|record-evidence)|node --test|(?:npx\s+(?:--?[\w-]+\s+)*)?ng (?:test|lint|build)|(?:\S*node_modules\/\.bin\/|npx\s+(?:--?[\w-]+\s+)+)(?:vitest|jest|tsc|eslint|playwright test|prettier)|node \S*(?:verify|check|build|test)[\w-]*\.m?[jt]s|git diff --check)\b/;

// retro: command_skeleton. Heredoc bodies and quoted strings are dropped so
// patterns match commands, not data.
export function commandSkeleton(command) {
  return command.split("<<", 1)[0].replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

// retro: normalize_command
export function normalizeCommand(command) {
  return command.trim().replace(/^\s*cd \S+ && /, "").split(/\s+/).join(" ");
}

// New: drops only the heredoc bodies and keeps what follows them. Agents often
// edit with `python3 - <<'EOF' ... EOF` and run the tests on the next line;
// commandSkeleton cuts at `<<` and would miss that run, so the done-claim
// metric uses this instead (METHOD.md explains the difference).
export function withoutHeredocs(command) {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, "<<HEREDOC");
}

// New: a Bash call that changes files itself rather than through the edit
// tools: a scripted rewrite, sed -i, or a redirect into a source file.
export const SHELL_EDIT = /\bpython3?\s+-\s*<<|\bnode\s+-\s*<<|\bsed\s+-i\b|\bperl\s+-p?i\b|(?:^|[^>2&])>\s*(?!\/dev\/|\/tmp\/)[\w./-]+\.(?:[cm]?[jt]sx?|json|css|scss|less|html|md|ya?ml|py)\b|\bgit (?:apply|checkout --|restore)\b/;

// Each simple command of a call, without leading VAR=value assignments.
const lines = (command) => withoutHeredocs(command).split(/\n|&&|\|\||;/)
  .map((part) => normalizeCommand(part).replace(/^(?:\w+=\S*\s+|timeout\s+\d+\w?\s+|fnm exec(?:\s+--?[\w-]+(?:[= ][\w.]+)?)*\s+|env\s+|time\s+)+/, ""));

export function isVerifyCommand(command) {
  return lines(command).some((part) => {
    const skeleton = commandSkeleton(part);
    return VERIFY.test(skeleton) || EXTRA_VERIFY.test(skeleton);
  });
}

export function isShellEdit(command) {
  return SHELL_EDIT.test(command.split("\n", 1)[0]) || lines(command).some((part) => SHELL_EDIT.test(part));
}
