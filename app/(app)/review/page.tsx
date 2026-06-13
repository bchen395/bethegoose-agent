import { getPostsByStatus, getProduct, getSettings } from "@/lib/db";
import { signedDisplayUrl } from "@/lib/storage";
import ReviewCard, { type ReviewCardData } from "../_components/ReviewCard";

export default async function ReviewPage() {
  const [drafts, settings] = await Promise.all([getPostsByStatus("draft"), getSettings()]);
  const captionStartersEnabled = Boolean(settings?.captionStartersEnabled);

  const cards: ReviewCardData[] = await Promise.all(
    drafts.map(async (post): Promise<ReviewCardData> => {
      let artUrl: string | null = null;
      if (post.artFilename) {
        try {
          artUrl = await signedDisplayUrl(post.artFilename);
        } catch {
          artUrl = null;
        }
      }
      let productName: string | null = null;
      if (post.productId) {
        const product = await getProduct(post.productId);
        productName = product?.name ?? null;
      }
      return {
        id: post.id,
        format: post.format,
        agentReasoning: post.agentReasoning,
        productName,
        reelScript: post.reelScript,
        caption: post.caption,
        hashtags: post.hashtags ?? [],
        ctaType: post.ctaType,
        ctaUrl: post.ctaUrl,
        ctaSuggestion: post.ctaSuggestion,
        artUrl,
        captionStartersEnabled,
      };
    }),
  );

  return (
    <main>
      <h1>📝 Post review</h1>
      {cards.length === 0 ? (
        <p className="muted">No drafts waiting. Generate one from the Weekly calendar.</p>
      ) : (
        <>
          <p className="muted">{cards.length} draft(s) waiting for your caption and approval.</p>
          {cards.map((c) => (
            <ReviewCard key={c.id} post={c} />
          ))}
        </>
      )}
    </main>
  );
}
