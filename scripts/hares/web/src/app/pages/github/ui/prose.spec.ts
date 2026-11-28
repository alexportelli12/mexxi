import { TestBed } from '@angular/core/testing';
import { Prose } from './prose';

async function render(body: string): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(Prose);
  fixture.componentRef.setInput('body', body);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('Prose', () => {
  it('strips a script and an inline handler even when the server let them through, because Angular sanitises what we bind', async () => {
    const element = await render('<p onclick="alert(1)">Hello</p><script>alert(2)</script><img src="x" onerror="alert(3)">');
    expect(element.querySelector('script')).toBeNull();
    expect(element.querySelector('[onclick]')).toBeNull();
    expect(element.querySelector('[onerror]')).toBeNull();
    expect(element.textContent).toContain('Hello');
  });

  it('keeps the rendered structure: headings one level down, a table, code, a quote and an image', async () => {
    const element = await render('<h1>Title</h1><table><tbody><tr><td>a</td></tr></tbody></table><pre><code>x = 1</code></pre><blockquote>q</blockquote><img src="https://camo.example/x.png" alt="shot">');
    expect(element.querySelector('h2')?.textContent).toBe('Title');
    expect(element.querySelector('h1')).toBeNull();
    expect(element.querySelector('table td')?.textContent).toBe('a');
    expect(element.querySelector('pre code')?.textContent).toBe('x = 1');
    expect(element.querySelector('blockquote')?.textContent).toBe('q');
    expect(element.querySelector('img')?.getAttribute('alt')).toBe('shot');
  });

  it('shows which task boxes are ticked after sanitising, not just the text beside them', async () => {
    const element = await render('<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> Done thing</li><li class="task-list-item"><input type="checkbox" disabled> Open thing</li></ul>');
    const boxes = [...element.querySelectorAll('.gh-task')];
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['Done', 'Not done']);
    expect(element.querySelectorAll('.gh-task-on')).toHaveLength(1);
  });
});
