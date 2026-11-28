import { prepareHtml } from './render-html';

describe('preparing a pull request body for display', () => {
  it('shows a ticked task as done and an open one as not done, because the sanitiser would drop the checkbox and lose the difference', () => {
    const html = '<li><input type="checkbox" class="task-list-item-checkbox" disabled checked> Unit tests</li><li><input type="checkbox" disabled> Sign-off</li>';
    const out = prepareHtml(html);
    expect(out).toContain('<span class="gh-task gh-task-on" role="img" aria-label="Done"></span> Unit tests');
    expect(out).toContain('<span class="gh-task" role="img" aria-label="Not done"></span> Sign-off');
    expect(out).not.toContain('<input');
  });

  it('starts the body at h2 under the page title and keeps the distance between its own levels', () => {
    expect(prepareHtml('<h1>A</h1><h2 id="x">B</h2><h4>C</h4>')).toBe('<h2>A</h2><h3 id="x">B</h3><h5>C</h5>');
    expect(prepareHtml('<h2>A</h2><h3>B</h3>')).toBe('<h2>A</h2><h3>B</h3>');
    expect(prepareHtml('<h4>A</h4>')).toBe('<h2>A</h2>');
    expect(prepareHtml('<p>no headings</p>')).toBe('<p>no headings</p>');
  });

  it('puts a table in its own scrolling box, so a wide one cannot push the page sideways', () => {
    expect(prepareHtml('<table><tr><td>a</td></tr></table>')).toBe('<div class="gh-table"><table><tr><td>a</td></tr></table></div>');
  });

  it('opens web links in a new tab without a referrer, and leaves in-page anchors and links that already say where to open alone', () => {
    expect(prepareHtml('<a href="https://example.com/x">x</a>')).toBe('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">x</a>');
    expect(prepareHtml('<a class="anchor" href="#why">#</a>')).toBe('<a class="anchor" href="#why">#</a>');
    expect(prepareHtml('<a href="https://a.test" target="_self">y</a>')).toBe('<a href="https://a.test" target="_self">y</a>');
  });
});
