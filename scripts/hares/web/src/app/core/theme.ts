import { Injectable, effect, signal } from '@angular/core';
import { readSetting, writeSetting } from './draft';

export type ThemePreference = 'system' | 'dark' | 'light';
export const THEME_SETTING = 'theme';
export const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/** The saved preference; anything unknown means follow the device. */
export function loadTheme(read: (name: string) => string | null = readSetting): ThemePreference {
  const saved = read(THEME_SETTING);
  return saved === 'dark' || saved === 'light' ? saved : 'system';
}

/**
 * The theme preference. It sets data-theme on the document: "dark" and "light" force a scheme, and "system"
 * clears the attribute so the device's setting decides. public/theme-init.js applies the saved value before
 * the first paint, so a light-theme reader never sees a dark flash.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(loadTheme());

  constructor() {
    effect(() => {
      const value = this.preference();
      if (value === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', value);
    });
  }

  set(value: ThemePreference): void {
    this.preference.set(value);
    writeSetting(THEME_SETTING, value === 'system' ? null : value);
  }
}
