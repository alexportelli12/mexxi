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
// backticks, quoted or not, and inside an unquoted heredoc's body),
// `sh|bash|zsh -c <script>`, `eval`, and a script a shell reads from its
// standard input (a heredoc, a herestring or a pipe). A script the reader
// cannot see, because a pipe, a process substitution or an expansion
// produces it at run time, is refused rather than guessed at.
//
// Arithmetic ($((...)) and ((...))) is read as arithmetic, so its << is a
// shift and never opens a heredoc; any command substitution inside it is
// still found.
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
// arrays of words: { value, globUnquoted, expanded, processSubstitution }
// (globUnquoted: an unquoted * ? or [ that the shell would expand; expanded:
// the word holds a substitution or a parameter, so its value is not what
// runs; processSubstitution: the word is a <(...) file). A command may carry
// `stdin`, the text of a heredoc or herestring fed to it; `stdinExpanded`,
// when the shell expands that text before feeding it; `stdinSubstituted`,
// when its input is redirected from a process substitution; and `pipedFrom`,
// the command whose output a `|` feeds it.
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
    if (redirect === "herestring") {
      words.stdin = word.value;
      if (word.expanded) words.stdinExpanded = true;
    }
    if (redirect === "input" && word.processSubstitution) words.stdinSubstituted = true;
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
      // A redirection written before the command (<<<x cmd) still feeds it.
      for (const key of ["stdin", "stdinExpanded", "stdinSubstituted"]) {
        if (finished[key] !== undefined) words[key] = finished[key];
      }
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
    if (char === "$" && text.startsWith("((", index + 1)) {
      const end = arithmeticEnd(text, index + 3);
      current().expanded = true;
      word.value += text.slice(index, end);
      commands.push(...arithmeticCommands(text.slice(index + 3, end)));
      index = end;
      continue;
    }
    if (char === "(" && text[index + 1] === "(" && word === null) {
      // An arithmetic command, (( x = 1 << 2 )): it runs nothing but the
      // substitutions inside it.
      const end = arithmeticEnd(text, index + 2);
      commands.push(...arithmeticCommands(text.slice(index + 2, end)));
      index = end;
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
      // A process substitution: a file whose contents a command produces at
      // run time. The command is read; the word only marks where it went.
      finishWord();
      Object.assign(current(), { expanded: true, processSubstitution: true });
      const end = substitution(index + 2);
      word.value = text.slice(index, end);
      index = end;
      finishWord();
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
      const bodies = readHeredocs(text, index + 1, heredocs.splice(0));
      commands.push(...bodies.commands);
      index = bodies.end;
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
        const raw = text.slice(index).split(/[\s;&|<>()]/, 1)[0];
        const delimiter = read(raw, 0, false).commands[0]?.[0]?.value ?? "";
        index += raw.length;
        // Any quoting in the delimiter keeps the body literal; otherwise the
        // shell expands it like a double-quoted string.
        heredocs.push({ delimiter, strip, target: words, expands: !/['"\\]/.test(raw) });
        continue;
      }
      if (char === "<" && text.startsWith("<<<", index)) {
        // A herestring: the word that follows is the command's input.
        index += 3;
        redirect = "herestring";
        continue;
      }
      const input = char === "<" && text[index + 1] !== "&";
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
      redirect = input ? "input" : true;
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

// The end of an arithmetic expression opened at `from` by (( : just past the
// matching )), or the end of the text.
function arithmeticEnd(text, from) {
  let depth = 2;
  let index = from;
  while (index < text.length && depth > 0) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") depth -= 1;
    index += 1;
  }
  return index;
}

// What an arithmetic expression runs: its command substitutions. The
// expression is read as commands too, with its shifts blanked so they open no
// heredoc: a shell without arithmetic (dash reads ((cmd)) as two subshells)
// would run it, and its words otherwise match no rule.
function arithmeticCommands(expression) {
  return read(expression.replace(/<</g, "  "), 0, false).commands;
}

// What expanding an unquoted heredoc body runs, read as a shell reads a
// double-quoted string: its $(...) and backtick substitutions (arithmetic
// included). `expanded` is whether the body holds any expansion at all, so
// the text a command receives is not the text written.
function bodyExpansion(body) {
  const commands = [];
  let expanded = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\") index += 1;
    else if (char === "`") {
      expanded = true;
      const close = body.indexOf("`", index + 1);
      const end = close === -1 ? body.length : close;
      commands.push(...read(body.slice(index + 1, end), 0, false).commands);
      index = end;
    } else if (char === "$" && body.startsWith("((", index + 1)) {
      expanded = true;
      const end = arithmeticEnd(body, index + 3);
      commands.push(...arithmeticCommands(body.slice(index + 3, end)));
      index = end - 1;
    } else if (char === "$" && body[index + 1] === "(") {
      expanded = true;
      const inner = read(body, index + 2, true);
      commands.push(...inner.commands);
      index = inner.end - 1;
    } else if (char === "$" && /[\w{@*#?$!-]/.test(body[index + 1] ?? "")) expanded = true;
  }
  return { commands, expanded };
}

// Reads each pending heredoc's body and hands it to the command it feeds.
// Returns { commands, end }: the commands an unquoted body's expansion runs,
// and the index after the last body.
function readHeredocs(text, index, heredocs) {
  const commands = [];
  for (const { delimiter, strip, target, expands } of heredocs) {
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
    if (expands) {
      const expansion = bodyExpansion(target.stdin);
      commands.push(...expansion.commands);
      if (expansion.expanded) target.stdinExpanded = true;
    }
  }
  return { commands, end: index };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Wrappers that run the rest of their arguments as a command, with the
// options that take a value of their own.
const WRAPPERS = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"]),
  doas: new Set(["-u", "-C"]),
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
// argv[0] reduced to its basename so /usr/bin/git is git. `words` are the
// reader's words behind argv, one for one; `nameExpanded` is whether the
// command's name comes from an expansion ($v push -f), so is not argv[0].
export function effectiveArgv(words) {
  let argv = words.map((word) => word.value);
  let globs = words.map((word) => word.globUnquoted);
  let kept = words;
  const drop = (count) => {
    argv = argv.slice(count);
    globs = globs.slice(count);
    kept = kept.slice(count);
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
  // A scoped package a runner names (npx @shopify/cli) keeps its scope.
  if (argv.length && !argv[0].startsWith("@")) argv[0] = argv[0].split("/").pop();
  // $HOME/bin/tool is still tool; only an expansion in the basename, or a
  // substitution anywhere in the word, leaves the name unknown.
  const nameExpanded = Boolean(kept[0]?.expanded) && (kept[0].substituted || !argv[0] || argv[0].includes("$"));
  return { argv, globs, words: kept, nameExpanded };
}

// Where a shell run with these arguments (and no -c) reads its script: the
// index of the script file it names, or -1 for standard input (no script
// file named, or -s, or -).
function scriptOperand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-") return -1;
    if (arg === "--") return args[index + 1] === undefined ? -1 : index + 1;
    if (/^[-+]o$/.test(arg) || arg === "--rcfile" || arg === "--init-file") index += 1;
    else if (/^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) return -1;
    else if (!arg.startsWith("-") && !arg.startsWith("+")) return index;
  }
  return -1;
}

// Where a shell run with -c finds its script: the first word after the
// option words, which may follow -c itself (bash -c -x 'cmd', bash -c -o
// pipefail 'cmd', bash -c -- 'cmd'). Returns the script's index in args, -1
// when there is no -c, or null when -c has no script.
function commandScript(args) {
  let command = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--" || arg === "-") {
      if (!command) return -1;
      return index + 1 < args.length ? index + 1 : null;
    }
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg.startsWith("-") && arg.includes("c")) command = true;
      // Each o or O in a cluster takes the next word as its value.
      index += (arg.slice(1).match(/[oO]/g) ?? []).length;
    } else if (arg === "--rcfile" || arg === "--init-file") index += 1;
    else if (!arg.startsWith("--")) return command ? index : -1;
  }
  return command ? null : -1;
}

// The text a pipe feeds the next command, when it is known without running
// anything: a literal echo or printf, or cat of a heredoc. Otherwise null.
function literalOutput(producer) {
  if (producer === UNKNOWN_PRODUCER || producer.some((word) => word.expanded)) return null;
  const { argv: [name, ...args] } = effectiveArgv(producer);
  if (name === "cat" && !args.length && producer.stdin !== undefined) return producer.stdinExpanded ? null : producer.stdin;
  if (name !== "echo" && name !== "printf") return null;
  // Escapes are read generously: finding an extra command only errs closed.
  return args.filter((arg) => !/^-[neE]+$/.test(arg)).join(" ").replace(/\\n/g, "\n");
}

const RUN_IT_DIRECTLY = "save the script to a file, read it, and run the commands it needs directly";

// Every simple command the text would run, in order, each { argv, globs }.
// Scripts handed to a shell with -c, or to eval, or fed to a shell's standard
// input, are read in their place. A script the reader cannot see (`curl ... |
// sh`, `bash < <(curl ...)`, `source <(...)`, `bash -c "$(...)"`) comes back
// as { argv, globs, refused } with the reason.
export function simpleCommands(text, depth = 0) {
  const found = [];
  for (const words of read(text, 0, false).commands) {
    const { words: commandWords, ...command } = effectiveArgv(words);
    const [name, ...args] = command.argv;
    if (!name) continue;
    const refuse = (reason) => found.push({ ...command, refused: `${name} ${reason}` });
    if ((name === "source" || name === ".") && commandWords.some((word) => word.processSubstitution)) {
      refuse(`runs a script from a process substitution the guard cannot inspect (as in source <(curl ...)); ${RUN_IT_DIRECTLY}`);
      continue;
    }
    if (depth < 4 && SHELLS.has(name)) {
      const script = commandScript(args);
      if (script !== null && script !== -1) {
        // args[script] is commandWords[script + 1]: commandWords starts at the name.
        if (commandWords[script + 1].expanded) {
          refuse(`-c runs a script built by an expansion ($(...), backticks or $VAR) the guard cannot inspect; write the commands out literally`);
        } else found.push(...simpleCommands(args[script], depth + 1));
        continue;
      }
      const operand = script === -1 ? scriptOperand(args) : null;
      if (operand !== null && operand !== -1 && commandWords[operand + 1].processSubstitution) {
        refuse(`runs a script from a process substitution the guard cannot inspect (as in bash <(curl ...)); ${RUN_IT_DIRECTLY}`);
        continue;
      }
      if (operand === -1) {
        if (words.stdinSubstituted || (words.stdin !== undefined && words.stdinExpanded)) {
          refuse(`reads a script the shell builds at run time (from a process substitution, as in bash < <(curl ...), or an expanding heredoc or herestring), which the guard cannot inspect; ${RUN_IT_DIRECTLY}`);
          continue;
        }
        const script = words.stdin ?? (words.pipedFrom ? literalOutput(words.pipedFrom) : undefined);
        if (typeof script === "string") {
          found.push(...simpleCommands(script, depth + 1));
          continue;
        }
        if (words.pipedFrom) {
          refuse(`reads its script from a pipe the guard cannot inspect (as in curl ... | sh); ${RUN_IT_DIRECTLY}`);
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
