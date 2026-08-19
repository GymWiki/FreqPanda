import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { botSelect, toBotDTO } from "@/lib/bot-select";
import {
  isSafePythonIdentifier,
  strategyCodeDefinesClass,
  isValidFreqAIConfig,
  MAX_STRATEGY_CODE_LENGTH,
} from "@/lib/strategy-validation";
import { withErrorHandling, parseJsonBody } from "@/lib/api-handler";
import { AUTO_PAIRLIST_SIZE_RANGE, AUTO_PAIRLIST_SIZE_DEFAULT } from "@/lib/training-timerange";

export const dynamic = "force-dynamic";

// freqaiConfig's exact shape is validated separately by isValidFreqAIConfig
// (see lib/strategy-validation.ts) — Zod only needs to confirm it's an
// object here, not re-encode every nested field as a second schema.
//
// No exchange choice here at all anymore — training and paper trading
// don't need one (see DATA_SOURCE_EXCHANGE in lib/hetzner.ts, a fixed
// public data source decoupled from any bot's own exchange). A bot's
// exchangeName (nullable — see prisma/schema.prisma) only gets set once
// the user connects a real account, via app/api/bots/[id]/exchange-connection,
// which is also where the exchange itself now gets chosen. A real,
// verified account is only ever required at the Go Live gate
// (app/api/bots/[id]/golive).
const createBotBodySchema = z.object({
  botName: z.string().trim().min(1, "botName is required"),
  strategy: z.string().min(1, "strategy is required"),
  strategyCode: z.string().min(1, "strategyCode is required"),
  // Defaults to "FREQAI" so this stays backward-compatible with any client
  // that hasn't been updated to send it yet — every bot before this field
  // existed was a FreqAI bot by definition (see StrategyType in
  // prisma/schema.prisma).
  strategyType: z.enum(["FREQAI", "RULE_BASED"]).default("FREQAI"),
  // Required for FREQAI, must be absent for RULE_BASED — enforced below,
  // once strategyType is known, rather than here (a rule-based bot has no
  // AI behavior to validate the shape of).
  freqaiConfig: z.record(z.string(), z.unknown()).optional(),
  autoSelectCoins: z.boolean().optional(),
  autoSelectPairCount: z
    .number()
    .int()
    .min(AUTO_PAIRLIST_SIZE_RANGE.min)
    .max(AUTO_PAIRLIST_SIZE_RANGE.max)
    .optional(),
  pairWhitelist: z.string().optional(),
});

export const GET = withErrorHandling(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bots = await prisma.botConfiguration.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: botSelect,
  });

  return NextResponse.json({ bots: bots.map(toBotDTO) });
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseJsonBody(req, createBotBodySchema);
  if ("error" in parsed) return parsed.error;
  const { botName, strategy, strategyCode, strategyType, freqaiConfig, autoSelectCoins, autoSelectPairCount, pairWhitelist } =
    parsed.data;

  // Defaults to on (matches BotConfiguration.autoSelectCoins @default(true))
  // — an explicit false is the only way to require a manual whitelist.
  const autoSelect = autoSelectCoins !== false;
  // pairWhitelist is only meaningful — and only required — in manual mode;
  // in auto mode it's ignored and stored as null (lib/hetzner.ts configures
  // VolumePairList instead, see FreqAIProfileConfig-adjacent pairlist logic).
  if (!autoSelect && (!pairWhitelist || pairWhitelist.trim().length === 0)) {
    return NextResponse.json(
      { error: "pairWhitelist is required when auto-select is off — pick at least one pair" },
      { status: 400 },
    );
  }

  // FREQAI: freqaiConfig is the training/feature/risk config for the chosen
  // AI behavior (see lib/strategy-presets.ts), not optional metadata —
  // lib/hetzner.ts trusts its shape when generating config.json.
  // RULE_BASED: there is no AI behavior to configure (see
  // lib/rule-based-presets.ts) — freqaiConfig must be absent, not just
  // unvalidated, so a bot's stored state can never silently mismatch its
  // own strategyType.
  if (strategyType === "FREQAI") {
    if (!isValidFreqAIConfig(freqaiConfig)) {
      return NextResponse.json({ error: "freqaiConfig is missing required fields" }, { status: 400 });
    }
  } else if (freqaiConfig !== undefined) {
    return NextResponse.json({ error: "freqaiConfig must not be set for a rule-based (non-FreqAI) bot" }, { status: 400 });
  }

  // `strategy` becomes both a Python class name and a filename
  // (user_data/strategies/<strategy>.py) once this bot is ever deployed or
  // trained — reject it here, at the earliest boundary, rather than let a
  // bad value surface later as a cryptic cloud-init failure.
  if (!isSafePythonIdentifier(strategy)) {
    return NextResponse.json(
      { error: "strategy must be a valid Python identifier (letters, digits, underscore; can't start with a digit)" },
      { status: 400 },
    );
  }
  if (strategyCode.length > MAX_STRATEGY_CODE_LENGTH) {
    return NextResponse.json(
      { error: `strategyCode must be a string under ${MAX_STRATEGY_CODE_LENGTH} characters` },
      { status: 400 },
    );
  }
  if (!strategyCodeDefinesClass(strategyCode, strategy)) {
    return NextResponse.json(
      { error: `strategyCode must define "class ${strategy}" — it doesn't seem to match the strategy name above` },
      { status: 400 },
    );
  }

  // "Try before you risk": every bot is created in paper trading, with no
  // budget at stake — totalBudget/maxStakePercentage stay null until the
  // user clears the Go Live flow (see app/api/bots/[id]/golive). There is
  // deliberately no way to pass those in, or to skip straight to live, at
  // creation time.
  const bot = await prisma.botConfiguration.create({
    data: {
      userId: user.id,
      botName,
      // Null until the user connects a real exchange account (see
      // app/api/bots/[id]/exchange-connection) — no exchange choice at
      // creation time anymore.
      strategy,
      strategyCode,
      strategyType,
      // Prisma.DbNull, NOT Prisma.JsonNull, for a rule-based bot — the two
      // are easy to confuse but write completely different things to a
      // jsonb column: JsonNull stores the JSON scalar `null` (the column is
      // NOT SQL NULL, just holds a null-valued JSON document), DbNull
      // stores actual SQL NULL. The bot_configurations_freqai_config_matches_type
      // check constraint requires real SQL NULL for a RULE_BASED bot (see
      // the migration that added strategyType) — JsonNull here made every
      // rule-based bot creation fail that constraint.
      freqaiConfig: strategyType === "FREQAI" ? (freqaiConfig as Prisma.InputJsonValue) : Prisma.DbNull,
      autoSelectCoins: autoSelect,
      autoSelectPairCount: autoSelectPairCount ?? AUTO_PAIRLIST_SIZE_DEFAULT,
      pairWhitelist: autoSelect ? null : pairWhitelist,
      isPaperTrading: true,
      deploymentStatus: "LOCAL",
    },
    select: botSelect,
  });

  return NextResponse.json({ bot: toBotDTO(bot) }, { status: 201 });
});
