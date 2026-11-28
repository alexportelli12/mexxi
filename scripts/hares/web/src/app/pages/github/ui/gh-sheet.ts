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
  styles: `
    dialog{box-sizing:border-box;border:0;padding:8px 20px 28px;background:var(--surface);color:var(--text);font-family:var(--font);width:100%;max-width:none;margin:auto 0 0;border-radius:28px 28px 0 0}
    dialog::backdrop{background:color-mix(in srgb, var(--bg) 70%, transparent)}
    .grab{display:block;width:36px;height:5px;border-radius:3px;background:var(--strong);margin:0 auto}
    h2{margin:16px 0 0;font-size:22px;line-height:1.24;font-weight:600;letter-spacing:-.016em}
    @media (min-width:640px){dialog{max-width:480px;margin:auto;border-radius:24px;padding:24px}.grab{display:none}h2{margin-top:0}}
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
