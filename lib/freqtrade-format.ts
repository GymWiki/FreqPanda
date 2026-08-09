// Matches freqtrade's own misc.pair_to_filename() exactly (see
// freqtrade/misc.py) — every place that writes or reads a per-pair OHLCV
// filename under user_data/data/<exchange>/ has to agree on this transform,
// or the browser-uploaded file (see app/api/train/cloud/upload-data) and
// the VM-side placement step (buildFreqAITrainingArtifacts's preloadedData
// handling in lib/hetzner.ts) will end up looking for two different names
// for the same pair.
export function pairToFreqtradeFilename(pair: string): string {
  return pair.replace(/[/ .@$+:]/g, "_");
}
