"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { markPosted } from "@/app/actions";

export default function MarkPostedButton({ postId }: { postId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      className="btn btn-primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await markPosted(postId);
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
    >
      📣 Mark as posted
    </button>
  );
}
