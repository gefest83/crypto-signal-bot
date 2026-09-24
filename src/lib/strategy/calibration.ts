/**
 * Pure calibration diagnostics for resolved signals.
 *
 * This module deliberately does not fit parameters or change the live gate.
 * It provides the measurements needed before a calibrated probability model
 * is introduced: Brier score, observed rate, and probability bins.
 */

export type CalibrationObservation = {
  /** Model probability in the [0, 1] range. */
  predictedProbability: number;
  /** 1 for a win, 0 for a loss/tie. */
  outcome: 0 | 1;
};

export type CalibrationBin = {
  lower: number;
  upper: number;
  n: number;
  meanPredictedProbability: number | null;
  observedRate: number | null;
};

export type CalibrationReport = {
  n: number;
  wins: number;
  accuracy: number | null;
  brierScore: number | null;
  meanPredictedProbability: number | null;
  meanObservedRate: number | null;
  bins: CalibrationBin[];
};

const BIN_WIDTH = 0.05;

function isValidObservation(observation: CalibrationObservation): boolean {
  return (
    Number.isFinite(observation.predictedProbability) &&
    observation.predictedProbability >= 0 &&
    observation.predictedProbability <= 1 &&
    (observation.outcome === 0 || observation.outcome === 1)
  );
}

/**
 * Calculate diagnostics from already-resolved observations.
 * Invalid rows are ignored so a partial migration of the journal cannot
 * corrupt the report.
 */
export function calculateCalibrationReport(
  observations: readonly CalibrationObservation[],
): CalibrationReport {
  const valid = observations.filter(isValidObservation);
  if (valid.length === 0) {
    return {
      n: 0,
      wins: 0,
      accuracy: null,
      brierScore: null,
      meanPredictedProbability: null,
      meanObservedRate: null,
      bins: [],
    };
  }

  const n = valid.length;
  const wins = valid.reduce((sum, observation) => sum + observation.outcome, 0);
  const meanPredictedProbability =
    valid.reduce((sum, observation) => sum + observation.predictedProbability, 0) / n;
  const meanObservedRate = wins / n;
  const brierScore =
    valid.reduce(
      (sum, observation) =>
        sum + (observation.predictedProbability - observation.outcome) ** 2,
      0,
    ) / n;

  const bins = new Map<number, CalibrationObservation[]>();
  for (const observation of valid) {
    const index = Math.min(
      Math.floor(observation.predictedProbability / BIN_WIDTH),
      Math.ceil(1 / BIN_WIDTH) - 1,
    );
    const bucket = bins.get(index) ?? [];
    bucket.push(observation);
    bins.set(index, bucket);
  }

  return {
    n,
    wins,
    accuracy: meanObservedRate,
    brierScore,
    meanPredictedProbability,
    meanObservedRate,
    bins: [...bins.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, bucket]) => ({
        lower: index * BIN_WIDTH,
        upper: Math.min(1, (index + 1) * BIN_WIDTH),
        n: bucket.length,
        meanPredictedProbability:
          bucket.reduce((sum, observation) => sum + observation.predictedProbability, 0) /
          bucket.length,
        observedRate:
          bucket.reduce((sum, observation) => sum + observation.outcome, 0) / bucket.length,
      })),
  };
}
