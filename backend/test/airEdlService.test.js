const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mergeRanges,
  segmentSpan,
  survivingPieces,
  overlayCoveredRanges,
  totalCutSeconds,
} = require("../services/airEdlService");

/**
 * Characterization tests for the pure half of services/airEdlService.js.
 *
 * This is the arithmetic that decides what physically goes to air: which segments survive a cut,
 * where an overlay hides the live underneath it, and how much of the broadcast delay has been
 * spent. An off-by-one here is not a failing request, it is a frame of the wrong material
 * transmitted — so these pin the current behaviour exactly, quirks included, to be the contract a
 * port has to satisfy.
 *
 * MIN_TRIM_SECONDS (0.2s) is not exported; the 200ms threshold is written literally below and
 * labelled wherever it matters.
 */

const range = (startMs, endMs) => ({ startMs, endMs });

test("mergeRanges", async (t) => {
  await t.test("leaves disjoint ranges alone, in ascending order", () => {
    assert.deepEqual(
      mergeRanges([range(300, 400), range(0, 100)]),
      [range(0, 100), range(300, 400)],
    );
  });

  await t.test("collapses overlapping ranges", () => {
    assert.deepEqual(mergeRanges([range(0, 100), range(50, 150)]), [range(0, 150)]);
    assert.deepEqual(mergeRanges([range(0, 200), range(50, 100)]), [range(0, 200)]);
  });

  await t.test("merges ranges that merely touch", () => {
    // `<=` not `<`: [0,100) and [100,200) become one span. A port using strict `<` would leave two
    // adjacent cuts, which changes how many trimmed substitutes get re-encoded.
    assert.deepEqual(mergeRanges([range(0, 100), range(100, 200)]), [range(0, 200)]);
  });

  await t.test("chains a merge across three ranges", () => {
    assert.deepEqual(
      mergeRanges([range(0, 100), range(90, 200), range(180, 300)]),
      [range(0, 300)],
    );
  });

  await t.test("does not mutate the input array or its objects", () => {
    // It sorts a copy. Callers pass edl.cuts straight in and then keep using it.
    const cuts = [range(300, 400), range(0, 100)];
    const snapshot = JSON.parse(JSON.stringify(cuts));
    mergeRanges(cuts);
    assert.deepEqual(cuts, snapshot);
  });

  await t.test("QUIRK: returns bare {startMs,endMs} and drops every other field", () => {
    // Cuts carry id and createdAt. mergeRanges strips them, so its output cannot be written back
    // to the EDL as-is — addCut rebuilds the ids afterwards for exactly this reason.
    const merged = mergeRanges([{ id: "cut-1", createdAt: "x", startMs: 0, endMs: 100 }]);
    assert.deepEqual(merged, [range(0, 100)]);
    assert.equal(merged[0].id, undefined);
  });

  await t.test("handles an empty list", () => {
    assert.deepEqual(mergeRanges([]), []);
  });
});

test("segmentSpan", async (t) => {
  const T0 = 1_000_000;

  await t.test("places a segment by index off the recording start", () => {
    assert.deepEqual(segmentSpan(0, T0, 4), { startMs: T0, endMs: T0 + 4000 });
    assert.deepEqual(segmentSpan(1, T0, 4), { startMs: T0 + 4000, endMs: T0 + 8000 });
    assert.deepEqual(segmentSpan(10, T0, 4), { startMs: T0 + 40000, endMs: T0 + 44000 });
  });

  await t.test("spans are exactly contiguous — no gap, no overlap", () => {
    // The whole point of index arithmetic over file mtime. If a port introduces rounding here,
    // cuts land a few ms off and every trim boundary drifts.
    for (let index = 0; index < 50; index += 1) {
      assert.equal(segmentSpan(index, T0, 4).endMs, segmentSpan(index + 1, T0, 4).startMs);
    }
  });

  await t.test("honours a non-4s segment length", () => {
    assert.deepEqual(segmentSpan(2, T0, 120), { startMs: T0 + 240000, endMs: T0 + 360000 });
  });
});

test("survivingPieces", async (t) => {
  const span = range(0, 4000);

  await t.test("returns the whole span when no cut touches it", () => {
    assert.deepEqual(survivingPieces(span, []), [range(0, 4000)]);
    assert.deepEqual(survivingPieces(span, [range(5000, 6000)]), [range(0, 4000)]);
  });

  await t.test("returns nothing when a cut covers the span entirely", () => {
    assert.deepEqual(survivingPieces(span, [range(0, 4000)]), []);
    assert.deepEqual(survivingPieces(span, [range(-1000, 9000)]), []);
  });

  await t.test("keeps the head when a cut takes the tail", () => {
    assert.deepEqual(survivingPieces(span, [range(3000, 9000)]), [range(0, 3000)]);
  });

  await t.test("keeps the tail when a cut takes the head", () => {
    assert.deepEqual(survivingPieces(span, [range(-1000, 1000)]), [range(1000, 4000)]);
  });

  await t.test("splits into two pieces when a cut lands in the middle", () => {
    assert.deepEqual(
      survivingPieces(span, [range(1000, 2000)]),
      [range(0, 1000), range(2000, 4000)],
    );
  });

  await t.test("applies several cuts cumulatively", () => {
    assert.deepEqual(
      survivingPieces(span, [range(500, 1000), range(2000, 2500)]),
      [range(0, 500), range(1000, 2000), range(2500, 4000)],
    );
  });

  await t.test("a cut abutting the boundary is not an overlap", () => {
    // `cut.endMs <= piece.startMs` and `cut.startMs >= piece.endMs` both pass through untouched.
    assert.deepEqual(survivingPieces(span, [range(-1000, 0)]), [range(0, 4000)]);
    assert.deepEqual(survivingPieces(span, [range(4000, 5000)]), [range(0, 4000)]);
  });

  await t.test("drops surviving slivers shorter than the 200ms trim floor", () => {
    // A cut landing 100ms from the edge leaves a sliver not worth an ffmpeg run — it would show
    // as a single-frame flash. The sliver is discarded, so the piece simply disappears.
    assert.deepEqual(survivingPieces(span, [range(100, 4000)]), []);
    assert.deepEqual(survivingPieces(span, [range(0, 3900)]), []);
  });

  await t.test("keeps a piece sitting exactly on the 200ms floor", () => {
    // `>=`, so exactly 200ms survives. One millisecond less does not.
    assert.deepEqual(survivingPieces(span, [range(200, 4000)]), [range(0, 200)]);
    assert.deepEqual(survivingPieces(span, [range(199, 4000)]), []);
  });

  await t.test("QUIRK: assumes its cuts are already merged", () => {
    // Callers pass mergeRanges() output. Handing it raw overlapping cuts still works here, but the
    // guarantee is not stated in the function — a port must keep merging at the call site.
    assert.deepEqual(
      survivingPieces(span, [range(1000, 2000), range(1500, 2500)]),
      [range(0, 1000), range(2500, 4000)],
    );
  });
});

test("overlayCoveredRanges", async (t) => {
  await t.test("covers exactly the clip's booked duration", () => {
    const edl = { cuts: [], inserts: [{ mode: "overlay", atMs: 1000, durationMs: 9000 }] };
    assert.deepEqual(overlayCoveredRanges(edl), [range(1000, 10000)]);
  });

  await t.test("ignores insert-mode clips entirely", () => {
    // An insert stops the live and hands back, so nothing underneath is hidden. This distinction
    // is the entire difference between the two modes at the playlist level.
    const edl = {
      cuts: [],
      inserts: [
        { mode: "insert", atMs: 1000, durationMs: 9000 },
        { mode: "overlay", atMs: 50000, durationMs: 5000 },
      ],
    };
    assert.deepEqual(overlayCoveredRanges(edl), [range(50000, 55000)]);
  });

  await t.test("returns nothing when there are no inserts", () => {
    assert.deepEqual(overlayCoveredRanges({ cuts: [], inserts: [] }), []);
  });
});

test("totalCutSeconds", async (t) => {
  await t.test("sums cut durations in seconds", () => {
    assert.equal(totalCutSeconds({ cuts: [range(0, 1000)] }), 1);
    assert.equal(totalCutSeconds({ cuts: [range(0, 1000), range(5000, 6500)] }), 2.5);
  });

  await t.test("counts overlapping cuts once", () => {
    // The reason totalCutSeconds merges first: double-counting would over-report the delay spent
    // and let the runway guard refuse cuts that are actually affordable.
    assert.equal(totalCutSeconds({ cuts: [range(0, 1000), range(500, 1500)] }), 1.5);
  });

  await t.test("is zero for an empty EDL", () => {
    assert.equal(totalCutSeconds({ cuts: [] }), 0);
  });
});
