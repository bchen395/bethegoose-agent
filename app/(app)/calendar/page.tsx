import { DateTime } from "luxon";
import Link from "next/link";

import { getIdeaLibrary, getPostedCountInWeek, getWeekRecap, todayIso } from "@/lib/db";
import CalendarBoard from "../_components/CalendarBoard";
import DefaultLayoutButton from "../_components/DefaultLayoutButton";
import RunPlanButton from "../_components/RunPlanButton";
import type { DayMeta, IdeaData, SlotCardData } from "../_components/calendar-types";
import { FORMAT_BADGE, badge } from "../_lib/format";

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

  const [recap, postedCount, ideaRows] = await Promise.all([
    getWeekRecap(weekStartIso),
    getPostedCountInWeek(weekStartIso),
    getIdeaLibrary(),
  ]);
  const slots = recap.map((r) => r.slot);
  const matchedCount = recap.filter((r) => r.post).length;
  const unplanned = Math.max(0, postedCount - matchedCount);
  const showRecap = slots.length > 0 || postedCount > 0;

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

      {showRecap && (
        <section className="card" style={{ marginTop: 18 }}>
          <h2 style={{ marginTop: 0 }}>📋 Plan vs. posted</h2>
          <p className="meta">
            Planned <strong>{slots.length}</strong> · posted <strong>{postedCount}</strong> this week
            {matchedCount > 0 ? ` · ${matchedCount} matched to plan` : ""}.
          </p>
          {slots.length === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No plan for this week — {postedCount} post(s) went out unplanned.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
              {recap.map((r) => (
                <li
                  key={r.slot.id}
                  className="row"
                  style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}
                >
                  <span>
                    {badge(FORMAT_BADGE, r.slot.format)} ·{" "}
                    {r.slot.theme || r.slot.contentIdea || "—"}
                  </span>
                  {r.post ? (
                    <span className="ok text-sm">
                      ✓ posted — {r.post.saves ?? 0} saves · {r.post.shares ?? 0} shares · score{" "}
                      <strong className="tabular">{r.score ?? 0}</strong>
                      {r.post.permalink ? (
                        <>
                          {" · "}
                          <a href={r.post.permalink} target="_blank" rel="noreferrer">
                            view ↗
                          </a>
                        </>
                      ) : null}
                    </span>
                  ) : (
                    <span className="muted text-sm">not posted</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {unplanned > 0 && (
            <p className="muted text-xs" style={{ marginBottom: 0, marginTop: 10 }}>
              +{unplanned} post(s) this week weren&apos;t tied to a planned slot.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
