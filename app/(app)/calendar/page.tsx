import { DateTime } from "luxon";
import Link from "next/link";

import { getCalendarWeek, getIdeaLibrary, todayIso } from "@/lib/db";
import CalendarBoard from "../_components/CalendarBoard";
import DefaultLayoutButton from "../_components/DefaultLayoutButton";
import RunPlanButton from "../_components/RunPlanButton";
import type { DayMeta, SlotData } from "../_components/calendar-types";

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

  const [slotRows, ideaRows] = await Promise.all([
    getCalendarWeek(weekStartIso),
    getIdeaLibrary(),
  ]);

  // Unify the two stores into one card type: scheduled slots + unscheduled ideas.
  const scheduled: SlotData[] = slotRows.map((s) => ({
    kind: "slot",
    id: s.id,
    slotDate: s.slotDate,
    slotTime: s.slotTime,
    format: s.format,
    theme: s.theme,
    contentIdea: s.contentIdea,
    priority: s.priority,
    done: s.done,
    fromAgent: !s.pinned && s.postId == null, // an untouched agent suggestion
  }));

  const ideas: SlotData[] = ideaRows.map((i) => ({
    kind: "idea",
    id: i.id,
    slotDate: null,
    slotTime: null,
    format: i.format,
    theme: i.title,
    contentIdea: i.contentIdea,
    priority: null,
    done: false,
    fromAgent: i.source === "agent",
  }));

  const slots = [...scheduled, ...ideas];
  const hasAnything = slots.length > 0;

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
        {scheduled.length === 0 && <DefaultLayoutButton weekStart={weekStartIso} />}
      </div>

      {!hasAnything && (
        <p className="muted">
          No plan for this week yet. <strong>Run weekly plan now</strong> for agent suggestions,{" "}
          <strong>use a default layout</strong>, or tap ＋ on any day to add a post.
        </p>
      )}

      <CalendarBoard days={days} slots={slots} />
    </main>
  );
}
