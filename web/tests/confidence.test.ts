import { describe, expect, it } from "vitest";
import {
  HIGH_MAX_MIN,
  MEDIUM_MAX_MIN,
  READING_FRESH_MAX_MIN,
  READING_RECENT_MAX_MIN,
  SUPPORT_HIGH_MIN,
  SUPPORT_MEDIUM_MIN,
  WEEKLY_OBSERVATIONS,
  confidenceFor,
} from "../src/confidence";

// A fixture that would read "high" by every rule at once proves nothing about
// which rule actually fired. Every case below leaves only one path open:
// support is held at 0 (or below SUPPORT_MEDIUM_MIN) whenever a reading-led
// row is under test, and the reading is pushed stale/far whenever a
// support-led row is under test.
const FAR_READING = { minutesFromReading: 10_000, readingAgeMin: 10_000 };

describe("confidenceFor", () => {
  it("has nothing to say without a forecast, even with a fresh reading and deep support", () => {
    expect(
      confidenceFor({ minutesFromReading: 5, readingAgeMin: 5, support: 200, updating: true, probability: null }),
    ).toBeNull();
  });

  it("has nothing to say for a lot that has stopped updating, even with a fresh reading and deep support", () => {
    expect(
      confidenceFor({ minutesFromReading: 5, readingAgeMin: 5, support: 200, updating: false, probability: 0.8 }),
    ).toBeNull();
  });

  it("has nothing to say for a non-finite probability -- NaN is not a value to grade, same as null", () => {
    expect(
      confidenceFor({ minutesFromReading: 5, readingAgeMin: 5, support: 200, updating: true, probability: NaN }),
    ).toBeNull();
  });

  describe("high, reason: reading -- arrival within 30 min of a reading <= 15 min old", () => {
    it("grades high at the boundary of both thresholds, with support at 0", () => {
      const result = confidenceFor({
        minutesFromReading: HIGH_MAX_MIN,
        readingAgeMin: READING_FRESH_MAX_MIN,
        support: 0,
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "high", reason: { kind: "reading", ageMin: READING_FRESH_MAX_MIN } });
    });

    it("drops out of high the moment the horizon crosses HIGH_MAX_MIN, even with a fresh reading", () => {
      // Falls through to the medium reading-led row instead (horizon still <= MEDIUM_MAX_MIN).
      const result = confidenceFor({
        minutesFromReading: HIGH_MAX_MIN + 1,
        readingAgeMin: READING_FRESH_MAX_MIN,
        support: 0,
        updating: true,
        probability: 0.5,
      });
      expect(result?.level).toBe("medium");
    });

    it("drops out of high the moment the reading itself is stale, even with a near horizon", () => {
      const result = confidenceFor({
        minutesFromReading: 5,
        readingAgeMin: READING_FRESH_MAX_MIN + 1,
        support: 0,
        updating: true,
        probability: 0.5,
      });
      expect(result?.level).toBe("medium");
    });
  });

  describe("high, reason: weeks -- support >= 24 (~4 weeks)", () => {
    it("grades high on support alone, with the reading pushed far away and stale", () => {
      const result = confidenceFor({
        ...FAR_READING,
        support: SUPPORT_HIGH_MIN,
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "high", reason: { kind: "weeks", weeks: 4 } });
    });

    it("drops out of high one observation below the support threshold", () => {
      const result = confidenceFor({
        ...FAR_READING,
        support: SUPPORT_HIGH_MIN - 1,
        updating: true,
        probability: 0.5,
      });
      expect(result?.level).toBe("medium");
    });

    /** The case the whole change exists for: distance alone no longer drowns out a month of evidence. */
    it("21:20 tomorrow, with four weeks of support behind that half-hour, reads high", () => {
      const now = Date.UTC(2026, 8, 17, 10, 0, 0) / 1000; // 2026-09-17 10:00 UTC
      const arrivalTomorrow2120 = Date.UTC(2026, 8, 18, 13, 20, 0) / 1000; // 2026-09-18 21:20 Taipei (UTC+8)
      const minutesFromReading = (arrivalTomorrow2120 - now) / 60;
      expect(minutesFromReading).toBeGreaterThan(MEDIUM_MAX_MIN); // it really is "far away" by the old rule
      const result = confidenceFor({
        minutesFromReading,
        readingAgeMin: 3, // the reading behind today's grid is fresh; it just isn't for this arrival
        support: 4 * WEEKLY_OBSERVATIONS,
        updating: true,
        probability: 0.6,
      });
      expect(result).toEqual({ level: "high", reason: { kind: "weeks", weeks: 4 } });
    });
  });

  describe("medium, reason: weeks -- support >= 6 (~1 week)", () => {
    it("grades medium on support alone at the boundary, reading far away and stale", () => {
      const result = confidenceFor({
        ...FAR_READING,
        support: SUPPORT_MEDIUM_MIN,
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "medium", reason: { kind: "weeks", weeks: 1 } });
    });

    it("drops to low one observation below the medium support threshold", () => {
      const result = confidenceFor({
        ...FAR_READING,
        support: SUPPORT_MEDIUM_MIN - 1,
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "low", reason: { kind: "thin" } });
    });
  });

  describe("medium, reason: reading -- arrival within 75 min of a reading <= 30 min old", () => {
    it("grades medium at the boundary of both thresholds, with support below the medium floor", () => {
      const result = confidenceFor({
        minutesFromReading: MEDIUM_MAX_MIN,
        readingAgeMin: READING_RECENT_MAX_MIN,
        support: SUPPORT_MEDIUM_MIN - 1,
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "medium", reason: { kind: "reading", ageMin: READING_RECENT_MAX_MIN } });
    });

    it("drops to low the moment the horizon crosses MEDIUM_MAX_MIN, with support still thin", () => {
      const result = confidenceFor({
        minutesFromReading: MEDIUM_MAX_MIN + 1,
        readingAgeMin: READING_RECENT_MAX_MIN,
        support: SUPPORT_MEDIUM_MIN - 1,
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "low", reason: { kind: "thin" } });
    });

    it("drops to low the moment the reading itself goes stale, with support still thin", () => {
      const result = confidenceFor({
        minutesFromReading: 40,
        readingAgeMin: READING_RECENT_MAX_MIN + 1,
        support: SUPPORT_MEDIUM_MIN - 1,
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "low", reason: { kind: "thin" } });
    });

    /** The other case the whole change exists for: closeness alone no longer manufactures a near-"high" grade for a lot with no history. */
    it("40 minutes from now, at a lot first seen yesterday, reads medium -- not high", () => {
      const result = confidenceFor({
        minutesFromReading: 40,
        readingAgeMin: 2, // the current reading is fresh
        support: 0, // but this lot was only first seen yesterday: no accumulated history at this hour yet
        updating: true,
        probability: 0.5,
      });
      expect(result).toEqual({ level: "medium", reason: { kind: "reading", ageMin: 2 } });
    });
  });

  describe("low, reason: thin -- otherwise", () => {
    it("grades low when neither a usable reading nor a week of support back the cell", () => {
      const result = confidenceFor({
        minutesFromReading: 200,
        readingAgeMin: 100,
        support: 3,
        updating: true,
        probability: 0.4,
      });
      expect(result).toEqual({ level: "low", reason: { kind: "thin" } });
    });

    it("grades low even for a lot never observed at all (support 0, no reading)", () => {
      const result = confidenceFor({
        ...FAR_READING,
        support: 0,
        updating: true,
        probability: 0.4,
      });
      expect(result).toEqual({ level: "low", reason: { kind: "thin" } });
    });
  });

  describe("weeks arithmetic", () => {
    it("is always Math.floor(support / WEEKLY_OBSERVATIONS) when reason.kind is 'weeks'", () => {
      for (const support of [SUPPORT_MEDIUM_MIN, 10, 23, SUPPORT_HIGH_MIN, 30, 35, 255]) {
        const result = confidenceFor({ ...FAR_READING, support, updating: true, probability: 0.5 });
        expect(result?.reason).toEqual({ kind: "weeks", weeks: Math.floor(support / WEEKLY_OBSERVATIONS) });
      }
    });
  });

  // Both `high` rows, and both `medium` rows, can be true at once (see the
  // module docstring's "reading wins at high, weeks wins at medium"
  // paragraph). The `level` alone can't tell them apart -- these fixtures
  // set up a genuine collision and assert the full `{ level, reason }`, so
  // swapping either pair of branches changes the *reason* even though the
  // level stays the same, and the test catches it.
  describe("collisions -- both rows of a tier are true at once", () => {
    it("high: a fresh, near reading AND deep support both qualify -- the reading wins", () => {
      // The module docstring's own example: a five-minute-old reading, ten
      // minutes out, at a lot with five weeks of support.
      const result = confidenceFor({
        minutesFromReading: 10,
        readingAgeMin: 5,
        support: 30, // Math.floor(30 / 6) = 5 weeks -- also clears SUPPORT_HIGH_MIN (24) on its own
        updating: true,
        probability: 0.7,
      });
      expect(result).toEqual({ level: "high", reason: { kind: "reading", ageMin: 5 } });
    });

    it("medium: a usable reading AND a week of support both qualify -- the weeks win", () => {
      // minutesFromReading is past HIGH_MAX_MIN (30) so the high/reading row
      // cannot also fire and mask which medium row won.
      const result = confidenceFor({
        minutesFromReading: 50,
        readingAgeMin: 20,
        support: 10, // Math.floor(10 / 6) = 1 week -- also clears SUPPORT_MEDIUM_MIN (6) on its own
        updating: true,
        probability: 0.7,
      });
      expect(result).toEqual({ level: "medium", reason: { kind: "weeks", weeks: 1 } });
    });
  });

  // WEEKLY_OBSERVATIONS, SUPPORT_HIGH_MIN, SUPPORT_MEDIUM_MIN and HIGH_MAX_MIN
  // are already anchored by literal values elsewhere (the two headline
  // tests, and "drops out of high the moment the horizon crosses
  // HIGH_MAX_MIN"). These three close the remaining gap: each uses literal
  // minute counts rather than the constant symbol, so a change to the
  // constant's *value* -- not just which branch reads it -- flips the
  // expected outcome.
  describe("threshold values are pinned, not just the symbols", () => {
    it("a 20-minute-old reading, 10 minutes out, is medium -- READING_FRESH_MAX_MIN (15) is not 20 or more", () => {
      const result = confidenceFor({ minutesFromReading: 10, readingAgeMin: 20, support: 0, updating: true, probability: 0.5 });
      expect(result).toEqual({ level: "medium", reason: { kind: "reading", ageMin: 20 } });
    });

    it("a 45-minute-old reading, 50 minutes out, is low -- READING_RECENT_MAX_MIN (30) is not 45 or more", () => {
      const result = confidenceFor({ minutesFromReading: 50, readingAgeMin: 45, support: 0, updating: true, probability: 0.5 });
      expect(result).toEqual({ level: "low", reason: { kind: "thin" } });
    });

    it("a fresh reading 90 minutes out is low, not medium -- MEDIUM_MAX_MIN (75) is not 90 or more", () => {
      const result = confidenceFor({ minutesFromReading: 90, readingAgeMin: 5, support: 0, updating: true, probability: 0.5 });
      expect(result).toEqual({ level: "low", reason: { kind: "thin" } });
    });
  });
});
