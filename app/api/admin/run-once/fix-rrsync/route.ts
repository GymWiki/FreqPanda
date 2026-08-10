import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { Client } from "ssh2";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";
// One real SSH session, five short commands run sequentially — comfortably
// under Vercel's default limits, but generous since a hung connection
// should time out on its own (see CONNECT_TIMEOUT_MS) well before this.
export const maxDuration = 60;

// ============================================================================
// TEMPORARY, ONE-OFF operator utility. Delete this whole route (and the
// ssh2 + @types/ssh2 dependencies in package.json, if nothing else ends up
// using them) once the fix below is confirmed applied on the data server —
// this is not meant to become a standing remote-exec capability.
//
// Exists because the agent that built this app has no network path to any
// Hetzner IP from its own sandbox (confirmed repeatedly this session — even
// a raw TCP connect to port 22 times out), but a Vercel serverless function
// does. Runs a fixed, hardcoded set of commands (never an arbitrary one —
// there is no request body this route reads) as root over a real SSH
// connection to install rrsync where the data server's own rsync package
// actually put it (gzipped, as documentation) and repoint the datasync
// user's authorized_keys forced command at it — see the "Fix rrsync install
// path" commit in lib/hetzner.ts (buildDataServerCloudInit) for the
// matching fix applied to future data-server provisioning; this route is
// only for the ALREADY-RUNNING box that provisioning fix can't reach
// retroactively.
//
// This app has never had a ROOT ssh credential to the data server before —
// DATA_SERVER_SSH_PRIVATE_KEY is deliberately the low-privilege `datasync`
// key, forced into a read-only rrsync command with no shell access at all
// (see buildDataServerCloudInit's own doc comment), so it cannot run these
// commands. DATA_SERVER_ROOT_SSH_PRIVATE_KEY is a NEW, separate env var:
// base64-encode (same convention as DATA_SERVER_SSH_PRIVATE_KEY, and for
// the same reason — see normalizeBase64Key in lib/hetzner.ts) whichever
// private key matches the public key HETZNER_SSH_KEY_ID pointed at when
// this server was created (that's what's already in its root
// ~/.ssh/authorized_keys). Remove this env var from Vercel once this route
// is deleted — there is no reason for a root credential to this box to sit
// in Vercel's config permanently for a one-off fix.
// ============================================================================

const DATA_SERVER_HOST = "178.105.173.228";
const CONNECT_TIMEOUT_MS = 20_000;

// Read-back commands (ls/cat) are included so the response is itself the
// confirmation — no separate manual verification step needed after this
// returns 200.
const COMMANDS = [
  "gunzip -c /usr/share/doc/rsync/scripts/rrsync.gz > /usr/local/bin/rrsync",
  "chmod +x /usr/local/bin/rrsync",
  "sed -i 's|/usr/share/rsync/scripts/rrsync|/usr/local/bin/rrsync|' /opt/freqdata/.ssh/authorized_keys",
  "ls -la /usr/local/bin/rrsync",
  "cat /opt/freqdata/.ssh/authorized_keys",
];

// Same Authorization: Bearer <CRON_SECRET> convention as
// app/api/train/cloud/reap and app/api/bots/sleep-sweep — this route is
// only ever meant to be hit deliberately (by hand, or via a cron-job.org
// "Test Run"), never by anything automated, but the bar for "not publicly
// callable" is the same either way.
function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[admin/run-once/fix-rrsync] CRON_SECRET is not configured — every call will be rejected as Unauthorized.");
    return false;
  }
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const actual = Buffer.from(authHeader);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runSshCommands(host: string, privateKey: string, commands: string[]): Promise<CommandResult[]> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const results: CommandResult[] = [];
    let settled = false;

    function finish(err?: Error) {
      if (settled) return;
      settled = true;
      conn.end();
      if (err) reject(err);
      else resolve(results);
    }

    function runNext(index: number) {
      if (index >= commands.length) {
        finish();
        return;
      }
      const command = commands[index];
      conn.exec(command, (err, stream) => {
        if (err) {
          results.push({ command, exitCode: null, stdout: "", stderr: err.message });
          runNext(index + 1);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream
          .on("close", (code: number | null) => {
            results.push({ command, exitCode: code, stdout, stderr });
            runNext(index + 1);
          })
          .on("data", (data: Buffer) => {
            stdout += data.toString();
          })
          .stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
      });
    }

    conn
      .on("ready", () => runNext(0))
      .on("error", (err) => finish(err))
      .connect({
        host,
        port: 22,
        username: "root",
        privateKey: Buffer.from(privateKey, "utf8"),
        readyTimeout: CONNECT_TIMEOUT_MS,
      });
  });
}

async function handleFixRrsync(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawKey = process.env.DATA_SERVER_ROOT_SSH_PRIVATE_KEY;
  if (!rawKey) {
    return NextResponse.json(
      {
        error:
          "DATA_SERVER_ROOT_SSH_PRIVATE_KEY is not configured. Set it in Vercel to the base64-encoded private key matching HETZNER_SSH_KEY_ID (same base64 -w0 convention as DATA_SERVER_SSH_PRIVATE_KEY).",
      },
      { status: 500 },
    );
  }
  const privateKey = Buffer.from(rawKey.replace(/\s+/g, ""), "base64").toString("utf8");

  try {
    const results = await runSshCommands(DATA_SERVER_HOST, privateKey, COMMANDS);
    const allOk = results.every((r) => r.exitCode === 0);
    return NextResponse.json({ ok: allOk, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "SSH connection failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export const GET = withErrorHandling(handleFixRrsync);
export const POST = withErrorHandling(handleFixRrsync);
