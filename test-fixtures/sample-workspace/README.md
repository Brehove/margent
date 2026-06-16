# Sample Project

This is a sample workspace for testing Margent's review workflows.

## Overview

The quick brown fox jumps over the lazy dog. This sentence is used throughout the test suite as a reference anchor target.

## Features

Margent supports inline review comments attached to specific text passages. Comments persist across editing sessions and can be managed via the CLI or the desktop app.

### Thread Anchoring

Anchors track the original quoted text, surrounding context, heading path, and block fingerprint. When the document is edited, anchors are re-resolved using a multi-step cascade.

### External Editing

Files can be edited outside the app. Margent detects external changes via content hash polling and re-resolves all anchors against the new content.

## Conclusion

This document is intentionally simple to make test assertions predictable.
