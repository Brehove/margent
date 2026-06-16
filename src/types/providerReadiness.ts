export type ProviderReadinessStatus =
  | "ready"
  | "missing"
  | "unauthenticated"
  | "auth_check_failed";

export interface ProviderReadiness {
  id: "codex" | "claude";
  displayName: string;
  binaryName: string;
  envVar: string;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  status: ProviderReadinessStatus;
  binaryPath: string | null;
  docsUrl: string;
  authDocsUrl: string;
  installCommand: string;
  loginCommand: string;
  authCheckCommand: string;
  nextStep: string | null;
  checkError: string | null;
}
