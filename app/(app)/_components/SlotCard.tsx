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
    <div className="slot">
      <div className="slot-tags">
        {slot.format && (
          <span className={`chip chip-fmt-${slot.format}`}>{badge(FORMAT_BADGE, slot.format)}</span>
        )}
        <span className={slot.priority === 1 ? "chip chip-must" : "chip chip-nice"}>
          {slot.priority === 1 ? "must-post" : "nice to have"}
        </span>
        {slot.slotTime && <span className="meta tabular slot-time">{slot.slotTime}</span>}
      </div>
      {slot.theme && <div className="slot-theme">{slot.theme}</div>}
      {slot.contentIdea && <div className="text-sm">{slot.contentIdea}</div>}
    </div>
  );
}
