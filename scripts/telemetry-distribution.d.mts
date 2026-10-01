export interface Distribution {
  scale: number;
  zero: number;
  bins: Map<number, number>;
}
export type EncodedDistribution = [number, number, string];
export function distribution(): Distribution;
export function distributionWeight(value: Distribution): number;
export function compactDistribution(value: Distribution, maxBins: number): void;
export function addObservation(
  target: Distribution,
  value: number,
  weight: number,
  maxBins?: number,
): void;
export function mergeDistribution(
  target: Distribution,
  source: Distribution,
  fraction?: number,
  maxBins?: number,
): void;
export function percentile(
  value: Distribution,
  quantile: number,
  maximum: number | null,
): number | null;
export function relativeError(value: Distribution): number | null;
export function encodeDistribution(value: Distribution): EncodedDistribution;
export function decodeDistribution(
  encoded: unknown,
  weightMs?: number,
): Distribution | null;
