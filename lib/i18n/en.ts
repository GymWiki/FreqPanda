// English dictionary — type-checked against nl.ts's shape (see
// dictionary.ts). Natural English phrasing for the same concepts, not a
// literal word-for-word translation of the Dutch terminology.
import type { Dictionary } from "./dictionary";

export const en: Dictionary = {
  common: {
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    remove: "Remove",
    genericError: "Something went wrong",
  },

  nav: {
    brand: "FreqPanda",
    settings: "Settings",
    myBots: "My bots",
    toDashboard: "To my bots",
  },

  dashboard: {
    title: "My bots",
    activeBots: (active: number, total: number) => `${active} of ${total} bots active`,
  },

  botFleet: {
    empty: "No bots yet. Train an AI model in the desktop app, then add it here.",
  },

  statusBadge: {
    local: "Local only",
    liveOnVps: "Live in the cloud",
    inactive: "Inactive",
  },

  lifecycleBadge: {
    notTrained: "Not trained yet",
    training: "Training…",
    ready: "Ready to use",
    activePaper: "Active — paper trading",
    activeLive: "Active — live trading",
    pausedManual: "Stopped",
    pausedEmergency: "Emergency stop active",
    sleeping: "Sleeping",
    error: "Error",
  },

  botCard: {
    resumeFailed: "Couldn't resume",
    stopFailed: "Couldn't stop",
    autoCompoundUpdateFailed: "Couldn't change 'reinvest profit'",
    uploadFailed: "Upload failed",
    localTrainingFailed: "Training on your computer failed",
    deployFailed: "Couldn't start",
    loadCredentialsFailed: "Couldn't load login details",
    removeFailed: "Couldn't remove",
    disconnectFailed: "Couldn't disconnect",

    confirmStop: (botName: string) =>
      `Stop ${botName}? No new positions will open — existing open positions keep running. You can resume it again afterward.`,
    confirmRemove: (botName: string) => `Remove ${botName}? This can't be undone.`,
    confirmDisconnectExchange: "Disconnect the account from this bot?",

    stopBot: "Stop bot",
    exchangeAccount: "Your account",
    exchangeAccountTooltip:
      "The exchange account this bot will eventually trade with. Only needed once you switch to real money — practicing already works without it.",
    modeTooltip:
      "Practice mode: the bot trades with fake money, purely to test things out. Real money: the bot trades with your own budget on your linked exchange account.",
    verified: "Verified",
    notVerified: "Not verified yet",
    noExchangeLinked: "Not linked yet — only needed to trade with real money, practicing works without it.",
    replaceAccount: "Replace",
    disconnectAccount: "Disconnect",
    connectAccount: "Link your account",

    autoCompound: "Automatically reinvest profit",
    autoCompoundHint: "Reinvests profit into bigger positions automatically — takes effect from the next (re)start.",

    emergencyStopped: "Emergency stop active",
    sleeping: "Sleeping — no activity for a while",
    manuallyStopped: "Stopped — existing positions keep running",

    resume: "Resume bot",
    stoppedLabel: "Stopped",
    practiceMode: "Practice mode",
    realMoney: "Real money",
    goLive: "Switch to real money",

    trainingLocally: "Training on your computer…",
    startLocalTraining: "Train AI on my computer",
    retrainLocally: "Retrain from scratch",
    localTrainingNeedsApp: "Training needs the desktop app — download it from the website.",
    modelUploaded: "Model uploaded — replace it manually if needed",
    orUploadManually: "Or upload a model file yourself (.joblib)",

    localConfig: "Download settings",
    deployed: "Live",
    deployToCloud: "Start bot",
    deployNeedsModel: "Train an AI model first before starting the bot.",
    showCredentials: "Show login details",
    apiCredentialsHint: (ip: string) => `Freqtrade API at ${ip}:8080 — save this now, it won't be shown in full again after this.`,
    username: "Username",
    password: "Password",
    removeBot: "Remove bot",
    copyLabel: (label: string) => `Copy ${label.toLowerCase()}`,

    budgetLine: (total: number, maxPerTrade: number, maxPct: number) =>
      `Budget: €${total} · max €${maxPerTrade} per trade (${maxPct}%)`,
    noBudgetYet: "Practice mode — no real-money budget set yet",

    localConfigNote: "Fill in your API key/secret locally — they're never exported from the dashboard.",
  },

  newBot: {
    validationNeedsPairs: "Pick at least 1 coin, or let the AI choose coins automatically.",
    createFailed: "Couldn't create the bot",
    trigger: "New bot",
    heading: "Set up a new AI bot",
    intro: "Every bot trades with an AI model and starts in practice mode — you switch to real money yourself, whenever you're ready.",
    botNameLabel: "Bot name",
    botNamePlaceholder: "My first bot",
    botTypeLabel: "What kind of bot do you want to make?",
    botTypeFreqAI: "FreqAI (machine learning)",
    botTypeFreqAIDescription: "An AI model learns to recognize patterns itself. Needs to be trained before it can trade.",
    botTypeRuleBased: "Rule-based (classic indicators)",
    botTypeRuleBasedDescription: "Fixed, well-known indicator rules (like RSI and MACD). No training needed — ready to backtest right away.",
    ruleBasedStrategyLabel: "Which strategy should it follow?",
    aiBehaviorLabel: "How should your bot trade?",
    aiBehaviorTooltip:
      "Determines how cautious or active the AI is: how often it opens positions and how much risk it takes doing so. Can't be changed for this bot after this.",
    pairsLabel: "Which coins can it trade?",
    autoSelectLabel: "Let the AI pick the best coins automatically",
    recommended: "(Recommended)",
    autoSelectHint: "The bot keeps an eye on the most-traded coins and lets the AI trade wherever the opportunity looks best. Which exchange exactly, you choose later, when linking your account.",
    practiceModeNoticePrefix: "This bot starts automatically in ",
    practiceModeNoticeBold: "practice mode",
    practiceModeNoticeSuffix: " — no budget needed, no real money at risk. Once you're happy with the results, switch to real money from the bot's detail page.",
    submit: "Create bot (practice mode)",
    // Wizard chrome: a stepped flow instead of one long form, so someone
    // with no technical background only ever sees one decision at a time,
    // with a sensible default already filled in.
    stepIndicator: (step: number, total: number) => `Step ${step} of ${total}`,
    stepBack: "Back",
    stepNext: "Next",
    step1Title: "Name and strategy",
    step2Title: "Link an exchange",
    step2Intro:
      "You only need this if you plan to trade with real money later. Training and testing in practice mode works fine without it — and you can always do this later, from the bot's page.",
    step2SkipTitle: "Link later",
    step2SkipDescription: "Start training and testing right away. Great for seeing how your bot performs first.",
    step2ConnectTitle: "Link now",
    step2ConnectDescription: "Pick your exchange and enter your API keys as soon as this bot is created.",
    step3Title: "Coins",
    step4Title: "Confirm",
    step4ReadyIntro: "One last check, then let's go:",
    step4SummaryName: "Name",
    step4SummaryType: "Type",
    step4SummaryStrategy: "Strategy",
    step4SummaryPairs: "Coins",
    step4SummaryPairsAuto: (count: number) => `Automatic, top ${count}`,
    step4SummaryExchange: "Exchange",
    step4SummaryExchangeLater: "Link later",
    step4SummaryExchangeNow: "Right after creation",
    submitAndTrain: "Create and start training",
    submitAndBacktest: "Create and start backtesting",
    submitWebOnlyNote: "Open the FreqPanda desktop app to have it train or backtest automatically after creation.",
  },

  strategyPicker: {
    ariaLabel: "Choose how your bot should trade",
    riskSuffix: " risk",
    timeframePrefix: "Checks every: ",
  },

  ruleBasedPicker: {
    ariaLabel: "Choose a rule-based strategy",
    timeframePrefix: "Timeframe: ",
  },

  // Plain-language translations for every error src-tauri/src/main.rs's
  // train_local_model/run_local_backtest can reject with — see
  // lib/training-error-messages.ts, which maps the raw Rust/Docker Err
  // string to one of these before it ever reaches the UI. The user must
  // never see that raw string directly: it can be an internal validation
  // message, a bare Docker exit code, or (worst case) a line straight out
  // of a freqtrade Python traceback. genericTraining/genericBacktest are
  // the catch-all for anything not specifically recognized below.
  trainingErrors: {
    dockerNotRunning: "Docker Desktop doesn't seem to be running. Start Docker Desktop and try again.",
    downloadFailed: "Downloading historical price data didn't work. Check your internet connection and try again in a few minutes.",
    noPairsSelected: "Pick at least 1 coin, or let coins be chosen automatically, before continuing.",
    dataMissingAfterDownload: "The downloaded data turned out incomplete for this strategy. Try again — if this keeps happening, report it as a bug.",
    strategyCodeInvalid: "There's an issue in this bot's strategy code that made it unclear which data is needed. Get in touch if this keeps happening.",
    genericTraining: "Something went wrong while downloading and training. This is usually temporary — try again.",
    genericBacktest: "Something went wrong while downloading and backtesting. This is usually temporary — try again.",
  },

  backtestResults: {
    heading: "Backtest results",
    disclaimer: "Past results are no guarantee of future performance.",
    totalProfit: "Total profit",
    winRate: "Win rate",
    trades: "Trades",
    maxDrawdown: "Max. drawdown",
    runBacktest: "Run backtest",
    rerunBacktest: "Run again",
    running: "Downloading and backtesting…",
    failed: "Backtest failed",
    needsApp: "Backtesting requires the desktop app — download it from the website.",
    noneYet: "No backtest has been run for this bot yet.",
    winLossDraw: (wins: number, losses: number, draws: number) => `${wins}W / ${losses}L / ${draws}D`,
    notAvailable: "N/A",
    zeroTrades:
      "This backtest closed zero trades in the chosen period — this strategy's entry rules simply never triggered for the selected coins. Try different coins or a less strict strategy.",
    // See lib/backtest-interpretation.ts for the thresholds that pick one
    // of these — a one-sentence, plain-language reading next to the raw
    // numbers, so someone with no trading background doesn't have to work
    // out for themselves whether a given profit% or drawdown% is
    // actually good or bad.
    interpretationStronglyNegative: "This strategy lost money consistently over the tested period — consider a different strategy or a different period.",
    interpretationNegative:
      "This strategy lost money on balance over the tested period. No reason to panic over a small loss, but be careful before taking this live.",
    interpretationHighDrawdown:
      "The result is positive, but with a steep dip (drawdown) along the way. Make sure you're prepared for that, both mentally and financially, before going live.",
    interpretationStronglyPositive:
      "This strategy performed strongly over the tested period. Remember: past results are no guarantee — it's worth testing a different period too before going live.",
    interpretationPositive: "A modest positive result over the tested period. Consider a longer test period or more coins for a sturdier picture.",
  },

  budgetSlider: {
    placeholder: "500",
    maxPerTradeLabel: "Max. stake per trade",
    maxPerTradeAriaLabel: "Max. stake per trade as a percentage of the budget",
    maxPerTradeHint: (amount: string) => `The bot stakes at most €${amount} per trade, and only when the AI is confident.`,
  },

  pairCountSlider: {
    label: "Number of pairs (top volume)",
    ariaLabel: "Number of pairs auto-selected by trading volume",
    adviceLow: "Fewer pairs = faster training, less diversification.",
    adviceMedium: "A balanced mix of training speed and market coverage.",
    adviceHigh: "More pairs = broader market coverage, longer training time.",
    estimatedTimeLabel: (time: string) => `Estimated training time: ${time}`,
    underAMinute: "< 1 min",
    minutesEstimate: (n: number) => `~${n} min`,
    hoursEstimate: (n: number) => `~${n} hr`,
  },

  exchangeCombobox: {
    placeholder: "Choose an exchange",
    searchPlaceholder: "Search for an exchange…",
    empty: "No exchange found.",
  },

  pairSelector: {
    removeAriaLabel: (symbol: string) => `Remove ${symbol}`,
    availableAriaLabel: "Available coins",
  },

  settings: {
    title: "Settings",
    subtitle: "Applies to your whole account — every bot you (re)start.",
    languageLabel: "Language",
    languageSaveFailed: "Couldn't change the language",
  },

  telegram: {
    saveFailed: "Couldn't save",
    unlinkFailed: "Couldn't disconnect",
    heading: "Telegram notifications",
    stepOneWithUsername: (botUsername: string) => `Open Telegram, search for @${botUsername}, and start the chat.`,
    stepOneFallback: "Start a chat with our Telegram bot (ask support for its name if you don't have it yet).",
    stepTwoPrefix: "Send a message to ",
    stepTwoLinkLabel: "@userinfobot",
    stepTwoSuffix: " to get your numeric Chat ID.",
    stepThree: "Paste it below — every bot you (re)start will then send updates there automatically.",
    chatIdLabel: "Telegram Chat ID",
    chatIdPlaceholder: "e.g. 123456789",
    save: "Save",
    unlink: "Disconnect Telegram",
  },

  connectExchange: {
    connectFailed: "Couldn't link the account",
    heading: "Link your account",
    subtitleWithExchange: (botName: string, exchangeLabel: string) => `For ${botName} on ${exchangeLabel}`,
    subtitleWithoutExchange: (botName: string) => `For ${botName} — choose the exchange first`,
    subtitleSuffix: " — only for this bot, not shared with your other bots.",
    exchangeLabel: "Exchange",
    exchangeHint: "Which exchange this account belongs to. Can't be changed for this bot after this.",
    apiKeyLabel: "API key",
    apiKeyHint: "Found in your exchange account's settings. Only give this key trading rights, never withdrawal rights.",
    secretPlaceholder: "••••••••••••",
    apiSecretLabel: "API secret",
    apiSecretHint: "The secret half of your API key. Stored encrypted and never shown again.",
    verifying: "Verifying…",
    submit: "Link account",
  },

  goLive: {
    loadBalanceFailed: "Couldn't load balance",
    goLiveFailed: "Couldn't switch to real money",
    heading: "Switch to real money",
    subtitle: (botName: string) => `${botName} — from now on with real money.`,
    balanceLabel: (exchangeLabel: string) => `Available balance on ${exchangeLabel}`,
    balanceTooLow: (exchangeLabel: string, minRequired: number) =>
      `Your balance on ${exchangeLabel} is too low. Deposit at least $${minRequired} to trade with real money.`,
    totalBudgetLabel: "Total budget (USDT)",
    budgetTooHigh: (available: string) => `Budget can't be higher than your available balance ($${available}).`,
    submit: "Switch to real money",
  },

  panic: {
    failed: "Emergency stop failed",
    trigger: "Emergency stop",
    confirmHeading: "Trigger emergency stop?",
    confirmBodyPrefix: "This ",
    confirmBodyBold: "immediately",
    confirmBodySuffix: " closes every open position on all your active bots at the current market price and pauses them all. This can't be undone.",
    confirmCancel: "Cancel",
    confirmProceed: "Yes, stop everything",
    resultHeading: "Emergency stop complete",
    resultEmpty: "No active bots to stop.",
    resultStopped: "Stopped",
    resultPartial: "Stopped — please check manually",
  },

  pnl: {
    loadFailed: "Couldn't load portfolio value",
    heading: "Total profit (all your bots)",
  },

  botDetail: {
    back: "Back to overview",
    trainingStatusHeading: "Training status",
    neverTrained: "Never trained yet",
    trainedToday: "Last trained: today",
    trainedDaysAgo: (days: number) => `Last trained: ${days} ${days === 1 ? "day" : "days"} ago`,
    retrainRecommended: "Retraining recommended — the market data this model trained on is starting to age.",
    retrainNotNeeded: "Model is still fresh — no need to retrain right now.",
    tradesHeading: "Trades",
    tradesLoadFailed: "Couldn't load trades",
    tradesEmptyNotDeployed: "The bot hasn't started yet — trades will show up here once it's active.",
    tradesEmpty: "No trades yet — once the bot closes a position, it'll show up here.",
    chartHeading: "Profit over time",
    tableDate: "Date",
    tablePair: "Pair",
    tableEntry: "Entry price",
    tableExit: "Exit price",
    tableResult: "Result",
    tableOpenPosition: "Still open",
    totalPlHeading: "Total profit/loss",
    totalPlPaperNote: (amount: string) => `${amount} (Practice mode — fake money)`,
  },

  trainingProgress: {
    loadFailed: "Couldn't load progress",
    stageQueued: "Queued…",
    stageBooted: "Server started…",
    stagePullingImage: "Getting ready…",
    stageDownloadingData: "Downloading market data…",
    stageTraining: "Training the AI model…",
    stageUploading: "Uploading model…",
    stageDone: "Training complete",
    failed: "Failed",
    cancelled: "Stopped",
    remaining: (duration: string) => `About ${duration} left`,
    longRunningHint: "With automatically chosen coins, this can realistically take up to ~2 hours.",
    durationSeconds: (n: number) => `${n}s`,
    durationMinutes: (n: number) => `${n} min`,
    durationHoursMinutes: (h: number, m: number) => `${h}h ${m}min`,
  },
};
