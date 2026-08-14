"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { EXCHANGE_PRESETS, type ExchangePreset } from "@/lib/exchange-presets";
import { useDictionary } from "@/components/I18nProvider";

interface ExchangeComboboxProps {
  value: string;
  onChange: (value: string) => void;
  "aria-label"?: string;
}

// A monogram badge stands in for a real exchange logo asset — same visual
// slot a <img src={logoUrl}> would occupy, swappable later without
// touching layout, without hotlinking third-party brand assets from here.
function ExchangeLogo({ exchange, className }: { exchange: ExchangePreset; className?: string }) {
  return (
    <span
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
        exchange.color,
        className,
      )}
      aria-hidden="true"
    >
      {exchange.monogram}
    </span>
  );
}

// A searchable exchange picker: Radix Select's built-in typeahead only
// jumps to the next match on keypress, it can't actually filter the list,
// so a real "type to narrow" combobox needs Popover + a live-filtered
// listbox built by hand instead. Follows the WAI-ARIA combobox pattern
// (input owns aria-expanded/aria-activedescendant, the list is a listbox
// of role="option" items) so arrow keys/Enter/Escape all work as expected.
export function ExchangeCombobox({ value, onChange, ...aria }: ExchangeComboboxProps) {
  const dict = useDictionary();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const optionId = (id: string) => `${listboxId}-${id}`;

  const selected = EXCHANGE_PRESETS.find((e) => e.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EXCHANGE_PRESETS;
    return EXCHANGE_PRESETS.filter(
      (e) => e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q),
    );
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(Math.max(0, EXCHANGE_PRESETS.findIndex((e) => e.id === value)));
      // Popover content mounts after this effect fires — wait a tick so the input actually exists to focus.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function selectExchange(exchange: ExchangePreset) {
    onChange(exchange.id);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const exchange = filtered[activeIndex];
      if (exchange) selectExchange(exchange);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={aria["aria-label"]}
          className="input flex items-center justify-between gap-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <>
                <ExchangeLogo exchange={selected} />
                <span className="truncate">{selected.label}</span>
              </>
            ) : (
              <span className="text-slate-500">{dict.exchangeCombobox.placeholder}</span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-[60] w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={filtered[activeIndex] ? optionId(filtered[activeIndex].id) : undefined}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={dict.exchangeCombobox.searchPlaceholder}
              className="w-full bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-500"
            />
          </div>

          <ul id={listboxId} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <li className="px-2.5 py-3 text-center text-xs text-slate-500">{dict.exchangeCombobox.empty}</li>
            )}
            {filtered.map((exchange, i) => {
              const checked = exchange.id === value;
              const active = i === activeIndex;
              return (
                <li
                  key={exchange.id}
                  id={optionId(exchange.id)}
                  role="option"
                  aria-selected={checked}
                >
                  <button
                    type="button"
                    onClick={() => selectExchange(exchange)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-slate-200 outline-none transition",
                      active && "bg-primary/10 text-primary",
                      checked && !active && "text-primary",
                    )}
                  >
                    <ExchangeLogo exchange={exchange} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{exchange.label}</span>
                      <span className="block truncate text-xs text-slate-500">{exchange.description}</span>
                    </span>
                    {checked && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
