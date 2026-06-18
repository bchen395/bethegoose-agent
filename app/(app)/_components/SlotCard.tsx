import { FORMAT_BADGE, badge } from "../_lib/format";

/**
 * A read-only weekly-plan suggestion from the Strategy Agent: when to post, what
 * format, and the theme/idea. Posting, art, captions and CTAs are all handled by
 * hand off-app, so this card carries no actions.
 */
export type SlotCardData = {
  id: number;
  slotDate: string;
  slotTime: string | null;
  format: string | null;
  theme: string | null;
  contentIdea: string | null;
  priority: number | null;
};

export default function SlotCard({ slot }: { slot: SlotCardData }) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>
        <strong>{slot.slotDate}</strong> · {slot.slotTime || "—"} ·{" "}
        {badge(FORMAT_BADGE, slot.format)} ·{" "}
        {slot.priority === 1 ? "⭐ must-post" : "nice to have"}
      </div>
      {slot.theme && <div style={{ fontWeight: 600, marginTop: 4 }}>{slot.theme}</div>}
      {slot.contentIdea && <div>{slot.contentIdea}</div>}
    </div>
  );
}
