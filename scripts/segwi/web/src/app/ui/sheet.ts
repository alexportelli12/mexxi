import { ChangeDetectionStrategy, Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

/**
 * A bottom sheet on phones and a centred dialog on desktop. It wraps the native dialog element,
 * which traps focus, closes on Esc and hands focus back to what opened it. Put `autofocus` on the
 * control that should be focused first.
 */
let sheets = 0;

@Component({
  selector: 'segwi-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog [attr.aria-labelledby]="titleId" (close)="closed.emit()"
      class="m-0 mt-auto w-full max-w-none rounded-t-2xl border border-border-strong bg-surface-raised p-5 text-text backdrop:bg-black/60 sm:m-auto sm:max-w-md sm:rounded-card">
      <h2 [id]="titleId" class="mb-2 text-lg font-semibold">{{ heading() }}</h2>
      <div class="flex flex-col gap-4 pb-[env(safe-area-inset-bottom)]"><ng-content /></div>
    </dialog>
  `,
})
export class Sheet {
  readonly open = input.required<boolean>();
  readonly heading = input.required<string>();
  readonly closed = output<void>();
  protected readonly titleId = `sheet-title-${++sheets}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const dialog = this.dialog().nativeElement;
      if (this.open() && !dialog.open) dialog.showModal();
      else if (!this.open() && dialog.open) dialog.close();
    });
  }
}
