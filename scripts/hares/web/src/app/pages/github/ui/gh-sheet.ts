import { ChangeDetectionStrategy, Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

let sheets = 0;

/**
 * A bottom sheet on phones and a centred dialog on desktop, on the native dialog element: it traps
 * focus, closes on Esc and returns focus to what opened it. Tapping the dimmed area closes it.
 */
@Component({
  selector: 'hares-gh-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="gh-sheet" [attr.aria-labelledby]="titleId" (close)="closed.emit()" (click)="onClick($event)">
      <span class="grab" aria-hidden="true"></span>
      <h2 [id]="titleId">{{ heading() }}</h2>
      <ng-content />
    </dialog>
  `,
})
export class GhSheet {
  readonly open = input.required<boolean>();
  readonly heading = input.required<string>();
  readonly closed = output<void>();
  protected readonly titleId = `gh-sheet-title-${++sheets}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const dialog = this.dialog().nativeElement;
      if (this.open() && !dialog.open) dialog.showModal();
      else if (!this.open() && dialog.open) dialog.close();
    });
  }

  protected onClick(event: MouseEvent): void {
    const dialog = this.dialog().nativeElement;
    if (event.target === dialog) dialog.close();
  }
}
