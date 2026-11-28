import names from '../../../../../names.json';
import { brand, documentTitle, numberWord, productName, sessionsPhrase, startCommands, titles } from './words';

describe('words', () => {
  it('takes every command name from names.json, so none is typed into a screen', () => {
    const commands = names.filter((entry) => entry.kind === 'command').map((entry) => entry.name);
    for (const command of startCommands) expect(commands).toContain(command.name);
  });

  it('keeps Maltese words out of titles, which are English only', () => {
    const text = Object.values(titles).join(' ').toLowerCase();
    for (const entry of names) expect(text).not.toContain(entry.name.toLowerCase());
  });

  it('sets the product name with the h-bar for the screen and plain ASCII for the tab title', () => {
    expect(brand.charAt(0)).toBe('ħ');
    expect(brand.slice(1)).toBe(productName.slice(1));
    expect(documentTitle(0)).toBe(productName);
    expect(documentTitle(3)).toBe(`(3) ${productName}`);
  });

  it('writes counts as words up to ten, and keeps the singular right', () => {
    expect(numberWord(3)).toBe('three');
    expect(numberWord(11)).toBe('11');
    expect(sessionsPhrase(1, { sentence: true })).toBe('One session');
    expect(sessionsPhrase(4)).toBe('four sessions');
  });
});
