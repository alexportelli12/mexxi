import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';

/**
 * The look the GitHub screens share, written once. It has no markup: GithubLayout renders it, so
 * these rules load with the lazy GitHub routes and with nothing else. Class names start with gh-.
 * Colour comes only from the theme tokens, so light and dark need no rules here.
 */
@Component({
  selector: 'hares-gh-styles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: '',
  styles: `
    .gh-page{max-width:1280px;margin:0 auto;padding:12px 20px 120px;color:var(--text);font-family:var(--font);font-feature-settings:'tnum' 1,'ss01' 1}
    .gh-page :where(button,input,textarea){font-family:inherit}
    .gh-page :focus-visible,.gh-sheet :focus-visible{outline:2px solid var(--amber);outline-offset:3px;border-radius:12px}
    .gh-page :where(h1,h2,h3){text-wrap:balance}
    .gh-page p{text-wrap:pretty}
    @media (min-width:1024px){.gh-page{padding:40px 32px 56px}}
    .gh-h1{margin:0;font-size:30px;line-height:1.1;font-weight:600;letter-spacing:-.026em}
    .gh-h2{margin:0;font-size:19px;line-height:1.2;font-weight:600;letter-spacing:-.012em}
    .gh-lede{margin:8px 0 0;font-size:16px;line-height:1.45;color:var(--muted)}
    .gh-faint{font-size:13.5px;color:var(--faint)}
    .gh-sub{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
    .gh-code{font-family:var(--mono);font-size:.88em}
    .gh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    @media (min-width:1024px){.gh-m{display:none!important}}
    @media (max-width:1023.98px){.gh-d{display:none!important}}
    .gh-btn{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0 18px;border-radius:12px;border:0;background:var(--raised);color:var(--text);font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
    .gh-btn.primary{background:var(--amber);color:var(--on-amber)}
    .gh-btn.ghost{background:transparent;color:var(--muted);font-weight:500}
    .gh-btn:disabled{opacity:.5;cursor:not-allowed}
    .gh-fab{width:48px;height:48px;display:inline-flex;align-items:center;justify-content:center;border-radius:24px;background:var(--amber);color:var(--on-amber);box-shadow:0 8px 24px -10px var(--amber)}
    .gh-tabs{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;scroll-padding:0 20px}
    .gh-tabs.bleed{margin:0 -20px;padding:0 20px}
    @media (min-width:1024px){.gh-tabs.bleed{margin:0;padding:0}}
    @media (min-width:1024px) and (pointer:fine){.gh-btn{min-height:40px}.gh-chip{min-height:38px}}
    .gh-tabs.seg{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));gap:2px;padding:4px;border-radius:16px;background:var(--surface);overflow:visible}
    .gh-chip{position:relative;flex:none;white-space:nowrap;min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:0 14px;border-radius:22px;border:0;background:var(--surface);color:var(--text);font-size:15px;font-weight:500;cursor:pointer}
    .gh-chip[aria-selected=true],.gh-chip[aria-checked=true]{background:var(--text);color:var(--bg);font-weight:600}
    .gh-chip b{font-weight:600;opacity:.6}
    .gh-tabs.seg .gh-chip{border-radius:12px;background:transparent;color:var(--muted);padding:0 2px;gap:4px;font-size:14.5px;min-width:0}
    .gh-tabs.seg .gh-chip[aria-selected=true],.gh-tabs.seg .gh-chip[aria-checked=true]{background:var(--raised);color:var(--text)}
    .gh-sqs{display:inline-flex;gap:2px;min-width:38px;flex:none}
    .gh-sq{width:8px;height:8px;border-radius:2px;background:var(--teal)}
    .gh-sq.fail{background:var(--red)}
    .gh-sq.pending{background:var(--amber)}
    .gh-add{color:var(--teal)}
    .gh-del{color:var(--red)}
    .tone-good{color:var(--teal)}
    .tone-bad{color:var(--red)}
    .tone-warn{color:var(--amber-text)}
    .tone-neutral{color:var(--muted)}
    .gh-err{margin:8px 0 0;font-size:14.5px;color:var(--red)}
    .gh-notice{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:20px;padding:12px 16px;border-radius:16px;background:var(--red-soft);color:var(--text);font-size:15px}
    .gh-empty{margin:32px 0;color:var(--muted);font-size:16px}
    .gh-input{min-height:48px;border-radius:14px;border:1px solid var(--strong);background:var(--surface);color:var(--text);padding:0 16px;font-size:16px}
    .gh-area{border-radius:16px;border:1px solid var(--strong);background:var(--bg);color:var(--text);padding:14px 16px;font-size:16px;line-height:1.5;resize:none}
  `,
})
export class GhStyles {}
