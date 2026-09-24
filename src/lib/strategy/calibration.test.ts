import { describe, expect, it } from "vitest";

import { calculateCalibrationReport } from "./calibration";

describe("calculateCalibrationReport", () => {
  it("returns an empty report for no valid observations", () => {
    expect(calculateCalibrationReport([])).toMatchObject({
      n: 0,
      wins: 0,
      accuracy: null,
      brierScore: null,
    });
  });

  it("calculates accuracy and Brier score from resolved outcomes", () => {
    const report = calculateCalibrationReport([
      { predictedProbability: 0.5, outcome: 1 },
      { predictedProbability: 0.6, outcome: 0 },
      { predictedProbability: 0.55, outcome: 1 },
      { predictedProbability: 0.56, outcome: 1 },
    ]);

    expect(report.n).toBe(4);
    expect(report.wins).toBe(3);
    expect(report.accuracy).toBe(0.75);
    expect(report.meanPredictedProbability).toBeCloseTo(0.5525, 4);
    expect(report.meanObservedRate).toBe(0.75);
    expect(report.brierScore).toBeCloseTo(0.251525, 4);
  });

  it("groups observations into probability bins for a reliability check", () => {
    const report = calculateCalibrationReport([
      { predictedProbability: 0.5, outcome: 1 },
      { predictedProbability: 0.52, outcome: 0 },
      { predictedProbability: 0.57, outcome: 1 },
    ]);

    expect(report.bins).toHaveLength(2);
    expect(report.bins[0]).toMatchObject({
      lower: 0.5,
      n: 2,
      meanPredictedProbability: 0.51,
      observedRate: 0.5,
    });
    expect(report.bins[0].upper).toBeCloseTo(0.55);
    expect(report.bins[1]).toMatchObject({
      lower: 0.55,
      n: 1,
      meanPredictedProbability: 0.57,
      observedRate: 1,
    });
    expect(report.bins[1].upper).toBeCloseTo(0.6);
  });

  it("ignores invalid probability and outcome values", () => {
    const report = calculateCalibrationReport([
      { predictedProbability: 1.1, outcome: 1 },
      { predictedProbability: 0.55, outcome: 2 as 0 | 1 },
      { predictedProbability: 0.55, outcome: 1 },
    ]);

    expect(report.n).toBe(1);
    expect(report.wins).toBe(1);
  });
});
