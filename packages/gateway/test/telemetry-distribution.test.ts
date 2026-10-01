import { describe, expect, it } from "vitest";
import {
  distribution,
  distributionWeight,
  addObservation,
  mergeDistribution,
  compactDistribution,
  encodeDistribution,
  decodeDistribution,
  percentile,
  relativeError,
} from "../../../scripts/telemetry-distribution.mjs";

describe("elapsed weighted percentile distributions", () => {
  it("selects weighted ranks, preserves zero, and does not compute percentiles of averages", () => {
    const data = distribution();
    for (const [value, duration] of [
      [0, 50000],
      [1, 45000],
      [8, 4000],
      [16, 1000],
    ]) {
      addObservation(data, value, duration);
    }
    expect(distributionWeight(data)).toBe(100000);
    expect(percentile(data, 0.5, 16)).toBe(0);
    expect(percentile(data, 0.95, 16)).toBe(1);
    expect(percentile(data, 0.99, 16)).toBe(8);
    expect(decodeDistribution(encodeDistribution(data), 100000)).toEqual(data);
  });

  it("merges distributions and partial interval weights consistently", () => {
    const a = distribution();
    const b = distribution();
    addObservation(a, 1, 9000);
    addObservation(b, 8, 1000);
    const merged = distribution();
    mergeDistribution(merged, a, 0.5);
    mergeDistribution(merged, b, 0.5);
    expect(distributionWeight(merged)).toBe(5000);
    expect(percentile(merged, 0.5, 8)).toBe(1);
    expect(percentile(merged, 0.95, 8)).toBe(8);
  });

  it("bounds occupied bins without discarding weights and exposes the coarsening error", () => {
    const data = distribution();
    const observations = Array.from(
      { length: 720 },
      (_, i) => 2 ** (-20 + (i * 55) / 719),
    );
    for (const value of observations) addObservation(data, value, 5000, 256);
    expect(data.bins.size).toBeLessThanOrEqual(256);
    expect(distributionWeight(data)).toBe(3600000);
    const estimate = percentile(data, 0.99, observations.at(-1));
    const exact = observations[Math.ceil(observations.length * 0.99) - 1];
    expect(estimate).toBeGreaterThanOrEqual(exact);
    expect(estimate).toBeLessThanOrEqual(exact * (1 + relativeError(data)!));
    expect(relativeError(data)).toBeLessThan(0.5);
    const originalWeight = distributionWeight(data);
    compactDistribution(data, 24);
    expect(data.bins.size).toBeLessThanOrEqual(24);
    expect(distributionWeight(data)).toBe(originalWeight);
    expect(decodeDistribution(encodeDistribution(data), 3600000)).toEqual(data);
  });

  it("rejects malformed, oversized, truncated or overweight distribution payloads", () => {
    const valid = distribution();
    addObservation(valid, 2, 5000);
    const encoded = encodeDistribution(valid);
    for (const value of [
      null,
      [2, 0, "AA=="],
      [1, -1, "AA=="],
      [1, 0, "A".repeat(4097)],
      [1, 0, "gA=="],
      [1, 0, "AA==\n"],
      [1, 0, ""],
      [1, 0, encoded[2].slice(0, -4)],
    ]) {
      expect(decodeDistribution(value, 5000)).toBeNull();
    }
    expect(decodeDistribution(encoded, 4999)).toBeNull();
    expect(decodeDistribution(encoded, 5000)).not.toBeNull();
    expect(percentile(distribution(), 0.99, 0)).toBeNull();
  });
});
