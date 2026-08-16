// Every bot on the platform runs on FreqAI — there is no "off" switch, only
// a choice of AI *behavior*. A picked card never just sets cosmetic labels:
// freqaiConfig is the structured object that travels with the bot (stored
// on BotConfiguration.freqaiConfig) and is read by lib/hetzner.ts when it
// builds the FreqAI block of the config.json shipped to the Hetzner VPS —
// so "AI Smart Scalper" retraining every 4h on a 15-day window is a real
// setting on the deployed instance, not just UI copy.

export interface FreqAIFeatureConfig {
  /**
   * The single concrete timeframe the strategy actually trades on (matches
   * the `timeframe` class attribute baked into `code`) — used for
   * `download-data --timeframe` and as the first entry FreqAI's
   * feature_parameters expects. Kept separate from StrategyPreset.timeframe,
   * which is a *display* string ("1h / 4h") and not always a single valid
   * freqtrade timeframe value.
   */
  baseTimeframe: string;
  /** Candle windows fed into feature_engineering_expand_all (RSI/EMA/etc. periods). */
  indicatorPeriods: number[];
  /** Extra timeframes FreqAI pulls in as additional features, alongside baseTimeframe. */
  includeTimeframes: string[];
  /** How many candles ahead set_freqai_targets looks when building the label. */
  labelPeriodCandles: number;
  /**
   * Minimum warm-up candles freqtrade must have available before the
   * strategy's own indicators (and FreqAI's feature engineering, which
   * uses the same indicatorPeriods lookbacks) are considered valid —
   * mirrored into the `startup_candle_count` class attribute in `code`.
   * Too low and the first predictions after a (re)start are computed on
   * partially-NaN features — a real source of spurious, overfit-looking
   * signals independent of anything FreqAI itself learned. Set generously
   * above the largest indicatorPeriods entry, regardless of timeframe —
   * src-tauri/src/main.rs also folds this into how many days of history a
   * local training run downloads.
   */
  startupCandleCount: number;
}

export interface FreqAITrainingConfig {
  trainPeriodDays: number;
  backtestPeriodDays: number;
  /** How often FreqAI retrains itself in the background while live/dry-run. */
  liveRetrainHours: number;
}

export interface FreqAIRiskConfig {
  stoploss: number;
  minimalRoi: Record<string, number>;
  trailingStop: boolean;
  trailingStopPositive?: number;
  trailingStopPositiveOffset?: number;
}

export interface FreqAIPositionAdjustmentConfig {
  enabled: boolean;
  maxEntryPositionAdjustment: number;
  /** Trade must be down at least this fraction before the bot averages down again. */
  rebuyTriggerPercent: number;
}

export interface FreqAIProfileConfig {
  /** The FreqAI model class freqtrade trains with — e.g. LightGBMRegressor. */
  freqaiModel: string;
  training: FreqAITrainingConfig;
  features: FreqAIFeatureConfig;
  risk: FreqAIRiskConfig;
  positionAdjustment?: FreqAIPositionAdjustmentConfig;
}

export interface StrategyPreset {
  id: string;
  title: string;
  description: string;
  risk: "Laag" | "Gemiddeld" | "Hoog";
  timeframe: string;
  /** Python class name — becomes both `strategy` and part of a filename. Never shown in the UI. */
  className: string;
  code: string;
  freqaiConfig: FreqAIProfileConfig;
}

const SMART_SCALPER_CODE = `import logging
from datetime import datetime
from typing import Optional

from freqtrade.strategy import IStrategy
import talib.abstract as ta

logger = logging.getLogger(__name__)


class FreqaiScalperStrategy(IStrategy):
    """AI Smart Scalper: de AI voorspelt supersnelle prijsbewegingen en
    handelt met hoge frequentie voor veel kleine winsten."""

    timeframe = "5m"
    minimal_roi = {"0": 0.015, "10": 0.008, "20": 0}
    stoploss = -0.02
    trailing_stop = True
    trailing_stop_positive = 0.003
    trailing_stop_positive_offset = 0.006
    trailing_only_offset_is_reached = True
    process_only_new_candles = True

    # Generous warm-up so every indicator/feature is fully computed (no
    # partial-NaN lookback window) before the first real prediction —
    # must stay in sync with freqaiConfig.features.startupCandleCount in
    # lib/strategy-presets.ts, which lib/hetzner.ts also uses to size how
    # much history a training run downloads.
    startup_candle_count = 200

    # Point at which abs(&-target) is treated as maximum directional
    # conviction in custom_stake_amount below — roughly 2.5x the entry
    # threshold this strategy already enters on.
    stake_confidence_scale = 0.01

    def bot_start(self, **kwargs) -> None:
        """FreqAI's minimal_roi/trailing_stop values are risk parameters
        chosen without knowing which exchange the user will pick. On a
        higher-fee exchange, a scalping-tuned profit target can sit below
        the round-trip cost of just entering and exiting a trade, turning
        a "winning" trade into a net loss after fees. Runs once at
        startup: raises (never lowers) any positive ROI tier and the
        trailing-stop trigger up to a safe margin above round-trip fees
        for the exchange in config.json's "fee" (see lib/hetzner.ts)."""
        fee_pct = self.config.get("fee")
        if fee_pct is None:
            return  # freqtrade will fetch the real fee live — nothing static to enforce yet

        round_trip_fee = fee_pct * 2  # one entry + one exit
        min_safe_roi = round_trip_fee * 1.5  # + 50% margin so a "won" trade nets a real profit

        adjusted_roi = {}
        roi_changed = False
        for minutes, roi in self.minimal_roi.items():
            if roi > 0 and roi < min_safe_roi:
                adjusted_roi[minutes] = min_safe_roi
                roi_changed = True
            else:
                adjusted_roi[minutes] = roi
        if roi_changed:
            self.minimal_roi = dict(sorted(adjusted_roi.items(), key=lambda kv: int(kv[0])))
            logger.warning(
                "minimal_roi tier(s) raised to %.4f to stay above round-trip fees (%.4f)",
                min_safe_roi, round_trip_fee,
            )

        if self.trailing_stop and self.trailing_stop_positive is not None \\
                and self.trailing_stop_positive < min_safe_roi:
            logger.warning(
                "trailing_stop_positive raised from %.4f to %.4f to stay above round-trip fees",
                self.trailing_stop_positive, min_safe_roi,
            )
            self.trailing_stop_positive = min_safe_roi

    def feature_engineering_expand_all(self, dataframe, period, metadata, **kwargs):
        dataframe["%-rsi"] = ta.RSI(dataframe, timeperiod=period)
        dataframe["%-ema"] = ta.EMA(dataframe, timeperiod=period)
        dataframe["%-mfi"] = ta.MFI(dataframe, timeperiod=period)
        return dataframe

    def feature_engineering_expand_basic(self, dataframe, metadata, **kwargs):
        dataframe["%-pct-change"] = dataframe["close"].pct_change()
        dataframe["%-raw-volume"] = dataframe["volume"]
        return dataframe

    def set_freqai_targets(self, dataframe, metadata, **kwargs):
        # ~30 min vooruit op een 5m-timeframe (6 candles).
        dataframe["&-target"] = dataframe["close"].shift(-6) / dataframe["close"] - 1
        return dataframe

    def populate_indicators(self, dataframe, metadata):
        dataframe = self.freqai.start(dataframe, metadata, self)
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["do_predict"] == 1)
            & (dataframe["&-target"] > 0.004)
            & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["do_predict"] == 1) & (dataframe["&-target"] < 0),
            "exit_long",
        ] = 1
        return dataframe

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                             proposed_stake: float, min_stake: Optional[float], max_stake: float,
                             leverage: float, entry_tag: Optional[str], side: str,
                             **kwargs) -> float:
        """Sizes the trade with how confident FreqAI is, never exceeding the
        user's configured max_stake_pct of their total_budget (both come
        from custom_user_settings in config.json — see lib/hetzner.ts).
        stake_amount itself is "unlimited" in config.json; this function is
        the real sizing logic."""
        settings = self.config.get("custom_user_settings", {})
        max_stake_pct = float(settings.get("max_stake_pct", 20)) / 100
        # Auto-Compounding: size off the *live* wallet instead of the fixed
        # total_budget snapshot, so profits compound into future position
        # sizes rather than sitting idle (see BotConfiguration.autoCompound,
        # lib/hetzner.ts tradable_balance_ratio, and lib/deploy-bot.ts).
        if bool(settings.get("auto_compound", False)):
            total_budget = float(self.wallets.get_total_stake_amount() or proposed_stake)
        else:
            total_budget = float(settings.get("total_budget") or self.wallets.get_total_stake_amount() or proposed_stake)

        hard_cap = total_budget * max_stake_pct
        floor = hard_cap * 0.25  # never risk less than a quarter of the user's own ceiling on a real signal

        confidence = 0.5  # neutral fallback until FreqAI has produced a prediction for this candle
        dataframe, _ = self.dp.get_analyzed_dataframe(pair=pair, timeframe=self.timeframe)
        if dataframe is not None and not dataframe.empty:
            last_candle = dataframe.iloc[-1]

            # Dissimilarity Index: how far this candle sits from the data
            # FreqAI actually trained on. 0 = squarely in-distribution, 1 =
            # at the DI_threshold cutoff FreqAI itself rejects outliers at.
            di_value = last_candle.get("DI_values")
            di_confidence = max(0.0, 1 - float(di_value)) if di_value is not None else 0.5

            # Classifier FreqAI models expose a "<label>_prob" column with
            # the model's own win probability (e.g. "up_prob"); our
            # regression target doesn't, so fall back to how far the
            # predicted move clears the entry threshold as a conviction proxy.
            if "up_prob" in last_candle:
                direction_confidence = float(last_candle["up_prob"])
            else:
                target = float(last_candle.get("&-target", 0))
                direction_confidence = max(0.0, min(1.0, abs(target) / self.stake_confidence_scale))

            confidence = max(0.0, min(1.0, (di_confidence + direction_confidence) / 2))

        stake = floor + (hard_cap - floor) * confidence
        stake = min(stake, hard_cap, max_stake)
        if min_stake is not None:
            stake = max(stake, min_stake)
        return stake
`;

const DYNAMIC_DCA_CODE = `import logging
from datetime import datetime
from typing import Optional

from freqtrade.strategy import IStrategy
import talib.abstract as ta

logger = logging.getLogger(__name__)


class FreqaiDcaStrategy(IStrategy):
    """AI Dynamic DCA: de AI zoekt strategische bodems om slim bij te kopen
    als de prijs zakt, en verkoopt automatisch bij een verwachte top."""

    timeframe = "15m"
    minimal_roi = {"0": 0.04, "60": 0.02, "180": 0}
    stoploss = -0.15
    trailing_stop = False
    process_only_new_candles = True

    # Freqtrade's eigen DCA-mechanisme: bijkopen via adjust_trade_position
    # hieronder, tot maximaal dit aantal extra instapmomenten.
    position_adjustment_enable = True
    max_entry_position_adjustment = 3

    # Generous warm-up so every indicator/feature is fully computed (no
    # partial-NaN lookback window) before the first real prediction —
    # must stay in sync with freqaiConfig.features.startupCandleCount in
    # lib/strategy-presets.ts, which lib/hetzner.ts also uses to size how
    # much history a training run downloads.
    startup_candle_count = 250

    # Point at which abs(&-target) is treated as maximum directional
    # conviction in custom_stake_amount below.
    stake_confidence_scale = 0.03

    def bot_start(self, **kwargs) -> None:
        """FreqAI's minimal_roi values are risk parameters chosen without
        knowing which exchange the user will pick. On a higher-fee
        exchange, a profit target can sit below the round-trip cost of
        just entering and exiting a trade, turning a "winning" trade into
        a net loss after fees. Runs once at startup: raises (never
        lowers) any positive ROI tier up to a safe margin above
        round-trip fees for the exchange in config.json's "fee" (see
        lib/hetzner.ts)."""
        fee_pct = self.config.get("fee")
        if fee_pct is None:
            return  # freqtrade will fetch the real fee live — nothing static to enforce yet

        round_trip_fee = fee_pct * 2  # one entry + one exit
        min_safe_roi = round_trip_fee * 1.5  # + 50% margin so a "won" trade nets a real profit

        adjusted_roi = {}
        roi_changed = False
        for minutes, roi in self.minimal_roi.items():
            if roi > 0 and roi < min_safe_roi:
                adjusted_roi[minutes] = min_safe_roi
                roi_changed = True
            else:
                adjusted_roi[minutes] = roi
        if roi_changed:
            self.minimal_roi = dict(sorted(adjusted_roi.items(), key=lambda kv: int(kv[0])))
            logger.warning(
                "minimal_roi tier(s) raised to %.4f to stay above round-trip fees (%.4f)",
                min_safe_roi, round_trip_fee,
            )

    def feature_engineering_expand_all(self, dataframe, period, metadata, **kwargs):
        dataframe["%-rsi"] = ta.RSI(dataframe, timeperiod=period)
        dataframe["%-ema"] = ta.EMA(dataframe, timeperiod=period)
        dataframe["%-volatility"] = ta.STDDEV(dataframe, timeperiod=period) / dataframe["close"]
        return dataframe

    def set_freqai_targets(self, dataframe, metadata, **kwargs):
        # 3 uur vooruit op een 15m-timeframe (12 candles).
        dataframe["&-target"] = dataframe["close"].shift(-12) / dataframe["close"] - 1
        return dataframe

    def populate_indicators(self, dataframe, metadata):
        dataframe = self.freqai.start(dataframe, metadata, self)
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        # AI ziet een bodem vormen: een eerste, kleine positie openen.
        dataframe.loc[
            (dataframe["do_predict"] == 1)
            & (dataframe["&-target"] > 0.01)
            & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        # AI ziet een top vormen: volledige positie sluiten.
        dataframe.loc[
            (dataframe["do_predict"] == 1) & (dataframe["&-target"] < -0.005),
            "exit_long",
        ] = 1
        return dataframe

    def adjust_trade_position(self, trade, current_time, current_rate, current_profit,
                               min_stake, max_stake, current_entry_rate, current_exit_rate,
                               current_entry_profit, current_exit_profit, **kwargs):
        # Bijkopen zolang de AI nog opwaarts potentieel ziet én de koers
        # voldoende is gezakt sinds de laatste instap. NOTE: freqtrade's
        # exacte parameterlijst voor deze hook verschilt licht per versie —
        # controleer dit tegen de freqtrade-versie in het gedeployde image.
        if current_profit > -0.03 or trade.nr_of_successful_entries > self.max_entry_position_adjustment:
            return None

        dataframe, _ = self.dp.get_analyzed_dataframe(pair=trade.pair, timeframe=self.timeframe)
        if dataframe.empty:
            return None

        last_candle = dataframe.iloc[-1]
        if last_candle["do_predict"] != 1 or last_candle["&-target"] <= 0:
            return None

        return trade.stake_amount

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                             proposed_stake: float, min_stake: Optional[float], max_stake: float,
                             leverage: float, entry_tag: Optional[str], side: str,
                             **kwargs) -> float:
        """Sizes the *initial* entry (adjust_trade_position above handles
        DCA rebuys separately) with how confident FreqAI is, never
        exceeding the user's configured max_stake_pct of their
        total_budget (both come from custom_user_settings in config.json —
        see lib/hetzner.ts). stake_amount itself is "unlimited" in
        config.json; this function is the real sizing logic."""
        settings = self.config.get("custom_user_settings", {})
        max_stake_pct = float(settings.get("max_stake_pct", 20)) / 100
        # Auto-Compounding: size off the *live* wallet instead of the fixed
        # total_budget snapshot, so profits compound into future position
        # sizes rather than sitting idle (see BotConfiguration.autoCompound,
        # lib/hetzner.ts tradable_balance_ratio, and lib/deploy-bot.ts).
        if bool(settings.get("auto_compound", False)):
            total_budget = float(self.wallets.get_total_stake_amount() or proposed_stake)
        else:
            total_budget = float(settings.get("total_budget") or self.wallets.get_total_stake_amount() or proposed_stake)

        hard_cap = total_budget * max_stake_pct
        floor = hard_cap * 0.25  # never risk less than a quarter of the user's own ceiling on a real signal

        confidence = 0.5  # neutral fallback until FreqAI has produced a prediction for this candle
        dataframe, _ = self.dp.get_analyzed_dataframe(pair=pair, timeframe=self.timeframe)
        if dataframe is not None and not dataframe.empty:
            last_candle = dataframe.iloc[-1]

            # Dissimilarity Index: how far this candle sits from the data
            # FreqAI actually trained on. 0 = squarely in-distribution, 1 =
            # at the DI_threshold cutoff FreqAI itself rejects outliers at.
            di_value = last_candle.get("DI_values")
            di_confidence = max(0.0, 1 - float(di_value)) if di_value is not None else 0.5

            # Classifier FreqAI models expose a "<label>_prob" column with
            # the model's own win probability (e.g. "up_prob"); our
            # regression target doesn't, so fall back to how far the
            # predicted move clears the entry threshold as a conviction proxy.
            if "up_prob" in last_candle:
                direction_confidence = float(last_candle["up_prob"])
            else:
                target = float(last_candle.get("&-target", 0))
                direction_confidence = max(0.0, min(1.0, abs(target) / self.stake_confidence_scale))

            confidence = max(0.0, min(1.0, (di_confidence + direction_confidence) / 2))

        stake = floor + (hard_cap - floor) * confidence
        stake = min(stake, hard_cap, max_stake)
        if min_stake is not None:
            stake = max(stake, min_stake)
        return stake
`;

const TREND_CATCHER_CODE = `import logging
from datetime import datetime
from typing import Optional

from freqtrade.strategy import IStrategy
import talib.abstract as ta

logger = logging.getLogger(__name__)


class FreqaiTrendCatcherStrategy(IStrategy):
    """AI Trend Catcher: de AI analyseert grote marktverschuivingen, negeert
    ruis, en houdt posities langer vast voor een hogere beloning."""

    timeframe = "1h"
    minimal_roi = {"0": 0.15, "720": 0.08, "1440": 0}
    stoploss = -0.12
    trailing_stop = True
    trailing_stop_positive = 0.02
    trailing_stop_positive_offset = 0.04
    trailing_only_offset_is_reached = True
    process_only_new_candles = True

    # Generous warm-up so every indicator/feature is fully computed (no
    # partial-NaN lookback window) before the first real prediction —
    # must stay in sync with freqaiConfig.features.startupCandleCount in
    # lib/strategy-presets.ts, which lib/hetzner.ts also uses to size how
    # much history a training run downloads.
    startup_candle_count = 500

    # Point at which abs(&-target) is treated as maximum directional
    # conviction in custom_stake_amount below.
    stake_confidence_scale = 0.08

    def bot_start(self, **kwargs) -> None:
        """FreqAI's minimal_roi/trailing_stop values are risk parameters
        chosen without knowing which exchange the user will pick. On a
        higher-fee exchange, a profit target can sit below the round-trip
        cost of just entering and exiting a trade, turning a "winning"
        trade into a net loss after fees. Runs once at startup: raises
        (never lowers) any positive ROI tier and the trailing-stop
        trigger up to a safe margin above round-trip fees for the
        exchange in config.json's "fee" (see lib/hetzner.ts)."""
        fee_pct = self.config.get("fee")
        if fee_pct is None:
            return  # freqtrade will fetch the real fee live — nothing static to enforce yet

        round_trip_fee = fee_pct * 2  # one entry + one exit
        min_safe_roi = round_trip_fee * 1.5  # + 50% margin so a "won" trade nets a real profit

        adjusted_roi = {}
        roi_changed = False
        for minutes, roi in self.minimal_roi.items():
            if roi > 0 and roi < min_safe_roi:
                adjusted_roi[minutes] = min_safe_roi
                roi_changed = True
            else:
                adjusted_roi[minutes] = roi
        if roi_changed:
            self.minimal_roi = dict(sorted(adjusted_roi.items(), key=lambda kv: int(kv[0])))
            logger.warning(
                "minimal_roi tier(s) raised to %.4f to stay above round-trip fees (%.4f)",
                min_safe_roi, round_trip_fee,
            )

        if self.trailing_stop and self.trailing_stop_positive is not None \\
                and self.trailing_stop_positive < min_safe_roi:
            logger.warning(
                "trailing_stop_positive raised from %.4f to %.4f to stay above round-trip fees",
                self.trailing_stop_positive, min_safe_roi,
            )
            self.trailing_stop_positive = min_safe_roi

    def feature_engineering_expand_all(self, dataframe, period, metadata, **kwargs):
        dataframe["%-ema"] = ta.EMA(dataframe, timeperiod=period)
        dataframe["%-adx"] = ta.ADX(dataframe, timeperiod=period)
        dataframe["%-rsi"] = ta.RSI(dataframe, timeperiod=period)
        return dataframe

    def set_freqai_targets(self, dataframe, metadata, **kwargs):
        # 1 dag vooruit op een 1h-timeframe (24 candles).
        dataframe["&-target"] = dataframe["close"].shift(-24) / dataframe["close"] - 1
        return dataframe

    def populate_indicators(self, dataframe, metadata):
        dataframe = self.freqai.start(dataframe, metadata, self)
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["do_predict"] == 1)
            & (dataframe["&-target"] > 0.03)
            & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["do_predict"] == 1) & (dataframe["&-target"] < 0),
            "exit_long",
        ] = 1
        return dataframe

    def custom_stake_amount(self, pair: str, current_time: datetime, current_rate: float,
                             proposed_stake: float, min_stake: Optional[float], max_stake: float,
                             leverage: float, entry_tag: Optional[str], side: str,
                             **kwargs) -> float:
        """Sizes the trade with how confident FreqAI is, never exceeding the
        user's configured max_stake_pct of their total_budget (both come
        from custom_user_settings in config.json — see lib/hetzner.ts).
        stake_amount itself is "unlimited" in config.json; this function is
        the real sizing logic."""
        settings = self.config.get("custom_user_settings", {})
        max_stake_pct = float(settings.get("max_stake_pct", 20)) / 100
        # Auto-Compounding: size off the *live* wallet instead of the fixed
        # total_budget snapshot, so profits compound into future position
        # sizes rather than sitting idle (see BotConfiguration.autoCompound,
        # lib/hetzner.ts tradable_balance_ratio, and lib/deploy-bot.ts).
        if bool(settings.get("auto_compound", False)):
            total_budget = float(self.wallets.get_total_stake_amount() or proposed_stake)
        else:
            total_budget = float(settings.get("total_budget") or self.wallets.get_total_stake_amount() or proposed_stake)

        hard_cap = total_budget * max_stake_pct
        floor = hard_cap * 0.25  # never risk less than a quarter of the user's own ceiling on a real signal

        confidence = 0.5  # neutral fallback until FreqAI has produced a prediction for this candle
        dataframe, _ = self.dp.get_analyzed_dataframe(pair=pair, timeframe=self.timeframe)
        if dataframe is not None and not dataframe.empty:
            last_candle = dataframe.iloc[-1]

            # Dissimilarity Index: how far this candle sits from the data
            # FreqAI actually trained on. 0 = squarely in-distribution, 1 =
            # at the DI_threshold cutoff FreqAI itself rejects outliers at.
            di_value = last_candle.get("DI_values")
            di_confidence = max(0.0, 1 - float(di_value)) if di_value is not None else 0.5

            # Classifier FreqAI models expose a "<label>_prob" column with
            # the model's own win probability (e.g. "up_prob"); our
            # regression target doesn't, so fall back to how far the
            # predicted move clears the entry threshold as a conviction proxy.
            if "up_prob" in last_candle:
                direction_confidence = float(last_candle["up_prob"])
            else:
                target = float(last_candle.get("&-target", 0))
                direction_confidence = max(0.0, min(1.0, abs(target) / self.stake_confidence_scale))

            confidence = max(0.0, min(1.0, (di_confidence + direction_confidence) / 2))

        stake = floor + (hard_cap - floor) * confidence
        stake = min(stake, hard_cap, max_stake)
        if min_stake is not None:
            stake = max(stake, min_stake)
        return stake
`;

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: "ai-smart-scalper",
    title: "AI Smart Scalper",
    description:
      "De AI voorspelt supersnelle prijsbewegingen. Koopt en verkoopt razendsnel voor veel kleine winsten.",
    risk: "Laag",
    timeframe: "5m",
    className: "FreqaiScalperStrategy",
    code: SMART_SCALPER_CODE,
    freqaiConfig: {
      freqaiModel: "LightGBMRegressor",
      training: { trainPeriodDays: 15, backtestPeriodDays: 3, liveRetrainHours: 4 },
      features: {
        baseTimeframe: "5m",
        indicatorPeriods: [5, 10, 20],
        includeTimeframes: ["5m", "15m"],
        labelPeriodCandles: 6,
        startupCandleCount: 200,
      },
      risk: {
        stoploss: -0.02,
        minimalRoi: { "0": 0.015, "10": 0.008, "20": 0 },
        trailingStop: true,
        trailingStopPositive: 0.003,
        trailingStopPositiveOffset: 0.006,
      },
    },
  },
  {
    id: "ai-dynamic-dca",
    title: "AI Dynamic DCA",
    description:
      "De AI zoekt strategische bodems om slim bij te kopen als de prijs zakt. Verkoopt automatisch bij een verwachte top.",
    risk: "Gemiddeld",
    timeframe: "15m",
    className: "FreqaiDcaStrategy",
    code: DYNAMIC_DCA_CODE,
    freqaiConfig: {
      freqaiModel: "LightGBMRegressor",
      training: { trainPeriodDays: 30, backtestPeriodDays: 7, liveRetrainHours: 12 },
      features: {
        baseTimeframe: "15m",
        indicatorPeriods: [10, 20, 50],
        includeTimeframes: ["15m", "1h"],
        labelPeriodCandles: 12,
        startupCandleCount: 250,
      },
      risk: { stoploss: -0.15, minimalRoi: { "0": 0.04, "60": 0.02, "180": 0 }, trailingStop: false },
      positionAdjustment: { enabled: true, maxEntryPositionAdjustment: 3, rebuyTriggerPercent: 0.03 },
    },
  },
  {
    id: "ai-trend-catcher",
    title: "AI Trend Catcher",
    description:
      "De AI analyseert de grote marktverschuivingen en negeert ruis. Stapt in bij grote trends en houdt posities langer vast.",
    risk: "Hoog",
    timeframe: "1h of 4h",
    className: "FreqaiTrendCatcherStrategy",
    code: TREND_CATCHER_CODE,
    freqaiConfig: {
      freqaiModel: "LightGBMRegressor",
      training: { trainPeriodDays: 60, backtestPeriodDays: 14, liveRetrainHours: 24 },
      features: {
        baseTimeframe: "1h",
        indicatorPeriods: [20, 50, 100],
        includeTimeframes: ["1h", "4h"],
        labelPeriodCandles: 24,
        startupCandleCount: 500,
      },
      risk: {
        stoploss: -0.12,
        minimalRoi: { "0": 0.15, "720": 0.08, "1440": 0 },
        trailingStop: true,
        trailingStopPositive: 0.02,
        trailingStopPositiveOffset: 0.04,
      },
    },
  },
];
