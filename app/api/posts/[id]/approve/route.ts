import { NextResponse } from "next/server";

import { distribute } from "@/lib/agents/distribution";
import { AgentError } from "@/lib/claude";
import { getPost } from "@/lib/db";

export const maxDuration = 300;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId)) {
    return NextResponse.json({ ok: false, error: "Invalid post id." }, { status: 400 });
  }

  try {
    const post = await getPost(postId);
    if (!post) {
      return NextResponse.json({ ok: false, error: "Post not found." }, { status: 404 });
    }
    // She writes the caption — required before approval.
    if (!(post.caption || "").trim()) {
      return NextResponse.json(
        { ok: false, error: "Add a caption before approving — you write the caption." },
        { status: 400 },
      );
    }
    const result = await distribute(postId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AgentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    }
    console.error("posts/[id]/approve failed:", e);
    return NextResponse.json(
      { ok: false, error: "Unexpected error during distribution." },
      { status: 500 },
    );
  }
}
