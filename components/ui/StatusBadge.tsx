import { cn } from "@/lib/utils";
import type { DeploymentStatus } from "@/lib/types";
import { useDictionary } from "@/components/I18nProvider";

const STYLES: Record<DeploymentStatus, string> = {
  LOCAL: "bg-slate-500/10 text-slate-300 border-slate-500/30",
  VPS_ACTIVE: "bg-primary/10 text-primary border-primary/30",
  INACTIVE: "bg-slate-700/30 text-slate-500 border-slate-600/30",
};

// A simple traffic-light dot ahead of the label: green = live and trading,
// amber = set up but not yet running anywhere, gray = nothing configured
// yet. Beginners can read the dot at a glance without parsing the enum text.
const DOT_STYLES: Record<DeploymentStatus, string> = {
  LOCAL: "bg-amber-400",
  VPS_ACTIVE: "bg-primary",
  INACTIVE: "bg-slate-500",
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const dict = useDictionary();
  const labels: Record<DeploymentStatus, string> = {
    LOCAL: dict.statusBadge.local,
    VPS_ACTIVE: dict.statusBadge.liveOnVps,
    INACTIVE: dict.statusBadge.inactive,
  };
  return (
    <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-medium", STYLES[status])}>
      <span className={cn("mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle", DOT_STYLES[status])} />
      {labels[status]}
    </span>
  );
}
