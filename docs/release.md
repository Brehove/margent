# Release and Distribution

Margent releases are published from Git tags named `v<version>` or from the manual `Release` workflow dispatch.

## Required GitHub Secrets

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application certificate.
- `APPLE_CERTIFICATE_PASSWORD`: password for the certificate export.
- `APPLE_SIGNING_IDENTITY`: Developer ID Application identity name.
- `APPLE_ID`: Apple ID used for notarization.
- `APPLE_PASSWORD`: app-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer team ID.
- `TAURI_SIGNING_PRIVATE_KEY`: private updater signing key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: updater signing key password; leave unset when the key has no password.

The updater public key is committed in `src-tauri/tauri.conf.json`. The matching private key must stay only in GitHub secrets.

## Release Steps

1. Confirm CI is green on `main`.
2. Tag the release:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. The `Release` workflow builds the macOS app, signs and notarizes it with the Apple secrets, publishes GitHub Release assets, emits Tauri updater metadata as `latest.json`, and uploads the CLI archive. Public onboarding should still point users to the agent setup flow first.

4. On a clean macOS account, install the downloaded app and run:

   ```sh
   spctl --assess --type execute --verbose /Applications/Margent.app
   xcrun stapler validate /Applications/Margent.app
   ```

## CLI via Homebrew

Until the formula is copied to a dedicated `homebrew-margent` repository, this repo can be tapped directly:

```sh
brew tap Brehove/margent https://github.com/Brehove/margent
brew install margent
```

The formula builds the CLI from the repo source and installs the `margent` binary.
