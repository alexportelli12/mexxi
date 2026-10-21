## Claude Code

Rules for Claude Code's own tools, which the other hosts do not have:

- Open a file with the Read tool before Edit or Write, and read it again after
  `sed -i`, a formatter or a script has changed it.
- Run anything that may take more than about two minutes with
  `run_in_background`, then wait for its completion notification; never poll
  it in a loop.
- Wait for a condition with Monitor, never `sleep`.
- For each `code-reviewer` pass, first try `ibni cross-review --session "<id>"
  --mode <discovery|confirmation> --background <file> --target "<target>"`: it
  runs the reviewer on a Codex model in a read-only sandbox. When it returns
  `delegated: true`, its `review` is the reviewer's result (append verification
  status and rendered evidence paths to the background file first). When it
  returns `delegated: false`, invoke the `code-reviewer` subagent as usual and
  give its `reason` in the pull request's Evidence.
