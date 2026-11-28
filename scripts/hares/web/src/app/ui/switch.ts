import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** An on and off switch. The tap area is 44 pixels tall; the track the eye sees is 32. */
@Component({
  selector: 'hares-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    <button type="button" role="switch" class="inline-flex min-h-11 min-w-13 cursor-pointer items-center justify-center" [attr.aria-checked]="checked()" [attr.aria-label]="label()" (click)="toggled.emit(!checked())">
      <span class="box-border flex h-8 w-13 rounded-2xl p-0.75" [class]="checked() ? 'justify-end bg-teal' : 'justify-start bg-strong'">
        <span class="size-6.5 rounded-full shadow-[0_1px_3px_var(--hares-knob-shadow)]" [class]="checked() ? 'bg-on-teal' : 'bg-text'"></span>
      </span>
    </button>
  `,
})
export class Switch {
  readonly checked = input.required<boolean>();
  readonly label = input.required<string>();
  readonly toggled = output<boolean>();
}
