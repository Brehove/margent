import { memo, useState } from "react";
import type { ProviderReadiness } from "../../types/providerReadiness";

interface ProviderSetupViewProps {
  errorMessage: string | null;
  isLoading: boolean;
  onOpenExternalUrl: (url: string) => void;
  onRefresh: () => void;
  providers: ProviderReadiness[];
}

export const ProviderSetupView = memo(function ProviderSetupView({
  errorMessage,
  isLoading,
  onOpenExternalUrl,
  onRefresh,
  providers,
}: ProviderSetupViewProps) {
  const [copiedProviderId, setCopiedProviderId] = useState<string | null>(null);
  const [copyErrorProviderId, setCopyErrorProviderId] = useState<string | null>(null);
  const readyCount = providers.filter((provider) => provider.ready).length;

  const copyCommand = async (provider: ProviderReadiness) => {
    const command = provider.ready
      ? provider.authCheckCommand
      : provider.status === "missing"
        ? provider.installCommand
        : provider.loginCommand;

    try {
      await navigator.clipboard.writeText(command);
      setCopyErrorProviderId(null);
      setCopiedProviderId(provider.id);
      window.setTimeout(() => setCopiedProviderId(null), 1600);
    } catch {
      setCopiedProviderId(null);
      setCopyErrorProviderId(provider.id);
      window.setTimeout(() => setCopyErrorProviderId(null), 2400);
    }
  };

  return (
    <section className="provider-setup-view" aria-labelledby="provider-setup-title">
      <header className="provider-setup-header">
        <div>
          <p className="eyebrow-lbl">Providers</p>
          <h2 id="provider-setup-title">Agent Setup</h2>
          <p>
            {readyCount
              ? `${readyCount} provider${readyCount === 1 ? "" : "s"} ready for Ask and Revise.`
              : "Set up Codex or Claude Code to enable Ask and Revise."}
          </p>
        </div>
        <button className="ghost-button" disabled={isLoading} onClick={onRefresh} type="button">
          {isLoading ? "Checking..." : "Refresh"}
        </button>
      </header>

      {errorMessage ? <div className="banner error-banner">{errorMessage}</div> : null}

      <div className="provider-status-list">
        {providers.map((provider) => {
          const command = provider.ready
            ? provider.authCheckCommand
            : provider.status === "missing"
              ? provider.installCommand
              : provider.loginCommand;
          const docsUrl = provider.status === "missing" ? provider.docsUrl : provider.authDocsUrl;
          const statusLabel = provider.ready
            ? "Ready"
            : provider.status === "missing"
              ? "Missing"
              : provider.status === "unauthenticated"
                ? "Not authenticated"
                : "Check failed";

          return (
            <article
              className={`provider-status-row status-${provider.status}`}
              key={provider.id}
            >
              <div className="provider-status-main">
                <div className="provider-status-title-row">
                  <h3>{provider.displayName}</h3>
                  <span className={`provider-status-pill status-${provider.status}`}>
                    {statusLabel}
                  </span>
                </div>
                <dl className="provider-status-facts">
                  <div>
                    <dt>Binary</dt>
                    <dd>{provider.binaryPath ?? provider.binaryName}</dd>
                  </div>
                  <div>
                    <dt>Auth</dt>
                    <dd>{provider.authenticated ? "Authenticated" : "Needs login"}</dd>
                  </div>
                </dl>
                {provider.nextStep ? (
                  <p className="provider-next-step">{provider.nextStep}</p>
                ) : (
                  <p className="provider-next-step">
                    Ready. Run <code>{provider.authCheckCommand}</code> to recheck.
                  </p>
                )}
                {provider.checkError ? (
                  <p className="provider-check-error">{provider.checkError}</p>
                ) : null}
                {copyErrorProviderId === provider.id ? (
                  <p className="provider-check-error">Copy failed. Select the command and copy it manually.</p>
                ) : null}
              </div>

              <div className="provider-status-actions">
                <code>{command}</code>
                <button className="ghost-button" onClick={() => void copyCommand(provider)} type="button">
                  {copiedProviderId === provider.id ? "Copied" : "Copy"}
                </button>
                <button className="ghost-button" onClick={() => onOpenExternalUrl(docsUrl)} type="button">
                  Docs
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
});
