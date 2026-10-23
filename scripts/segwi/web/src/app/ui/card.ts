import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'segwi-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block rounded-card border border-border bg-surface p-4' },
  template: '<ng-content />',
})
export class Card {}
