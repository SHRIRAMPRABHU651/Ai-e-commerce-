export const ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'MARKETING',
  'OPERATIONS',
  'SUPPORT',
  'ANALYST',
  'CUSTOMER',
] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: readonly Role[] = ROLES.filter((r) => r !== 'CUSTOMER');

export const COUNTRY_CODES = ['US', 'CA', 'IN'] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'SUPPLIER_PROCESSING',
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
  'REFUND_REQUESTED',
  'REFUNDED',
  'EXCEPTION',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PRODUCT_STATES = [
  'DISCOVERED',
  'ANALYZING',
  'APPROVED',
  'DRAFT',
  'IMAGE_REQUIRED',
  'COMPLIANCE_REVIEW',
  'SUPPLIER_REVIEW',
  'PRICING_REVIEW',
  'READY',
  'PUBLISHED',
  'TESTING',
  'WINNER',
  'SCALING',
  'DECLINING',
  'PAUSED',
  'OUT_OF_STOCK',
  'BANNED',
  'ARCHIVED',
] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];

/** States in which a product may be shown to customers. */
export const SELLABLE_STATES: readonly ProductState[] = [
  'PUBLISHED',
  'TESTING',
  'WINNER',
  'SCALING',
  'DECLINING',
];

export const PRODUCT_TRANSITIONS: Record<ProductState, readonly ProductState[]> = {
  DISCOVERED: ['ANALYZING', 'IMAGE_REQUIRED', 'BANNED', 'ARCHIVED'],
  ANALYZING: ['APPROVED', 'IMAGE_REQUIRED', 'COMPLIANCE_REVIEW', 'SUPPLIER_REVIEW', 'PRICING_REVIEW', 'BANNED', 'ARCHIVED', 'DISCOVERED'],
  APPROVED: ['DRAFT', 'IMAGE_REQUIRED', 'ARCHIVED', 'BANNED'],
  DRAFT: ['PUBLISHED', 'TESTING', 'IMAGE_REQUIRED', 'READY', 'ARCHIVED', 'BANNED'],
  // blocked until the product has at least one usable, Orvia-hosted photo
  IMAGE_REQUIRED: ['READY', 'ANALYZING', 'ARCHIVED', 'BANNED'],
  COMPLIANCE_REVIEW: ['ANALYZING', 'APPROVED', 'ARCHIVED', 'BANNED'],
  SUPPLIER_REVIEW: ['ANALYZING', 'APPROVED', 'ARCHIVED', 'BANNED'],
  PRICING_REVIEW: ['ANALYZING', 'APPROVED', 'ARCHIVED', 'BANNED'],
  READY: ['PUBLISHED', 'TESTING', 'DRAFT', 'IMAGE_REQUIRED', 'ARCHIVED', 'BANNED'],
  PUBLISHED: ['TESTING', 'PAUSED', 'OUT_OF_STOCK', 'ARCHIVED', 'BANNED', 'WINNER', 'DECLINING'],
  TESTING: ['WINNER', 'DECLINING', 'PAUSED', 'ARCHIVED', 'OUT_OF_STOCK', 'BANNED'],
  WINNER: ['SCALING', 'DECLINING', 'PAUSED', 'OUT_OF_STOCK', 'BANNED', 'ARCHIVED'],
  SCALING: ['WINNER', 'DECLINING', 'PAUSED', 'OUT_OF_STOCK', 'BANNED', 'ARCHIVED'],
  DECLINING: ['PAUSED', 'ARCHIVED', 'WINNER', 'OUT_OF_STOCK', 'BANNED', 'TESTING'],
  PAUSED: ['PUBLISHED', 'TESTING', 'ARCHIVED', 'BANNED', 'DRAFT'],
  OUT_OF_STOCK: ['PUBLISHED', 'PAUSED', 'ARCHIVED', 'BANNED', 'TESTING'],
  BANNED: ['ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

export const AUTOMATION_MODES = ['OFF', 'ASSISTED', 'AUTOMATIC'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const AUTOMATION_KEYS = [
  'product_discovery',
  'auto_publishing',
  'dynamic_pricing',
  'inventory_sync',
  'order_fulfillment',
  'tracking',
  'customer_support',
  'ad_optimization',
  'promotion_optimization',
  'abandoned_cart',
  'ai_reports',
] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

export const EXCEPTION_KINDS = [
  'FRAUD',
  'CHARGEBACK',
  'SAFETY',
  'COMPLIANCE',
  'HIGH_VALUE_REFUND',
  'SUPPLIER_FAILURE',
  'PAYMENT_FAILURE',
  'SUSPICIOUS_ORDER',
  'AUTHENTICITY',
  'PRICE_CHANGE',
  'NEGATIVE_MARGIN',
  'TRACKING',
  'MISSING_IMAGE',
  'MANUAL_FULFILLMENT',
  'RECONCILIATION',
  'STOCK_STALE',
  'ORGANIC_CLAIM',
  'MARKET_SOURCE',
  'OTHER',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const INVENTORY_STATUSES = [
  'IN_STOCK',
  'LOW_STOCK',
  'OUT_OF_STOCK',
  'SUPPLIER_UNAVAILABLE',
  'PRICE_CHANGED',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export const CATEGORY_TREE = [
  {
    slug: 'pet',
    name: 'Pet',
    children: [
      'Interactive dog toys',
      'Slow-feeding accessories',
      'Portable pet water',
      'Car & travel pet accessories',
      'Grooming tools',
      'Pet-hair removal',
      'Pet organization',
      'Walking accessories',
      'Cat enrichment',
      'Personalized pet accessories',
    ],
  },
  {
    slug: 'kids',
    name: 'Kids',
    children: [
      'STEM toys',
      'Educational toys',
      'Building toys',
      'Creative kits',
      'Sensory toys',
      'Screen-free activities',
      'Kids accessories',
      'Kids clothing',
      'Room accessories',
      'Personalized kids products',
    ],
  },
  {
    slug: 'fashion',
    name: 'Fashion',
    children: ['Unique clothing', 'Accessories', 'Bags', 'Personalized fashion', 'Seasonal'],
  },
  {
    slug: 'gadgets',
    name: 'Gadgets',
    children: [
      'Desk gadgets',
      'Travel gadgets',
      'Car accessories',
      'Organization gadgets',
      'Phone accessories',
      'Lifestyle gadgets',
      'Smart accessories',
      'Novelty gadgets',
    ],
  },
  { slug: 'trending', name: 'Trending', children: [], dynamic: true },
] as const;

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
