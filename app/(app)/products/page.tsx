import { getAllProducts } from "@/lib/db";

import ProductForm from "../_components/ProductForm";
import ProductRow from "../_components/ProductRow";

export default async function ProductsPage() {
  const products = await getAllProducts();
  return (
    <main>
      <h1>🛍 Products</h1>
      <p className="muted">
        These drive the shop CTAs and the rotation the Content & Strategy agents use. Deactivate
        anything that&apos;s out of stock so it stops being suggested.
      </p>

      <h2>Add a product</h2>
      <ProductForm />

      <h2>Your products</h2>
      {products.length === 0 ? (
        <p className="muted">No products yet — add one above.</p>
      ) : (
        <div className="read-list">
          {products.map((p) => (
            <ProductRow key={p.id} product={p} />
          ))}
        </div>
      )}
    </main>
  );
}
