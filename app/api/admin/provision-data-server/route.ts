import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildDataServerCloudInit, createHetznerServer } from "@/lib/hetzner";
import { withErrorHandling } from "@/lib/api-handler";
import { isAdminUser } from "@/lib/admin";

export const dynamic = "force-dynamic";
// createHetznerServer makes several sequential Hetzner API calls
// (firewall lookup/create, location resolution, server create) — see
// app/api/train/cloud/route.ts's own maxDuration comment for why the
// default Vercel timeout isn't safely long enough for that chain.
export const maxDuration = 60;

const DATA_SERVER_NAME = "freqpanda-data-server";

// TEMPORARY: a one-click alternative to running
// `npm run provision:data-server` locally, for provisioning the one
// permanent market-data box this app depends on (see
// buildDataServerCloudInit in lib/hetzner.ts). Meant to be deleted again
// once that server exists — there's no reason for this to stay reachable
// in production afterward, and provisioning is a one-time operator action,
// not a feature. Gated to a single hardcoded operator account (see
// lib/admin.ts) since this creates real, billed infrastructure and this
// app has no broader admin-role system to hang a proper permission check
// off of.
export const POST = withErrorHandling(async (_req: NextRequest) => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdminUser(user.email)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cloudInit = buildDataServerCloudInit();
  const { server } = await createHetznerServer({
    name: DATA_SERVER_NAME,
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
