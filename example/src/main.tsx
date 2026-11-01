import { Component, StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App.jsx";
import "./index.css";

const address = import.meta.env.VITE_CONVEX_URL;
let client: ConvexReactClient | undefined;
let configurationError: string | undefined;
if (address) {
  try {
    client = new ConvexReactClient(address);
  } catch (caught) {
    configurationError =
      caught instanceof Error ? caught.message : String(caught);
  }
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main>
          <h1>The demo needs attention.</h1>
          <p className="error" role="alert">
            {this.state.error.message}
          </p>
          <p>
            Check the Convex terminal, Azure configuration, and Blob service
            CORS rule. Reloading clears unfinished upload sessions.
          </p>
          <button
            type="button"
            className="button"
            onClick={() => location.reload()}
          >
            Reload the demo
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {client ? (
      <AppErrorBoundary>
        <ConvexProvider client={client}>
          <App />
        </ConvexProvider>
      </AppErrorBoundary>
    ) : (
      <main>
        <h1>Connect your Convex backend.</h1>
        <p className="error" role="alert">
          {configurationError ??
            "VITE_CONVEX_URL is missing. Run npm run dev, configure your frontend URL, then restart npm run dev:frontend."}
        </p>
      </main>
    )}
  </StrictMode>,
);
