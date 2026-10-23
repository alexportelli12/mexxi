import { escapeCount, joinSegments, visibleSegments } from './visible-text';

const labels = (text: string) => visibleSegments(text).filter((segment) => segment.kind === 'escape').map((segment) => (segment as { label: string }).label);

describe('visible text', () => {
  const opaque = Array.from({ length: 3000 }, (_, index) => 'Ab0+/_-='[index % 8]).join('');
  const samples = [
    '',
    'npm run verify',
    'API_KEY=sk-live-123 DEBUG=1 node server.js',
    'curl -H "Authorization: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://example.com',
    opaque,
    `export TOKEN=${opaque}`,
    'printf "\u001b[2K\u001b[1Gnpm test"; rm -rf ~/',
    'echo safe\rrm -rf /',
    'line one\r\nline two\n\tindented',
    'ls \u202Etxt.exe\u202C and \u2066isolated\u2069 \u2067rtl\u2069',
    'zero\u200Bwidth\u200C\u200D\u2060\u2061\u2062\u2063\u2064\uFEFF\u061C',
    'tag \u{E0041}\u{E0042} and emoji \u{1F600} and a lone \uD800 surrogate',
    '\u0000\u0007\u0008\u007F\u0085\u009B',
    '\u2028\u2029\u00AD\u3164',
  ];

  it('is lossless: joining the segments gives back the original exactly', () => {
    for (const sample of samples) expect(joinSegments(visibleSegments(sample))).toBe(sample);
  });

  it('leaves ordinary text, newlines and tabs alone, and never shortens a long string', () => {
    expect(visibleSegments('API_KEY=sk-live-123 DEBUG=1')).toEqual([{ kind: 'text', text: 'API_KEY=sk-live-123 DEBUG=1' }]);
    expect(visibleSegments('a\n\tb')).toEqual([{ kind: 'text', text: 'a\n\tb' }]);
    const long = visibleSegments(opaque);
    expect(long).toHaveLength(1);
    expect((long[0] as { text: string }).text).toHaveLength(3000);
  });

  it('shows control characters as escapes, carriage returns included', () => {
    expect(labels('printf "\u001b[2K"')).toEqual(['\\x1b']);
    expect(labels('echo safe\rrm -rf /')).toEqual(['\\r']);
    expect(labels('a\r\nb')).toEqual(['\\r']);
    expect(labels('\u0000\u0007\u007F\u0085\u009B')).toEqual(['\\x00', '\\x07', '\\x7f', '\\x85', '\\x9b']);
  });

  it('shows bidi and invisible characters as code points, so text cannot be reordered or hidden', () => {
    expect(labels('ls \u202Etxt.exe\u202C')).toEqual(['U+202E', 'U+202C']);
    expect(labels('\u2066a\u2069\u2067b\u2069\u2068c\u2069')).toEqual(['U+2066', 'U+2069', 'U+2067', 'U+2069', 'U+2068', 'U+2069']);
    expect(labels('\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202D')).toEqual(['U+200B', 'U+200C', 'U+200D', 'U+200E', 'U+200F', 'U+202A', 'U+202B', 'U+202D']);
    expect(labels('\u2060\u2061\u2062\u2063\u2064\uFEFF\u061C\u00AD')).toEqual(['U+2060', 'U+2061', 'U+2062', 'U+2063', 'U+2064', 'U+FEFF', 'U+061C', 'U+00AD']);
    expect(labels('\u{E0041}\u2028\u3164\uD800')).toEqual(['U+E0041', 'U+2028', 'U+3164', 'U+D800']);
    expect(labels('emoji \u{1F600} caf\u00E9')).toEqual([]);
  });

  it('names the common ones and counts them', () => {
    const [escape] = visibleSegments('\u202E').filter((segment) => segment.kind === 'escape');
    expect(escape).toMatchObject({ raw: '\u202E', label: 'U+202E', title: 'Hidden character U+202E (right-to-left override)' });
    expect(escapeCount(visibleSegments('a\u001bb\u200Bc'))).toBe(2);
  });
});
