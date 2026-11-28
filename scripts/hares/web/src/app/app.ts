import { ChangeDetectionStrategy, Component, HostListener, effect, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { LiveService } from './core/live';
import { ThemeService } from './core/theme';
import { Viewport } from './core/viewport';
import { Banner } from './ui/banner';
import { Icon, type IconName } from './ui/icon';
import { Lantern } from './ui/lantern';
import { brand, documentTitle } from './words';

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  exact: boolean;
}

/** The screens the bottom bar belongs to on a phone; a session, Start and Settings use the whole screen. */
const NAV_PATHS = /^\/(?:$|\?|prs|issues|ci)/;

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Banner, Icon, Lantern],
  selector: 'hares-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-dvh flex-col' },
  template: `
    <a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-xl focus:bg-amber focus:px-4 focus:py-3 focus:text-on-amber">Skip to content</a>

    @if (viewport.desktop()) {
      <header class="border-b border-line">
        <div class="mx-auto flex max-w-[1280px] items-center gap-10 px-8">
          <a routerLink="/" class="inline-flex min-h-11 items-center gap-2.5 text-text no-underline" [attr.aria-label]="brand + ', Now'">
            <hares-lantern [phase]="live.counts().waiting ? 'waiting' : live.counts().working ? 'working' : 'idle'" />
            <span class="text-xl font-bold tracking-[-0.025em]">{{ brand }}</span>
          </a>
          <nav class="flex gap-7" aria-label="Main">
            @for (item of nav; track item.path) {
              <a [routerLink]="item.path" routerLinkActive="font-semibold text-text shadow-[inset_0_-2px_0_var(--amber)]" [routerLinkActiveOptions]="{ exact: item.exact }" ariaCurrentWhenActive="page"
                class="-mx-1.5 inline-flex min-h-16 items-center px-1.5 text-[15px] font-medium text-muted no-underline hover:text-text">
                {{ item.label }}
                @if (item.path === '/prs' && live.boardCount()) {
                  <span class="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber px-1.5 text-xs font-bold text-on-amber">{{ live.boardCount() }}<span class="sr-only"> to review</span></span>
                }
                @if (item.path === '/ci' && live.health()?.board?.mainRed) {
                  <span class="ml-2 inline-block size-1.75 rounded-full bg-red"></span><span class="sr-only"> main is red</span>
                }
              </a>
            }
          </nav>
          <span class="flex-1"></span>
          <span class="inline-flex items-center gap-1.5 text-[13px] font-medium" [class]="live.offline() ? 'text-red' : 'text-teal'">
            <span aria-hidden="true" class="size-1.5 rounded-full" [class]="live.offline() ? 'bg-red' : 'bg-teal'"></span>{{ host() }} {{ live.offline() ? 'offline' : 'live' }}
          </span>
          <a routerLink="/settings" aria-label="Settings" class="inline-flex size-11 items-center justify-center rounded-full text-muted no-underline hover:text-text"><hares-icon name="gear" [size]="22" /></a>
          <a routerLink="/start" class="inline-flex min-h-11 items-center gap-2 rounded-[14px] bg-amber pr-4.5 pl-3.5 text-[15px] font-semibold text-on-amber no-underline shadow-[0_10px_30px_-16px_var(--amber)]">
            <hares-icon name="plus" [size]="18" />Start a session<span class="ml-1 font-medium opacity-60" aria-hidden="true">N</span>
          </a>
        </div>
      </header>
    }

    <main id="main" tabindex="-1" class="flex w-full flex-1 flex-col outline-none lg:mx-auto lg:max-w-[1280px] lg:px-8 lg:pt-10 lg:pb-12" [class.pb-[calc(5.5rem+env(safe-area-inset-bottom))]]="showNav() && !viewport.desktop()">
      @if (live.connection() === 'reconnecting') {
        <hares-banner class="mx-5 mt-4 lg:mx-0" kind="error">Reconnecting…</hares-banner>
      }
      <router-outlet />
    </main>

    @if (showNav() && !viewport.desktop()) {
      <nav class="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-bg px-1.5 pt-1 pb-[calc(1.375rem+env(safe-area-inset-bottom))]" aria-label="Main">
        @for (item of nav; track item.path) {
          <a [routerLink]="item.path" routerLinkActive="font-semibold text-text" #here="routerLinkActive" [routerLinkActiveOptions]="{ exact: item.exact }" ariaCurrentWhenActive="page"
            class="relative flex min-h-13.5 flex-col items-center justify-center gap-1 text-[12.5px] font-medium text-faint no-underline">
            <span class="relative inline-flex">
              <hares-icon [name]="item.icon" [size]="22" />
              @if (item.path === '/prs' && live.boardCount()) {
                <span class="absolute -top-1 left-[calc(50%+6px)] box-border inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full border-2 border-bg bg-amber px-1.25 text-[11.5px] font-bold text-on-amber">{{ live.boardCount() }}<span class="sr-only"> to review</span></span>
              }
              @if (item.path === '/ci' && live.health()?.board?.mainRed) {
                <span class="absolute -top-0.5 -right-1 size-2 rounded-full border-2 border-bg bg-red"></span><span class="sr-only"> main is red</span>
              }
            </span>
            {{ item.label }}
            @if (here.isActive) { <span aria-hidden="true" class="absolute top-0 h-0.75 w-5 rounded-b-[3px] bg-amber"></span> }
          </a>
        }
      </nav>
    }
  `,
})
export class App {
  protected readonly live = inject(LiveService);
  protected readonly viewport = inject(Viewport);
  protected readonly brand = brand;
  protected readonly nav: NavItem[] = [
    { path: '/', label: 'Now', icon: 'now', exact: true },
    { path: '/prs', label: 'Pull requests', icon: 'pr', exact: false },
    { path: '/issues', label: 'Issues', icon: 'issue', exact: false },
    { path: '/ci', label: 'CI', icon: 'ci', exact: false },
  ];
  private readonly router = inject(Router);
  protected readonly showNav = signal(NAV_PATHS.test(this.router.url));
  protected host = () => this.live.health()?.host ?? 'atlas';

  constructor() {
    inject(ThemeService);
    const title = inject(Title);
    effect(() => title.setTitle(documentTitle(this.live.needsCount())));
    this.live.start();
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe((event) => this.showNav.set(NAV_PATHS.test((event as NavigationEnd).urlAfterRedirects)));
  }

  /** N starts a session from anywhere on a desktop, unless the keys are going into a field. */
  @HostListener('document:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (!this.viewport.desktop() || event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    void this.router.navigate(['/start']);
  }
}
