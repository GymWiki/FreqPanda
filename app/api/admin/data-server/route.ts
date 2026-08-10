import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildDataServerCloudInit, createHetznerServer, deleteHetznerServer, findDataServer, DATA_SERVER_HETZNER_NAME } from "@/lib/hetzner";
import { withErrorHandling } from "@/lib/api-handler";
import { isAdminUser } from "@/lib/admin";

export const dynamic = "force-dynamic";
// createHetznerServer (POST) makes several sequential Hetzner API calls
// (firewall lookup/create, location resolution, server create) — see
// app/api/train/cloud/route.ts's own maxDuration comment for why the
// default Vercel timeout isn't safely long enough for that chain.
export const maxDuration = 60;

// Manages the one permanent data server this app depends on (see
// buildDataServerCloudInit in lib/hetzner.ts) — create it, check its
// status, or delete it, all looked up by its fixed name
// (DATA_SERVER_HETZNER_NAME) rather than an id stored in our own DB, since
// there's exactly one of these ever. Gated to a single hardcoded operator
// account (see lib/admin.ts): this creates/destroys real, billed
// infrastructure and this app has no broader admin-role system to hang a
// proper permission check off of. Surfaced in Settings — see
// components/DataServerAdminPanel.tsx.
async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdminUser(user.email)) {
    return null;
  }
  return user;
}

export const GET = withErrorHandling(async (_req: NextRequest) => {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const server = await findDataServer();
  return NextResponse.json({ server });
});

export const POST = withErrorHandling(async (_req: NextRequest) => {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cloudInit = buildDataServerCloudInit();
  const { server } = await createHetznerServer({
    name: DATA_SERVER_HETZNER_NAME,
    cloudInit,
    serverType: process.env.DATA_SERVER_TYPE || "cx22",
    firewallProfile: "data-server",
  });

  return NextResponse.json({
    id: server.id,
    status: server.status,
    ip: server.public_net.ipv4?.ip ?? null,
  });
});

export const DELETE = withErrorHandling(async (_req: NextRequest) => {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const server = await findDataServer();
  if (!server) {
    return NextResponse.json({ error: "Geen data-server gevonden" }, { status: 404 });
  }
  await deleteHetznerServer(String(server.id));
  return NextResponse.json({ ok: true });
});
