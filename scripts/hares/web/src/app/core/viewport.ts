import { Injectable, signal } from '@angular/core';

/** The width where the desktop cockpit replaces the phone layout. */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** Whether the window is wide enough for the desktop layout. One listener, read as a signal. */
@Injectable({ providedIn: 'root' })
export class Viewport {
  readonly desktop = signal(false);

  constructor() {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(DESKTOP_QUERY);
    this.desktop.set(query.matches);
    query.addEventListener('change', (event) => this.desktop.set(event.matches));
  }
}
