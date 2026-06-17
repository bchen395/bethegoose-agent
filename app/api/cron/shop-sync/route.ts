/**
 * app/api/cron/shop-sync/route.ts — daily Stripe → products sync (Item #3).
 *
 * Vercel Cron invokes this with `Authorization: Bearer <CRON_SECRET>` (vercel.json).
 * The route is exempt from the auth middleware (it guards itself with the secret).
 * It pulls the active Stripe catalog and upserts it into `products`, keyed on
 * stripe_product_id, then deactivates Stripe-origin rows no longer present.
 * Hand-created CRUD products (null stripe_product_id) are never touched, and
 * last_promoted_at (the CTA rotation cursor) is left alone.
 *
 * Fail-soft: if Stripe is unavailable (missing key / network / API error), the sync
 * is skipped and the table is left intact — the manual product CRUD keeps working.
 *
 * NOTE: the schedule only fires once deployed to Vercel. Locally, hit this route
 * manually with the secret header to verify.
 */

import { NextResponse } from "next/server";

import {
  deactivateStripeProductsNotIn,
  getProductByStripeId,
  insertProduct,
  updateProduct,
} from "@/lib/db";
import { listActiveStripeProducts } from "@/lib/shop";

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const catalog = await listActiveStripeProducts();
  if (catalog === null) {
    // Fail-soft: missing key or Stripe error. Crucially, do NOT deactivate anything
    // on a failed fetch — that would wrongly retire the whole catalog.
    return NextResponse.json(
      { ok: false, error: "Stripe catalog unavailable — sync skipped." },
      { status: 200 },
    );
  }

  let created = 0;
  let updated = 0;
  for (const item of catalog) {
    const existing = await getProductByStripeId(item.stripeProductId);
    if (existing) {
      // metadata.type is the source of truth when valid; otherwise keep the row's
      // existing (possibly hand-edited) type. Never touches last_promoted_at.
      await updateProduct(existing.id, {
        name: item.name,
        url: item.url,
        active: true,
        ...(item.type ? { type: item.type } : {}),
      });
      updated++;
    } else {
      await insertProduct({
        name: item.name,
        url: item.url,
        type: item.type ?? "print", // CHECK-safe default when metadata.type is absent
        active: true,
        stripeProductId: item.stripeProductId,
      });
      created++;
    }
  }

  // Safe: only reached after a confirmed-good fetch. Retires products archived in Stripe.
  const deactivated = await deactivateStripeProductsNotIn(catalog.map((p) => p.stripeProductId));

  return NextResponse.json({ ok: true, created, updated, deactivated });
}
