const power10 = (value) => 10n ** BigInt(value);

export function decimalFraction(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("invalid_decimal");
  const [whole, fraction = ""] = text.split(".");
  return { numerator: BigInt(whole + fraction), denominator: power10(fraction.length) };
}

const multiply = (left, right) => ({ numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator });
const add = (left, right) => ({ numerator: left.numerator * right.denominator + right.numerator * left.denominator, denominator: left.denominator * right.denominator });
const divide = (left, right) => ({ numerator: left.numerator * right.denominator, denominator: left.denominator * right.numerator });

export function normalizedFraction(score, maximumScore, scaleMaximum = "20") {
  return multiply(divide(decimalFraction(score), decimalFraction(maximumScore)), decimalFraction(scaleMaximum));
}

export function weightedAverageFraction(items) {
  let weighted = { numerator: 0n, denominator: 1n }, weights = { numerator: 0n, denominator: 1n };
  for (const item of items) {
    if (item.value === null || item.value === undefined) continue;
    const weight = decimalFraction(item.weight);
    weighted = add(weighted, multiply(typeof item.value === "object" ? item.value : decimalFraction(item.value), weight));
    weights = add(weights, weight);
  }
  return weights.numerator === 0n ? null : divide(weighted, weights);
}

export function roundFraction(value, precision = 2) {
  if (!value) return null;
  const factor = power10(precision), scaledNumerator = value.numerator * factor;
  let quotient = scaledNumerator / value.denominator;
  const remainder = scaledNumerator % value.denominator;
  if (remainder * 2n >= value.denominator) quotient += 1n;
  const text = quotient.toString().padStart(precision + 1, "0");
  return precision ? `${text.slice(0, -precision)}.${text.slice(-precision)}` : text;
}
