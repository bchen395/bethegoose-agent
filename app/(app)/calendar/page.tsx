import { DateTime } from "luxon";
import Link from "next/link";

import { getCalendarWeek, getIdeaLibrary, todayIso } from "@/lib/db";
import CalendarBoard from "../_components/CalendarBoard";
import DefaultLayoutButton from "../_components/DefaultLayoutButton";
import RunPlanButton from "../_components/RunPlanButton";
import type { DayMeta, IdeaData, SlotCardData } from "../_components/calendar-types";

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

  const [slots, ideaRows] = await Promise.all([getCalendarWeek(weekStartIso), getIdeaLibrary()]);

  const cards: SlotCardData[] = slots.map((slot) => ({
    id: slot.id,
    slotDate: slot.slotDate,
    slotTime: slot.slotTime,
    format: slot.format,
    theme: slot.theme,
    contentIdea: slot.contentIdea,
    priority: slot.priority,
    done: slot.done,
  }));

  const ideas: IdeaData[] = ideaRows.map((i) => ({
    id: i.id,
    title: i.title,
    format: i.format,
    contentIdea: i.contentIdea,
  }));

  const prev = monday.minus({ days: 7 }).toISODate();
  const next = monday.plus({ days: 7 }).toISODate();

  const todayDate = today.toISODate()!;
  const days: DayMeta[] = Array.from({ length: 7 }, (_, i) => {
    const d = monday.plus({ days: i });
    const iso = d.toISODate()!;
    return {
      iso,
      name: d.toFormat("ccc"),
      dateLabel: d.toFormat("LLL d"),
      isToday: isThisWeek && iso === todayDate,
      isPast: isThisWeek && iso < todayDate,
    };
  });

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

      <div className="row" style={{ margin: "14px 0", gap: 10, flexWrap: "wrap" }}>
        <RunPlanButton weekStart={weekStartIso} />
        {slots.length === 0 && <DefaultLayoutButton weekStart={weekStartIso} />}
      </div>

      {slots.length === 0 && (
        <p className="muted">
          No plan for this week yet. <strong>Run weekly plan now</strong> for an agent plan,{" "}
          <strong>use a default layout</strong>, or drag ideas from the box onto a day.
        </p>
      )}

      <CalendarBoard weekStart={weekStartIso} days={days} slots={cards} ideas={ideas} />
    </main>
  );
}
