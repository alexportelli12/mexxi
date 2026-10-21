// A small POSIX-shell reader for the hooks: enough of the grammar to find
// every simple command a Bash tool call would run, with its words unquoted,
// so a guard rule sees `cd x && firebase deploy` or `bash -c "git push -f"`
// the same as the bare command. It is not a shell: it never expands
// variables or globs, and where it cannot be sure it errs towards finding a
// command, since the guard fails closed.
//
// Quoted text is data. `echo "git push --force"` is one echo command whose
// argument happens to read like a push, so it is allowed. Text only becomes a
// command again where a shell would run it: command substitution ($(...) and
// backticks, quoted or not), `sh|bash|zsh -c <script>`, `eval`, and a script a
// shell reads from its standard input (a heredoc, a herestring or a pipe).
//
// Compound commands are read through their keywords: `if`, `{`, `!`, `do` and
// the rest are stripped from the front of a command, so the command they wrap
// is the one a rule sees.

const OPERATOR = new Set([";", "&", "|", "\n", "(", ")"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// A pipe whose producer the reader could not pin down (`( a ) | sh`).
const UNKNOWN_PRODUCER = [];

// Reads words up to the end of `text`, or up to the `)` closing a
// substitution when `nested`. Returns { commands, end } where commands are
// arrays of words: { value, globUnquoted, expanded } (globUnquoted: an
// unquoted * ? or [ that the shell would expand; expanded: the word holds a
// substitution or a parameter, so its value is not what runs). A command may
// carry `stdin`, the text of a heredoc or herestring fed to it, and
// `pipedFrom`, the command whose output a `|` feeds it.
function read(text, start, nested) {
  const commands = [];
  let words = [];
  let word = null;
  let index = start;
  let redirect = false;
  let pipedFrom = null;
  const heredocs = [];

  const finishWord = () => {
    if (word === null) return;
    if (redirect === "herestring") words.stdin = word.value;
    if (redirect) redirect = false;
    else words.push(word);
    word = null;
  };
  // Returns the finished command, or null when there were no words.
  const finishCommand = () => {
    finishWord();
    const finished = words;
    words = [];
    if (!finished.length) {
      if (finished.stdin !== undefined) words.stdin = finished.stdin;
      return null;
    }
    if (pipedFrom) finished.pipedFrom = pipedFrom;
    pipedFrom = null;
    commands.push(finished);
    return finished;
  };
  const current = () => (word ??= { value: "", globUnquoted: false, expanded: false });
  const substitution = (from) => {
    const inner = read(text, from, true);
    commands.push(...inner.commands);
    return inner.end;
  };

  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      if (text[index + 1] === "\n") index += 2;
      else {
        current().value += text[index + 1] ?? "";
        index += 2;
      }
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      const end = close === -1 ? text.length : close;
      current().value += text.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === "$" && text[index + 1] === "'") {
      let value = "";
      index += 2;
      while (index < text.length && text[index] !== "'") {
        if (text[index] === "\\" && index + 1 < text.length) {
          const escaped = text[index + 1];
          value += { n: "\n", t: "\t", "'": "'", "\\": "\\" }[escaped] ?? escaped;
          index += 2;
        } else value += text[index++];
      }
      current().value += value;
      index += 1;
      continue;
    }
    if (char === '"') {
      current();
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && '"\\$`\n'.includes(text[index + 1])) {
          if (text[index + 1] !== "\n") word.value += text[index + 1];
          index += 2;
        } else if (text[index] === "$" && text[index + 1] === "(" && text[index + 2] !== "(") {
          word.expanded = true;
          index = substitution(index + 2);
        } else if (text[index] === "`") {
          word.expanded = true;
          const close = text.indexOf("`", index + 1);
          const end = close === -1 ? text.length : close;
          commands.push(...read(text.slice(index + 1, end), 0, false).commands);
          index = end + 1;
        } else {
          if (text[index] === "$") word.expanded = true;
          word.value += text[index++];
        }
      }
      index += 1;
      continue;
    }
    if (char === "$" && text[index + 1] === "(" && text[index + 2] !== "(") {
      current().expanded = true;
      index = substitution(index + 2);
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      const end = close === -1 ? text.length : close;
      current().expanded = true;
      commands.push(...read(text.slice(index + 1, end), 0, false).commands);
      index = end + 1;
      continue;
    }
    if (char === "<" && text[index + 1] === "(") {
      finishWord();
      index = substitution(index + 2);
      continue;
    }
    if (char === ")" && nested) {
      finishCommand();
      return { commands, end: index + 1 };
    }
    if (char === "#" && word === null) {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "\n" && heredocs.length) {
      finishCommand();
      index = readHeredocs(text, index + 1, heredocs.splice(0));
      continue;
    }
    if (char === "&" && text[index + 1] === ">") {
      // &> and &>> send both streams to the file word that follows.
      finishWord();
      index += text[index + 2] === ">" ? 3 : 2;
      redirect = true;
      continue;
    }
    if (char === "|" && text[index + 1] !== "|") {
      // A pipe (| or |&): the next command reads this one's output.
      pipedFrom = finishCommand() ?? UNKNOWN_PRODUCER;
      index += text[index + 1] === "&" ? 2 : 1;
      continue;
    }
    if (char === "|") {
      finishCommand();
      index += 2;
      continue;
    }
    if (OPERATOR.has(char)) {
      finishCommand();
      index += 1;
      continue;
    }
    if (char === ">" || char === "<") {
      // A file descriptor written right before the operator (2>) is not a word.
      if (word && /^\d+$/.test(word.value)) word = null;
      finishWord();
      if (char === "<" && text[index + 1] === "<" && text[index + 2] !== "<") {
        index += 2;
        const strip = text[index] === "-";
        if (strip) index += 1;
        while (text[index] === " " || text[index] === "\t") index += 1;
        const delimiter = read(text.slice(index).split(/[\s;&|<>()]/, 1)[0], 0, false).commands[0]?.[0]?.value ?? "";
        index += text.slice(index).split(/[\s;&|<>()]/, 1)[0].length;
        heredocs.push({ delimiter, strip, target: words });
        continue;
      }
      if (char === "<" && text.startsWith("<<<", index)) {
        // A herestring: the word that follows is the command's input.
        index += 3;
        redirect = "herestring";
        continue;
      }
      index += 1;
      if (text[index] === ">" || text[index] === "<" || text[index] === "|") index += 1;
      if (text[index] === "&") {
        index += 1;
        // >&2 and 2>&1 duplicate a descriptor; there is no file word to drop.
        const digits = text.slice(index).match(/^(\d+|-)/);
        if (digits) {
          index += digits[0].length;
          continue;
        }
      }
      redirect = true;
      continue;
    }
    if (char === " " || char === "\t") {
      finishWord();
      index += 1;
      continue;
    }
    if (char === "*" || char === "?" || char === "[") current().globUnquoted = true;
    if (char === "$") current().expanded = true;
    current().value += char;
    index += 1;
  }
  finishCommand();
  return { commands, end: index };
}

// Reads each pending heredoc's body and hands it to the command it feeds.
function readHeredocs(text, index, heredocs) {
  for (const { delimiter, strip, target } of heredocs) {
    const lines = [];
    while (index < text.length) {
      const lineEnd = text.indexOf("\n", index);
      const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
      index = lineEnd === -1 ? text.length : lineEnd + 1;
      const stripped = strip ? line.replace(/^\t+/, "") : line;
      if (stripped === delimiter) break;
      lines.push(stripped);
    }
    target.stdin = lines.join("\n");
  }
  return index;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Wrappers that run the rest of their arguments as a command, with the
// options that take a value of their own.
const WRAPPERS = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"]),
  env: new Set(["-u", "-C", "-S"]),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs"]),
  npx: new Set(["-p", "--package", "-c", "--call"]),
  bunx: new Set(["-p", "--package"]),
};

// Reserved words and grouping that open or continue a compound command; the
// command after them is what runs. `(` and `)` never reach here: the reader
// splits on them, which also turns `f() { ...; }` into `f` and its body and a
// case pattern's `*)` into a command of its own.
const RESERVED = new Set(["{", "}", "!", "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "in", "esac"]);
// Headers that run nothing themselves: `for x in ...`, `select x in ...` and
// `case word in`.
const HEADERS = new Set(["for", "select", "case"]);

// The command a simple command finally runs: leading reserved words,
// assignments and wrappers (sudo, env, timeout 5, npx -y, xargs) removed,
// argv[0] reduced to its basename so /usr/bin/git is git.
export function effectiveArgv(words) {
  let argv = words.map((word) => word.value);
  let globs = words.map((word) => word.globUnquoted);
  const drop = (count) => {
    argv = argv.slice(count);
    globs = globs.slice(count);
  };
  for (;;) {
    let skip = 0;
    while (skip < argv.length && ASSIGNMENT.test(argv[skip])) skip += 1;
    drop(skip);
    if (!argv.length) break;
    if (RESERVED.has(argv[0])) {
      drop(1);
      continue;
    }
    if (HEADERS.has(argv[0])) {
      drop(argv.length);
      break;
    }
    if (argv[0] === "function") {
      // function name { body; } -- the body follows the name.
      drop(2);
      continue;
    }
    if (argv[0] === "coproc") {
      // coproc [NAME] { body; } names the coprocess only before a group.
      drop(argv[2] === "{" ? 2 : 1);
      continue;
    }
    const name = argv[0].split("/").pop();
    if (name === "timeout") {
      let next = 1;
      while (next < argv.length && argv[next].startsWith("-")) next += ["-s", "-k", "--signal", "--kill-after"].includes(argv[next]) ? 2 : 1;
      drop(next + 1);
      continue;
    }
    const valued = WRAPPERS[name];
    if (!valued) break;
    let next = 1;
    while (next < argv.length && argv[next].startsWith("-") && argv[next] !== "-") {
      next += valued.has(argv[next]) ? 2 : 1;
    }
    drop(next);
  }
  if (argv.length) argv[0] = argv[0].split("/").pop();
  return { argv, globs };
}

// Whether a shell run with these arguments (and no -c) reads its script from
// standard input: no script file named, or -s, or -.
function readsStdin(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-") return true;
    if (arg === "--") return args[index + 1] === undefined;
    if (/^[-+]o$/.test(arg) || arg === "--rcfile" || arg === "--init-file") index += 1;
    else if (/^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) return true;
    else if (!arg.startsWith("-") && !arg.startsWith("+")) return false;
  }
  return true;
}

// The text a pipe feeds the next command, when it is known without running
// anything: a literal echo or printf, or cat of a heredoc. Otherwise null.
function literalOutput(producer) {
  if (producer === UNKNOWN_PRODUCER || producer.some((word) => word.expanded)) return null;
  const { argv: [name, ...args] } = effectiveArgv(producer);
  if (name === "cat" && !args.length && producer.stdin !== undefined) return producer.stdin;
  if (name !== "echo" && name !== "printf") return null;
  // Escapes are read generously: finding an extra command only errs closed.
  return args.filter((arg) => !/^-[neE]+$/.test(arg)).join(" ").replace(/\\n/g, "\n");
}

// Every simple command the text would run, in order, each { argv, globs }.
// Scripts handed to a shell with -c, or to eval, or fed to a shell's standard
// input, are read in their place. A shell piped a script the reader cannot
// see (`curl ... | sh`) comes back as { argv, globs, refused } with the reason.
export function simpleCommands(text, depth = 0) {
  const found = [];
  for (const words of read(text, 0, false).commands) {
    const command = effectiveArgv(words);
    const [name, ...args] = command.argv;
    if (!name) continue;
    if (depth < 4 && SHELLS.has(name)) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (flag !== -1 && args[flag + 1] !== undefined) {
        found.push(...simpleCommands(args[flag + 1], depth + 1));
        continue;
      }
      if (flag === -1 && readsStdin(args)) {
        const script = words.stdin ?? (words.pipedFrom ? literalOutput(words.pipedFrom) : undefined);
        if (typeof script === "string") {
          found.push(...simpleCommands(script, depth + 1));
          continue;
        }
        if (words.pipedFrom) {
          found.push({ ...command, refused: `${name} reads its script from a pipe the guard cannot inspect (as in curl ... | sh); save the script to a file, read it, and run the commands it needs directly` });
          continue;
        }
      }
    }
    if (depth < 4 && name === "eval") {
      found.push(...simpleCommands(args.join(" "), depth + 1));
      continue;
    }
    found.push(command);
  }
  return found;
}
