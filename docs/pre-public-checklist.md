# Pre-Public Checklist

Status: in progress for public-prep branch.
Date: 2026-06-15

This repository is not flipped public by this checklist. Visibility remains the maintainer's manual decision.

## Required Before Public Visibility

- GitHub secret scanning: verify enabled on the repository.
- GitHub push protection: verify enabled on the repository.
- Full git-history secret scan: run `gitleaks detect --source . --redact --exit-code 1`.
- CI: confirm the current branch is green after the final hygiene commit is pushed.
- Local validation: run the full Margent verification gate from `AGENTS.md` / `CONTRIBUTING.md`.
- Public hygiene: run `scripts/check-public-hygiene.sh` against the working tree.
- Current-tree review: confirm public docs, screenshots, and fixtures contain no private documents, provider credentials, or real review sidecars.

## Current Results

- GitHub secret scanning: unavailable for the current private repository via GitHub REST API (`PATCH repos/:owner/:repo` returned HTTP 422, `Secret scanning is not available for this repository.`). Re-check after any account/visibility change.
- GitHub push protection: unavailable for the current private repository through the same API path because secret scanning itself is unavailable.
- Full git-history secret scan: passed on 2026-06-15 with `gitleaks detect --source . --redact --no-banner --exit-code 7`; 74 commits scanned, no leaks found.
- CI: PR #1 `Verify Margent` passed on 2026-06-15 before the public-prep branch was created.
- Local validation: pending for the public-prep branch.

## Public-Prep Decision Record

- The public source tree should contain the app, CLI, schemas, tests, release wiring, public docs, and sanitized fixtures.
- Private operating memory belongs in ignored local files such as `AGENTS.local.md` and `docs/internal/`, or in a separate private repository.
- The app bundle identifier `com.joelgladd.margent` remains intentionally stable because changing it would disrupt installed-app identity, file associations, deep links, and macOS permissions.
- The existing git history has been scanned for secrets. It may still contain older non-secret local paths or development notes; rewriting history is not part of this branch.
