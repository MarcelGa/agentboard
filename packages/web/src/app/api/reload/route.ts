import { resetServices } from "@/lib/services";
import { NextResponse } from "next/server";

/**
 * POST /api/reload
 *
 * Clears the server-side services singleton so the next request
 * re-reads agent-orchestrator.yaml and per-project envFile overrides
 * from disk. Does not restart the Node process — env vars loaded by
 * Next.js at startup (e.g. .env.local) are not affected.
 */
export async function POST() {
  resetServices();
  return NextResponse.json({ ok: true });
}
