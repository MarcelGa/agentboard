import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@agentboard/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

const DEFAULT_LINES = 200;
const MAX_LINES = 1000;

/** GET /api/sessions/:id/output — Retrieve recent output from a session */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  const { id } = await params;

  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  const rawLines = _request.nextUrl.searchParams.get("lines");
  let lines = DEFAULT_LINES;
  if (rawLines !== null) {
    const parsed = parseInt(rawLines, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return jsonWithCorrelation(
        { error: "lines must be a positive integer" },
        { status: 400 },
        correlationId,
      );
    }
    lines = Math.min(parsed, MAX_LINES);
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);
    const output = await sessionManager.getOutput(id, lines);
    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]/output",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
      data: { lines, outputLength: output.length },
    });
    return jsonWithCorrelation({ sessionId: id, output, lines }, { status: 200 }, correlationId);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]/output",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to get output",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to get output";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
