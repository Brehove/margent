import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { resolveThreadAnchors } from "../src/lib/anchorResolution";
import {
  buildReadableMarkdownDecorations,
  buildRenderedMarkdownDecorations,
  buildThreadPresentation,
  mapThreadPresentation,
} from "../src/components/editor/useCodeMirror";
import {
  createFootnoteHeavyScenario,
  createLargePlainDocument,
  createManyThreadScenario,
} from "./perfFixtures";

interface PerfReportEntry {
  iterationsPerSample: number;
  label: string;
  medianMs: number;
  p95Ms: number;
}

describe("editor perf report", () => {
  it("prints repeatable hot-path timings", () => {
    const largePlain = createLargePlainDocument();
    const manyThread = createManyThreadScenario();
    const footnoteHeavy = createFootnoteHeavyScenario();

    const markdownExtensions = [markdown()];
    const largePlainState = EditorState.create({ doc: largePlain, extensions: markdownExtensions });
    const manyThreadState = EditorState.create({
      doc: manyThread.content,
      extensions: markdownExtensions,
    });
    const manyThreadPresentation = buildThreadPresentation(manyThread.threads, manyThreadState);
    const footnoteState = EditorState.create({
      doc: footnoteHeavy.content,
      extensions: markdownExtensions,
    });

    const editA = manyThreadState.update({
      changes: {
        from: 0,
        insert: "intro\n",
      },
    });
    const editB = editA.state.update({
      changes: {
        from: 6,
        insert: "more\n",
      },
    });
    const editC = editB.state.update({
      changes: {
        from: 0,
        to: 6,
        insert: "",
      },
    });
    const cumulativeChanges = [editA.changes, editB.changes, editC.changes];

    const reports: PerfReportEntry[] = [
      runMeasured("doc.toString large plain", 75, () => {
        largePlainState.doc.toString();
      }),
      runMeasured("buildThreadPresentation many-thread", 12, () => {
        buildThreadPresentation(manyThread.threads, manyThreadState);
      }),
      runMeasured("buildThreadPresentation footnote-heavy", 12, () => {
        buildThreadPresentation(footnoteHeavy.threads, footnoteState);
      }),
      runMeasured("mapThreadPresentation cumulative edits", 40, () => {
        let mapped = manyThreadPresentation;
        for (const change of cumulativeChanges) {
          mapped = mapThreadPresentation(mapped, change);
        }
        return mapped;
      }),
      runMeasured("resolveThreadAnchors footnote-heavy", 12, () => {
        resolveThreadAnchors(footnoteHeavy.threads, footnoteHeavy.content);
      }),
      runMeasured("buildReadableMarkdownDecorations large plain", 24, () => {
        buildReadableMarkdownDecorations(largePlainState, [
          {
            from: 0,
            to: largePlainState.doc.length,
          },
        ]);
      }),
      runMeasured("buildReadableMarkdownDecorations many-thread", 24, () => {
        buildReadableMarkdownDecorations(manyThreadState, [
          {
            from: 0,
            to: manyThreadState.doc.length,
          },
        ]);
      }),
      runMeasured("buildReadableMarkdownDecorations footnote-heavy", 24, () => {
        buildReadableMarkdownDecorations(footnoteState, [
          {
            from: 0,
            to: footnoteState.doc.length,
          },
        ]);
      }),
      // Rendered-mode collectors memoize per EditorState. Measure each
      // iteration against a fresh state identity (empty transaction keeps the
      // shared parse tree) so the benchmark reports the uncached build cost
      // instead of WeakMap hits.
      runMeasured("buildRenderedMarkdownDecorations large plain", 24, () => {
        const freshState = largePlainState.update({}).state;
        buildRenderedMarkdownDecorations(
          freshState,
          [
            {
              from: 0,
              to: freshState.doc.length,
            },
          ],
          "rendered",
        );
      }),
      runMeasured("buildRenderedMarkdownDecorations many-thread", 24, () => {
        const freshState = manyThreadState.update({}).state;
        buildRenderedMarkdownDecorations(
          freshState,
          [
            {
              from: 0,
              to: freshState.doc.length,
            },
          ],
          "rendered",
        );
      }),
      runMeasured("buildRenderedMarkdownDecorations footnote-heavy", 24, () => {
        const freshState = footnoteState.update({}).state;
        buildRenderedMarkdownDecorations(
          freshState,
          [
            {
              from: 0,
              to: freshState.doc.length,
            },
          ],
          "rendered",
        );
      }),
    ];

    console.log(
      "[perf-corpus]",
      JSON.stringify(
        {
          footnoteChars: footnoteHeavy.content.length,
          footnoteThreads: footnoteHeavy.threads.length,
          largePlainChars: largePlain.length,
          manyThreadChars: manyThread.content.length,
          manyThreadThreads: manyThread.threads.length,
        },
        null,
        2,
      ),
    );
    console.table(
      reports.map((entry) => ({
        iterationsPerSample: entry.iterationsPerSample,
        label: entry.label,
        medianMs: entry.medianMs.toFixed(3),
        p95Ms: entry.p95Ms.toFixed(3),
      })),
    );

    expect(reports).toHaveLength(11);
    for (const report of reports) {
      expect(Number.isFinite(report.medianMs)).toBe(true);
      expect(Number.isFinite(report.p95Ms)).toBe(true);
      expect(report.medianMs).toBeGreaterThanOrEqual(0);
      expect(report.p95Ms).toBeGreaterThanOrEqual(report.medianMs);
    }
  }, 30_000);
});

function runMeasured(
  label: string,
  iterationsPerSample: number,
  fn: () => unknown,
  sampleCount = 15,
): PerfReportEntry {
  for (let warmup = 0; warmup < 5; warmup += 1) {
    fn();
  }

  const samples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const start = performance.now();
    for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) {
      fn();
    }
    samples.push((performance.now() - start) / iterationsPerSample);
  }

  const ordered = [...samples].sort((left, right) => left - right);
  return {
    iterationsPerSample,
    label,
    medianMs: percentile(ordered, 0.5),
    p95Ms: percentile(ordered, 0.95),
  };
}

function percentile(samples: number[], fraction: number) {
  if (samples.length === 0) {
    return 0;
  }

  const index = Math.min(samples.length - 1, Math.max(0, Math.ceil(samples.length * fraction) - 1));
  return samples[index];
}
