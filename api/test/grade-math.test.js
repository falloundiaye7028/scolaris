import assert from "node:assert/strict";
import test from "node:test";
import { normalizedFraction, roundFraction, weightedAverageFraction } from "../src/grade-math.js";

test("M4 normalise 8/10 sur 20 sans flottant", () => {
  assert.equal(roundFraction(normalizedFraction("8", "10", "20"), 2), "16.00");
});

test("M4 calcule la fixture 14,67 puis 13,95 sans arrondi prématuré", () => {
  const math = weightedAverageFraction([
    { value: normalizedFraction("12", "20", "20"), weight: "1" },
    { value: normalizedFraction("8", "10", "20"), weight: "2" },
  ]);
  assert.equal(roundFraction(math, 2), "14.67");
  const general = weightedAverageFraction([{ value: math, weight: "4" }, { value: "13", weight: "3" }]);
  assert.equal(roundFraction(general, 2), "13.95");
});

test("M4 exclut les résultats sans valeur du dénominateur", () => {
  const average = weightedAverageFraction([{ value: "12", weight: "1" }, { value: null, weight: "9" }]);
  assert.equal(roundFraction(average, 2), "12.00");
  assert.equal(weightedAverageFraction([{ value: null, weight: "1" }]), null);
});

