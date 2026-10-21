// The command fixer: a Bash call that would trip over the shell is rewritten
// on its way to the tool instead of failing, and the agent is told what
// changed in the call's context. Claude Code only; the rules every host
// follows live in the shared guard and instructions.
import type { Register } from 'claude-code'

import { fixCommand } from './fix'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const fix = fixCommand(e.command, e.run_in_background === true)
    if (!fix.changes.length) return next(e)
    const ran = await next({ ...e, command: fix.command, run_in_background: fix.runInBackground })
    if (ran.deny !== undefined) return ran
    const note = `${$.plugin.name} rewrote this command: ${fix.changes.join('; ')}. It ran as: ${fix.command}`
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
}
