// The small glob dialect the docs tooling uses for allowlists and `sources:`
// declarations: `*` stays within a path segment, `**` crosses segments, `?` is
// one character. It matches Verifika's `paths` closely enough for both.
export function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesAny(globs, file) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}
