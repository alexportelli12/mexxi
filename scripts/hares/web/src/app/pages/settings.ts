import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api';
import { now } from '../core/clock';
import { LiveService } from '../core/live';
import { clockTime, dayLabel } from '../core/session-view';
import { THEMES, ThemeService } from '../core/theme';
import type { AuditRow, Extension, NotificationPrefs, RepoInfo } from '../models';
import { BackLink } from '../ui/back-link';
import { Icon } from '../ui/icon';
import { brand, workflowName } from '../words';

/** The extension that shows the machine's health: its page is linked from here, whatever else is installed. */
const HEALTH_EXTENSION = 'atlas-ops';

/**
 * Settings: the repos being watched, read only, since they come from the config file; links to
 * Notifications and Activity; the appearance; and whether herdr, where the sessions live, can be reached.
 */
@Component({
  imports: [BackLink, Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex-1' },
  template: `
    <header class="flex items-center px-3.5 pt-2"><hares-back-link to="/" label="Now" /></header>
    <main class="flex flex-col gap-8 px-5 pt-3 pb-12">
      <h1 class="text-[30px] leading-[1.1] font-semibold tracking-[-0.026em]">Settings</h1>

      <section class="flex flex-col" aria-labelledby="h-repos">
        <div class="sect-head"><h2 id="h-repos">Repos</h2><span class="text-[13.5px] text-faint">{{ repos().length }} watched</span></div>
        <ul>
          @for (repo of repos(); track repo.name) {
            <li class="flex items-center gap-3.5 border-b border-line py-3.5">
              <span class="flex-1 text-base font-medium">{{ repo.name }}</span>
              @if (repo.github) { <span class="text-[13.5px] text-faint">{{ repo.github }}</span> }
            </li>
          }
        </ul>
        <p class="mt-3 text-sm leading-[1.45] text-faint">Repos come from <code class="font-mono text-[13px] text-muted">~/.config/{{ workflow }}/config.json</code>. Add new ones there.</p>
      </section>

      <section class="flex flex-col" aria-labelledby="h-general">
        <div class="sect-head"><h2 id="h-general">General</h2></div>
        <a routerLink="/settings/notifications" class="flex items-center gap-3.5 border-b border-line py-4 text-text no-underline">
          <span class="text-muted"><hares-icon name="bell" /></span><span class="flex-1 text-base font-medium">Notifications</span>
          @if (eventCount() !== null) { <span class="text-[14.5px] text-faint">{{ eventCount() }} {{ eventCount() === 1 ? 'event' : 'events' }}</span> }
          <span class="text-faint"><hares-icon name="chevron" /></span>
        </a>
        <a routerLink="/activity" class="flex items-center gap-3.5 border-b border-line py-4 text-text no-underline">
          <span class="text-muted"><hares-icon name="resume" /></span><span class="flex-1 text-base font-medium">Activity</span>
          @if (todayCount() !== null) { <span class="text-[14.5px] text-faint">Today {{ todayCount() }}</span> }
          <span class="text-faint"><hares-icon name="chevron" /></span>
        </a>
        <div class="flex items-center gap-3.5 border-b border-line py-3">
          <span id="appearance-label" class="flex-1 text-base font-medium">Appearance</span>
          <div role="radiogroup" aria-labelledby="appearance-label" class="grid grid-cols-3 gap-0.5 rounded-xl bg-surface p-0.75">
            @for (theme of themes; track theme.value) {
              <button type="button" role="radio" class="min-h-11 cursor-pointer rounded-[10px] border-0 px-3 text-sm" [attr.aria-checked]="themeService.preference() === theme.value"
                [class]="themeService.preference() === theme.value ? 'bg-raised font-semibold text-text' : 'bg-transparent font-medium text-muted'" (click)="themeService.set(theme.value)">{{ theme.label }}</button>
            }
          </div>
        </div>
      </section>

      <section class="flex flex-col" aria-labelledby="h-host">
        <div class="sect-head"><h2 id="h-host">{{ host() }}</h2></div>
        <div class="flex items-center gap-3.5 border-b border-line py-4">
          <span aria-hidden="true" class="mx-1.5 size-2 flex-none rounded-full" [class]="herdr()?.connected ? 'bg-teal' : 'bg-red'"></span>
          <span class="flex flex-1 flex-col gap-0.75">
            <span class="text-base font-medium">{{ herdr()?.connected ? 'herdr connected' : 'herdr isn’t reachable' }}</span>
            <span class="text-[13.5px] text-faint">{{ herdrLine() }}</span>
          </span>
        </div>
        @if (health(); as machine) {
          <a [href]="machine.url" class="flex items-center gap-3.5 border-b border-line py-4 text-text no-underline">
            <span class="text-muted"><hares-icon name="server" /></span><span class="flex-1 text-base font-medium">Machine health</span>
            <span class="text-[14.5px] text-faint">{{ machine.name }}</span><span class="text-faint"><hares-icon name="chevron" /></span>
          </a>
        }
      </section>

      <p class="text-[13.5px] text-faint">{{ brand }}{{ version() ? ' ' + version() : '' }}, part of {{ workflow }}</p>
    </main>
  `,
})
export class SettingsPage {
  private readonly api = inject(ApiService);
  protected readonly live = inject(LiveService);
  protected readonly themeService = inject(ThemeService);
  protected readonly themes = THEMES;
  protected readonly brand = brand;
  protected readonly workflow = workflowName;
  protected readonly repos = signal<RepoInfo[]>([]);
  protected readonly prefs = signal<NotificationPrefs | null>(null);
  protected readonly audit = signal<AuditRow[] | null>(null);
  protected readonly extensions = signal<Extension[]>([]);

  protected host = () => this.live.health()?.host ?? 'atlas';
  protected readonly herdr = computed(() => this.live.health()?.herdr ?? null);
  protected readonly version = computed(() => this.live.health()?.version ?? '');
  protected readonly health = computed(() => this.extensions().find((entry) => entry.name === HEALTH_EXTENSION) ?? null);
  protected readonly eventCount = computed(() => {
    const events = this.prefs()?.events;
    return events ? Object.values(events).filter(Boolean).length : null;
  });
  protected readonly todayCount = computed(() => {
    const rows = this.audit();
    return rows ? rows.filter((row) => dayLabel(row.at, now()) === 'Today').length : null;
  });
  protected readonly herdrLine = computed(() => {
    const herdr = this.herdr();
    if (!herdr) return 'Checking…';
    if (!herdr.connected) return herdr.lastSeenAt ? `Last seen at ${clockTime(herdr.lastSeenAt)}. ${brand} keeps trying.` : `${brand} keeps trying.`;
    const sessions = herdr.claudeSessions;
    return `Protocol ${herdr.protocol}, ${herdr.panes} ${herdr.panes === 1 ? 'pane' : 'panes'}, ${sessions} Claude ${sessions === 1 ? 'session' : 'sessions'}`;
  });

  constructor() {
    // Each part loads on its own, so one that fails leaves the rest of the screen as it is.
    this.api.repos().then((repos) => this.repos.set(repos), () => undefined);
    this.api.notificationPrefs().then((answer) => this.prefs.set(answer.prefs), () => undefined);
    this.api.audit(200).then((rows) => this.audit.set(rows), () => undefined);
    this.api.extensions().then((list) => this.extensions.set(list), () => undefined);
  }
}
