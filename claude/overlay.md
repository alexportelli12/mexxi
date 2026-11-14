## Claude Code

Rules for Claude Code's own tools, which the other hosts do not have:

- Open a file with the Read tool, using offset and limit for a long one,
  before Edit or Write; `cat`, `head`, `tail` or `sed -n` output does not
  count. Read it again after `sed -i`, a formatter or a script has changed it.
- Run anything that may take more than about two minutes with
  `run_in_background`, then wait for its completion notification; never poll
  it in a loop.
- Wait for one condition, such as a server's URL answering, with an `until`
  loop run with `run_in_background`; use Monitor only for a stream of events.
  Never hold the foreground with `sleep`.
