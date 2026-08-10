import { createClient as createServiceRoleClient } from "@supabase/supabase-js";

// Hetzner hard-caps a server's user_data at 32768 bytes (the 422 "Length
// must be between 0 and 32768" error this module exists to prevent) — fine
// for the cloud-init this app used to inline directly, but not once the
// generated train.sh (strategy source, config.json, and — for an
// auto-select bot with a permanent data server configured — the embedded
// SSH private key and rsync script, see buildFreqAITrainingArtifacts in
// lib/hetzner.ts) started pushing close to that limit. Storage has no such
// limit, so the actual training artifacts (config.json, the strategy
// source, and the train.sh script) are uploaded here instead, and the VM's
// user_data becomes a short bootstrap that curls them down after boot (see
// buildTrainingBootstrapCloudInit).
const TRAINING_BOOTSTRAP_BUCKET = "training-bootstrap";

// Generous relative to how long this actually needs to live: the VM fetches
// all three files within seconds of booting, and boot itself follows
// createHetznerServer by at most a couple of minutes. Not tied to
// maxRuntimeHours (the training run itself) since nothing after the initial
// fetch ever needs these URLs again.
const SIGNED_URL_TTL_SECONDS = 3600;

function serviceRoleClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key);
}

export interface TrainingArtifacts {
  configJson: string;
  strategyCode: string;
  trainScript: string;
}

export interface TrainingBootstrapUrls {
  configUrl: string;
  strategyUrl: string;
  trainScriptUrl: string;
}

// Uploads one training job's artifacts to the private "training-bootstrap"
// bucket under `${jobId}/...` and mints a signed URL for each — called once,
// right before createHetznerServer, from startCloudTrainingJob
// (lib/train-cloud.ts). Nothing here is ever read back by this app itself;
// it exists purely for the training VM's own bootstrap curl to fetch.
export async function uploadTrainingBootstrap(jobId: string, artifacts: TrainingArtifacts): Promise<TrainingBootstrapUrls> {
  const supabase = serviceRoleClient();
  const entries: Array<{ key: keyof TrainingBootstrapUrls; path: string; content: string }> = [
    { key: "configUrl", path: `${jobId}/config.json`, content: artifacts.configJson },
    { key: "strategyUrl", path: `${jobId}/strategy.py`, content: artifacts.strategyCode },
    { key: "trainScriptUrl", path: `${jobId}/train.sh`, content: artifacts.trainScript },
  ];

  const urls = {} as TrainingBootstrapUrls;
  for (const { key, path, content } of entries) {
    const { error: uploadError } = await supabase.storage
      .from(TRAINING_BOOTSTRAP_BUCKET)
      .upload(path, new Blob([content], { type: "text/plain" }), { upsert: true });
    if (uploadError) {
      throw new Error(`Failed to upload training bootstrap artifact ${path}: ${uploadError.message}`);
    }

    const { data, error: signError } = await supabase.storage
      .from(TRAINING_BOOTSTRAP_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (signError || !data) {
      throw new Error(`Failed to sign training bootstrap artifact ${path}: ${signError?.message ?? "unknown error"}`);
    }
    urls[key] = data.signedUrl;
  }

  return urls;
}
