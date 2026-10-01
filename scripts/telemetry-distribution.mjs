// Shared collector/gateway codec. Positive values use upper-inclusive base-2
// buckets; observed milliseconds are the weights. Coarsening merges adjacent
// buckets rather than averaging observations, retaining a mergeable distribution.
const BASE = 64;
const MAX_SCALE = 18;
const MAX_ENCODED_BINS = 256;
const MAX_WEIGHT = 3_600_000;

export function distribution() {
  return { scale: 0, zero: 0, bins: new Map() };
}

export function distributionWeight(value) {
  let weight = value.zero;
  for (const count of value.bins.values()) weight += count;
  return weight;
}

function coarsen(value) {
  const bins = new Map();
  for (const [index, weight] of value.bins) {
    const key = Math.ceil(index / 2);
    bins.set(key, (bins.get(key) ?? 0) + weight);
  }
  value.bins = bins;
  value.scale += 1;
}

export function compactDistribution(value, maxBins) {
  while (value.bins.size > maxBins && value.scale < MAX_SCALE) coarsen(value);
}

export function addObservation(target, value, weight, maxBins = 256) {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isFinite(weight) ||
    weight <= 0
  ) {
    return;
  }
  if (value === 0) {
    target.zero += weight;
    return;
  }
  const index = Math.ceil((Math.log2(value) * BASE) / 2 ** target.scale);
  target.bins.set(index, (target.bins.get(index) ?? 0) + weight);
  compactDistribution(target, maxBins);
}

export function mergeDistribution(target, source, fraction = 1, maxBins = 512) {
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return;
  }
  while (target.scale < source.scale) coarsen(target);
  target.zero += source.zero * fraction;
  const divisor = 2 ** (target.scale - source.scale);
  for (const [index, weight] of source.bins) {
    const key = Math.ceil(index / divisor);
    target.bins.set(key, (target.bins.get(key) ?? 0) + weight * fraction);
  }
  compactDistribution(target, maxBins);
}

export function percentile(value, quantile, maximum) {
  const total = distributionWeight(value);
  if (!(total > 0) || !Number.isFinite(maximum) || maximum < 0) {
    return null;
  }
  const threshold = total * quantile;
  let accumulated = value.zero;
  if (value.zero > 0 && accumulated >= threshold) {
    return 0;
  }
  for (const [index, weight] of [...value.bins].sort((a, b) => a[0] - b[0])) {
    accumulated += weight;
    if (accumulated + total * 1e-12 >= threshold) {
      return Math.min(maximum, 2 ** ((index * 2 ** value.scale) / BASE));
    }
  }
  return maximum;
}

export function relativeError(value) {
  if (!value.bins.size) {
    return 0;
  }
  const error = Math.expm1((Math.LN2 * 2 ** value.scale) / BASE);
  return Number.isFinite(error) ? error : null;
}

function writeVarint(bytes, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new Error("Invalid distribution weight");
  }
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next + (value ? 128 : 0));
  } while (value);
}

export function encodeDistribution(value) {
  const bytes = [];
  writeVarint(bytes, value.zero);
  let previous;
  for (const [index, weight] of [...value.bins].sort((a, b) => a[0] - b[0])) {
    writeVarint(
      bytes,
      previous === undefined
        ? index >= 0
          ? index * 2
          : -index * 2 - 1
        : index - previous,
    );
    writeVarint(bytes, weight);
    previous = index;
  }
  return [1, value.scale, Buffer.from(bytes).toString("base64")];
}

export function decodeDistribution(encoded, weightMs = MAX_WEIGHT) {
  if (
    !Array.isArray(encoded) ||
    encoded.length !== 3 ||
    encoded[0] !== 1 ||
    !Number.isInteger(encoded[1]) ||
    encoded[1] < 0 ||
    encoded[1] > MAX_SCALE ||
    typeof encoded[2] !== "string" ||
    encoded[2].length > 4096 ||
    !Number.isFinite(weightMs) ||
    weightMs < 0 ||
    weightMs > MAX_WEIGHT
  ) {
    return null;
  }
  const bytes = Buffer.from(encoded[2], "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded[2]) {
    return null;
  }
  let offset = 0;
  const read = () => {
    let value = 0;
    for (let digit = 0; digit < 4 && offset < bytes.length; digit += 1) {
      const byte = bytes[offset++];
      value += (byte & 127) * 128 ** digit;
      if (byte < 128) {
        if (digit && byte === 0) {
          throw new Error("Noncanonical distribution");
        }
        return value;
      }
    }
    throw new Error("Truncated distribution");
  };
  try {
    const result = { scale: encoded[1], zero: read(), bins: new Map() };
    let previous;
    while (offset < bytes.length) {
      const key = read();
      const index =
        previous === undefined
          ? key % 2
            ? -(key + 1) / 2
            : key / 2
          : previous + key;
      const weight = read();
      if (
        (previous !== undefined && index <= previous) ||
        !weight ||
        index < Math.ceil((-1074 * BASE) / 2 ** result.scale) ||
        index > Math.ceil((1024 * BASE) / 2 ** result.scale) ||
        result.bins.size >= MAX_ENCODED_BINS
      ) {
        return null;
      }
      result.bins.set(index, weight);
      previous = index;
    }
    return distributionWeight(result) <= weightMs + 1e-6 ? result : null;
  } catch {
    return null;
  }
}
