/** ORVIA Find: discovery presets (gift / budget / need). PURE. Each preset is just a natural-language query run by the same engine. */
import { NEEDS } from '@orvia/types';

export interface FindPreset {
  id: string;
  group: 'gift' | 'budget' | 'need' | 'quick';
  title: string;
  query: string;
}

/** Round budget steps per currency, in major units. */
export const BUDGET_STEPS: Record<'USD' | 'CAD' | 'INR', number[]> = { USD: [25, 50, 100], CAD: [30, 60, 120], INR: [500, 1500, 3000] };
const SYMBOL: Record<'USD' | 'CAD' | 'INR', string> = { USD: '$', CAD: '$', INR: '₹' };

export function buildPresets(currency: 'USD' | 'CAD' | 'INR'): FindPreset[] {
  const sym = SYMBOL[currency];
  const steps = BUDGET_STEPS[currency];
  const presets: FindPreset[] = [
    ...steps.map((b) => ({ id: `gift-${b}`, group: 'gift' as const, title: `Gifts under ${sym}${b}`, query: `gift under ${sym}${b}` })),
    { id: 'gift-dog', group: 'gift', title: 'Gifts for a dog', query: 'gift for my dog' },
    { id: 'gift-cat', group: 'gift', title: 'Gifts for a cat', query: 'gift for my cat' },
    { id: 'gift-kid', group: 'gift', title: 'Gifts for kids', query: 'gift for a kid' },
    { id: 'gift-personal', group: 'gift', title: 'Personalised gifts', query: 'personalized gift' },
    ...steps.map((b) => ({ id: `budget-${b}`, group: 'budget' as const, title: `Best value under ${sym}${b}`, query: `best value under ${sym}${b}` })),
    { id: 'quick-rated', group: 'quick', title: 'Top rated', query: 'top rated' },
    { id: 'quick-fast', group: 'quick', title: 'Fastest delivery', query: 'fastest delivery' },
    ...NEEDS.map((n) => ({ id: `need-${n.slug}`, group: 'need' as const, title: n.name, query: n.name.toLowerCase().replace(/&/g, 'and') })),
  ];
  return presets;
}
