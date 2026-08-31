const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatWallClockTimecode,
  millisecondsSinceMidnight,
  timeReferenceSamples,
  parseTimecodeToMilliseconds,
  timecodeDifferenceInFrames,
} = require("../services/timecodeFormat");

/**
 * Characterization tests for services/timecodeFormat.js.
 *
 * These describe what the code does *today*, quirks included, rather than what it arguably ought
 * to do. That is the point: they exist so a port to another language can be proved equivalent,
 * and an "obvious improvement" made during that port shows up here as a failure instead of on
 * air. Where a behaviour looks like a bug it is pinned anyway and labelled, so the decision to
 * change it is deliberate rather than accidental.
 *
 * Every Date is constructed with the local-time constructor. Every function in this module reads
 * local time (getHours, getMinutes, ...), so a test built on an ISO string or a UTC epoch would
 * pass or fail depending on the machine's timezone.
 */

// 1970-01-02 is deliberate: a day boundary away from the epoch, so an accidental UTC read shows up.
const at = (h, m, s, ms = 0) => new Date(1970, 0, 2, h, m, s, ms);

test("formatWallClockTimecode", async (t) => {
  await t.test("formats local time of day as HH:MM:SS:FF", () => {
    assert.equal(formatWallClockTimecode(at(10, 39, 42, 360), 25), "10:39:42:09");
    assert.equal(formatWallClockTimecode(at(0, 0, 0, 0), 25), "00:00:00:00");
    assert.equal(formatWallClockTimecode(at(23, 59, 59, 960), 25), "23:59:59:24");
  });

  await t.test("frames are floored, not rounded", () => {
    // 0.999 of a frame still reads as the frame below it.
    assert.equal(formatWallClockTimecode(at(0, 0, 0, 39), 25), "00:00:00:00");
    assert.equal(formatWallClockTimecode(at(0, 0, 0, 40), 25), "00:00:00:01");
    assert.equal(formatWallClockTimecode(at(0, 0, 0, 79), 25), "00:00:00:01");
  });

  await t.test("counts in whatever frame base it is given", () => {
    assert.equal(formatWallClockTimecode(at(1, 2, 3, 500), 25), "01:02:03:12");
    assert.equal(formatWallClockTimecode(at(1, 2, 3, 500), 50), "01:02:03:25");
    assert.equal(formatWallClockTimecode(at(1, 2, 3, 500), 1), "01:02:03:00");
  });

  await t.test("QUIRK: a fractional fps yields a fractional frame count, truncated by pad()", () => {
    // pad() applies Math.trunc, so this does not throw or produce a decimal — it silently floors.
    // Emerald runs at a whole 25, and the 29.97 default that used to be here is exactly the case
    // this pins. A port must not "fix" this into rounding.
    assert.equal(formatWallClockTimecode(at(0, 0, 0, 500), 29.97), "00:00:00:14");
  });
});

test("millisecondsSinceMidnight", async (t) => {
  await t.test("counts from local midnight", () => {
    assert.equal(millisecondsSinceMidnight(at(0, 0, 0, 0)), 0);
    assert.equal(millisecondsSinceMidnight(at(0, 0, 1, 0)), 1000);
    assert.equal(millisecondsSinceMidnight(at(1, 0, 0, 0)), 3600000);
    assert.equal(millisecondsSinceMidnight(at(23, 59, 59, 999)), 86399999);
  });

  await t.test("is the exact basis the BWF stamp and the timecode share", () => {
    // The module comment promises these two can never disagree about which instant "now" is.
    const date = at(12, 34, 56, 789);
    assert.equal(timeReferenceSamples(date, 48000), Math.round((millisecondsSinceMidnight(date) / 1000) * 48000));
  });
});

test("timeReferenceSamples", async (t) => {
  await t.test("converts to samples at 48k by default", () => {
    assert.equal(timeReferenceSamples(at(0, 0, 0, 0)), 0);
    assert.equal(timeReferenceSamples(at(0, 0, 1, 0)), 48000);
    assert.equal(timeReferenceSamples(at(1, 0, 0, 0)), 172800000);
  });

  await t.test("honours a non-default sample rate", () => {
    assert.equal(timeReferenceSamples(at(0, 0, 1, 0), 44100), 44100);
  });

  await t.test("rounds rather than floors", () => {
    // Contrast with formatWallClockTimecode, which floors. The asymmetry is real and must survive.
    assert.equal(timeReferenceSamples(at(0, 0, 0, 1), 48000), 48);
    assert.equal(timeReferenceSamples(at(0, 0, 0, 1), 1000), 1);
  });
});

test("parseTimecodeToMilliseconds", async (t) => {
  await t.test("is the inverse of formatWallClockTimecode on whole frames", () => {
    assert.equal(parseTimecodeToMilliseconds("00:00:00:00", 25), 0);
    assert.equal(parseTimecodeToMilliseconds("10:39:42:09", 25), 38382360);
    assert.equal(parseTimecodeToMilliseconds("01:00:00:00", 25), 3600000);
  });

  await t.test("frames contribute a fractional millisecond value", () => {
    // 1 frame at 25fps is exactly 40ms; at 30fps it is 33.333... and is NOT rounded.
    assert.equal(parseTimecodeToMilliseconds("00:00:00:01", 25), 40);
    assert.equal(parseTimecodeToMilliseconds("00:00:00:01", 30), 1000 / 30);
  });

  await t.test("trims surrounding whitespace", () => {
    assert.equal(parseTimecodeToMilliseconds("  10:00:00:00  ", 25), 36000000);
  });

  await t.test("requires exactly two digits in every field", () => {
    // A port using a laxer regex would accept these and silently shift every downstream position.
    assert.equal(parseTimecodeToMilliseconds("1:02:03:04", 25), null);
    assert.equal(parseTimecodeToMilliseconds("01:2:03:04", 25), null);
    assert.equal(parseTimecodeToMilliseconds("001:02:03:04", 25), null);
    assert.equal(parseTimecodeToMilliseconds("01:02:03", 25), null);
    assert.equal(parseTimecodeToMilliseconds("01:02:03:04:05", 25), null);
    assert.equal(parseTimecodeToMilliseconds("01;02;03;04", 25), null);
  });

  await t.test("rejects non-strings rather than coercing", () => {
    assert.equal(parseTimecodeToMilliseconds(null, 25), null);
    assert.equal(parseTimecodeToMilliseconds(undefined, 25), null);
    assert.equal(parseTimecodeToMilliseconds(0, 25), null);
    assert.equal(parseTimecodeToMilliseconds(new Date(), 25), null);
  });

  await t.test("rejects an unusable frame rate", () => {
    assert.equal(parseTimecodeToMilliseconds("00:00:00:00", 0), null);
    assert.equal(parseTimecodeToMilliseconds("00:00:00:00", -25), null);
    assert.equal(parseTimecodeToMilliseconds("00:00:00:00", NaN), null);
    assert.equal(parseTimecodeToMilliseconds("00:00:00:00", Infinity), null);
    assert.equal(parseTimecodeToMilliseconds("00:00:00:00", undefined), null);
  });

  await t.test("QUIRK: out-of-range fields are accepted, not validated", () => {
    // A frame number at or beyond the frame rate is not rejected — it simply overflows into the
    // next second. Same for hours past 23. Nothing upstream guards this, so a port that adds
    // validation here would start returning null where this returns a number, and callers treat
    // null as "no timecode known".
    assert.equal(parseTimecodeToMilliseconds("00:00:00:30", 25), 1200);
    assert.equal(parseTimecodeToMilliseconds("99:99:99:99", 25), 99 * 3600000 + 99 * 60000 + 99 * 1000 + 3960);
  });
});

test("timecodeDifferenceInFrames", async (t) => {
  await t.test("reports a signed distance in frames", () => {
    assert.equal(timecodeDifferenceInFrames("00:00:01:00", "00:00:00:00", 25), 25);
    assert.equal(timecodeDifferenceInFrames("00:00:00:00", "00:00:01:00", 25), -25);
    assert.equal(timecodeDifferenceInFrames("00:00:00:01", "00:00:00:00", 25), 1);
  });

  await t.test("wraps at midnight so a comparison across 00:00 stays small", () => {
    // This is the whole reason the function exists: without the wrap these read as ~24 hours.
    assert.equal(timecodeDifferenceInFrames("00:00:00:00", "23:59:59:24", 25), 1);
    assert.equal(timecodeDifferenceInFrames("23:59:59:24", "00:00:00:00", 25), -1);
  });

  await t.test("a genuine half-day gap is where the wrap flips sign", () => {
    // Exactly 12h is the boundary; the comparison is strictly greater-than, so 12h stays positive.
    assert.equal(timecodeDifferenceInFrames("12:00:00:00", "00:00:00:00", 25), 12 * 3600 * 25);
    // A hair past 12h reads as slightly less than 12h in the other direction.
    assert.ok(timecodeDifferenceInFrames("12:00:00:01", "00:00:00:00", 25) < 0);
  });

  await t.test("returns a float, not a whole number of frames", () => {
    // Callers compare against a frame threshold; a port returning an int would change that test.
    assert.equal(timecodeDifferenceInFrames("00:00:00:01", "00:00:00:00", 30), 1);
    assert.equal(typeof timecodeDifferenceInFrames("00:00:00:00", "00:00:00:00", 25), "number");
  });

  await t.test("propagates null when either side is unparseable", () => {
    assert.equal(timecodeDifferenceInFrames("bad", "00:00:00:00", 25), null);
    assert.equal(timecodeDifferenceInFrames("00:00:00:00", "bad", 25), null);
    assert.equal(timecodeDifferenceInFrames("00:00:00:00", "00:00:00:00", 0), null);
  });
});

test("round trip: format then parse recovers the same instant", async (t) => {
  await t.test("holds for every frame of a second at 25fps", () => {
    for (let frame = 0; frame < 25; frame += 1) {
      const date = at(13, 45, 30, frame * 40);
      const formatted = formatWallClockTimecode(date, 25);
      assert.equal(
        parseTimecodeToMilliseconds(formatted, 25),
        millisecondsSinceMidnight(date),
        `frame ${frame} did not round trip`,
      );
    }
  });
});
