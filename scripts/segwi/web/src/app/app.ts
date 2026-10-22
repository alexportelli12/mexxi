import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { productName } from './words';

@Component({
  imports: [RouterOutlet],
  selector: 'segwi-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto flex min-h-dvh max-w-xl flex-col gap-6 p-4">
      <header class="border-b border-border pb-4">
        <span class="font-code text-accent">{{ productName }}</span>
      </header>
      <h1 class="text-2xl font-semibold text-text">Runs</h1>
      <p class="text-muted">Your runs will appear here.</p>
      <router-outlet />
    </main>
  `,
})
export class App {
  protected readonly productName = productName;
}
