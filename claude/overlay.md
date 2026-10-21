## Claude Code

Rules for Claude Code's own tools, which the other hosts do not have:

- Open a file with the Read tool before Edit or Write, and read it again after
  `sed -i`, a formatter or a script has changed it.
- Run anything that may take more than about two minutes with
  `run_in_background`, then wait for its completion notification; never poll
  it in a loop.
- Wait for a condition with Monitor, never `sleep`.
