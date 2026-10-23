import names from '../../../../../names.json';

/**
 * Every name the interface shows comes from here, so a Maltese word is never
 * typed into a template. names.json is read at build time. segwi has no entry
 * there yet, so the product name stands in until it does. The command names are
 * shown only in mono, as the command a run executes.
 */
const nameOf = (wanted: string): string => names.find((entry) => entry.name === wanted)?.name ?? wanted;

export const productName: string = nameOf('segwi');

export type Action = 'build' | 'ready' | 'ask';

const commandNames: Record<Exclude<Action, 'ask'>, string> = {
  build: nameOf('wettaq'),
  ready: nameOf('lesti'),
};

/** The slash command an action runs, or null when it only answers. */
export function commandFor(action: Action): string | null {
  return action === 'ask' ? null : `/${commandNames[action]}`;
}

export const actionLabels: Record<Action, string> = { build: 'Build', ready: 'Get ready', ask: 'Ask' };

/** The "what happens" line on the New run screen. */
export function whatHappens(action: Action, repo: string): string {
  const command = commandFor(action);
  return command
    ? `Runs ${command} in ${repo} on a new branch; you'll get a PR`
    : `Answers in ${repo} without changing anything`;
}

/** The notification explanation, with the product name taken from here. */
export const notificationsExplainer = `${productName} tells you when a run needs your reply or OK, and when it finishes or fails. Nothing else.`;
export const iosHomeScreenHint = `On iPhone, add ${productName} to your Home Screen first, then turn notifications on here.`;

/** Titles. English only: no Maltese word has been verified yet. */
export const titles = {
  runs: 'Runs',
  runDetail: 'Run',
  approvals: 'Approvals',
  newRun: 'New run',
  audit: 'Audit',
  notFound: "This page doesn't exist",
} as const;

/** The page title: a count of what needs you, then the product name. */
export function documentTitle(needsYou: number): string {
  return needsYou > 0 ? `(${needsYou}) ${productName}` : productName;
}
