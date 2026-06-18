import { DateTime } from "luxon";
import Link from "next/link";

import { getCalendarWeek, todayIso } from "@/lib/db";
import RunPlanButton from "../_components/RunPlanButton";
import SlotCard, { type SlotCardData } from "../_components/SlotCard";

function mondayOf(d: DateTime): DateTime {
  return d.minus({ days: d.weekday - 1 }).startOf("day");
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const today = DateTime.fromISO(await todayIso());
  const monday = week ? DateTime.fromISO(week).startOf("day") : mondayOf(today);
  const sunday = monday.plus({ days: 6 });
  const weekStartIso = monday.toISODate()!;
  const isThisWeek = weekStartIso === mondayOf(today).toISODate();

  const slots = await getCalendarWeek(weekStartIso);

  const cards: SlotCardData[] = slots.map((slot) => ({
    id: slot.id,
    slotDate: slot.slotDate,
    slotTime: slot.slotTime,
    format: slot.format,
    theme: slot.theme,
    contentIdea: slot.contentIdea,
    priority: slot.priority,
  }));

  const prev = monday.minus({ days: 7 }).toISODate();
  const next = monday.plus({ days: 7 }).toISODate();

  return (
    <main>
      <h1>📅 Weekly calendar</h1>

      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link className="btn" href={`/calendar?week=${prev}`}>
          ◀ Prev week
        </Link>
        <span>
          Week of <strong>{monday.toFormat("LLL d")}</strong> –{" "}
          <strong>{sunday.toFormat("LLL d, yyyy")}</strong>
          {isThisWeek ? "  ·  this week" : ""}
        </span>
        <Link className="btn" href={`/calendar?week=${next}`}>
          Next week ▶
        </Link>
      </div>

      <div style={{ margin: "14px 0" }}>
        <RunPlanButton weekStart={weekStartIso} />
      </div>

      {slots.length === 0 ? (
        <p className="muted">
          No plan for this week yet. Click <strong>Run weekly plan now</strong> to generate one.
        </p>
      ) : (
        cards.map((c) => <SlotCard key={c.id} slot={c} />)
      )}
    </main>
  );
}
