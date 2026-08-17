// The Dutch dictionary — also the shape every other locale (see en.ts) is
// type-checked against (see dictionary.ts). New, beginner-friendly wording:
// see docs/superpowers/specs/2026-08-14-beginner-ui-and-i18n-design.md for
// the terminology table this replaces. Functions are used wherever a
// string needs a runtime value (a bot name, a number, an amount) —
// everything else is a plain string.
export const nl = {
  common: {
    save: "Opslaan",
    cancel: "Annuleren",
    close: "Sluiten",
    remove: "Verwijderen",
    genericError: "Er ging iets mis",
  },

  nav: {
    brand: "FreqPanda",
    settings: "Instellingen",
    myBots: "Mijn bots",
    toDashboard: "Naar mijn bots",
  },

  dashboard: {
    title: "Mijn bots",
    activeBots: (active: number, total: number) => `${active} van ${total} bots actief`,
  },

  botFleet: {
    empty: "Nog geen bots. Train een AI-model in de desktop-app en voeg 'm hier toe.",
  },

  statusBadge: {
    local: "Alleen lokaal",
    liveOnVps: "Actief in de cloud",
    inactive: "Niet actief",
  },

  lifecycleBadge: {
    notTrained: "Nog niet getraind",
    training: "Wordt getraind…",
    ready: "Klaar om te gebruiken",
    activePaper: "Actief — paper trading",
    activeLive: "Actief — live trading",
    pausedManual: "Gestopt",
    pausedEmergency: "Noodstop actief",
    sleeping: "Slaapstand",
    error: "Fout",
  },

  botCard: {
    resumeFailed: "Hervatten is mislukt",
    stopFailed: "Stoppen is mislukt",
    autoCompoundUpdateFailed: "Kon 'winst herinvesteren' niet wijzigen",
    uploadFailed: "Uploaden is mislukt",
    localTrainingFailed: "Trainen op je pc is mislukt",
    deployFailed: "Starten is mislukt",
    loadCredentialsFailed: "Kon inloggegevens niet ophalen",
    removeFailed: "Verwijderen is mislukt",
    disconnectFailed: "Loskoppelen is mislukt",

    confirmStop: (botName: string) =>
      `${botName} stoppen? Er worden geen nieuwe posities meer geopend — bestaande open posities blijven gewoon lopen. Je kan de bot daarna weer hervatten.`,
    confirmRemove: (botName: string) => `${botName} verwijderen? Dit kan niet ongedaan gemaakt worden.`,
    confirmDisconnectExchange: "Account loskoppelen van deze bot?",

    stopBot: "Bot stoppen",
    exchangeAccount: "Je account",
    exchangeAccountTooltip:
      "Het exchange-account waarmee deze bot uiteindelijk kan handelen. Alleen nodig zodra je overstapt op echt geld — oefenen werkt hier al zonder.",
    modeTooltip:
      "Oefenmodus: de bot handelt met nepgeld, puur om te testen. Echt geld: de bot handelt met jouw eigen budget op je gekoppelde exchange-account.",
    verified: "Geverifieerd",
    notVerified: "Nog niet geverifieerd",
    noExchangeLinked: "Nog niet gekoppeld — alleen nodig om met echt geld te handelen, oefenen kan zonder.",
    replaceAccount: "Vervangen",
    disconnectAccount: "Loskoppelen",
    connectAccount: "Koppel je account",

    autoCompound: "Winst automatisch herinvesteren",
    autoCompoundHint: "Herinvesteert winst automatisch in grotere posities — actief vanaf de volgende (her)start.",

    emergencyStopped: "Noodstop actief",
    sleeping: "In slaapstand — even geen activiteit",
    manuallyStopped: "Gestopt — bestaande posities blijven gewoon lopen",

    resume: "Bot hervatten",
    stoppedLabel: "Gestopt",
    practiceMode: "Oefenmodus",
    realMoney: "Echt geld",
    goLive: "Overstappen op echt geld",

    trainingLocally: "Wordt getraind op je pc…",
    startLocalTraining: "AI trainen op mijn pc",
    localTrainingNeedsApp: "Trainen vereist de desktop-app — download 'm op de website.",
    modelUploaded: "Model geüpload — vervang handmatig indien nodig",
    orUploadManually: "Of upload zelf een modelbestand (.joblib)",

    localConfig: "Instellingen downloaden",
    deployed: "Actief",
    deployToCloud: "Bot starten",
    deployNeedsModel: "Train eerst een AI-model voordat je de bot start.",
    showCredentials: "Toon inloggegevens",
    apiCredentialsHint: (ip: string) =>
      `Freqtrade API op ${ip}:8080 — bewaar dit nu, het wordt hierna niet meer volledig getoond.`,
    username: "Gebruikersnaam",
    password: "Wachtwoord",
    removeBot: "Bot verwijderen",
    copyLabel: (label: string) => `${label.toLowerCase()} kopiëren`,

    budgetLine: (total: number, maxPerTrade: number, maxPct: number) =>
      `Budget: €${total} · max €${maxPerTrade} per trade (${maxPct}%)`,
    noBudgetYet: "Oefenmodus — nog geen echt-geld-budget ingesteld",

    localConfigNote: "Vul je API-key/secret lokaal in — die worden nooit vanuit het dashboard geëxporteerd.",
  },

  newBot: {
    validationNeedsPairs: "Kies minstens 1 munt, of laat de AI automatisch munten kiezen.",
    createFailed: "Aanmaken is mislukt",
    trigger: "Nieuwe bot",
    heading: "Nieuwe AI-bot instellen",
    intro:
      "Elke bot handelt met een AI-model en start in oefenmodus — pas als jij dat zelf wilt, schakel je over naar echt geld.",
    botNameLabel: "Botnaam",
    botNamePlaceholder: "Mijn eerste bot",
    aiBehaviorLabel: "Hoe moet je bot handelen?",
    aiBehaviorTooltip:
      "Bepaalt hoe voorzichtig of actief de AI handelt: hoe vaak hij posities opent en hoeveel risico hij daarbij neemt. Kan later niet meer gewijzigd worden voor deze bot.",
    pairsLabel: "Welke munten mag hij verhandelen?",
    autoSelectLabel: "Laat de AI automatisch de beste munten kiezen",
    recommended: "(Aanbevolen)",
    autoSelectHint:
      "De bot kijkt voortdurend naar de meest verhandelde munten en laat de AI handelen waar de kansen het grootst zijn. Bij welke exchange dat precies is, kies je later, bij het koppelen van je account.",
    practiceModeNoticePrefix: "Deze bot start automatisch in ",
    practiceModeNoticeBold: "oefenmodus",
    practiceModeNoticeSuffix:
      " — geen budget nodig, geen echt geld op het spel. Zodra je tevreden bent met de resultaten, schakel je over op echt geld vanaf de bot-kaart.",
    submit: "Bot aanmaken (oefenmodus)",
  },

  strategyPicker: {
    ariaLabel: "Kies hoe je bot moet handelen",
    riskSuffix: " risico",
    timeframePrefix: "Kijkt elke: ",
  },

  budgetSlider: {
    placeholder: "500",
    maxPerTradeLabel: "Max. inzet per trade",
    maxPerTradeAriaLabel: "Max. inzet per trade als percentage van het budget",
    maxPerTradeHint: (amount: string) => `De bot zet maximaal €${amount} in per trade, en alleen als de AI zeker is.`,
  },

  pairCountSlider: {
    label: "Aantal paren (top volume)",
    ariaLabel: "Aantal paren dat automatisch geselecteerd wordt, op handelsvolume",
    adviceLow: "Minder paren = snellere training, minder spreiding.",
    adviceMedium: "Een gebalanceerde mix tussen trainingssnelheid en marktdekking.",
    adviceHigh: "Meer paren = bredere marktdekking, langere trainingstijd.",
    estimatedTimeLabel: (time: string) => `Geschatte trainingstijd: ${time}`,
    underAMinute: "< 1 min",
    minutesEstimate: (n: number) => `~${n} min`,
    hoursEstimate: (n: number) => `~${n} uur`,
  },

  exchangeCombobox: {
    placeholder: "Kies een exchange",
    searchPlaceholder: "Zoek een exchange…",
    empty: "Geen exchange gevonden.",
  },

  pairSelector: {
    removeAriaLabel: (symbol: string) => `${symbol} verwijderen`,
    availableAriaLabel: "Beschikbare munten",
  },

  settings: {
    title: "Instellingen",
    subtitle: "Geldt voor je hele account — elke bot die je (her)start.",
    languageLabel: "Taal",
    languageSaveFailed: "Taal wijzigen is mislukt",
  },

  telegram: {
    saveFailed: "Opslaan is mislukt",
    unlinkFailed: "Loskoppelen is mislukt",
    heading: "Telegram-meldingen",
    stepOneWithUsername: (botUsername: string) => `Open Telegram, zoek naar @${botUsername} en start het gesprek.`,
    stepOneFallback: "Start een gesprek met onze Telegram-bot (vraag de bot-naam na bij support als je die nog niet hebt).",
    stepTwoPrefix: "Stuur een bericht naar ",
    stepTwoLinkLabel: "@userinfobot",
    stepTwoSuffix: " om je numerieke Chat ID op te vragen.",
    stepThree: "Plak die hieronder — elke bot die je (her)start stuurt daar dan automatisch updates naartoe.",
    chatIdLabel: "Telegram Chat ID",
    chatIdPlaceholder: "bijv. 123456789",
    save: "Opslaan",
    unlink: "Telegram loskoppelen",
  },

  connectExchange: {
    connectFailed: "Koppelen is mislukt",
    heading: "Je account koppelen",
    subtitleWithExchange: (botName: string, exchangeLabel: string) => `Voor ${botName} op ${exchangeLabel}`,
    subtitleWithoutExchange: (botName: string) => `Voor ${botName} — kies eerst de exchange`,
    subtitleSuffix: " — alleen voor deze bot, niet gedeeld met je andere bots.",
    exchangeLabel: "Exchange",
    exchangeHint: "Bij welke exchange dit account hoort. Kan hierna niet meer gewijzigd worden voor deze bot.",
    apiKeyLabel: "API-key",
    apiKeyHint:
      "Te vinden in de instellingen van je exchange-account. Geef deze key alleen handelsrechten, nooit opnamerechten (withdraw).",
    secretPlaceholder: "••••••••••••",
    apiSecretLabel: "API-secret",
    apiSecretHint: "Het geheime deel bij je API-key. Wordt versleuteld bewaard en nooit meer getoond.",
    verifying: "Verifiëren…",
    submit: "Koppelen",
  },

  goLive: {
    loadBalanceFailed: "Kon saldo niet ophalen",
    goLiveFailed: "Overstappen op echt geld is mislukt",
    heading: "Overstappen op echt geld",
    subtitle: (botName: string) => `${botName} — vanaf nu met echt geld.`,
    balanceLabel: (exchangeLabel: string) => `Beschikbaar saldo op ${exchangeLabel}`,
    balanceTooLow: (exchangeLabel: string, minRequired: number) =>
      `Je saldo op ${exchangeLabel} is te laag. Stort minimaal $${minRequired} om met echt geld te handelen.`,
    totalBudgetLabel: "Totaal budget (USDT)",
    budgetTooHigh: (available: string) => `Budget kan niet hoger zijn dan je beschikbare saldo ($${available}).`,
    submit: "Overstappen op echt geld",
  },

  panic: {
    failed: "Noodstop is mislukt",
    trigger: "Noodstop",
    confirmHeading: "Noodstop activeren?",
    confirmBodyPrefix: "Dit sluit ",
    confirmBodyBold: "direct",
    confirmBodySuffix:
      " alle open posities op al je actieve bots tegen de huidige marktprijs en pauzeert ze allemaal. Dit kan niet ongedaan worden gemaakt.",
    confirmCancel: "Annuleren",
    confirmProceed: "Ja, stop alles",
    resultHeading: "Noodstop uitgevoerd",
    resultEmpty: "Geen actieve bots om te stoppen.",
    resultStopped: "Gestopt",
    resultPartial: "Gestopt — controleer handmatig",
  },

  pnl: {
    loadFailed: "Kon portfolio-waarde niet laden",
    heading: "Totale winst (al je bots)",
  },

  tradeHistory: {
    loadFailed: "Kon geschiedenis niet laden",
    heading: "Geschiedenis",
    show: "tonen",
    hide: "verbergen",
    empty: "Nog geen trades — de bot heeft nog geen positie gesloten.",
  },

  trainingProgress: {
    loadFailed: "Kon voortgang niet laden",
    stageQueued: "In de wachtrij…",
    stageBooted: "Server opgestart…",
    stagePullingImage: "Wordt voorbereid…",
    stageDownloadingData: "Marktdata downloaden…",
    stageTraining: "AI-model trainen…",
    stageUploading: "Model uploaden…",
    stageDone: "Training voltooid",
    failed: "Mislukt",
    cancelled: "Gestopt",
    remaining: (duration: string) => `Nog ongeveer ${duration}`,
    longRunningHint: "Bij automatisch gekozen munten kan dit realistisch tot ~2 uur duren.",
    durationSeconds: (n: number) => `${n}s`,
    durationMinutes: (n: number) => `${n} min`,
    durationHoursMinutes: (h: number, m: number) => `${h}u ${m}min`,
  },
};
