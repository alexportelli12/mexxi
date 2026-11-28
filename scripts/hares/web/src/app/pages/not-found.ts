import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Button } from '../ui/button';

@Component({
  imports: [RouterLink, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'gap-4 px-5 pt-12 lg:px-0' },
  template: `
    <h1 class="text-[30px] leading-[1.1] font-semibold tracking-[-0.026em]">This page doesn’t exist</h1>
    <p class="max-w-[32ch] text-base leading-[1.45] text-muted">The link may be from an older version. Everything that needs you is on Now.</p>
    <a hares-button variant="primary" class="self-start" routerLink="/">Go to Now</a>
  `,
})
export class NotFoundPage {}
