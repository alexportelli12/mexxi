import { signal } from '@angular/core';

/** One shared clock so every relative time on screen stays current without a timer each. */
export const now = signal(Date.now());
if (typeof setInterval !== 'undefined') setInterval(() => now.set(Date.now()), 30_000);
