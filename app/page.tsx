import { redirect } from "next/navigation";

// The app's home is the weekly calendar (built in Task 6). Until then this
// redirect target may 404 in dev; that's expected during the scaffold step.
export default function Home() {
  redirect("/calendar");
}
