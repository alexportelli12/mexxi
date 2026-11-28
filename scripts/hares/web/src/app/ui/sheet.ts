import { ChangeDetectionStrategy, Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

let sheets = 0;

/**
 * A bottom sheet on phones and a centred dialog on desktop. It wraps the native dialog element, which traps
 * focus, closes on Esc and hands focus back to what opened it. Put `autofocus` on the control that should be
 * focused first.
 */
@Component({
  selector: 'hares-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog [attr.aria-labelledby]="titleId" (close)="closed.emit()"
      class="m-0 mt-auto w-full max-w-none overflow-y-auto rounded-t-[28px] border-0 bg-surface px-3 pt-2 pb-7 text-text backdrop:bg-(--hares-scrim) sm:m-auto sm:max-w-md sm:rounded-[28px]">
      <span aria-hidden="true" class="mx-auto block h-1.25 w-9 rounded-sm bg-strong"></span>
      <h2 [id]="titleId" class="mx-3 mt-4 mb-3 text-[19px] leading-[1.2] font-semibold tracking-[-0.012em]">{{ heading() }}</h2>
      <div class="flex flex-col pb-[env(safe-area-inset-bottom)]"><ng-content /></div>
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
