import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LiveService } from './core/live';
import { Banner } from './ui/banner';
import { NotificationsToggle } from './ui/notifications-toggle';
import { documentTitle, productName } from './words';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Banner, NotificationsToggle],
  selector: 'segwi-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-card focus:bg-accent focus:px-4 focus:py-3 focus:text-on-accent">Skip to content</a>

    <header class="border-b border-border">
      <div class="mx-auto flex w-full max-w-180 items-center justify-between gap-4 px-4 py-3">
        <a routerLink="/runs" class="inline-flex min-h-11 items-center gap-2.5" [attr.aria-label]="productName + ', Runs'">
          <svg class="size-6.5" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="8" class="fill-surface-raised stroke-border-strong" />
            <path d="M8.5 16h13M16.5 10.5L22 16l-5.5 5.5" class="fill-none stroke-accent" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="font-code text-[15px] font-semibold tracking-tight">{{ productName }}</span>
        </a>
        <div class="flex items-center gap-3">
          <nav class="hidden items-center gap-1 lg:flex" aria-label="Main">
            @for (item of nav; track item.path) {
              <a [routerLink]="item.path" routerLinkActive="bg-surface-raised text-text" ariaCurrentWhenActive="page"
                class="inline-flex min-h-11 items-center gap-2 rounded-card px-4 text-[15px] text-muted hover:text-text">
                {{ item.label }}
                @if (item.badge && live.approvals().length) {
                  <span class="rounded-full bg-accent px-2 text-sm font-semibold text-on-accent">{{ live.approvals().length }}<span class="sr-only"> waiting</span></span>
                }
              </a>
            }
          </nav>
          <segwi-notifications-toggle />
        </div>
      </div>
    </header>

    <main id="main" tabindex="-1" class="mx-auto flex w-full max-w-180 flex-col gap-5 px-4 pt-5 pb-[calc(9rem+env(safe-area-inset-bottom))] outline-none lg:pb-12">
      @if (live.connection() === 'reconnecting') {
        <segwi-banner>Reconnecting…</segwi-banner>
      }
      <router-outlet />
    </main>

    <nav class="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden" aria-label="Main">
      <ul class="mx-auto flex max-w-180">
        @for (item of nav.slice(0, 3); track item.path) {
          <li class="flex-1">
            <a [routerLink]="item.path" routerLinkActive="text-accent" ariaCurrentWhenActive="page"
              class="flex min-h-16 flex-col items-center justify-center gap-1 text-sm text-muted">
              <span class="relative inline-flex">
                <svg class="size-6" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                  @switch (item.path) {
                    @case ('/runs') { <path d="M4 6h16M4 12h16M4 18h10" /> }
                    @case ('/approvals') { <path d="M12 3l7 3v5c0 4.5-3 7.5-7 10-4-2.5-7-5.5-7-10V6z" /> }
                    @default { <path d="M12 5v14M5 12h14" /> }
                  }
                </svg>
                @if (item.badge && live.approvals().length) {
                  <span class="absolute -top-1.5 -right-3 min-w-5 rounded-full bg-accent px-1 text-center text-xs font-semibold text-on-accent">{{ live.approvals().length }}<span class="sr-only"> waiting</span></span>
                }
              </span>
              {{ item.label }}
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class App {
  protected readonly live = inject(LiveService);
  protected readonly productName = productName;
  protected readonly nav = [
    { path: '/runs', label: 'Runs', badge: false },
    { path: '/approvals', label: 'Approvals', badge: true },
    { path: '/new', label: 'New', badge: false },
    { path: '/audit', label: 'Audit', badge: false },
  ];

  constructor() {
    const title = inject(Title);
    effect(() => title.setTitle(documentTitle(this.live.needsCount())));
    this.live.start();
  }
}
