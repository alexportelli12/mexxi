import { TestBed } from '@angular/core/testing';
import { loadTheme, ThemeService } from './theme';

describe('theme', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('follows the device unless dark or light was saved', () => {
    expect(loadTheme(() => null)).toBe('system');
    expect(loadTheme(() => 'light')).toBe('light');
    expect(loadTheme(() => 'purple')).toBe('system');
  });

  it('sets data-theme for a forced scheme and clears it to follow the device', () => {
    const service = TestBed.inject(ThemeService);
    service.set('light');
    TestBed.tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    service.set('system');
    TestBed.tick();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('keeps the choice for the next visit', () => {
    TestBed.inject(ThemeService).set('dark');
    expect(loadTheme()).toBe('dark');
  });
});
