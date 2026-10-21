import { expect, test } from 'claude-code/testing'

import { fixCommand } from '../hooks/fix'

test('quotes unquoted --include and --exclude globs, and only those', () => {
  expect(fixCommand('grep -rn foo --include=*.ts --exclude-dir=node_modules .', false).command)
    .toBe("grep -rn foo --include='*.ts' --exclude-dir=node_modules .")
  expect(fixCommand('rg x --exclude=*.min.js && grep -r y --include=*.{ts,tsx} src', false).command)
    .toBe("rg x --exclude='*.min.js' && grep -r y --include='*.ts' --include='*.tsx' src")
  expect(fixCommand("grep -rn foo --include='*.ts' .", false).changes).toEqual([])
  expect(fixCommand('echo "--include=*.ts"', false).changes).toEqual([])
})

test('expands a simple brace list into one option per entry, grep has no braces', () => {
  expect(fixCommand('grep -r y --include=*.{ts,tsx} --exclude-dir={dist,.git} src', false).command)
    .toBe("grep -r y --include='*.ts' --include='*.tsx' --exclude-dir={dist,.git} src")
  expect(fixCommand('grep -r y --include=src/*.{ts,tsx,} .', false).command)
    .toBe("grep -r y --include='src/*.ts' --include='src/*.tsx' --include='src/*.' .")
  expect(fixCommand('grep -r y --include=*.{ts,{js,mjs}} .', false).changes).toEqual([])
  expect(fixCommand('grep -r y --include=*{1..3}.log .', false).changes).toEqual([])
  expect(fixCommand('grep -r y --include=*.{ts}.bak .', false).changes).toEqual([])
})

test('adds pipefail to a verify pipe, not to other pipes', () => {
  expect(fixCommand('vfk --changed 2>&1 | tail -40', false).command)
    .toBe('set -o pipefail; vfk --changed 2>&1 | tail -40')
  expect(fixCommand('ls | head', false).changes).toEqual([])
  expect(fixCommand('vfk --changed || echo failed', false).changes).toEqual([])
  expect(fixCommand('set -o pipefail; vfk --changed | tail', false).changes).toEqual([])
})

test('moves a foreground full verify into the background', () => {
  const fix = fixCommand('npm run verify', false)
  expect(fix.runInBackground).toBe(true)
  expect(fix.command).toBe('npm run verify')
  expect(fixCommand('cd app && vfk --all', false).runInBackground).toBe(true)
  expect(fixCommand('vfk --changed', false).runInBackground).toBe(false)
  expect(fixCommand('npm run verify', true).changes).toEqual([])
  expect(fixCommand('echo "npm run verify"', false).runInBackground).toBe(false)
})

test('the hook hands the rewritten call to the tool and tells the agent', async ($, on) => {
  const seen: { command: string; background: boolean | undefined }[] = []
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') seen.push({ command: e.command, background: e.run_in_background })
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run verify 2>&1 | tail -5' })
  expect(seen).toEqual([{ command: 'set -o pipefail; npm run verify 2>&1 | tail -5', background: true }])
  expect(ran.context?.join('\n')).toMatch(/pipefail.*background/s)

  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(seen[1]).toEqual({ command: 'git status', background: undefined })
})
