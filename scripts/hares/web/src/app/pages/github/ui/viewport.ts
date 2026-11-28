import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** The width where the design switches from the phone layout to the desktop one. */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** Tracks whether the window is desktop width. Call it where a component is built. */
export function desktopSignal(): Signal<boolean> {
  const query = typeof matchMedia === 'function' ? matchMedia(DESKTOP_QUERY) : null;
  const desktop = signal(query?.matches ?? false);
  if (query) {
    const update = (event: MediaQueryListEvent) => desktop.set(event.matches);
    query.addEventListener('change', update);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', update));
  }
  return desktop.asReadonly();
}
