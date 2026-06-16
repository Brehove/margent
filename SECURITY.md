# Security

Margent is a local-first Markdown review app. Markdown documents and `.mdreview/` sidecars stay on the user's machine unless the user stores or syncs that workspace elsewhere.

## Credential Model

Margent does not collect API keys. Codex and Claude authentication stay in the provider CLIs and the user's system credential store. The desktop app and CLI check provider readiness and launch provider subprocesses, but provider credentials should not be written into this repository, `.mdreview/` sidecars, or issue reports.

## Reporting Vulnerabilities

Please do not open a public issue for a vulnerability or a suspected credential leak. Contact the maintainer privately first. Include a concise reproduction, affected version or commit, and whether the issue involves the desktop app, CLI, `.mdreview` sidecars, provider execution, exports, or release artifacts.

## Sensitive Data

Do not attach real review workspaces, private documents, provider logs containing credentials, signing keys, notarization credentials, or local auth files to public issues. Synthetic fixtures are preferred.
