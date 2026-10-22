import names from '../../../../../names.json';

/**
 * Every name the interface shows comes from here, so a Maltese word is never
 * typed into a template. names.json is read at build time. segwi has no entry
 * there yet, so the product name stands in until it does.
 */
export const productName: string = names.find((entry) => entry.name === 'segwi')?.name ?? 'segwi';
