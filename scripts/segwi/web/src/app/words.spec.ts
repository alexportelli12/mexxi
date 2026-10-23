import names from '../../../../../names.json';
import { actionLabels, commandFor, documentTitle, iosHomeScreenHint, notificationsExplainer, productName, titles, whatHappens } from './words';

describe('words', () => {
  it('takes command names from names.json and shows none for an ask', () => {
    const commands = names.filter((entry) => entry.kind === 'command').map((entry) => `/${entry.name}`);
    expect(commands).toContain(commandFor('build'));
    expect(commands).toContain(commandFor('ready'));
    expect(commandFor('build')).not.toBe(commandFor('ready'));
    expect(commandFor('ask')).toBeNull();
  });

  it('words the "what happens" line for each action', () => {
    expect(whatHappens('build', 'my-app')).toBe(`Runs ${commandFor('build')} in my-app on a new branch; you'll get a PR`);
    expect(whatHappens('ready', 'my-app')).toBe(`Runs ${commandFor('ready')} in my-app on a new branch; you'll get a PR`);
    expect(whatHappens('ask', 'my-app')).toBe('Answers in my-app without changing anything');
  });

  it('keeps Maltese words out of titles and labels, which are English only', () => {
    const text = [...Object.values(titles), ...Object.values(actionLabels)].join(' ').toLowerCase();
    for (const entry of names) expect(text).not.toContain(entry.name.toLowerCase());
    expect(Object.values(actionLabels)).toEqual(['Build', 'Get ready', 'Ask']);
  });

  it('names the product in the page title and the notification copy', () => {
    expect(documentTitle(0)).toBe(productName);
    expect(documentTitle(3)).toBe(`(3) ${productName}`);
    expect(notificationsExplainer).toContain('Nothing else.');
    expect(iosHomeScreenHint).toContain('Home Screen');
  });
});
