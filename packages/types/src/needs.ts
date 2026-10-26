/**
 * "Shop by need": shoppers rarely want a category, they want an outcome (peace of mind, time back, a gift that means
 * something). Each need maps to catalogue rules, so it is always backed by real products and empty needs are hidden.
 *
 * `principles` are hypotheses from the customer-value framework (docs/GROWTH_STRATEGY.md), NOT proven facts: validate
 * each need with click-through and conversion data before investing in it. Copy states what the product category is
 * for; it never promises an outcome and never uses scarcity or fear.
 */
export interface NeedDef {
  slug: string;
  name: string;
  tagline: string;
  /** Honest one-liner shown on the need page. */
  promise: string;
  /** Customer-value principles (1-24) this need tests. */
  principles: readonly number[];
  match: {
    /** sub-category slugs (slugified CATEGORY_TREE children) */
    categories?: readonly string[];
    /** whole-word keywords matched against tags and title */
    keywords?: readonly string[];
  };
}

export const NEEDS: readonly NeedDef[] = [
  { slug: 'screen-free-play', name: 'Screen-free play', tagline: 'Calm, hands-on play for kids', promise: 'Activities that keep little hands busy away from screens. Age ranges and safety standards are listed on each product.', principles: [2, 4], match: { categories: ['screen-free-activities', 'sensory-toys', 'creative-kits'] } },
  { slug: 'learn-and-grow', name: 'Learn & grow', tagline: 'Toys that build skills', promise: 'STEM, building and learning toys that support curiosity and skills.', principles: [1, 3, 16], match: { categories: ['stem-toys', 'educational-toys', 'building-toys'] } },
  { slug: 'time-savers', name: 'Time-savers', tagline: 'Less effort, faster', promise: 'Small tools that shorten the repetitive jobs: cleaning up, grooming, getting organised.', principles: [13, 14], match: { categories: ['pet-hair-removal', 'grooming-tools', 'pet-organization', 'organization-gadgets'], keywords: ['organizer', 'organiser', 'quick'] } },
  { slug: 'travel-ready', name: 'Travel-ready', tagline: 'Take it with you', promise: 'Portable gear for trips, commutes and days out, for you and your pet.', principles: [20, 15], match: { categories: ['travel-gadgets', 'car-and-travel-pet-accessories', 'portable-pet-water', 'car-accessories', 'bags'], keywords: ['travel', 'portable'] } },
  { slug: 'pet-wellbeing', name: 'Happy, healthy pets', tagline: 'Enrichment and care for pets', promise: 'Enrichment, slower feeding and everyday care for dogs and cats. Not a substitute for veterinary advice.', principles: [2, 4], match: { categories: ['interactive-dog-toys', 'slow-feeding-accessories', 'cat-enrichment', 'walking-accessories'] } },
  { slug: 'thoughtful-gifts', name: 'Thoughtful gifts', tagline: 'Made personal', promise: 'Personalised pieces for people and pets, so the gift says you thought about them.', principles: [6, 21], match: { categories: ['personalized-pet-accessories', 'personalized-kids-products', 'personalized-fashion'], keywords: ['personalized', 'personalised', 'custom', 'engraved'] } },
  { slug: 'stand-out', name: 'Stand out', tagline: 'Pieces with character', promise: 'Distinctive clothing and accessories for people who like to look like themselves.', principles: [9, 21, 22], match: { categories: ['unique-clothing', 'accessories', 'novelty-gadgets'] } },
  { slug: 'desk-upgrades', name: 'Work smarter', tagline: 'Upgrade your desk and phone', promise: 'Practical desk and phone accessories for people who work, study or create at a screen.', principles: [10, 14, 18], match: { categories: ['desk-gadgets', 'phone-accessories', 'smart-accessories'] } },
  { slug: 'rest-and-comfort', name: 'Rest & comfort', tagline: 'Ease the day', promise: 'Comfort-focused finds for winding down. We list only what the catalogue actually contains.', principles: [24], match: { keywords: ['comfort', 'cozy', 'cosy', 'sleep', 'massage', 'relax', 'calming'] } },
];

export const needBySlug = (slug: string): NeedDef | undefined => NEEDS.find((n) => n.slug === slug);

/** Referral programme terms. One place so copy, code and tests agree. */
export const REFERRAL_TERMS = {
  /** discount the invited friend gets on their first order */
  friendPercent: 0.1,
  /** discount code the referrer earns once the friend's order is delivered and not refunded */
  rewardPercent: 0.1,
  rewardValidDays: 60,
} as const;
