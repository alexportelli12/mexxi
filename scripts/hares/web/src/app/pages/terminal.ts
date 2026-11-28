import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, failureMessage } from '../core/api';
import { LiveService } from '../core/live';
import { readSetting, writeSetting } from '../core/draft';
import type { Screen } from '../models';
import { Banner } from '../ui/banner';
import { BackLink } from '../ui/back-link';
import { Button } from '../ui/button';

interface Key {
  label: string;
  /** The name a screen reader says; the label is a glyph. */
  spoken: string;
  /** The key name herdr takes; absent for Ctrl, which is sticky and changes the next key. */
  name?: string;
}

/** The keycap row of the design: the keys a phone keyboard lacks, plus the digits and slash that answer prompts. */
const KEYS: Key[] = [
  { label: 'Ctrl', spoken: 'Control, then the next key' },
  { label: 'Esc', spoken: 'Escape', name: 'escape' },
  { label: 'Tab', spoken: 'Tab', name: 'tab' },
  { label: '⇧Tab', spoken: 'Shift Tab', name: 'shift-tab' },
  { label: '↑', spoken: 'Up', name: 'up' },
  { label: '↓', spoken: 'Down', name: 'down' },
  { label: '1', spoken: '1', name: '1' },
  { label: '2', spoken: '2', name: '2' },
  { label: '3', spoken: '3', name: '3' },
  { label: '4', spoken: '4', name: '4' },
  { label: '/', spoken: 'Slash', name: '/' },
  { label: '⏎', spoken: 'Enter', name: 'enter' },
];

export const TEXT_SIZES = [10.5, 11.5, 13, 15, 17];
const SIZE_SETTING = 'terminal-size';

/**
 * The raw terminal, for what the readable view can't show. The screen is plain text; the keycap row and the
 * type box send keys to the pane. Every send carries the status and sequence of the screen on display, so a
 * keystroke never lands on a prompt that changed after you looked.
 */
@Component({
  imports: [Banner, BackLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'h-dvh flex-1' },
  template: `
    <header class="flex items-center justify-between border-b border-line px-3.5 py-2">
      <hares-back-link [to]="['/s', id()]" label="Readable view" />
      <div role="group" aria-label="Text size" class="flex gap-1">
        <button type="button" class="size-11 cursor-pointer rounded-[10px] border-0 bg-raised text-[13px] font-semibold text-text disabled:opacity-50" aria-label="Smaller text" [disabled]="size() === 0" (click)="resize(-1)">A</button>
        <button type="button" class="size-11 cursor-pointer rounded-[10px] border-0 bg-raised text-[17px] font-semibold text-text disabled:opacity-50" aria-label="Larger text" [disabled]="size() === sizes.length - 1" (click)="resize(1)">A</button>
      </div>
    </header>
    <pre class="m-0 min-h-0 flex-1 overflow-auto bg-(--hares-term-bg) p-4 pb-6 font-mono leading-[1.6] whitespace-pre text-(--hares-term-fg)" tabindex="0" [attr.aria-label]="'Terminal output, ' + label()" [style.font-size.px]="sizes[size()]"><code>@for (line of lines(); track $index) {<span class="block min-h-[1.6em]" [class.text-amber]="line.startsWith('❯')">{{ line }}</span>}</code></pre>
    <div class="flex flex-col gap-3 border-t border-line bg-surface px-3 pt-3 pb-[calc(1.75rem+env(safe-area-inset-bottom))]">
      @if (failure(); as message) {
        <hares-banner kind="error">{{ message }}<button action hares-button size="sm" variant="quiet" type="button" (click)="checkAgain()">Check again</button></hares-banner>
      } @else if (screen()?.overlay) {
        <hares-banner kind="info">An overlay is open in the terminal. Close it there first; it can look idle.</hares-banner>
      }
      <div role="toolbar" aria-label="Keys" class="grid grid-cols-6 gap-1.5">
        @for (key of keys; track key.label) {
          <button type="button" class="min-h-11 cursor-pointer rounded-[11px] border-0 border-b-[3px] text-[14.5px] font-semibold" [attr.aria-label]="key.spoken" [attr.aria-pressed]="key.name ? null : ctrl()"
            [class]="isLit(key) ? 'border-(--hares-key-edge) bg-amber text-on-amber' : 'border-line bg-key text-text'" [disabled]="busy()" (click)="press(key)">{{ key.label }}</button>
        }
      </div>
      <form class="flex gap-2" (submit)="sendText($event)">
        <label for="txt" class="sr-only">Type into the terminal</label>
        <input id="txt" name="txt" class="min-h-13 min-w-0 flex-1 rounded-2xl border border-strong bg-bg px-4 font-mono text-[15px] text-text" placeholder="Type into the terminal" autocomplete="off" autocapitalize="off" spellcheck="false" [value]="text()" (input)="text.set($any($event.target).value)" />
        <button hares-button variant="primary" type="submit" [disabled]="!text() || busy()">Send</button>
      </form>
    </div>
  `,
})
export class TerminalPage {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  readonly id = input.required<string>();
  protected readonly keys = KEYS;
  protected readonly sizes = TEXT_SIZES;
  protected readonly screen = signal<Screen | null>(null);
  protected readonly ctrl = signal(false);
  protected readonly text = signal('');
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly size = signal(Math.min(Math.max(Number(readSetting(SIZE_SETTING) ?? 1), 0), TEXT_SIZES.length - 1) || 0);
  protected readonly lines = computed(() => (this.screen()?.text ?? '').replace(/\n+$/, '').split('\n'));
  protected readonly label = computed(() => {
    const session = this.live.sessions().find((entry) => entry.id === this.id());
    return session?.repo || session?.title || 'this session';
  });

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
    this.live.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.sessionId === this.id()) void this.load();
    });
    this.live.reloads.pipe(takeUntilDestroyed()).subscribe(() => void this.load());
  }

  protected isLit = (key: Key): boolean => (key.name ? key.name === 'enter' : this.ctrl());

  protected resize(by: number): void {
    const next = Math.min(Math.max(this.size() + by, 0), TEXT_SIZES.length - 1);
    this.size.set(next);
    writeSetting(SIZE_SETTING, String(next));
  }

  protected async load(): Promise<void> {
    try {
      this.screen.set(await this.api.screen(this.id()));
    } catch (error) {
      this.failure.set(failureMessage(error));
    }
  }

  protected async checkAgain(): Promise<void> {
    this.failure.set(null);
    await this.load();
  }

  protected press(key: Key): void {
    if (!key.name) {
      this.ctrl.update((value) => !value);
      return;
    }
    const name = this.ctrl() && key.name !== 'enter' ? `ctrl-${key.name}` : key.name;
    this.ctrl.set(false);
    void this.send({ keys: [name] });
  }

  protected sendText(event: Event): void {
    event.preventDefault();
    const text = this.text();
    if (!text) return;
    // With Ctrl lit, one typed character is a control key: Ctrl and C interrupts, as at a keyboard.
    const input = this.ctrl() && text.length === 1 ? { keys: [`ctrl-${text.toLowerCase()}`] } : { text, keys: ['enter'] };
    this.ctrl.set(false);
    void this.send(input).then(() => this.text.set(''));
  }

  private async send(input: { keys?: string[]; text?: string }): Promise<void> {
    const screen = this.screen();
    if (!screen || this.busy()) return;
    this.busy.set(true);
    this.failure.set(null);
    try {
      await this.api.keys(this.id(), screen.expect, input);
      // The pane takes a moment to draw what the keys did.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await this.load();
    } catch (error) {
      this.failure.set(failureMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
