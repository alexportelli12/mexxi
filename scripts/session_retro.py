#!/usr/bin/env python3
"""Extract friction signals from Claude Code session transcripts.

Reads ~/.claude/projects/*/*.jsonl (top-level sessions only; subagent
transcripts in nested directories are counted but not analysed) and writes
aggregate counts to a JSON file. Raw transcript content never leaves this
script except as short, redacted snippets (<= SNIPPET_LEN chars), so the
output is safe to commit after a final human check.

Usage: python3 -I scripts/session_retro.py [--projects-dir DIR] [--out FILE]
"""

from __future__ import annotations

import argparse
import collections
import difflib
import glob
import json
import os
import re
from datetime import datetime

SNIPPET_LEN = 100
HOME = os.path.expanduser("~")

# Thresholds. Tuned so each signal flags a handful of sessions, not all of them.
RETRY_MIN = 3
NEAR_DUP_RATIO = 0.9
REREAD_MIN = 4
SWEEP_MIN = 6
LOOP_MIN_CYCLES = 2
SLOW_TOOL_SECONDS = 120
GAP_SECONDS = 300

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[abpors]-[A-Za-z0-9-]{10,}"),
    re.compile(r"shp(at|ss|ca|pa)_[A-Fa-f0-9]{16,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)\b([A-Z0-9_]*(?:key|token|secret|password|passwd|pwd)[A-Z0-9_]*)\s*[=:]\s*\S+"),
    # Long opaque tokens: mixed letters and digits, no path separators.
    re.compile(r"\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b"),
]

CATEGORY_PATTERNS = {
    "command_not_found": re.compile(r"command not found|not found in PATH|No such file or directory.*(bin|exec)|is not recognized as", re.I),
    "missing_package": re.compile(r"ModuleNotFoundError|No module named|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|package .* (is )?not (found|installed)|Unable to locate package|could not find .*executable|E404|npm ERR! 404", re.I),
    "permission": re.compile(r"Permission denied|EACCES|EPERM|Operation not permitted|sudo:|requires root|must be run as root|a password is required", re.I),
    "timeout": re.compile(r"timed out|Timeout \d+ms exceeded|ETIMEDOUT|deadline exceeded", re.I),
    "network": re.compile(r"ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve host|Network is unreachable|fetch failed|socket hang up|HTTP\S* 50[234]|50[234] (Bad Gateway|Service Unavailable|Gateway Timeout)|rate limit exceeded|429 Too Many", re.I),
}

# Named failure families seen in this machine's transcripts; matched against
# failed tool results of any tool to give stable counts for the report.
ERROR_FAMILIES = {
    "edit_before_read": re.compile(r"File has not been read yet|modified since read"),
    "read_too_large": re.compile(r"exceeds maximum allowed tokens"),
    "playwright_outside_allowed_roots": re.compile(r"outside allowed roots"),
    "playwright_locator_timeout": re.compile(r"Timeout \d+ms exceeded"),
    "implementation_workspace": re.compile(r"Implementation workspace error|command not found: implementation-workspace"),
    "harness_sleep_block": re.compile(r"Blocked: sleep"),
    "missing_binary_or_module": re.compile(r"command not found|magick not found|No module named|ERR_MODULE_NOT_FOUND|Cannot find package"),
}

# Classifier and safety-check rejections are counted from permissionDecision
# entries; tool results only add explicit user rejections.
USER_DENIAL_RE = re.compile(r"doesn't want to proceed|tool use was rejected", re.I)
CLASSIFIER_DOWN_RE = re.compile(r"classifier gave no verdict", re.I)
# zsh aborts just the offending segment of a `;`-joined command, so these often
# appear in "successful" results; they are matched in every Bash output.
ZSH_PITFALL_RE = re.compile(r"\(eval\):\d+: (no matches found|bad pattern|parse error|bad substitution|=+ not found)")
HARNESS_BLOCK_RE = re.compile(r"^(<[^>]+>)?Blocked: ")
AUTO_MODE_DENIAL_RE = re.compile(r"^(<[^>]+>)?Permission for this (action|command) was denied")
INTERRUPT_RE = re.compile(r"\[Request interrupted by user")
# Strong: the user is telling the agent it went wrong. Soft: steering words that
# also appear in ordinary follow-up requests, so they are reported separately.
CORRECTION_RE = re.compile(
    r"^\s*(no|nope|nah|stop|wait)\b|\bwrong\b|\bthat'?s not\b|\bthat is not\b|\bI said\b|\bI asked\b|\bdid ?n[o']t ask\b|\bnot what I\b|\bwhy did you\b|\bundo\b|\brevert (that|this|it)\b|\bstill (broken|failing|not)\b|\bdoesn'?t work\b",
    re.I,
)
SOFT_CORRECTION_RE = re.compile(r"\binstead\b|\bdon'?t\b|\bactually\b|\brather than\b", re.I)
FOLLOW_UP_RE = re.compile(r"^\s*(<pasted_content[^>]*>\s*)?(follow[- ]up|review fixes|one more|small follow|phase \d+ looks)", re.I)
# Anchored to the start of a shell segment so `ls skills/verifika` is not a run.
VERIFY_RE = re.compile(
    r"(?:^|[;&|(]\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:verify|test|build|lint|typecheck|check|e2e)\b|(?:npx\s+)?(?:vitest|jest|pytest|tsc|eslint|ruff|mypy|vfk|verifika|playwright test|prettier)\b|cargo (?:test|build|clippy)\b|go (?:test|build|vet)\b|shopify theme check\b)",
)
SEARCH_BASH_RE = re.compile(r"^\s*(cd \S+ && )?(find|bfs|fd|grep|rg|ag|ls|tree|locate)\b")
EXIT_CODE_RE = re.compile(r"Exit code ([1-9]\d*)")
# Failure text in output whose tool call still "succeeded", usually because the
# agent wrote `cmd > log; echo exit $?` or piped through tail/grep.
MASKED_FAILURE_RE = re.compile(r"(?i:\bexit(?:ed)?(?: code| status)?\W{1,3}[1-9])|\bFAIL(?:ED)?\b|\b[1-9]\d* (?:failed|failing)\b|\bfail [1-9]|error TS\d+|npm ERR!|\u2716|\u2717")
POLL_RE = re.compile(r"^(sleep \d+[;&]+\s*)?(tail|cat|head|grep|ls)\b|until |while |gh (pr|run) (checks|view|watch)")
ERRORISH_RE = re.compile(r"(?i)error|fail|not found|denied|cannot|can't|unable|invalid|refus|missing|exceeded|no such|not a |fatal")


def redact(text: str) -> str:
    text = shorten_paths(text)
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text


def shorten_paths(text: str) -> str:
    text = text.replace(HOME, "~")
    return re.sub(r"~/\.local/share/opencode/implementation-worktrees/[\w.-]+/", "<worktrees>/", text)


def snippet(text: str) -> str:
    one_line = " ".join(text.split())
    return redact(one_line)[:SNIPPET_LEN]


def normalize_error(text: str) -> str:
    """Collapse an error to a stable key: first meaningful line, variable parts masked."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    prefix = ""
    if lines and re.fullmatch(r"Exit code \d+", lines[0]):
        prefix, lines = "Exit code N: ", lines[1:]
    # Skip markdown headers ("### Error") and prefer the first line that reads
    # like an error; otherwise the last line, where most tools put the cause.
    lines = [l for l in lines if not l.startswith("#")] or lines
    errorish = [l for l in lines if ERRORISH_RE.search(l)]
    line = prefix + (errorish[0] if errorish else (lines[-1] if lines else "(no output)"))
    line = re.sub(r"<[^>]+>", "", line)
    line = shorten_paths(line)
    line = re.sub(r"(~|/)[\w./@+-]+", "<path>", line)
    line = re.sub(r"\b[0-9a-f]{7,}\b", "<hex>", line)
    line = re.sub(r"\d+", "N", line)
    line = re.sub(r"(['\"`]).*?\1", "<q>", line)
    return redact(line.strip())[:140]


def normalize_command(cmd: str) -> str:
    cmd = re.sub(r"^\s*cd \S+ && ", "", cmd.strip())
    return " ".join(cmd.split())


def command_skeleton(cmd: str) -> str:
    """Drop heredoc bodies and quoted strings so patterns match commands, not data."""
    cmd = cmd.split("<<", 1)[0]
    return re.sub(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"", "''", cmd)


def content_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
                elif item.get("type") == "tool_result":
                    parts.append(content_text(item.get("content")))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return ""


def parse_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def is_human_prompt(entry, text: str) -> bool:
    if entry.get("isMeta") or entry.get("isSidechain"):
        return False
    if not text.strip():
        return False
    markers = ("<command-", "<local-command", "<task-notification", "<system-reminder", "Base directory for this skill", "Caveat:", "This session is being continued")
    return not text.lstrip().startswith(markers)


def project_label(cwd: str | None, dirname: str) -> str:
    return (cwd or dirname).replace(HOME, "~")


class Session:
    def __init__(self, path: str):
        self.path = path
        self.id = os.path.basename(path)[:-6]
        self.short = self.id[:8]
        self.dirname = os.path.basename(os.path.dirname(path))
        self.cwd = None
        self.start = self.end = None
        self.tool_uses = {}  # id -> (name, input, ts)
        self.events = []  # ordered: ("use", id) / ("result", id, is_error, text, ts) / ("prompt", text) / ("compact",)
        self.titles = []
        self.seen = set()

    def load(self):
        with open(self.path, encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                self._ingest(entry)

    def _ingest(self, entry):
        # Resumed sessions replay earlier lines; count each entry once.
        uuid = entry.get("uuid")
        if uuid:
            if uuid in self.seen:
                return
            self.seen.add(uuid)
        ts = parse_ts(entry.get("timestamp"))
        if ts:
            self.start = ts if self.start is None or ts < self.start else self.start
            self.end = ts if self.end is None or ts > self.end else self.end
        if entry.get("cwd") and not self.cwd:
            self.cwd = entry["cwd"]
        etype = entry.get("type")
        if etype == "ai-title" and entry.get("aiTitle"):
            self.titles.append(entry["aiTitle"])
        if etype == "system" and entry.get("subtype") == "compact_boundary":
            self.events.append(("compact",))
            return
        if entry.get("permissionDecision", {}).get("decision") == "reject":
            self.events.append(("deny_config", entry["permissionDecision"].get("reasonType", "")))
        message = entry.get("message")
        if not isinstance(message, dict):
            return
        content = message.get("content")
        if etype == "assistant" and isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "tool_use":
                    self.tool_uses[item["id"]] = (item.get("name", "?"), item.get("input") or {}, ts)
                    self.events.append(("use", item["id"]))
                elif isinstance(item, dict) and item.get("type") == "text" and item.get("text", "").strip():
                    self.events.append(("assistant_text", item["text"]))
        elif etype == "user":
            if isinstance(content, list) and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "tool_result":
                        text = content_text(item.get("content"))
                        self.events.append(("result", item.get("tool_use_id"), bool(item.get("is_error")), text, ts))
            else:
                text = content_text(content)
                if INTERRUPT_RE.search(text):
                    self.events.append(("interrupt",))
                elif is_human_prompt(entry, text):
                    self.events.append(("prompt", text))


def analyse(sessions):
    errors = collections.Counter()
    error_sessions = collections.defaultdict(set)
    error_by_tool = collections.Counter()
    categories = collections.Counter()
    category_sessions = collections.defaultdict(set)
    category_examples = collections.defaultdict(collections.Counter)
    retries, rereads, sweeps, loops, slow_tools, gaps, user_waits = [], [], [], [], [], [], []
    denials, interrupts, corrections, soft_corrections, follow_ups, compactions, unfinished = [], [], [], [], [], [], []
    masked_failures, harness_blocks, classifier_down = [], [], []
    families = collections.Counter()
    zsh_hits = []
    family_sessions = collections.defaultdict(set)
    tool_totals = collections.Counter()
    per_session = []

    for s in sessions:
        sid = s.short
        counts = collections.Counter()
        commands = []  # (normalized, failed)
        reads = collections.Counter()
        sweep_run = 0
        verify_state = {}  # family -> {"cycles", "edited_since_fail", "failing"}
        session_loops = collections.Counter()
        last_result_ts = None
        last_event = None

        def bump(key, n=1):
            counts[key] += n

        results = {e[1]: e for e in s.events if e[0] == "result"}
        for event in s.events:
            kind = event[0]
            if kind == "use":
                name, inp, ts = s.tool_uses[event[1]]
                tool_totals[name] += 1
                # Only agent-side gaps: a human prompt in between resets the clock.
                if last_result_ts and ts:
                    gap = (ts - last_result_ts).total_seconds()
                    if gap >= GAP_SECONDS:
                        gaps.append({"session": sid, "seconds": int(gap), "before_tool": name})
                        bump("long_gaps")
                result = results.get(event[1])
                output = result[3] if result else ""
                if result and result[4] and ts:
                    dur = (result[4] - ts).total_seconds()
                    if name == "AskUserQuestion":
                        user_waits.append({"session": sid, "seconds": int(dur)})
                    elif dur >= SLOW_TOOL_SECONDS:
                        label = normalize_command(inp.get("command", ""))[:60] if name == "Bash" else name
                        slow_tools.append({"session": sid, "tool": name, "seconds": int(dur), "what": snippet(label)})
                        bump("slow_tools")
                failed = bool(result and (result[2] or (name == "Bash" and EXIT_CODE_RE.search(output[:200]))))
                is_search = name in ("Grep", "Glob") or (name == "Bash" and SEARCH_BASH_RE.match(inp.get("command", "")))
                if is_search:
                    sweep_run += 1
                else:
                    if sweep_run >= SWEEP_MIN:
                        sweeps.append({"session": sid, "length": sweep_run})
                        bump("search_sweeps")
                    sweep_run = 0
                if name == "Read" and inp.get("file_path"):
                    reads[inp["file_path"]] += 1
                if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                    for st in verify_state.values():
                        if st["failing"]:
                            st["edited_since_fail"] = True
                if name == "Bash":
                    cmd = normalize_command(inp.get("command", ""))
                    match = VERIFY_RE.search(command_skeleton(cmd))
                    if match and not failed and MASKED_FAILURE_RE.search(output):
                        masked_failures.append({"session": sid, "command": snippet(cmd)[:80]})
                        bump("masked_verify_failures")
                        failed = True
                    commands.append((cmd, failed))
                    if match:
                        family = re.sub(r"^[;&|(\s]+|\s+run\s+", " ", match.group(0).lower()).strip()
                        st = verify_state.setdefault(family, {"cycles": 0, "edited_since_fail": False, "failing": False})
                        if st["failing"] and st["edited_since_fail"]:
                            st["cycles"] += 1
                        st["failing"] = failed
                        st["edited_since_fail"] = False
                        if not failed:
                            if st["cycles"] >= LOOP_MIN_CYCLES:
                                session_loops[family] = max(session_loops[family], st["cycles"])
                            st["cycles"] = 0
            elif kind == "result":
                _, tid, is_error, text, ts = event
                last_result_ts = ts or last_result_ts
                name = s.tool_uses.get(tid, ("?",))[0]
                if is_error or (name == "Bash" and EXIT_CODE_RE.match(text.strip()[:20])):
                    head = text[:3000]
                    for family, pattern in ERROR_FAMILIES.items():
                        if pattern.search(head):
                            families[family] += 1
                            family_sessions[family].add(sid)
                            bump(family)
                if name == "Bash" and ZSH_PITFALL_RE.search(text):
                    silent = not (is_error or EXIT_CODE_RE.match(text.strip()[:20]))
                    zsh_hits.append({"session": sid, "silent": silent,
                                     "kind": ZSH_PITFALL_RE.search(text).group(1).lstrip("=") or "="})
                    bump("zsh_pitfall")
                if name != "AskUserQuestion" and USER_DENIAL_RE.search(text[:400]):
                    denials.append({"session": sid, "tool": name, "kind": "user_rejected"})
                    bump("denials")
                    continue
                if CLASSIFIER_DOWN_RE.search(text[:400]):
                    classifier_down.append({"session": sid})
                    bump("classifier_unavailable")
                    continue
                if AUTO_MODE_DENIAL_RE.search(text):
                    continue  # counted from the permissionDecision entry
                if HARNESS_BLOCK_RE.search(text):
                    harness_blocks.append({"session": sid, "message": normalize_error(text)[:90]})
                    bump("harness_blocks")
                    continue
                if is_error or (name == "Bash" and EXIT_CODE_RE.match(text.strip()[:20])):
                    key = normalize_error(text)
                    if is_error:
                        errors[(name, key)] += 1
                        error_sessions[(name, key)].add(sid)
                        error_by_tool[name] += 1
                        bump("tool_errors")
                    # Match only the head and tail of the output, where causes
                    # appear, so incidental words in dumped files don't count.
                    lines = text.splitlines()
                    focus = "\n".join(l for l in lines[:4] + lines[-6:] if ERRORISH_RE.search(l))
                    for cat, pattern in CATEGORY_PATTERNS.items():
                        if pattern.search(focus):
                            categories[cat] += 1
                            category_sessions[cat].add(sid)
                            category_examples[cat][key] += 1
                            bump(f"env_{cat}")
            elif kind == "deny_config":
                denials.append({"session": sid, "tool": "?", "kind": f"auto_mode_{event[1]}"})
                bump("denials")
            elif kind == "interrupt":
                interrupts.append({"session": sid})
                bump("interrupts")
                last_result_ts = None
            elif kind == "prompt":
                text = event[1]
                last_result_ts = None
                if FOLLOW_UP_RE.search(text):
                    follow_ups.append({"session": sid})
                    bump("follow_up_requests")
                elif len(text) < 1500 and CORRECTION_RE.search(text):
                    corrections.append({"session": sid, "snippet": snippet(text)})
                    bump("corrections")
                elif len(text) < 1500 and SOFT_CORRECTION_RE.search(text):
                    soft_corrections.append({"session": sid, "snippet": snippet(text)})
                    bump("soft_corrections")
            elif kind == "compact":
                compactions.append({"session": sid})
                bump("compactions")
            if kind not in ("deny_config",):
                last_event = event

        if sweep_run >= SWEEP_MIN:
            sweeps.append({"session": sid, "length": sweep_run})
            bump("search_sweeps")
        for family, st in verify_state.items():
            if st["cycles"] >= LOOP_MIN_CYCLES:
                session_loops[family] = max(session_loops[family], st["cycles"])
        for family, cycles in session_loops.items():
            loops.append({"session": sid, "command": family, "fail_edit_rerun_cycles": cycles})
            bump("verify_loops")

        for path, n in reads.items():
            if n >= REREAD_MIN:
                rereads.append({"session": sid, "file": redact(path)[-80:], "reads": n})
                bump("rereads")

        # Retries: exact or near-duplicate commands repeated RETRY_MIN+ times.
        clusters = []  # [representative, count, failures]
        for cmd, failed in commands:
            if not cmd:
                continue
            for cluster in clusters:
                rep = cluster[0]
                if rep == cmd or (abs(len(rep) - len(cmd)) < 40 and difflib.SequenceMatcher(None, rep, cmd).ratio() >= NEAR_DUP_RATIO):
                    cluster[1] += 1
                    cluster[2] += int(failed)
                    break
            else:
                clusters.append([cmd, 1, int(failed)])
        for rep, n, fails in clusters:
            if n >= RETRY_MIN:
                polling = bool(POLL_RE.search(rep))
                retries.append({"session": sid, "command": snippet(rep)[:80], "runs": n, "failed_runs": fails, "polling": polling})
                bump("retries")
                if fails >= 2:
                    bump("failing_retries")

        # Metadata-only sessions (no prompts or tool calls) are not "unfinished".
        reason = None
        if last_event is None:
            pass
        elif last_event[0] == "interrupt":
            reason = "interrupted"
        elif last_event[0] == "use":
            reason = "ended_mid_tool_call"
        elif last_event[0] == "result":
            reason = "ended_after_tool_result_without_reply"
        elif last_event[0] == "prompt":
            reason = "user_prompt_unanswered"
        elif last_event[0] == "assistant_text" and last_event[1].rstrip().endswith("?"):
            reason = "ended_awaiting_user_answer"
        if reason:
            unfinished.append({"session": sid, "reason": reason})
            bump("unfinished")

        duration = (s.end - s.start).total_seconds() / 60 if s.start and s.end else 0
        per_session.append({
            "session": sid,
            "project": project_label(s.cwd, s.dirname),
            "start": s.start.isoformat() if s.start else None,
            "minutes": round(duration, 1),
            "tool_calls": sum(1 for e in s.events if e[0] == "use"),
            "prompts": sum(1 for e in s.events if e[0] == "prompt"),
            "title": snippet(s.titles[-1]) if s.titles else None,
            "signals": dict(counts),
            "friction_score": friction_score(counts),
        })

    def top(counter, sessions_map=None, n=40):
        out = []
        for key, count in counter.most_common(n):
            tool, msg = key if isinstance(key, tuple) else (None, key)
            row = {"count": count, "message": msg}
            if tool:
                row["tool"] = tool
            if sessions_map is not None:
                row["sessions"] = len(sessions_map[key])
            out.append(row)
        return out

    def sessions_of(rows):
        return len({r["session"] for r in rows})

    return {
        "tool_errors": {
            "total": sum(error_by_tool.values()),
            "by_tool": dict(error_by_tool.most_common()),
            "top_normalized": top(errors, error_sessions),
        },
        "error_families": {f: {"occurrences": families[f], "sessions": len(family_sessions[f]),
                               "session_ids": sorted(family_sessions[f])} for f in ERROR_FAMILIES},
        "zsh_pitfalls": {"description": "zsh-only failures (unquoted globs such as grep --include=*.ts, leading = words)",
                         "total": len(zsh_hits), "sessions": sessions_of(zsh_hits),
                         "silent_in_successful_calls": sum(1 for z in zsh_hits if z["silent"]),
                         "by_kind": dict(collections.Counter(z["kind"] for z in zsh_hits))},
        "environment_failures": {
            cat: {"occurrences": categories[cat], "sessions": len(category_sessions[cat]),
                  "top_messages": [{"message": m, "count": c} for m, c in category_examples[cat].most_common(8)]}
            for cat in CATEGORY_PATTERNS
        },
        "bash_retries": {"total": len(retries), "sessions": sessions_of(retries),
                         "polling": sum(1 for r in retries if r["polling"]),
                         "with_2plus_failures": sum(1 for r in retries if r["failed_runs"] >= 2),
                         "items": sorted(retries, key=lambda r: -r["runs"])[:40]},
        "denials": {"total": len(denials), "sessions": sessions_of(denials),
                    "by_kind": dict(collections.Counter(d["kind"] for d in denials))},
        "auto_mode_classifier_unavailable": {"total": len(classifier_down), "sessions": sessions_of(classifier_down)},
        "harness_blocks": {"total": len(harness_blocks), "sessions": sessions_of(harness_blocks),
                           "messages": dict(collections.Counter(h["message"] for h in harness_blocks).most_common(10))},
        "masked_verify_failures": {"description": "verify/test/lint runs whose tool call succeeded but whose output reports failure",
                                   "total": len(masked_failures), "sessions": sessions_of(masked_failures),
                                   "examples": masked_failures[:15]},
        "interrupts": {"total": len(interrupts), "sessions": sessions_of(interrupts),
                       "by_session": dict(collections.Counter(i["session"] for i in interrupts).most_common())},
        "corrections": {"total": len(corrections), "sessions": sessions_of(corrections), "items": corrections[:40]},
        "soft_corrections": {"total": len(soft_corrections), "sessions": sessions_of(soft_corrections), "items": soft_corrections[:40]},
        "follow_up_requests": {"total": len(follow_ups), "sessions": sessions_of(follow_ups)},
        "rereads": {"total": len(rereads), "sessions": sessions_of(rereads),
                    "items": sorted(rereads, key=lambda r: -r["reads"])[:30]},
        "search_sweeps": {"total": len(sweeps), "sessions": sessions_of(sweeps),
                          "items": sorted(sweeps, key=lambda r: -r["length"])[:30]},
        "compactions": {"total": len(compactions), "sessions": sessions_of(compactions),
                        "by_session": dict(collections.Counter(c["session"] for c in compactions).most_common())},
        "unfinished_sessions": {"total": len(unfinished),
                                "by_reason": dict(collections.Counter(u["reason"] for u in unfinished)),
                                "items": unfinished},
        "verify_loops": {"total": len(loops), "sessions": sessions_of(loops),
                         "by_command": dict(collections.Counter(l["command"] for l in loops)),
                         "items": sorted(loops, key=lambda r: -r["fail_edit_rerun_cycles"])[:30]},
        "slow_tool_calls": {"total": len(slow_tools), "sessions": sessions_of(slow_tools),
                            "by_tool": dict(collections.Counter(t["tool"] for t in slow_tools)),
                            "bash_hit_10_minute_cap": sum(1 for t in slow_tools if t["tool"] == "Bash" and t["seconds"] >= 595),
                            "total_minutes": round(sum(t["seconds"] for t in slow_tools) / 60),
                            "items": sorted(slow_tools, key=lambda r: -r["seconds"])[:30]},
        "user_waits_on_questions": {"total": len(user_waits), "median_seconds": sorted(w["seconds"] for w in user_waits)[len(user_waits) // 2] if user_waits else 0},
        "long_gaps_between_tool_calls": {"threshold_seconds": GAP_SECONDS, "total": len(gaps), "sessions": sessions_of(gaps),
                                         "items": sorted(gaps, key=lambda r: -r["seconds"])[:30]},
        "tool_usage": dict(tool_totals.most_common()),
        "sessions": sorted(per_session, key=lambda r: -r["friction_score"]),
    }


def friction_score(counts) -> int:
    weights = {"tool_errors": 1, "failing_retries": 3, "denials": 2, "interrupts": 3, "corrections": 4,
               "rereads": 1, "search_sweeps": 2, "compactions": 3, "verify_loops": 3, "unfinished": 2,
               "masked_verify_failures": 1, "zsh_pitfall": 1, "harness_blocks": 1, "classifier_unavailable": 1}
    return sum(counts.get(k, 0) * w for k, w in weights.items()) + sum(v for k, v in counts.items() if k.startswith("env_"))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--projects-dir", default=os.path.join(HOME, ".claude", "projects"))
    parser.add_argument("--out", default="data/signals.json")
    parser.add_argument("--exclude", action="append", default=[], metavar="SESSION_PREFIX",
                        help="skip sessions whose id starts with this (e.g. the session running the retro)")
    args = parser.parse_args()

    paths = sorted(p for p in glob.glob(os.path.join(args.projects_dir, "*", "*.jsonl"))
                   if not any(os.path.basename(p).startswith(x) for x in args.exclude))
    nested = glob.glob(os.path.join(args.projects_dir, "*", "**", "*.jsonl"), recursive=True)
    sessions = []
    for path in paths:
        session = Session(path)
        session.load()
        sessions.append(session)

    # A session without a cwd (e.g. metadata-only) borrows one from its project directory.
    dir_cwd = {s.dirname: s.cwd for s in sessions if s.cwd}
    for s in sessions:
        s.cwd = s.cwd or dir_cwd.get(s.dirname)
    starts = [s.start for s in sessions if s.start]
    ends = [s.end for s in sessions if s.end]
    projects = collections.Counter(project_label(s.cwd, s.dirname) for s in sessions)
    report = {
        "generated_by": "scripts/session_retro.py",
        "inventory": {
            "sessions": len(sessions),
            "excluded_session_prefixes": args.exclude,
            "sessions_with_tool_calls": sum(1 for s in sessions if s.tool_uses),
            "subagent_transcripts_not_analysed": len(nested) - len(paths),
            "projects": dict(projects.most_common()),
            "date_range": [min(starts).isoformat() if starts else None, max(ends).isoformat() if ends else None],
            "total_tool_calls": sum(sum(1 for e in s.events if e[0] == "use") for s in sessions),
        },
        "thresholds": {"retry_min": RETRY_MIN, "near_dup_ratio": NEAR_DUP_RATIO, "reread_min": REREAD_MIN,
                       "sweep_min": SWEEP_MIN, "loop_min_cycles": LOOP_MIN_CYCLES,
                       "slow_tool_seconds": SLOW_TOOL_SECONDS, "gap_seconds": GAP_SECONDS},
    }
    report.update(analyse(sessions))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"{len(sessions)} sessions -> {args.out}")


if __name__ == "__main__":
    main()
