/**
 * Text an approval shows must look exactly like what would run. Control characters can
 * rewrite a terminal line, and bidi or zero-width characters can reorder or hide text on
 * screen, so each one becomes a visible chip instead. Everything else, including newlines
 * and tabs, is kept as it is. The split is lossless: joining the raw parts gives back the input.
 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'escape'; raw: string; label: string; title: string };

const NAMES: Record<number, string> = {
  0x0d: 'carriage return', 0x1b: 'escape', 0x00: 'null', 0x08: 'backspace', 0x7f: 'delete',
  0x061c: 'Arabic letter mark', 0x200b: 'zero-width space', 0x200c: 'zero-width non-joiner', 0x200d: 'zero-width joiner',
  0x200e: 'left-to-right mark', 0x200f: 'right-to-left mark', 0x202a: 'left-to-right embedding', 0x202b: 'right-to-left embedding',
  0x202c: 'pop directional formatting', 0x202d: 'left-to-right override', 0x202e: 'right-to-left override',
  0x2028: 'line separator', 0x2029: 'paragraph separator', 0x2060: 'word joiner', 0x2066: 'left-to-right isolate',
  0x2067: 'right-to-left isolate', 0x2068: 'first strong isolate', 0x2069: 'pop directional isolate', 0xfeff: 'zero-width no-break space',
};

// C0 and C1 controls and DEL, except newline and tab, which read as themselves.
const CONTROL = /^[\u0000-\u0008\u000b-\u001f\u007f-\u009f]$/u;
// Format characters (bidi controls, zero-width characters, U+2060 to U+2064, tag characters and the rest of
// Cf), line and paragraph separators, blank fillers that render as nothing, and lone surrogates.
const HIDDEN = /^[\p{Cf}\p{Cs}\u2028\u2029\u034F\u115F\u1160\u17B4\u17B5\u3164\uFFA0]$/u;

const hex = (code: number, width: number) => code.toString(16).toUpperCase().padStart(width, '0');

/** The chip for one character, or null when it is shown as itself. */
function escapeFor(char: string): { label: string; title: string } | null {
  const code = char.codePointAt(0)!;
  if (CONTROL.test(char)) {
    const label = code === 0x0d ? '\\r' : `\\x${hex(code, 2).toLowerCase()}`;
    return { label, title: `Control character U+${hex(code, 4)}${NAMES[code] ? ` (${NAMES[code]})` : ''}` };
  }
  if (HIDDEN.test(char)) {
    const label = `U+${hex(code, 4)}`;
    return { label, title: `Hidden character ${label}${NAMES[code] ? ` (${NAMES[code]})` : ''}` };
  }
  return null;
}

export function visibleSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let plain = '';
  // for...of walks code points, and yields a lone surrogate as itself, so nothing is dropped.
  for (const char of text) {
    const escape = escapeFor(char);
    if (!escape) {
      plain += char;
      continue;
    }
    if (plain) segments.push({ kind: 'text', text: plain });
    plain = '';
    segments.push({ kind: 'escape', raw: char, ...escape });
  }
  if (plain) segments.push({ kind: 'text', text: plain });
  return segments;
}

/** The original text back from its segments. */
export const joinSegments = (segments: readonly Segment[]): string => segments.map((segment) => (segment.kind === 'text' ? segment.text : segment.raw)).join('');

export const escapeCount = (segments: readonly Segment[]): number => segments.filter((segment) => segment.kind === 'escape').length;
