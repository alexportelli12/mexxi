// Pure rewrites of a Bash command line, kept apart from the hook so tests can
// call them directly. Each one fixes a failure the retro counted, and only
// where the shell's own reading of the line is certain: anything inside
// quotes is left alone.

export type Fix = {
  command: string
  runInBackground: boolean
  changes: string[]
}

type Scan = { index: number; quoted: boolean; wordStart: boolean }

// `<<` or `<<-`, then the delimiter word, quoted or not. A here-string (`<<<`)
// is excluded by the caller: its word is an ordinary one.
const HEREDOC = /^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()'"\\])+)/

type Heredoc = { delimiter: string; stripTabs: boolean }

// Marks the bodies of the heredocs opened on the line just ended as quoted, so
// nothing in them is rewritten and their quotes never reach the scanner.
// Returns where the scan resumes: the newline ending the last delimiter line.
function skipHeredocBodies(command: string, start: number, heredocs: Heredoc[], positions: Scan[]): number {
  const pending = [...heredocs]
  let index = start
  while (index < command.length) {
    const newline = command.indexOf('\n', index)
    const end = newline === -1 ? command.length : newline
    const line = command.slice(index, end)
    const { delimiter, stripTabs } = pending[0] ?? { delimiter: '', stripTabs: false }
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) pending.shift()
    for (let at = index; at < end; at += 1) positions.push({ index: at, quoted: true, wordStart: false })
    if (pending.length === 0) return end
    if (end < command.length) positions.push({ index: end, quoted: true, wordStart: false })
    index = end + 1
  }
  return command.length
}

// Positions of the line with whether each sits inside quotes, and whether it
// starts a word. Backslash escapes and heredoc bodies count as quoted.
function scan(command: string): Scan[] {
  const positions: Scan[] = []
  let quote: '"' | "'" | null = null
  let previous = ''
  let heredocs: Heredoc[] = []
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (quote === null && char === '\n' && heredocs.length > 0) {
      positions.push({ index, quoted: false, wordStart: false })
      index = skipHeredocBodies(command, index + 1, heredocs, positions) - 1
      heredocs = []
      previous = '\n'
      continue
    }
    const wordStart = quote === null && (index === 0 || /[\s;&|()]/.test(previous))
    if (quote === null && command.startsWith('<<<', index)) {
      for (let at = index; at < index + 3; at += 1) positions.push({ index: at, quoted: false, wordStart: at === index && wordStart })
      previous = '<'
      index += 2
      continue
    }
    const heredoc = quote === null && char === '<' ? HEREDOC.exec(command.slice(index)) : null
    if (heredoc) {
      const word = heredoc[2] ?? ''
      heredocs.push({ delimiter: word.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, '$1$2$3'), stripTabs: heredoc[1] === '-' })
      for (let at = index; at < index + heredoc[0].length; at += 1) positions.push({ index: at, quoted: true, wordStart: false })
      previous = word[word.length - 1] ?? ''
      index += heredoc[0].length - 1
      continue
    }
    if (quote === null && char === '\\') {
      positions.push({ index, quoted: true, wordStart }, { index: index + 1, quoted: true, wordStart: false })
      previous = command[index + 1] ?? ''
      index += 1
      continue
    }
    if (quote === null && (char === '"' || char === "'")) quote = char
    else if (quote !== null && char === quote) quote = null
    positions.push({ index, quoted: quote !== null || char === '"' || char === "'", wordStart })
    previous = char
  }
  return positions
}

const GLOB_OPTION = /^--(include|exclude)(-dir)?=([^\s'"\\$`;&|<>()]+)(?=[\s;&|<>()]|$)/

const BRACE_LIST = /^([^{}]*)\{([^{}]*,[^{}]*)\}([^{}]*)$/

// The globs a value stands for once the shell has expanded its braces, or null
// when the braces are anything but one simple comma list (nested, a {1..3}
// range): those are left for the shell rather than guessed at.
function braceExpand(value: string): string[] | null {
  if (!/[{}]/.test(value)) return [value]
  const match = BRACE_LIST.exec(value)
  if (!match) return null
  return (match[2] ?? '').split(',').map((entry) => `${match[1]}${entry}${match[3]}`)
}

// zsh expands an unquoted --include=*.ts itself, and aborts the whole line with
// "no matches found" when nothing in the directory matches. grep has no brace
// syntax, so quoting --include=*.{ts,tsx} as it stands would match nothing;
// it becomes one quoted option per entry, as bash's own expansion would.
export function quoteGlobOptions(command: string): string {
  const positions = scan(command)
  let result = ''
  let cursor = 0
  for (const { index, quoted, wordStart } of positions) {
    if (index < cursor || quoted || !wordStart) continue
    const match = GLOB_OPTION.exec(command.slice(index))
    if (!match || !/[*?[]/.test(match[3] ?? '')) continue
    const globs = braceExpand(match[3] ?? '')
    if (!globs) continue
    const option = `--${match[1]}${match[2] ?? ''}`
    result += `${command.slice(cursor, index)}${globs.map((glob) => `${option}='${glob}'`).join(' ')}`
    cursor = index + match[0].length
  }
  return result + command.slice(cursor)
}

function hasUnquotedPipe(command: string): boolean {
  return scan(command).some(({ index, quoted }) =>
    !quoted && command[index] === '|' && command[index + 1] !== '|' && command[index - 1] !== '|')
}

const VERIFY = /(^|[\s;&|(])(npm run(?: -s| --silent)? verify|npx verifika|verifika|vfk)(?=\s|$|[;&|)])/
const FULL_VERIFY = /(^|[\s;&|(])(npm run(?: -s| --silent)? verify|(?:npx )?verifika --all|vfk --all)(?=\s|$|[;&|)])/

// A pipe reports its last command's status, so `npm run verify | tail` reads
// green whatever verify did.
export function addPipefail(command: string): string {
  if (!VERIFY.test(command) || !hasUnquotedPipe(command) || /pipefail/.test(command)) return command
  return `set -o pipefail; ${command}`
}

// A full verify outlasts the foreground Bash cap in slow repositories; in the
// background the agent is told when it ends instead of polling or timing out.
export function runsFullVerify(command: string): boolean {
  const match = FULL_VERIFY.exec(command)
  if (!match) return false
  const at = match.index + (match[1]?.length ?? 0)
  return !scan(command).some(({ index, quoted }) => index === at && quoted)
}

export function fixCommand(command: string, runInBackground: boolean): Fix {
  const changes: string[] = []
  let fixed = quoteGlobOptions(command)
  if (fixed !== command) changes.push('quoted the --include/--exclude globs so the shell does not expand them')
  const piped = addPipefail(fixed)
  if (piped !== fixed) changes.push('added set -o pipefail so the pipe keeps verify\'s exit status')
  fixed = piped
  const background = !runInBackground && runsFullVerify(fixed)
  if (background) changes.push('moved the full verify into the background: wait for its completion notification, never poll it or sleep')
  return { command: fixed, runInBackground: runInBackground || background, changes }
}
