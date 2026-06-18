import { getAllMarkets } from "@/lib/db";

import MarketForm from "../_components/MarketForm";
import MarketRow from "../_components/MarketRow";

export default async function MarketsPage() {
  const markets = await getAllMarkets();
  return (
    <main>
      <h1>🏪 Markets</h1>
      <p className="muted">
        Markets the Strategy Agent can tease and the Distribution Agent can draft application blurbs
        for. A drafted blurb appears read-only on its card once the agent has written one.
      </p>

      <h2>Add a market</h2>
      <MarketForm />

      <h2>Your markets</h2>
      {markets.length === 0 ? (
        <p className="muted">No markets yet — add one above.</p>
      ) : (
        <div className="read-list">
          {markets.map((m) => (
            <MarketRow key={m.id} market={m} />
          ))}
        </div>
      )}
    </main>
  );
}
