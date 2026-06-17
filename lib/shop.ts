/**
 * lib/shop.ts — server-only Stripe catalog reader (Item #3 shop sync).
 *
 * The artist's shop products live in Stripe. The daily shop-sync cron pulls the
 * active catalog through here and upserts it into the `products` table. This
 * module only ever READS Stripe (lists products); it never writes. Fail-soft:
 * any missing-config / network / API error returns null so the cron can no-op and
 * leave the manual product CRUD intact (mirrors the catch-and-ignore in
 * lib/claude.ts `logUsage`).
 *
 * The Stripe key must be a restricted, read-only key scoped to Products+Prices
 * (see DEPLOY.md §3).
 */

import Stripe from "stripe";

// Keep in sync with the products_type_check CHECK in lib/db/schema.ts and
// PRODUCT_TYPES in app/(app)/_lib/format.ts.
const PRODUCT_TYPES = ["print", "sticker", "craft", "snail_mail"] as const;
type ProductType = (typeof PRODUCT_TYPES)[number];

export type ShopProduct = {
  stripeProductId: string;
  name: string;
  url: string | null;
  type: ProductType | null; // null when metadata.type is missing/invalid
  active: true;
};

let _stripe: Stripe | null = null;

/** Lazily build the client; null when no key is configured (sync then no-ops). */
function client(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!_stripe) _stripe = new Stripe(key);
  return _stripe;
}

/** The artist sets each Stripe product's `metadata.type`; accept only valid values. */
function normalizeType(raw: unknown): ProductType | null {
  return typeof raw === "string" && (PRODUCT_TYPES as readonly string[]).includes(raw)
    ? (raw as ProductType)
    : null;
}

/**
 * List every active product in the Stripe catalog, mapped to our shape (auto-
 * paginates). Returns null on any failure (missing key, network, API error) so the
 * caller skips the sync rather than throwing into the cron route.
 */
export async function listActiveStripeProducts(): Promise<ShopProduct[] | null> {
  const stripe = client();
  if (!stripe) {
    console.warn("shop sync: STRIPE_SECRET_KEY not set — skipping.");
    return null;
  }
  try {
    const out: ShopProduct[] = [];
    // for-await auto-paginates across all pages.
    for await (const p of stripe.products.list({ active: true, limit: 100 })) {
      const name = (p.name ?? "").trim();
      if (!name) continue; // products.name is NOT NULL — skip nameless entries
      const type = normalizeType(p.metadata?.type);
      if (!type) {
        console.warn(
          `shop sync: Stripe product ${p.id} ("${name}") has no valid metadata.type ` +
            `(expected one of ${PRODUCT_TYPES.join(", ")}).`,
        );
      }
      out.push({ stripeProductId: p.id, name, url: p.url ?? null, type, active: true });
    }
    return out;
  } catch (e) {
    console.error("shop sync: Stripe products.list failed:", e);
    return null;
  }
}
