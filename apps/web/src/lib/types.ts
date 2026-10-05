import type { CardProduct } from '@orvia/ui';

export interface Meta {
  detectedCountry: string;
  countries: { code: string; name: string; currency: string; locale: string; taxInclusive: boolean; shippingMethods: { code: string; label: string; fee: number; freeOver: number | null; minDays: number; maxDays: number }[]; paymentMethods: string[]; legalNotice: string; returnWindowDays: number }[];
  categories: { slug: string; name: string; dynamic: boolean; children: { slug: string; name: string }[] }[];
  payment: { mode: 'mock' | 'live'; stripePublishableKey: string | null };
  environment: string;
}

export interface StoreProduct extends CardProduct {
  brand: string; description: string; bullets: string[]; features: string[]; benefits: string[]; faqs: { q: string; a: string }[]; category: string; topCategory: string; attributes: Record<string, string>;
  sold: number; state: string; stock: number; shipsFrom: string | null; returnWindowDays?: number; seo: { title?: string | null; metaDescription?: string | null }; safety?: { standards: string[]; ageRange?: string | null };
}

export interface CartLine { productId: string; slug: string; title: string; image?: string; sku: string; variantLabel?: string; quantity: number; unitPrice: number; lineTotal: number; available: boolean; maxQty: number; issue?: string }
export interface CartView {
  token: string; country: string; currency: string; lines: CartLine[]; itemCount: number; subtotal: number; discount: number; promotions: { name: string; type: string; amount: number; code?: string }[]; couponCode?: string; couponError?: string;
  shippingOptions: { code: string; label: string; fee: number; charge: number; free: boolean; minDays: number; maxDays: number }[]; shippingMethod: string;
  totals: { subtotal: number; discount: number; shipping: number; tax: number; total: number; taxInclusive: boolean; taxRate: number }; delivery: { label: string } | null; issues: string[]; checkoutBlocked: boolean; freeShippingRemaining: number | null; legalNotice: string;
}
export interface User { id: string; email: string; name: string; role: string; emailVerified: boolean }
export interface HomeData {
  country: string; currency: string; trending: StoreProduct[]; recommended: StoreProduct[]; deals: StoreProduct[]; newArrivals: StoreProduct[]; bestSellers: StoreProduct[]; countryTrending: StoreProduct[]; recentlyViewed: StoreProduct[];
  categories: { slug: string; name: string; count: number }[]; testimonials: { rating: number; title: string; body: string; authorName: string; product: string; verifiedPurchase: boolean }[]; promotions: { id: string; name: string; type: string; percent: number; code?: string }[];
}
export interface ProductPage {
  product: StoreProduct; variants: { sku: string; label: string; options: Record<string, string>; image?: string }[]; delivery: { label: string } | null; shipsFrom: string | null; availableIn: string[]; paymentMethods: string[]; legalNotice: string;
  shipping: { code: string; label: string; fee: number; freeOver: number | null }[];
  reviews: { items: { _id: string; rating: number; title: string; body: string; authorName: string; verifiedPurchase: boolean; helpfulVotes: number; createdAt: string }[]; total: number; distribution: Record<string, number> };
  similar: StoreProduct[]; frequentlyBoughtTogether: StoreProduct[]; breadcrumbs: { label: string; href: string }[];
}
export interface OrderView {
  id: string; orderNumber: string; status: string; createdAt: string; country: string; currency: string; email: string; items: { productId: string; sku: string; title: string; image?: string; quantity: number; unitPrice: number }[];
  amounts: { subtotal: number; discount: number; shipping: number; tax: number; total: number; taxInclusive: boolean }; address: { fullName: string; line1: string; line2?: string; city: string; region: string; postalCode: string; country: string };
  payment: { status: string; provider?: string }; timeline: { status: string; at: string; note?: string }[]; shipments: { status: string; carrier?: string; trackingNumber?: string; trackingUrl?: string; estimatedDelivery?: string; events: { status: string; description: string; location?: string; at: string }[] }[];
  returns: { status: string; reason: string }[]; canCancel: boolean; canReturn: boolean; returnWindowDays?: number;
}
