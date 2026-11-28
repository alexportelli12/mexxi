import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isComplete, isPicked, pickLabel, tapOption, toAnswers, type Pick } from '../core/answer';
import { ApiService, failureMessage, isStale } from '../core/api';
import { now } from '../core/clock';
import { LiveService } from '../core/live';
import { QueueTapGuard } from '../core/tap-guard';
import { relativeTime } from '../core/time';
import type { Pending } from '../models';
import { AskCard, type AskVariant } from './ask-card';
import { Banner } from './banner';
import { Button } from './button';

let cards = 0;

/**
 * A question from a session, with its options as big tappable choices. It handles one pick, several picks,
 * several questions in one call (answered one after another), an answer of your own and "talk it through".
 * Every answer carries the expect the person saw; if the session moved, the server refuses and the card says so.
 */
@Component({
  selector: 'hares-question-card',
  imports: [AskCard, Banner, Button, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <hares-ask-card [variant]="variant()" [lead]="lead()" [labelledBy]="titleId" [queue]="queue()" [age]="queue() ? null : age()" (previous)="previous.emit()" (next)="next.emit()">
      @if (items().length > 1) {
        <p class="mt-2 text-[13.5px] text-faint" [class]="variant() === 'card' ? 'px-4' : variant() === 'sheet' ? 'px-3 lg:px-0' : ''">Question {{ step() + 1 }} of {{ items().length }}</p>
      }
      <h2 [id]="titleId" class="text-[22px] leading-[1.24] font-semibold tracking-[-0.016em]"
        [class]="(variant() === 'card' ? 'mt-2 mb-4 px-4' : variant() === 'sheet' ? 'mt-2 mb-4 px-3 lg:px-0' : 'mt-2 mb-5')">{{ item().question }}</h2>

      @if (pending().answerable) {
        <div [attr.role]="item().multiSelect ? 'group' : 'radiogroup'" [attr.aria-labelledby]="titleId"
          [class]="variant() === 'cockpit' ? 'grid grid-cols-3 gap-2' : 'flex flex-col gap-1'">
          @for (option of item().options; track option.n) {
            <button type="button" [attr.role]="item().multiSelect ? 'checkbox' : 'radio'" [attr.aria-checked]="picked(option.n)" (click)="choose(option.n, $event)"
              class="flex cursor-pointer border text-left text-text" [class]="optionClass(picked(option.n))">
              @if (variant() === 'cockpit') {
                <span class="flex items-center justify-between">
                  <kbd class="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-md border-b-2 border-line bg-key px-1.5 font-[inherit] text-[12.5px] font-semibold text-amber-text">{{ option.n }}</kbd>
                  <span aria-hidden="true" class="box-border inline-flex size-5 items-center justify-center border-2 text-xs font-bold text-on-amber" [class]="indicatorClass(picked(option.n))">{{ picked(option.n) ? '✓' : '' }}</span>
                </span>
                <span class="mt-1 text-[15.5px] leading-[1.3] font-semibold">{{ option.label }}</span>
                @if (option.description) { <span class="text-sm leading-[1.4] text-muted">{{ option.description }}</span> }
              } @else {
                <span class="w-3 text-base leading-[1.3] font-bold text-amber-text">{{ option.n }}</span>
                <span class="flex flex-1 flex-col gap-1">
                  <span class="text-base leading-[1.3] font-medium">{{ option.label }}</span>
                  @if (variant() === 'sheet' && option.description) { <span class="text-[14.5px] leading-[1.38] text-muted">{{ option.description }}</span> }
                </span>
                <span aria-hidden="true" class="box-border inline-flex size-5.5 flex-none items-center justify-center border-2 text-[13px] font-bold text-on-amber" [class]="indicatorClass(picked(option.n))">{{ picked(option.n) ? '✓' : '' }}</span>
              }
            </button>
          }
        </div>

        @if (error(); as message) {
          <hares-banner class="mt-3" kind="error">{{ message }}
            <button action hares-button size="sm" variant="quiet" type="button" (click)="checkAgain()">Check again</button>
          </hares-banner>
        }

        @switch (variant()) {
          @case ('card') {
            <div class="flex items-center gap-2 pt-3 pr-2 pb-2 pl-4">
              @if (pending().freeText) {
                <a [routerLink]="['/s', pending().sessionId]" [queryParams]="{ own: 1, q: pending().id }" class="flex min-h-11 flex-1 items-center text-[15px] text-muted no-underline">Write my own answer</a>
              } @else {
                <span class="flex-1"></span>
              }
              <button hares-button variant="primary" type="button" [disabled]="!ready() || busy()" (click)="send($event)">{{ sendLabel() }}</button>
            </div>
          }
          @default {
            <div class="mt-4 flex gap-2" [class]="variant() === 'sheet' ? 'px-0' : ''">
              @if (pending().freeText && !item().multiSelect) {
                <label [for]="ownId" class="sr-only">Your own answer</label>
                <input #own [id]="ownId" class="min-h-13 min-w-0 flex-1 rounded-2xl border border-strong bg-bg px-4 text-base text-text" placeholder="Or write your own answer" [value]="ownText()" (input)="typed($any($event.target).value)" (keydown.enter)="send(null)" />
              } @else {
                <span class="flex-1"></span>
              }
              <button hares-button variant="primary" type="button" [disabled]="!ready() || busy()" (click)="send($event)">{{ sendLabel() }}</button>
            </div>
            @if (variant() === 'sheet' && pending().chat) {
              @if (chatOpen()) {
                <div class="mt-2 flex gap-2">
                  <label [for]="chatId" class="sr-only">What do you want to say?</label>
                  <input [id]="chatId" class="min-h-13 min-w-0 flex-1 rounded-2xl border border-strong bg-bg px-4 text-base text-text" placeholder="What do you want to say?" [value]="chatText()" (input)="chatText.set($any($event.target).value)" (keydown.enter)="talk()" />
                  <button hares-button type="button" [disabled]="!chatText().trim() || busy()" (click)="talk()">Send</button>
                </div>
              } @else {
                <button type="button" class="mt-2 ml-3 min-h-11 cursor-pointer self-start border-0 bg-transparent p-0 text-[14.5px] text-muted lg:ml-0" (click)="chatOpen.set(true)">Talk it through instead</button>
              }
            }
          }
        }
      } @else {
        <div class="flex flex-col gap-3" [class]="variant() === 'card' ? 'px-4 pb-4' : 'mt-2'">
          <p class="text-[15px] leading-[1.45] text-muted">{{ pending().reason ?? 'Only the terminal can answer this one.' }}</p>
          <a hares-button size="sm" variant="primary" class="self-start" [routerLink]="['/s', pending().sessionId, 'terminal']">Answer in the terminal</a>
        </div>
      }
    </hares-ask-card>
  `,
})
export class QuestionCard {
  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  private readonly guard = inject(QueueTapGuard);
  readonly pending = input.required<Pending>();
  readonly variant = input<AskVariant>('card');
  readonly queue = input<{ index: number; total: number } | null>(null);
  /** Focus the own-answer field when the card appears (a link from Now asks for it). */
  readonly focusOwn = input(false);
  readonly previous = output<void>();
  readonly next = output<void>();
  /** The answer went through: what was answered, in words, for a "You answered" line. */
  readonly sent = output<string>();

  private readonly ownField = viewChild<ElementRef<HTMLInputElement>>('own');
  protected readonly titleId = `question-${++cards}`;
  protected readonly ownId = `own-${cards}`;
  protected readonly chatId = `chat-${cards}`;
  protected readonly step = signal(0);
  protected readonly picks = signal<(Pick | undefined)[]>([]);
  protected readonly ownText = signal('');
  protected readonly chatOpen = signal(false);
  protected readonly chatText = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The id alone: a reload that brings the same question again as a new object must not clear what was picked. */
  private readonly pendingId = computed(() => this.pending().id);
  protected readonly items = computed(() => this.pending().items);
  protected readonly item = computed(() => this.items()[Math.min(this.step(), this.items().length - 1)]);
  protected readonly last = computed(() => this.step() >= this.items().length - 1);
  protected readonly lead = computed(() => {
    const who = this.variant() === 'card' ? this.pending().asker : 'Claude';
    const topic = this.variant() !== 'card' && this.pending().topic ? ` about ${this.pending().topic}` : '';
    return `${who} is asking${topic}`;
  });
  protected readonly age = computed(() => relativeTime(this.pending().askedAt, now()));
  protected readonly ready = computed(() => this.pending().answerable && this.picks()[this.step()] !== undefined && isComplete([this.item()], [this.picks()[this.step()]]));
  protected readonly sendLabel = computed(() => (this.last() ? (this.variant() === 'sheet' ? 'Send' : 'Send answer') : 'Next question'));

  constructor() {
    // A different question in the same card starts clean: nothing picked for one is sent for another.
    effect(() => {
      this.pendingId();
      untracked(() => this.reset());
    });
    effect(() => {
      const field = this.ownField()?.nativeElement;
      if (field && this.focusOwn()) field.focus();
    });
  }

  private reset(): void {
    this.step.set(0);
    this.picks.set([]);
    this.ownText.set('');
    this.chatOpen.set(false);
    this.chatText.set('');
    this.error.set(null);
    this.busy.set(false);
  }

  protected picked = (n: number): boolean => isPicked(this.picks()[this.step()], n);

  protected optionClass(on: boolean): string {
    const base = on ? 'border-amber bg-glow' : 'border-transparent bg-raised';
    if (this.variant() === 'cockpit') return `${base} flex-col gap-1.5 rounded-2xl p-4`;
    return `${base} rounded-2xl ${this.variant() === 'card' ? 'min-h-14 items-center gap-3 pr-3 pl-4' : 'items-start gap-3 p-3.5'}`;
  }

  protected indicatorClass(on: boolean): string {
    const shape = this.item().multiSelect ? 'rounded-md' : 'rounded-full';
    return `${shape} ${on ? 'border-amber bg-amber' : 'border-strong bg-transparent'}`;
  }

  /** Picks an option. The keyboard (the cockpit's 1 to 9) comes through here too. */
  choose(n: number, event: MouseEvent | null = null): void {
    if (!this.guard.accepts(event) || this.busy() || !this.pending().answerable) return;
    if (!this.item().options.some((option) => option.n === n)) return;
    const picks = [...this.picks()];
    picks[this.step()] = tapOption(this.item(), picks[this.step()], n);
    this.picks.set(picks);
    this.ownText.set('');
    this.error.set(null);
  }

  protected typed(value: string): void {
    this.ownText.set(value);
    const picks = [...this.picks()];
    picks[this.step()] = value.trim() ? { kind: 'text', text: value } : picks[this.step()]?.kind === 'text' ? undefined : picks[this.step()];
    this.picks.set(picks);
  }

  /** Sends the answer, or moves to the next question of the call. */
  async send(event: MouseEvent | null): Promise<void> {
    if (!this.guard.accepts(event) || this.busy() || !this.ready()) return;
    if (!this.last()) {
      this.step.update((value) => value + 1);
      this.ownText.set('');
      return;
    }
    const items = this.items();
    const picks = this.picks();
    await this.submit(toAnswersOrNull(items, picks), items.map((entry, index) => (picks[index] ? pickLabel(entry, picks[index]!) : '')).join('; '));
  }

  protected async talk(): Promise<void> {
    const text = this.chatText().trim();
    if (!text || this.busy()) return;
    await this.submit([{ kind: 'chat', text }], text);
  }

  private async submit(answers: ReturnType<typeof toAnswers> | null, label: string): Promise<void> {
    if (!answers) return;
    this.busy.set(true);
    this.error.set(null);
    const { id, sessionId, expect } = this.pending();
    try {
      await this.api.answer(sessionId, { questionId: id, expect, answers });
      this.sent.emit(label);
      void this.live.refresh();
    } catch (error) {
      this.error.set(failureMessage(error));
      if (isStale(error)) void this.live.refresh();
    } finally {
      this.busy.set(false);
    }
  }

  protected async checkAgain(): Promise<void> {
    this.error.set(null);
    await this.live.refresh();
  }
}

function toAnswersOrNull(items: Pending['items'], picks: readonly (Pick | undefined)[]) {
  try {
    return toAnswers(items, picks);
  } catch {
    return null;
  }
}
