import React from "react";
import { t } from "../i18n";

interface State {
  error: Error | null;
}

// Top-level boundary: render errors must show a visible message, never a silent black screen.
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("渲染错误:", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ margin: "auto", padding: 24, maxWidth: 560, lineHeight: 1.7 }}>
          <h2 style={{ marginBottom: 8 }}>{t("eb.title")}</h2>
          <div style={{ color: "var(--muted)", marginBottom: 16 }}>
            {this.state.error.message || String(this.state.error)}
          </div>
          <button className="primary" onClick={() => window.location.reload()}>
            {t("eb.reload")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
