import { cn } from "@/lib/utils";
import type { BotLifecycleStatus } from "@/lib/bot-lifecycle";
import { useDictionary } from "@/components/I18nProvider";

const STYLES: Record<BotLifecycleStatus, string> = {
  NOT_TRAINED: "bg-slate-500/10 text-slate-300 border-slate-500/30",
  TRAINING: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  READY: "bg-primary/10 text-primary border-primary/30",
  ACTIVE_PAPER: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  ACTIVE_LIVE: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  PAUSED_MANUAL: "bg-slate-500/10 text-slate-300 border-slate-500/30",
  PAUSED_EMERGENCY: "bg-red-500/10 text-red-400 border-red-500/30",
  SLEEPING: "bg-violet-500/10 text-violet-400 border-violet-500/30",
  ERROR: "bg-red-500/10 text-red-400 border-red-500/30",
};

const DOT_STYLES: Record<BotLifecycleStatus, string> = {
  NOT_TRAINED: "bg-slate-500",
  TRAINING: "bg-amber-400 animate-pulse",
  READY: "bg-primary",
  ACTIVE_PAPER: "bg-sky-400",
  ACTIVE_LIVE: "bg-emerald-400",
  PAUSED_MANUAL: "bg-slate-500",
  PAUSED_EMERGENCY: "bg-red-400",
  SLEEPING: "bg-violet-400",
  ERROR: "bg-red-400",
};

// The "is this bot ready to use?" answer at a glance — see
// deriveLifecycleStatus in lib/bot-lifecycle.ts for what maps to what.
// Deliberately separate from StatusBadge (deploymentStatus only — LOCAL/
// VPS_ACTIVE/INACTIVE): that one answers "where does this bot run", this
// one answers "what is it actually doing right now", and collapsing them
// into one badge would lose the distinction that most confused the user
// this replaces — e.g. VPS_ACTIVE alone can't tell "just deployed and
// paper trading" apart from "manually stopped" or "mid-retrain".
export function LifecycleBadge({ status }: { status: BotLifecycleStatus }) {
  const dict = useDictionary();
  const labels: Record<BotLifecycleStatus, string> = {
    NOT_TRAINED: dict.lifecycleBadge.notTrained,
    TRAINING: dict.lifecycleBadge.training,
    READY: dict.lifecycleBadge.ready,
    ACTIVE_PAPER: dict.lifecycleBadge.activePaper,
    ACTIVE_LIVE: dict.lifecycleBadge.activeLive,
    PAUSED_MANUAL: dict.lifecycleBadge.pausedManual,
    PAUSED_EMERGENCY: dict.lifecycleBadge.pausedEmergency,
    SLEEPING: dict.lifecycleBadge.sleeping,
    ERROR: dict.lifecycleBadge.error,
  };
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium", STYLES[status])}>
      <span className={cn("mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle", DOT_STYLES[status])} />
      {labels[status]}
    </span>
  );
}
