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
// backticks, quoted or not), `sh|bash|zsh -c <script>` and `eval`.

const OPERATOR = new Set([";", "&", "|", "\n", "(", ")"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// Reads words up to the end of `text`, or up to the `)` closing a
// substitution when `nested`. Returns { commands, end } where commands are
// arrays of words: { value, globUnquoted } (globUnquoted: an unquoted * ? or [
// that the shell would expand).
function read(text, start, nested) {
  const commands = [];
  let words = [];
  let word = null;
  let index = start;
  let redirect = false;
  const heredocs = [];

  const finishWord = () => {
    if (word === null) return;
    if (redirect) redirect = false;
    else words.push(word);
    word = null;
  };
  const finishCommand = () => {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const current = () => (word ??= { value: "", globUnquoted: false });
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
          index = substitution(index + 2);
        } else if (text[index] === "`") {
          const close = text.indexOf("`", index + 1);
          const end = close === -1 ? text.length : close;
          commands.push(...read(text.slice(index + 1, end), 0, false).commands);
          index = end + 1;
        } else word.value += text[index++];
      }
      index += 1;
      continue;
    }
    if (char === "$" && text[index + 1] === "(" && text[index + 2] !== "(") {
      current();
      index = substitution(index + 2);
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      const end = close === -1 ? text.length : close;
      current();
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
      index = skipHeredocs(text, index + 1, heredocs.splice(0));
      continue;
    }
    if (char === "&" && text[index + 1] === ">") {
      // &> and &>> send both streams to the file word that follows.
      finishWord();
      index += text[index + 2] === ">" ? 3 : 2;
      redirect = true;
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
        heredocs.push({ delimiter, strip });
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
    current().value += char;
    index += 1;
  }
  finishCommand();
  return { commands, end: index };
}

function skipHeredocs(text, index, heredocs) {
  for (const { delimiter, strip } of heredocs) {
    while (index < text.length) {
      const lineEnd = text.indexOf("\n", index);
      const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
      index = lineEnd === -1 ? text.length : lineEnd + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break;
    }
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

// The command a simple command finally runs: leading assignments and wrappers
// (sudo, env, timeout 5, npx -y, xargs) removed, argv[0] reduced to its
// basename so /usr/bin/git is git.
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

// Every simple command the text would run, in order, each { argv, globs }.
// Scripts handed to a shell with -c, or to eval, are read in their place.
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
    }
    if (depth < 4 && name === "eval") {
      found.push(...simpleCommands(args.join(" "), depth + 1));
      continue;
    }
    found.push(command);
  }
  return found;
}
