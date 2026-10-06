# Organic / eco claims

Orvia never invents claims such as "organic", "eco-friendly", "non-toxic", "chemical-free", "biodegradable" or "plant-based".

- **Import**: claim wording found in a supplier title/description is stripped from titles and all generated copy. The original is kept in `product.organic.sourceTitle`, removed phrases in `removedClaims`, and an `ORGANIC_CLAIM` exception tells the admin.
- **Evidence**: an admin may attach certification evidence per product (certifier, certificate number, scope, jurisdiction(s), expiry, document). A claim is allowed only when the evidence is *verified*, complete, unexpired and covers **every** market the product is sold in.
- **Gates**: `canPublish` and the product PATCH route reject listings that contain an unevidenced claim. AI copy guards strip claims at generation time.
- **Audit**: evidence changes are audit-logged; RBAC applies.
- **Regulated categories**: cosmetics/personal care, food and pet food go to compliance review (ingredient lists and regional rules). Orvia does not decide legality; it routes these to a human.

Limitation: certificate authenticity is confirmed by the human who marks it verified; Orvia does not call certifier registries.
