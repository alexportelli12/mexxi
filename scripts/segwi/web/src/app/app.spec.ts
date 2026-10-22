import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { productName } from './words';

describe('App', () => {
  it('shows the wordmark and the Runs title', async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('header')?.textContent).toContain(productName);
    expect(page.querySelector('h1')?.textContent).toBe('Runs');
  });
});
