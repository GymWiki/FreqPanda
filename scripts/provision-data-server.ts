// Stands up the ONE permanent Hetzner box this app relies on for market
// data (see buildDataServerCloudInit in ../lib/hetzner.ts for what actually
// runs on it). Run this by hand, once, from a machine that can both reach
// api.hetzner.cloud and hold a real HETZNER_API_TOKEN — NOT triggered from
// inside a Vercel request the way every other server this app creates is,
// since "provision the one permanent data server" is an operator action,
// not something that should ever happen as a side effect of a user's own
// request.
//
// Usage:
//   HETZNER_API_TOKEN=... [HETZNER_LOCATION=fsn1] [DATA_SERVER_TYPE=cx22] \
//     [HETZNER_SSH_KEY_ID=...] [HETZNER_IMAGE=ubuntu-24.04] \
//     npx tsx scripts/provision-data-server.ts
//
// HETZNER_LOCATION should match whatever training/live-trading VMs already
// use (see lib/hetzner.ts's createHetznerServer — same env var) so the data
// server sits in the same datacenter and the rsync pull training VMs do at
// boot stays a fast, same-DC transfer rather than crossing regions.
//
// HETZNER_SSH_KEY_ID is optional but strongly recommended: without it, this
// server has no operator SSH access at all (cloud-init's own steps still
// run and set everything up unattended) — with it, you can SSH in as root
// to tail /var/log/freqdata-refresh.log and watch the first backfill
// progress.
//
// After this prints a public IP, set DATA_SERVER_HOST to it in Vercel's
// Environment Variables (Production) — see this script's own final output
// for the full checklist, including the DATA_SERVER_SSH_PRIVATE_KEY value
// training VMs need to actually reach this box.
import { buildDataServerCloudInit, createHetznerServer } from "../lib/hetzner";

const DATA_SERVER_NAME = "freqpanda-data-server";
const DATA_SERVER_TYPE = process.env.DATA_SERVER_TYPE || "cx22";

async function main() {
  if (!process.env.HETZNER_API_TOKEN) {
    console.error("HETZNER_API_TOKEN is not set in this shell's environment — aborting.");
    process.exit(1);
  }

  console.log(`Provisioning permanent data server "${DATA_SERVER_NAME}" (type: ${DATA_SERVER_TYPE})...`);
  const cloudInit = buildDataServerCloudInit();

  const { server } = await createHetznerServer({
    name: DATA_SERVER_NAME,
    cloudInit,
    serverType: DATA_SERVER_TYPE,
    firewallProfile: "data-server",
  });

  const ip = server.public_net.ipv4?.ip;
  console.log("");
  console.log(`Server created: id=${server.id} status=${server.status} ip=${ip ?? "(none assigned yet)"}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. In Vercel (Production env), set:");
  console.log(`       DATA_SERVER_HOST=${ip ?? "<server IP once assigned>"}`);
  console.log("       DATA_SERVER_SSH_PRIVATE_KEY=<the private key you were given separately>");
  console.log("  2. Wait for the first backfill to finish (can take hours — this is a one-time,");
  console.log("     full-history download for every timeframe and every top-volume pair). Check:");
  console.log(`       ssh root@${ip ?? "<ip>"} tail -f /var/log/freqdata-refresh.log`);
  console.log("  3. Once user_data/data/<exchange>/ and pairlist.json exist and are owned by");
  console.log("     'datasync', auto-select training runs will start rsyncing from this box");
  console.log("     automatically — no further action needed.");
}

main().catch((err) => {
  console.error("Provisioning failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
