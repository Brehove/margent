# Editor Perf Baseline

Date: 2026-06-11
Commit: `02c8555`
Command: `npm run perf:report`

Environment:

- Node: `v20.18.0`
- npm: `10.8.2`
- Rust: `rustc 1.94.0 (4a4ef493e 2026-03-02)`
- Cargo: `cargo 1.94.0 (85eff7c80 2026-01-15)`

Corpus:

- `largePlainChars`: `59598`
- `manyThreadChars`: `19798`
- `manyThreadThreads`: `180`
- `footnoteChars`: `28361`
- `footnoteThreads`: `240`

Baseline timings:

| Label | Iterations/sample | Median ms | P95 ms |
| --- | ---: | ---: | ---: |
| `doc.toString large plain` | 75 | 0.006 | 0.020 |
| `buildThreadPresentation many-thread` | 12 | 0.054 | 0.156 |
| `buildThreadPresentation footnote-heavy` | 12 | 0.069 | 0.087 |
| `mapThreadPresentation cumulative edits` | 40 | 0.259 | 0.268 |
| `resolveThreadAnchors footnote-heavy` | 12 | 0.027 | 0.029 |
| `buildReadableMarkdownDecorations large plain` | 24 | 0.073 | 0.112 |
| `buildReadableMarkdownDecorations many-thread` | 24 | 0.027 | 0.031 |
| `buildReadableMarkdownDecorations footnote-heavy` | 24 | 0.032 | 0.058 |
| `buildRenderedMarkdownDecorations large plain` | 24 | 5.136 | 5.929 |
| `buildRenderedMarkdownDecorations many-thread` | 24 | 1.928 | 2.272 |
| `buildRenderedMarkdownDecorations footnote-heavy` | 24 | 3.431 | 3.614 |

Gate:

- Treat these medians as the post-UI-pass local baseline.
- Later milestone gates should investigate any median above `1.25x` this file's corresponding value, with a rerun before declaring a regression.

## Addendum — 2026-06-11 (memoization + honest benchmark)

The image/table rendered-mode work initially regressed `buildRenderedMarkdownDecorations` to ~1.8× baseline. Fixed by memoizing per immutable `EditorState`: `collectMarkdownTableRanges`, `getRevealRangesForState`, and `collectRenderedSourceFallbackRanges` (WeakMap; `mergeRevealRanges` made copy-on-write so cached arrays are never mutated). The perf test now rebuilds a fresh state identity per iteration (empty transaction, shared parse tree) so it measures the uncached build, not WeakMap hits.

New post-memoization medians (same corpus, same machine class):

| Label | Median ms | P95 ms |
| --- | ---: | ---: |
| `buildRenderedMarkdownDecorations large plain` | 1.377 | 1.516 |
| `buildRenderedMarkdownDecorations many-thread` | 0.500 | 0.511 |
| `buildRenderedMarkdownDecorations footnote-heavy` | 0.936 | 1.090 |

Treat these as the current gate reference for the rendered path.
