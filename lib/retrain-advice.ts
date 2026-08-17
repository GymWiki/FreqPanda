// Simple, deliberately-not-perfect heuristic for "should this bot probably
// be retrained?" — a starting point, not a claim that 30 days is precisely
// when a model goes stale. Chosen to match FREQAI_TRAIN_PERIOD_DAYS (the
// training window FreqAI itself is already configured with, both here and
// in src-tauri/src/main.rs's local training flow — see that file's own
// train_period_days comment): a model trained on the last N days of
// candles is trained to recognize a market regime roughly N days long, so
// once that same amount of time has passed since training, the market it
// was trained on and the market it's now trading in have likely diverged
// by about as much as the model was ever designed to tolerate. A future
// version could react to something more direct (how much the training
// data's own regime has actually shifted, e.g. via volatility drift)
// instead of a flat day count — this is a reasonable, easy-to-explain
// first cut.
export const RETRAIN_RECOMMENDED_AFTER_DAYS = 30;

export interface TrainingFreshness {
  /** False when this bot has never had a model uploaded at all. */
  everTrained: boolean;
  trainedAt: Date | null;
  daysSinceTraining: number | null;
  /** True once training is this stale, OR the bot was never trained. */
  retrainRecommended: boolean;
}

export function getTrainingFreshness(aiModelUploadedAt: string | Date | null): TrainingFreshness {
  if (!aiModelUploadedAt) {
    return { everTrained: false, trainedAt: null, daysSinceTraining: null, retrainRecommended: true };
  }
  const trainedAt = new Date(aiModelUploadedAt);
  const daysSinceTraining = Math.floor((Date.now() - trainedAt.getTime()) / (24 * 60 * 60 * 1000));
  return {
    everTrained: true,
    trainedAt,
    daysSinceTraining,
    retrainRecommended: daysSinceTraining >= RETRAIN_RECOMMENDED_AFTER_DAYS,
  };
}
