import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200MB, matches the "models" bucket's file_size_limit
const MODELS_BUCKET = "models";

export const POST = withErrorHandling(async (req: NextRequest) => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const botId = formData.get("botId");

  if (typeof botId !== "string" || !botId) {
    return NextResponse.json({ error: "botId is required" }, { status: 400 });
  }

  // Strictly a single file, never a list: reject outright if the client
  // sent zero or more than one "file" part rather than silently taking the
  // first one, since formData.get() would otherwise hide that ambiguity.
  const files = formData.getAll("file");
  if (files.length !== 1) {
    return NextResponse.json(
      { error: `Expected exactly 1 file, received ${files.length}` },
      { status: 400 },
    );
  }
  const [file] = files;
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!file.name.toLowerCase().endsWith(".joblib")) {
    return NextResponse.json({ error: "Only .joblib model files are accepted" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: "File exceeds 200MB limit" }, { status: 400 });
  }

  const bot = await prisma.botConfiguration.findUnique({ where: { id: botId } });
  if (!bot || bot.userId !== user.id) {
    return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  }

  // Path is scoped to the user's own folder so the storage.objects RLS
  // policies (see supabase/migrations) can enforce ownership.
  const objectPath = `${user.id}/${botId}/model-${Date.now()}.joblib`;

  const { error: uploadError } = await supabase.storage.from(MODELS_BUCKET).upload(objectPath, file, {
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 502 });
  }

  // Best-effort cleanup of the previous model file, if any.
  if (bot.aiModelPath) {
    await supabase.storage.from(MODELS_BUCKET).remove([bot.aiModelPath]);
  }

  const updated = await prisma.botConfiguration.update({
    where: { id: botId },
    data: { aiModelPath: objectPath, aiModelUploadedAt: new Date() },
  });

  return NextResponse.json({ aiModelPath: updated.aiModelPath });
});
