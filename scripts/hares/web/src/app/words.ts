import names from '../../../../../names.json';

/**
 * Every name the interface shows comes from here, so a Maltese word is never typed into a template.
 * names.json is read at build time. The command names are shown only as the command a session runs.
 */
const nameOf = (wanted: string): string => names.find((entry) => entry.name === wanted)?.name ?? wanted;

/** The product name in plain ASCII, for titles and anywhere the h-bar might not render. */
export const productName: string = nameOf('hares');
/** The product name as the design sets it, with the Maltese h-bar. */
export const brand = 'ħ' + productName.slice(1);
/** The workflow the product belongs to. */
export const workflowName: string = nameOf('mexxi');

/** The commands the Start screen offers, in the design's order, with what each one does. */
export const startCommands: { name: string; what: string }[] = [
  { name: nameOf('wettaq'), what: 'Build an issue, end to end' },
  { name: nameOf('lesti'), what: 'Get a repo ready for ' + workflowName },
  { name: nameOf('sewwi'), what: 'Change the workflow itself' },
  { name: nameOf('ittestja'), what: 'Test a change in a browser' },
  { name: nameOf('irrifletti'), what: 'Look back on recent sessions' },
];

/** The command that builds an issue; the Issue tab runs it with the issue number. */
export const buildCommand = startCommands[0].name;

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** "three" for 3, up to ten; larger counts stay digits. */
export const numberWord = (count: number): string => NUMBER_WORDS[count] ?? String(count);

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** "Three sessions", "One session": the count in words, capitalised at the start of a sentence. */
export const sessionsPhrase = (count: number, { sentence = false } = {}): string => {
  const text = `${numberWord(count)} ${count === 1 ? 'session' : 'sessions'}`;
  return sentence ? capitalise(text) : text;
};

/** The notification explanation, with the product name taken from here. */
export const notificationsExplainer = `${productName} tells you when a session asks you something, when it finishes, and when main goes red. Nothing else is on unless you turn it on.`;
export const iosHomeScreenHint = `On iPhone, add ${productName} to your Home Screen first, then turn notifications on here.`;

/** Titles for the browser tab. English only: no Maltese word has been verified yet. */
export const titles = {
  now: 'Now',
  session: 'Session',
  terminal: 'Terminal',
  start: 'Start a session',
  settings: 'Settings',
  notifications: 'Notifications',
  activity: 'Activity',
  notFound: 'This page doesn’t exist',
} as const;

/** The page title: a count of what needs you, then the product name. */
export function documentTitle(needsYou: number): string {
  return needsYou > 0 ? `(${needsYou}) ${productName}` : productName;
}

/** What Now says when the server can't see herdr. */
export const offlineLine = `Your sessions keep running in herdr. ${brand} reconnects on its own.`;
