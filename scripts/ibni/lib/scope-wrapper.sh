# Runs inside ibni's systemd scope (see scope.mjs). It is a file, not a
# `sh -c` string, because systemd 259 and later expand `$VAR` and `$$` in a
# scope's command line: `$$` became `$`, so the shell counted itself as a
# leftover, and the command's text was pasted in before sh parsed it.
#
# Marks that the scope started, runs the command, then writes the scope's own
# counters as labelled lines before the shell exits, because a scope with
# nothing left in it is gone. The processes still in the scope are counted
# with the shell's own read, which starts no process of its own. A command
# killed by a signal ends the shell with the same signal.
echo started > "$IBNI_SCOPE_STATS"
sh -c "$IBNI_COMMAND"
status=$?
cgroup=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -n 1)
left=0
while read -r pid; do [ "$pid" = "$$" ] || left=$((left + 1)); done < "$cgroup/cgroup.procs"
{ echo "left $left"; echo "peak $(cat "$cgroup/memory.peak" 2>/dev/null)"; grep "^usage_usec " "$cgroup/cpu.stat"; grep "^oom_kill " "$cgroup/memory.events"; } >> "$IBNI_SCOPE_STATS" 2>/dev/null
if [ "$status" -gt 128 ]; then kill -$((status - 128)) $$; fi
exit $status
