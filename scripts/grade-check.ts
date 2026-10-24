import { getConcept, grade } from "../src/engine.js";

const cases: [string, "diagnose" | "retest", string, boolean][] = [
  ["post_increment", "diagnose", "5", true], ["post_increment", "diagnose", "it prints six", false], ["post_increment", "diagnose", "I don't know", false],
  ["string_equality", "diagnose", "false", true], ["string_equality", "diagnose", "true", false], ["string_equality", "retest", ".equals", true],
  ["string_equality", "retest", "==", false], ["string_equality", "retest", "double equals", false],
  ["integer_division", "diagnose", "3", true], ["integer_division", "diagnose", "3.5", false], ["integer_division", "diagnose", "three point five", false],
  ["integer_division", "retest", "2", true], ["integer_division", "retest", "2.25", false],
  ["array_index", "diagnose", "four", true], ["array_index", "diagnose", "5", false], ["array_index", "retest", "9", true],
  ["variable_scope", "diagnose", "no", true], ["variable_scope", "diagnose", "yes", false], ["variable_scope", "retest", "no you cannot", true],
];
let bad = 0;
for (const [c, p, a, want] of cases) {
  const got = grade(getConcept("java-basics", c)![p], a);
  if (got !== want) { bad++; console.log("MISMATCH", c, p, JSON.stringify(a), got); }
}
console.log(bad ? `${bad} mismatches` : `all ${cases.length} grading cases ok`);
process.exit(bad ? 1 : 0);
