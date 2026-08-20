// A second, simpler bot type alongside FreqAI (see lib/strategy-presets.ts):
// classic, rule-based freqtrade strategies — plain indicator logic, no
// machine-learning model to train or upload. A bot of this kind only ever
// needs historical data downloaded and (optionally) backtested locally —
// see run_local_backtest in src-tauri/src/main.rs, the non-FreqAI
// counterpart to train_local_model. Selected once at bot creation via
// BotConfiguration.strategyType = "RULE_BASED" (see prisma/schema.prisma)
// and never changes afterward, same as a FreqAI bot's chosen persona.

export interface RuleBasedPreset {
  id: string;
  title: string;
  description: string;
  risk: "Laag" | "Gemiddeld" | "Hoog";
  /**
   * Display string shown in the UI (e.g. "15m", or "15m / 1h" for a
   * strategy with an informative pair). Purely cosmetic — which
   * timeframe(s) `run_local_backtest` actually downloads is no longer
   * sourced from this preset object at all. It used to be (via a
   * baseTimeframe/informativeTimeframe pair of fields here), which meant
   * two independent, hand-maintained copies of the same fact — this string
   * for the UI, those fields for the download — with nothing but a doc
   * comment enforcing that they and `code`'s own `timeframe`/
   * `informative_timeframe` class attributes all agreed. Rust's
   * extract_download_timeframes (src-tauri/src/main.rs) now parses the
   * timeframe(s) directly out of `code` itself instead — the same bytes
   * freqtrade parses for backtesting — so there is exactly one source of
   * truth left, and this display string can drift from it without ever
   * causing a download/backtest mismatch again.
   */
  timeframe: string;
  /** Python class name — becomes both `strategy` and part of a filename. Never shown in the UI. */
  className: string;
  code: string;
  /**
   * Must equal the `startup_candle_count` class attribute baked into
   * `code` (in units of the strategy's own `timeframe` candles — see
   * TrendVolumeStrategy's own comment for why that's a real, easy-to-get-wrong distinction once
   * an informative pair on a different timeframe is involved). Kept here
   * purely as a visible cross-check against `code` drifting out of sync
   * with itself — unlike FreqAIFeatureConfig.startupCandleCount in
   * lib/strategy-presets.ts, this value is NOT currently read by
   * run_local_backtest to size the download window: RULE_BASED_BACKTEST_
   * PERIOD_DAYS in src-tauri/src/main.rs is a fixed 90-day constant,
   * comfortably larger than any of these presets' warm-up needs today, so
   * there was nothing to wire up yet. If a future preset ever needed more
   * than ~90 days of warm-up, this field would need to actually flow into
   * that constant — it doesn't yet.
   */
  startupCandleCount: number;
}

const RSI_MACD_CODE = `import talib.abstract as ta
from freqtrade.strategy import IStrategy


class SimpleRsiMacdStrategy(IStrategy):
    """Eenvoudige, regel-gebaseerde strategie zonder machine learning —
    gebaseerd op het patroon van freqtrade's eigen officiële voorbeeld
    (freqtrade/templates/sample_strategy.py, gegenereerd via de
    'freqtrade new-strategy'-opdracht). Combineert twee bekende
    indicatoren: RSI (koopt bij oversold) en MACD (bevestigt de richting
    van de trend).
    Geen training, geen modelbestand nodig — werkt direct na het
    downloaden van historische data.
    """

    timeframe = "15m"
    minimal_roi = {"0": 0.05, "30": 0.025, "60": 0.01, "120": 0}
    stoploss = -0.08
    trailing_stop = False
    process_only_new_candles = True

    # Generous warm-up so RSI/MACD are fully computed (no partial-NaN
    # lookback window) before the first real signal — must stay in sync
    # with startupCandleCount in lib/rule-based-presets.ts, which
    # src-tauri/src/main.rs also uses to size how much history a local
    # backtest run downloads.
    startup_candle_count = 50

    def populate_indicators(self, dataframe, metadata):
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        macd = ta.MACD(dataframe)
        dataframe["macd"] = macd["macd"]
        dataframe["macdsignal"] = macd["macdsignal"]
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["rsi"] < 35)
            & (dataframe["macd"] > dataframe["macdsignal"])
            & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["rsi"] > 70) | (dataframe["macd"] < dataframe["macdsignal"]),
            "exit_long",
        ] = 1
        return dataframe
`;

// NOT the real NostalgiaForInfinity. The actual project
// (https://github.com/iterativv/NostalgiaForInfinity, GPL-3.0) is a single
// strategy file that has grown to roughly 75,000+ lines across dozens of
// entry/exit "modes", with companion pairlist/blacklist config files and an
// update sidecar — far beyond what can be embedded, understood, or safely
// kept in sync inside this codebase, and a partial rewrite of it would sit
// in genuine copyright ambiguity as a derivative of a GPL-3.0 work without
// actually being practical to ship under that license here. This is a much
// smaller, original strategy inspired only by NFI's general *approach*
// (require a higher-timeframe trend before trading a lower one, combined
// with volume/RSI confirmation) — labelled honestly as such in its own
// description and docstring, with a link to the real project for anyone
// who wants the genuine strategy.
const TREND_VOLUME_CODE = `import talib.abstract as ta
from freqtrade.strategy import IStrategy, merge_informative_pair


class TrendVolumeStrategy(IStrategy):
    """Geïnspireerd door de algemene aanpak van het populaire community-
    project NostalgiaForInfinity (https://github.com/iterativv/
    NostalgiaForInfinity, GPL-3.0): alleen instappen als een hogere
    timeframe een opwaartse trend bevestigt, gecombineerd met volume- en
    RSI-condities. Dit is NIET de daadwerkelijke NostalgiaForInfinity-code
    — die strategie is inmiddels tienduizenden regels met tientallen
    entry/exit-modes en hoort niet zomaar gekopieerd te worden. Dit is een
    eigen, veel eenvoudigere strategie die dezelfde denkwijze volgt.
    """

    timeframe = "15m"
    informative_timeframe = "1h"
    minimal_roi = {"0": 0.06, "60": 0.03, "180": 0.01, "360": 0}
    stoploss = -0.1
    trailing_stop = True
    trailing_stop_positive = 0.015
    trailing_stop_positive_offset = 0.03
    trailing_only_offset_is_reached = True
    process_only_new_candles = True

    # startup_candle_count is in units of THIS strategy's own timeframe
    # (15m), not the informative one — freqtrade converts nothing here.
    # The widest real lookback is ema200 on the 1h informative pair: 200
    # HOURS, i.e. 200*4 = 800 fifteen-minute candles, not 200 fifteen-minute
    # candles. A too-low value here (this used to say 100 — ~25 hours, only
    # 1/8th of what ema200_1h actually needs) makes freqtrade start
    # evaluating entry signals while ema50_1h/ema200_1h are still NaN for
    # every pair, so the ema50_1h > ema200_1h comparison never has a real
    # answer during that stretch — not a crash, just entries that can never fire until
    # real warm-up completes on its own well into the run. Must stay in
    # sync with startupCandleCount in lib/rule-based-presets.ts.
    startup_candle_count = 850

    def informative_pairs(self):
        pairs = self.dp.current_whitelist()
        return [(pair, self.informative_timeframe) for pair in pairs]

    def populate_indicators(self, dataframe, metadata):
        informative = self.dp.get_pair_dataframe(pair=metadata["pair"], timeframe=self.informative_timeframe)
        informative["ema50"] = ta.EMA(informative, timeperiod=50)
        informative["ema200"] = ta.EMA(informative, timeperiod=200)
        dataframe = merge_informative_pair(dataframe, informative, self.timeframe, self.informative_timeframe, ffill=True)

        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        dataframe["ema20"] = ta.EMA(dataframe, timeperiod=20)
        dataframe["volume_mean_20"] = dataframe["volume"].rolling(20).mean()
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe[f"ema50_{self.informative_timeframe}"] > dataframe[f"ema200_{self.informative_timeframe}"])
            & (dataframe["close"] > dataframe["ema20"])
            & (dataframe["rsi"] < 40)
            & (dataframe["volume"] > dataframe["volume_mean_20"])
            & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["rsi"] > 75)
            | (dataframe[f"ema50_{self.informative_timeframe}"] < dataframe[f"ema200_{self.informative_timeframe}"]),
            "exit_long",
        ] = 1
        return dataframe
`;

const BOLLINGER_CODE = `import talib.abstract as ta
from freqtrade.strategy import IStrategy


class BollingerMeanReversionStrategy(IStrategy):
    """Mean-reversion strategie op basis van Bollinger Bands: koopt wanneer
    de prijs de onderste band aantikt (verwacht herstel naar het
    gemiddelde), verkoopt zodra de prijs de middelste band (het
    voortschrijdend gemiddelde) weer bereikt. Een bekend, eenvoudig
    patroon — geen training of modelbestand nodig.
    """

    timeframe = "1h"
    minimal_roi = {"0": 0.04, "120": 0.02, "360": 0}
    stoploss = -0.06
    trailing_stop = False
    process_only_new_candles = True

    # Generous warm-up so the Bollinger Bands' own 20-candle lookback (and
    # RSI's 14) are fully computed before the first real signal — must stay
    # in sync with startupCandleCount in lib/rule-based-presets.ts, which
    # src-tauri/src/main.rs also uses to size how much history a local
    # backtest run downloads.
    startup_candle_count = 40

    def populate_indicators(self, dataframe, metadata):
        bollinger = ta.BBANDS(dataframe, timeperiod=20, nbdevup=2.0, nbdevdn=2.0)
        dataframe["bb_lowerband"] = bollinger["lowerband"]
        dataframe["bb_middleband"] = bollinger["middleband"]
        dataframe["bb_upperband"] = bollinger["upperband"]
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        return dataframe

    def populate_entry_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["close"] <= dataframe["bb_lowerband"])
            & (dataframe["rsi"] < 40)
            & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe, metadata):
        dataframe.loc[
            (dataframe["close"] >= dataframe["bb_middleband"]) | (dataframe["close"] >= dataframe["bb_upperband"]),
            "exit_long",
        ] = 1
        return dataframe
`;

export const RULE_BASED_PRESETS: RuleBasedPreset[] = [
  {
    id: "rb-rsi-macd",
    title: "RSI + MACD",
    description:
      "Klassieke instapregels: koopt bij een oversold RSI mét bevestiging van de MACD-trend. Werkt met 5-15 paren op een 15m-timeframe. Geen AI, geen training — direct te backtesten.",
    risk: "Gemiddeld",
    timeframe: "15m",
    className: "SimpleRsiMacdStrategy",
    code: RSI_MACD_CODE,
    startupCandleCount: 50,
  },
  {
    id: "rb-trend-volume",
    title: "Trend & Volume (NFI-geïnspireerd)",
    description:
      "Stapt alleen in als een hogere timeframe (1h) een opwaartse trend bevestigt, met volume- en RSI-condities op 15m. Geïnspireerd door NostalgiaForInfinity's aanpak — géén kopie van die code. Werkt het best met 10-30 paren.",
    risk: "Gemiddeld",
    timeframe: "15m / 1h",
    className: "TrendVolumeStrategy",
    code: TREND_VOLUME_CODE,
    startupCandleCount: 850,
  },
  {
    id: "rb-bollinger",
    title: "Bollinger mean-reversion",
    description:
      "Koopt wanneer de prijs de onderste Bollinger Band aantikt, verkoopt bij terugkeer naar het gemiddelde. Eenvoudig en voorspelbaar, het best op een 1h-timeframe met 5-15 paren.",
    risk: "Laag",
    timeframe: "1h",
    className: "BollingerMeanReversionStrategy",
    code: BOLLINGER_CODE,
    startupCandleCount: 40,
  },
];
