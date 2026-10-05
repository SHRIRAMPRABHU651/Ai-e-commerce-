import { z } from 'zod';
import { COUNTRY_CODES } from './enums';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const countrySchema = z.enum(COUNTRY_CODES);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), {
    message: 'Password needs upper, lower case letters and a number',
  });

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(80),
});
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });
export const forgotSchema = z.object({ email: emailSchema });
export const resetSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

export const addressSchema = z.object({
  fullName: z.string().trim().min(1).max(100),
  line1: z.string().trim().min(1).max(160),
  line2: z.string().trim().max(160).optional().default(''),
  city: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(40),
  postalCode: z.string().trim().min(2).max(12),
  country: countrySchema,
  phone: z.string().trim().max(24).optional().default(''),
});
export type Address = z.infer<typeof addressSchema>;

export const cartItemInput = z.object({
  productId: objectId,
  variantSku: z.string().max(80).optional(),
  quantity: z.number().int().min(1).max(10),
});

export const checkoutSchema = z.object({
  email: emailSchema,
  address: addressSchema,
  shippingMethod: z.string().max(20).default('standard'),
  couponCode: z.string().trim().max(40).optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

export const searchQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  inStock: z.coerce.boolean().optional(),
  brand: z.string().trim().max(60).optional(),
  sort: z
    .enum(['relevance', 'price_asc', 'price_desc', 'rating', 'trending', 'newest', 'bestselling'])
    .default('relevance'),
  country: countrySchema.optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(120).default(''),
  body: z.string().trim().min(5).max(4000),
  images: z.array(z.string().url().max(500)).max(4).default([]),
});

export const returnRequestSchema = z.object({
  orderId: objectId,
  reason: z.enum(['damaged', 'not_as_described', 'wrong_item', 'not_delivered', 'changed_mind', 'other']),
  details: z.string().trim().max(2000).default(''),
  itemSkus: z.array(z.string().max(80)).min(1).max(10),
});
