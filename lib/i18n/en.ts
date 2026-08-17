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
    localTrainingNeedsApp: "Training needs the desktop app — download it from the website.",
    modelUploaded: "Model uploaded — replace it manually if needed",
    orUploadManually: "Or upload a model file yourself (.joblib)",

    localConfig: "Download settings",
    deployed: "Live",
    deployToCloud: "Start bot",
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
    aiBehaviorLabel: "How should your bot trade?",
    aiBehaviorTooltip:
      "Determines how cautious or active the AI is: how often it opens positions and how much risk it takes doing so. Can't be changed for this bot after this.",
    pairsLabel: "Which coins can it trade?",
    autoSelectLabel: "Let the AI pick the best coins automatically",
    recommended: "(Recommended)",
    autoSelectHint: "The bot keeps an eye on the most-traded coins and lets the AI trade wherever the opportunity looks best. Which exchange exactly, you choose later, when linking your account.",
    practiceModeNoticePrefix: "This bot starts automatically in ",
    practiceModeNoticeBold: "practice mode",
    practiceModeNoticeSuffix: " — no budget needed, no real money at risk. Once you're happy with the results, switch to real money from the bot card.",
    submit: "Create bot (practice mode)",
  },

  strategyPicker: {
    ariaLabel: "Choose how your bot should trade",
    riskSuffix: " risk",
    timeframePrefix: "Checks every: ",
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

  tradeHistory: {
    loadFailed: "Couldn't load history",
    heading: "History",
    show: "show",
    hide: "hide",
    empty: "No trades yet — the bot hasn't closed a position yet.",
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
