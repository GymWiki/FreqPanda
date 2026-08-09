import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { extractBearerToken, hashCallbackToken } from "@/lib/training-token";
import { withErrorHandling, parseJsonBody } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const progressBodySchema = z.object({
  stage: z.enum(["BOOTED", "PULLING_IMAGE", "DOWNLOADING_DATA", "TRAINING", "UPLOADING", "DONE"]),
});

// Best-effort checkpoint the training VM's own script calls at each real
// phase boundary (see lib/hetzner.ts buildFreqAITrainingArtifacts's
// report_stage) — deliberately separate from POST /api/train/cloud/callback,
// which handles the one terminal COMPLETED/FAILED report and its much
// heavier side effects (redeploying a bot, resuming trading). This route
// only ever touches TrainingJob.stage/stageUpdatedAt, so a stage ping can
// never interfere with — or race — the terminal callback.
export const POST = withErrorHandling(async (req: NextRequest) => {
  const token = extractBearerToken(req.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }

  const job = await prisma.trainingJob.findUnique({
    where: { callbackTokenHash: hashCallbackToken(token) },
  });
  if (!job) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  // A terminal job (COMPLETED/FAILED already recorded via the callback
  // route, or CANCELLED via POST /api/train/cloud/stop) never needs its
  // stage touched again — the script self-destructs right after that, or
  // the VM has already been deleted out from under it, so a stray/racing
  // progress ping this late is a harmless no-op, not an error.
  if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") {
    return NextResponse.json({ ok: true });
  }

  const parsed = await parseJsonBody(req, progressBodySchema);
  if ("error" in parsed) return parsed.error;

  await prisma.trainingJob.update({
    where: { id: job.id },
    data: { stage: parsed.data.stage, stageUpdatedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
});
