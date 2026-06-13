import { redirect } from "next/navigation";

import { getMarketsWithDeadline, getPostsMissingEngagement } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import NavLinks from "./_components/NavLinks";
import SignOutButton from "./_components/SignOutButton";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login"); // middleware also guards, belt-and-suspenders

  const [missing, deadlines] = await Promise.all([
    getPostsMissingEngagement(),
    getMarketsWithDeadline(14),
  ]);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <strong>🎨 Be The Goose</strong>
          <NavLinks />
          <span className="muted" style={{ fontSize: 12 }}>
            {user.email}
          </span>
          <SignOutButton />
        </div>
      </header>

      <div className="container">
        {/* Always-on banners (engagement nudge + market deadlines). */}
        {missing.length > 0 && (
          <div className="banner">
            📊 {missing.length} posted item(s) still missing saves or reach — open the Engagement
            view to keep the learning loop fed.
          </div>
        )}
        {deadlines.map((m) => (
          <div className="banner info" key={m.id}>
            🗓 Market deadline: <strong>{m.name}</strong>
            {m.applicationDeadline ? ` — applications due ${m.applicationDeadline}` : ""}
            {m.draftApplication ? (
              <details style={{ marginTop: 6 }}>
                <summary>Draft application for {m.name}</summary>
                <p style={{ whiteSpace: "pre-wrap" }}>{m.draftApplication}</p>
              </details>
            ) : null}
          </div>
        ))}

        {children}
      </div>
    </>
  );
}
