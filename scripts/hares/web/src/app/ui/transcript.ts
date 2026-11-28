import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import type { TranscriptEntry } from '../models';
import { Icon } from './icon';

/**
 * The readable transcript: what you said on the right, what the session said in plain paragraphs, and every
 * run of tool steps folded into one line that opens to the steps.
 */
@Component({
  selector: 'hares-transcript',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-4', 'aria-label': 'Transcript', role: 'log' },
  template: `
    @for (entry of entries(); track entry.seq) {
      @switch (entry.kind) {
        @case ('you') {
          <div class="max-w-[84%] self-end rounded-[20px_20px_6px_20px] bg-raised px-4 py-3 text-[15.5px] leading-[1.45] break-words whitespace-pre-wrap">{{ entry.text }}</div>
        }
        @case ('answer') {
          <div class="max-w-[84%] self-end rounded-[20px_20px_6px_20px] bg-glow px-4 py-3 text-[15.5px] leading-[1.45] break-words">
            <span class="mb-1 block text-[13.5px] font-semibold text-amber-text">You answered</span>{{ entry.text }}
          </div>
        }
        @case ('agent') {
          <p class="max-w-[36ch] text-base leading-[1.58] whitespace-pre-wrap lg:max-w-[60ch]">{{ entry.text }}</p>
        }
        @case ('steps') {
          <div class="flex flex-col items-start gap-2">
            <button type="button" class="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-surface py-0 pr-3.5 pl-2.5 text-left text-[14.5px] text-muted" [attr.aria-expanded]="isOpen(entry.seq)" (click)="toggle(entry.seq)">
              <span class="inline-flex text-teal"><hares-icon name="check" [size]="18" /></span>{{ entry.summary }}
            </button>
            @if (isOpen(entry.seq)) {
              <ul class="flex flex-col gap-1 pl-3 text-[13.5px] text-muted">
                @for (step of entry.steps; track $index) {
                  <li class="flex gap-2"><span class="font-mono break-all" [class.text-red]="step.ok === false">{{ step.title }}</span>@if (step.ok === false) { <span class="text-red">failed</span> }</li>
                }
              </ul>
            }
          </div>
        }
      }
    }
  `,
})
export class Transcript {
  readonly entries = input.required<TranscriptEntry[]>();
  private readonly open = signal<ReadonlySet<number>>(new Set());

  protected isOpen = (seq: number): boolean => this.open().has(seq);
  protected toggle(seq: number): void {
    this.open.update((current) => {
      const next = new Set(current);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  }
}
