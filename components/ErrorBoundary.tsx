"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// A render crash anywhere in `children` stops there instead of bubbling up
// to app/error.tsx and taking down the entire page — one broken bot card
// or chart no longer has to cost the rest of the dashboard. Wrap it around
// any widget that renders per-item (BotCard inside a list) or depends on
// data shaped by something outside this app's control (an exchange
// response, a freqtrade status payload).
//
// A class component on purpose: React only supports the error-boundary
// lifecycle methods (getDerivedStateFromError/componentDidCatch) on
// classes, there's no hook equivalent.
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ErrorBoundary] Caught a render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Dit onderdeel kon niet geladen worden. De rest van de pagina werkt gewoon door.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
