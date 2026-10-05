/**
 * DEV / TEST ONLY. A small deterministic demo catalog served by the mock supplier adapters.
 * It never runs in production (production config rejects SUPPLIER_MODE=mock).
 * Images are procedurally generated illustrations served by the storefront at /art/:id.
 */
import type { SupplierProductSummary } from '../types';

type Row = {
  id: string;
  title: string;
  desc: string;
  cat: string; // sub-category name as in CATEGORY_TREE
  top: 'Pet' | 'Kids' | 'Fashion' | 'Gadgets';
  cost: number; // USD cents
  tags: string[];
  attrs?: Record<string, string>;
  variants?: string[]; // labels for a single "Option" dimension
  safety?: { standards: string[]; ageRange?: string };
  video?: boolean;
  demand?: number; // 0-100 demo signal used by the discovery agent
  trend?: number;
  competition?: number; // higher = less saturated
  retail?: number[]; // observed competitor prices, USD cents
};

const rows: Row[] = [
  // ---- PET
  { id: 'pet-snuffle-mat', title: 'Snuffle Treat Puzzle Mat', top: 'Pet', cat: 'Interactive dog toys', cost: 620, tags: ['dog', 'enrichment', 'puzzle'], desc: 'A washable fleece snuffle mat with layered strips that hide treats and dry kibble, encouraging natural foraging. Machine washable. Anti-slip base.', attrs: { Material: 'Polyester fleece', Size: '40 x 30 cm' }, variants: ['Sage', 'Sand'], demand: 91, trend: 86, competition: 58, retail: [2799, 2999, 3499], video: true },
  { id: 'pet-treat-ball', title: 'Rolling Treat Dispenser Ball', top: 'Pet', cat: 'Interactive dog toys', cost: 380, tags: ['dog', 'treat', 'toy'], desc: 'A durable rolling ball with an adjustable opening that releases treats as your dog pushes it around. Dishwasher-safe on the top rack.', attrs: { Material: 'BPA-free plastic', Diameter: '8 cm' }, variants: ['Small', 'Large'], demand: 84, trend: 70, competition: 62, retail: [1699, 1999, 2299], video: true },
  { id: 'pet-slow-bowl', title: 'Slow Feeder Maze Bowl', top: 'Pet', cat: 'Slow-feeding accessories', cost: 410, tags: ['dog', 'feeding', 'bowl'], desc: 'A raised-ridge feeding bowl that slows down fast eaters. Non-slip rubber base and food-grade materials.', attrs: { Material: 'Food-grade plastic', Capacity: '700 ml' }, variants: ['Blue', 'Grey'], demand: 80, trend: 65, competition: 55, retail: [1599, 1899, 2199] },
  { id: 'pet-lick-mat', title: 'Silicone Lick Mat with Suction Cups', top: 'Pet', cat: 'Slow-feeding accessories', cost: 290, tags: ['dog', 'cat', 'lick mat'], desc: 'A textured silicone mat for spreading peanut-free pet-safe pastes, yoghurt or wet food. Suction cups hold it to smooth surfaces.', attrs: { Material: 'Food-grade silicone' }, variants: ['Orange', 'Teal'], demand: 78, trend: 74, competition: 60, retail: [1299, 1499, 1799] },
  { id: 'pet-water-bottle', title: 'Portable Pet Water Bottle 500 ml', top: 'Pet', cat: 'Portable pet water', cost: 450, tags: ['dog', 'travel', 'water'], desc: 'A leak-resistant bottle with a flip-out drinking trough. Squeeze to fill, release to drain unused water back into the bottle.', attrs: { Material: 'BPA-free plastic', Capacity: '500 ml' }, variants: ['Grey', 'Green'], demand: 76, trend: 62, competition: 52, retail: [1799, 2199, 2499], video: true },
  { id: 'pet-car-seat', title: 'Waterproof Back Seat Cover', top: 'Pet', cat: 'Car & travel pet accessories', cost: 1450, tags: ['dog', 'car', 'travel'], desc: 'A quilted, waterproof hammock-style seat cover with side flaps and seat-belt openings. Machine washable.', attrs: { Material: 'Oxford fabric', Fit: 'Most cars and SUVs' }, demand: 72, trend: 58, competition: 50, retail: [3999, 4499, 4999] },
  { id: 'pet-slicker-brush', title: 'Self-Cleaning Slicker Brush', top: 'Pet', cat: 'Grooming tools', cost: 330, tags: ['grooming', 'dog', 'cat'], desc: 'A slicker brush with fine bent bristles and a push-button that retracts the bristles to release collected fur.', attrs: { Material: 'ABS and stainless steel pins' }, demand: 82, trend: 68, competition: 57, retail: [1499, 1699, 1999] },
  { id: 'pet-hair-roller', title: 'Reusable Pet Hair Roller', top: 'Pet', cat: 'Pet-hair removal', cost: 360, tags: ['pet hair', 'cleaning'], desc: 'A reusable roller that lifts pet hair from sofas, car seats and clothes. Empty the chamber, no sticky sheets needed.', attrs: { Material: 'ABS plastic' }, demand: 88, trend: 77, competition: 48, retail: [1599, 1799, 1999], video: true },
  { id: 'pet-treat-pouch', title: 'Training Treat Pouch', top: 'Pet', cat: 'Pet organization', cost: 260, tags: ['training', 'dog', 'pouch'], desc: 'A belt-clip treat pouch with a magnetic closure and a built-in waste-bag dispenser slot.', attrs: { Material: 'Polyester' }, variants: ['Black', 'Navy'], demand: 66, trend: 52, competition: 63, retail: [1299, 1499, 1699] },
  { id: 'pet-leash', title: 'Reflective Leash 1.5 m', top: 'Pet', cat: 'Walking accessories', cost: 520, tags: ['leash', 'dog', 'walking'], desc: 'A 1.5 m nylon leash with reflective stitching, padded handle and a swivel clip.', attrs: { Material: 'Nylon', Length: '1.5 m' }, variants: ['Black', 'Orange'], demand: 70, trend: 55, competition: 45, retail: [1699, 1999, 2299] },
  { id: 'pet-cat-wand', title: 'Feather Wand Cat Teaser Set', top: 'Pet', cat: 'Cat enrichment', cost: 310, tags: ['cat', 'toy', 'wand'], desc: 'Extendable wand with a feather and bell attachment plus three spare heads for interactive play.', attrs: { Material: 'Stainless steel, feathers' }, demand: 74, trend: 60, competition: 64, retail: [1199, 1399, 1599] },
  { id: 'pet-id-tag', title: 'Personalised Engraved Pet ID Tag', top: 'Pet', cat: 'Personalized pet accessories', cost: 480, tags: ['personalised', 'dog', 'cat'], desc: 'A stainless steel round ID tag engraved with your pet’s name and phone number. Engraving details are collected after purchase.', attrs: { Material: 'Stainless steel', Diameter: '3 cm' }, variants: ['Silver', 'Gold tone'], demand: 79, trend: 64, competition: 59, retail: [1499, 1899, 2299] },
  // ---- KIDS
  { id: 'kids-circuit-kit', title: 'Beginner Circuit Builder STEM Kit', top: 'Kids', cat: 'STEM toys', cost: 1380, tags: ['stem', 'electronics', 'learning'], desc: 'Snap-together circuit blocks to build 30 beginner experiments including a buzzer, light and fan. No soldering.', attrs: { Pieces: '38', 'Recommended age': '8+' }, safety: { standards: ['ASTM F963', 'EN71'], ageRange: '8+' }, demand: 85, trend: 80, competition: 55, retail: [3499, 3999, 4499], video: true },
  { id: 'kids-magnetic-tiles', title: 'Magnetic Building Tiles 60-piece Set', top: 'Kids', cat: 'Building toys', cost: 1650, tags: ['magnetic', 'building', 'stem'], desc: 'Translucent magnetic tiles in assorted shapes that snap together to build 3D structures. Includes storage bag.', attrs: { Pieces: '60', 'Recommended age': '3+' }, safety: { standards: ['ASTM F963', 'EN71'], ageRange: '3+' }, demand: 90, trend: 82, competition: 40, retail: [3999, 4499, 5499], video: true },
  { id: 'kids-alphabet-board', title: 'Wooden Alphabet Puzzle Board', top: 'Kids', cat: 'Educational toys', cost: 640, tags: ['puzzle', 'wood', 'alphabet'], desc: 'Chunky wooden letter pieces that fit into a coloured board, helping early letter recognition.', attrs: { Material: 'Wood, water-based paint', 'Recommended age': '3+' }, safety: { standards: ['ASTM F963', 'EN71'], ageRange: '3+' }, demand: 73, trend: 55, competition: 58, retail: [1999, 2399, 2799] },
  { id: 'kids-clay-kit', title: 'Air-Dry Clay Creative Kit', top: 'Kids', cat: 'Creative kits', cost: 720, tags: ['clay', 'craft', 'creative'], desc: 'Non-toxic air-dry clay in 12 colours with sculpting tools and a project guide.', attrs: { Colours: '12', 'Recommended age': '6+' }, safety: { standards: ['ASTM D4236', 'EN71'], ageRange: '6+' }, demand: 77, trend: 68, competition: 56, retail: [2299, 2599, 2999] },
  { id: 'kids-sensory-bottles', title: 'Calm-Down Sensory Bottles (Set of 6)', top: 'Kids', cat: 'Sensory toys', cost: 540, tags: ['sensory', 'calm', 'bottles'], desc: 'Six sealed glitter bottles for visual focus and quiet-time routines. Sealed with tamper-resistant caps.', attrs: { Pieces: '6', 'Recommended age': '3+' }, safety: { standards: ['EN71'], ageRange: '3+' }, demand: 71, trend: 66, competition: 61, retail: [1799, 1999, 2399] },
  { id: 'kids-water-pad', title: 'Reusable Water-Reveal Activity Pad', top: 'Kids', cat: 'Screen-free activities', cost: 380, tags: ['screen-free', 'travel', 'drawing'], desc: 'A mess-free activity pad that reveals colour when drawn on with the included water pen. Dries and can be reused.', attrs: { Size: '30 x 20 cm', 'Recommended age': '2+' }, safety: { standards: ['EN71'], ageRange: '2+' }, demand: 83, trend: 78, competition: 54, retail: [1499, 1799, 1999], video: true },
  { id: 'kids-backpack', title: 'Mini Explorer Backpack', top: 'Kids', cat: 'Kids accessories', cost: 790, tags: ['backpack', 'kids', 'school'], desc: 'A lightweight backpack with padded straps and a water-bottle pocket, sized for ages 3 to 6.', attrs: { Material: 'Polyester', Capacity: '8 L' }, variants: ['Forest', 'Berry'], demand: 69, trend: 57, competition: 53, retail: [2499, 2799, 3199] },
  { id: 'kids-dino-pyjamas', title: 'Organic Cotton Dino Pyjama Set', top: 'Kids', cat: 'Kids clothing', cost: 1150, tags: ['pyjamas', 'organic', 'kids clothing'], desc: 'Two-piece pyjama set in 100% organic cotton with a dinosaur print. Close-fitting for sleepwear safety.', attrs: { Material: '100% organic cotton' }, variants: ['2-3Y', '4-5Y', '6-7Y'], safety: { standards: ['OEKO-TEX 100'], ageRange: '2-7' }, demand: 67, trend: 54, competition: 49, retail: [2799, 3199, 3599] },
  { id: 'kids-star-projector', title: 'Starry Night Light Projector', top: 'Kids', cat: 'Room accessories', cost: 870, tags: ['night light', 'projector', 'room'], desc: 'A USB-powered projector that casts a gentle star pattern onto the ceiling, with an automatic off-timer.', attrs: { Power: 'USB 5V', Timer: '30/60/120 min' }, safety: { standards: ['CE', 'RoHS', 'EN71'], ageRange: '3+' }, demand: 81, trend: 75, competition: 51, retail: [2499, 2999, 3499], video: true },
  { id: 'kids-name-puzzle', title: 'Personalised Wooden Name Puzzle', top: 'Kids', cat: 'Personalized kids products', cost: 910, tags: ['personalised', 'puzzle', 'gift'], desc: 'A wooden puzzle with your child’s name in chunky letters. Name details are collected after purchase.', attrs: { Material: 'Birch wood', 'Recommended age': '2+' }, safety: { standards: ['ASTM F963', 'EN71'], ageRange: '2+' }, demand: 75, trend: 63, competition: 57, retail: [2499, 2899, 3299] },
  { id: 'kids-teething-beads', title: 'Baby Teething Bead Necklace Toy', top: 'Kids', cat: 'Kids accessories', cost: 420, tags: ['baby', 'teething'], desc: 'A string of silicone beads for babies to chew on.', attrs: { Material: 'Silicone' }, demand: 68, trend: 59, competition: 60, retail: [1699, 1999, 2299] },
  // ---- FASHION
  { id: 'fashion-linen-shirt', title: 'Relaxed Linen-Blend Shirt', top: 'Fashion', cat: 'Unique clothing', cost: 1280, tags: ['shirt', 'linen', 'summer'], desc: 'A relaxed-fit shirt in a breathable linen-cotton blend with a button front and chest pocket.', attrs: { Material: '55% linen, 45% cotton' }, variants: ['S', 'M', 'L', 'XL'], demand: 70, trend: 61, competition: 38, retail: [3999, 4499, 5499] },
  { id: 'fashion-crossbody', title: 'Quilted Crossbody Bag', top: 'Fashion', cat: 'Bags', cost: 1490, tags: ['bag', 'crossbody'], desc: 'A compact quilted crossbody with an adjustable strap, zipped main compartment and card slots.', attrs: { Material: 'Vegan leather' }, variants: ['Black', 'Cream', 'Tan'], demand: 79, trend: 71, competition: 41, retail: [3999, 4999, 5999] },
  { id: 'fashion-satin-scarf', title: 'Printed Satin Scarf', top: 'Fashion', cat: 'Accessories', cost: 520, tags: ['scarf', 'satin'], desc: 'A lightweight satin-finish square scarf that can be worn at the neck, in hair or tied to a bag.', attrs: { Material: 'Polyester satin', Size: '70 x 70 cm' }, variants: ['Terracotta', 'Midnight'], demand: 63, trend: 50, competition: 55, retail: [1799, 2299, 2799] },
  { id: 'fashion-card-wallet', title: 'Personalised Card Wallet', top: 'Fashion', cat: 'Personalized fashion', cost: 780, tags: ['wallet', 'personalised', 'gift'], desc: 'A slim card wallet with a debossed monogram. Initials are collected after purchase.', attrs: { Material: 'Vegan leather' }, variants: ['Black', 'Brown'], demand: 72, trend: 62, competition: 52, retail: [2299, 2799, 3299] },
  { id: 'fashion-rib-beanie', title: 'Ribbed Knit Beanie', top: 'Fashion', cat: 'Seasonal', cost: 450, tags: ['beanie', 'winter'], desc: 'A stretchy ribbed beanie with a soft inner lining.', attrs: { Material: 'Acrylic blend' }, variants: ['Charcoal', 'Oat', 'Rust'], demand: 74, trend: 69, competition: 47, retail: [1699, 1999, 2299] },
  { id: 'fashion-canvas-tote', title: 'Canvas Everyday Tote', top: 'Fashion', cat: 'Bags', cost: 690, tags: ['tote', 'canvas'], desc: 'A heavyweight cotton canvas tote with an inner zip pocket and reinforced handles.', attrs: { Material: '12 oz cotton canvas' }, variants: ['Natural', 'Black'], demand: 68, trend: 58, competition: 44, retail: [2199, 2499, 2899] },
  // ---- GADGETS
  { id: 'gad-desk-organizer', title: 'Modular Desk Organizer', top: 'Gadgets', cat: 'Desk gadgets', cost: 1090, tags: ['desk', 'organizer', 'wfh'], desc: 'Stackable modules for pens, phone, cards and cables. Rearrange to suit your desk.', attrs: { Material: 'ABS and bamboo' }, demand: 75, trend: 66, competition: 46, retail: [2999, 3499, 3999], video: true },
  { id: 'gad-cable-clips', title: 'Magnetic Cable Management Clips (6 pack)', top: 'Gadgets', cat: 'Desk gadgets', cost: 240, tags: ['cable', 'desk'], desc: 'Weighted magnetic clips that keep charging cables from falling behind your desk.', attrs: { Pieces: '6' }, demand: 80, trend: 72, competition: 59, retail: [1299, 1499, 1699], video: true },
  { id: 'gad-travel-adapter', title: 'Universal Travel Adapter', top: 'Gadgets', cat: 'Travel gadgets', cost: 1380, tags: ['travel', 'adapter', 'usb'], desc: 'Covers US, UK, EU and AU plug types with two USB-A and one USB-C port and a built-in fuse.', attrs: { Ports: '2x USB-A, 1x USB-C' }, safety: { standards: ['CE', 'FCC', 'RoHS'] }, demand: 77, trend: 60, competition: 42, retail: [2499, 2999, 3499] },
  { id: 'gad-packing-cubes', title: 'Compression Packing Cubes (4 piece)', top: 'Gadgets', cat: 'Travel gadgets', cost: 1220, tags: ['travel', 'packing'], desc: 'Four zip-compression cubes in assorted sizes, made from lightweight ripstop fabric.', attrs: { Material: 'Ripstop nylon', Pieces: '4' }, variants: ['Graphite', 'Teal'], demand: 78, trend: 67, competition: 47, retail: [2799, 3299, 3799] },
  { id: 'gad-vent-mount', title: 'Car Vent Phone Mount', top: 'Gadgets', cat: 'Car accessories', cost: 410, tags: ['car', 'phone'], desc: 'A one-hand-release vent clip phone mount with adjustable arms for most phone sizes.', attrs: { Fit: 'Standard car vents' }, demand: 71, trend: 52, competition: 36, retail: [1499, 1799, 1999] },
  { id: 'gad-car-bin', title: 'Hanging Car Trash Bin', top: 'Gadgets', cat: 'Car accessories', cost: 330, tags: ['car', 'organization'], desc: 'A leak-resistant hanging bin with a flip lid that attaches to the back of a seat.', attrs: { Material: 'Oxford fabric' }, demand: 60, trend: 48, competition: 58, retail: [1299, 1499, 1699] },
  { id: 'gad-gadget-pouch', title: 'Cable & Gadget Organizer Pouch', top: 'Gadgets', cat: 'Organization gadgets', cost: 520, tags: ['organizer', 'cable', 'travel'], desc: 'A zip pouch with elastic loops and mesh pockets for chargers, cables and small electronics.', attrs: { Material: 'Polyester' }, variants: ['Grey', 'Navy'], demand: 69, trend: 56, competition: 55, retail: [1599, 1899, 2199] },
  { id: 'gad-phone-stand', title: 'Magnetic Phone Stand', top: 'Gadgets', cat: 'Phone accessories', cost: 680, tags: ['phone', 'stand', 'magnetic'], desc: 'An adjustable-angle desk stand with a magnetic ring plate compatible with magnet-ready phones and cases.', attrs: { Material: 'Aluminium alloy' }, demand: 73, trend: 64, competition: 43, retail: [2199, 2599, 2999] },
  { id: 'gad-mini-lamp', title: 'Rechargeable Mini Desk Lamp', top: 'Gadgets', cat: 'Lifestyle gadgets', cost: 1020, tags: ['lamp', 'usb-c', 'desk'], desc: 'A foldable LED lamp with three colour temperatures and a USB-C rechargeable battery.', attrs: { Charging: 'USB-C' }, safety: { standards: ['CE', 'FCC', 'RoHS'] }, demand: 76, trend: 65, competition: 44, retail: [2499, 2999, 3499], video: true },
  { id: 'gad-bt-tracker', title: 'Bluetooth Item Tracker', top: 'Gadgets', cat: 'Smart accessories', cost: 890, tags: ['tracker', 'bluetooth'], desc: 'A coin-cell Bluetooth tracker for keys and bags with an app-triggered ring. Replaceable battery.', attrs: { Battery: 'CR2032 (replaceable)' }, safety: { standards: ['CE', 'FCC'] }, demand: 82, trend: 73, competition: 35, retail: [1999, 2499, 2999] },
  { id: 'gad-fidget-cube', title: 'Desk Fidget Cube', top: 'Gadgets', cat: 'Novelty gadgets', cost: 210, tags: ['fidget', 'desk', 'novelty'], desc: 'A six-sided desk toy with switches, dials and rollers for quiet fidgeting.', attrs: { Material: 'ABS' }, demand: 64, trend: 47, competition: 60, retail: [1199, 1499, 1799] },
  // ---- Items that MUST be rejected / held by compliance (kept to demonstrate the filter)
  { id: 'blocked-tactical-knife', title: 'Tactical Pocket Knife Set', top: 'Gadgets', cat: 'Novelty gadgets', cost: 700, tags: ['knife', 'tactical'], desc: 'A folding tactical knife set with a locking blade.', demand: 88, trend: 70, competition: 40, retail: [2999] },
  { id: 'blocked-slim-patch', title: 'Rapid Slimming Patch — cures obesity in 7 days', top: 'Gadgets', cat: 'Lifestyle gadgets', cost: 300, tags: ['slimming', 'patch'], desc: 'Clinically proven patch that cures obesity and treats diabetes without diet.', demand: 90, trend: 85, competition: 30, retail: [3999] },
  { id: 'blocked-replica-bag', title: 'Designer Inspired Replica Handbag (Louis-style logo)', top: 'Fashion', cat: 'Bags', cost: 1900, tags: ['replica', 'designer'], desc: 'A replica of a famous luxury handbag with the iconic monogram.', demand: 92, trend: 80, competition: 35, retail: [9999] },
];

const art = (id: string, n: number) => `/art/${id}?v=${n}`;

export const MOCK_CATALOG: SupplierProductSummary[] = rows.map((r) => ({
  externalId: r.id,
  title: r.title,
  description: r.desc,
  images: [art(r.id, 1), art(r.id, 2), art(r.id, 3)],
  videos: [],
  category: r.cat,
  attributes: { ...(r.attrs ?? {}), 'Top category': r.top },
  safetyInfo: r.safety,
  variants: (r.variants ?? ['Default']).map((label) => ({
    sku: `${r.id}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    label,
    options: { Option: label },
  })),
  baseCostUsd: r.cost,
  tags: r.tags,
}));

/** Demo market signals used by the discovery agent in mock mode (not real market data). */
export const MOCK_MARKET_SIGNALS: Record<string, { demand: number; trend: number; competition: number; retail: number[]; video: boolean }> =
  Object.fromEntries(
    rows.map((r) => [
      r.id,
      { demand: r.demand ?? 60, trend: r.trend ?? 50, competition: r.competition ?? 50, retail: r.retail ?? [], video: !!r.video },
    ]),
  );
