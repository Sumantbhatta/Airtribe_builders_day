// Unit tests for the mentor's inline-evidence handling (no network).
import { EVIDENCE_DELIM, evidenceFilter, splitEvidence } from "../src/mentor.js";

let failures = 0;
const check = (c: unknown, label: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${label}`); if (!c) failures++; };

const ev = `{"language":"Hinglish","profile":{"goal":"","motivation":"","struggle":""},"graded":{"answered":true,"correct":false,"misconception":"thinks x++ adds first"},"asked":{"asked":true,"concept":"post_increment","prompt":"int y = 10; int z = y++; z?","answer_key":"10"},"inferred_gaps":[]}`;
const full = `Arre nahi, 5 print hoga. Ab batao: int y = 10; int z = y++; z?\n${EVIDENCE_DELIM}\n${ev}`;

// Stream it in awkward chunks, including one that splits the delimiter.
const chunks = [full.slice(0, 20), full.slice(20, full.indexOf(EVIDENCE_DELIM) + 4), full.slice(full.indexOf(EVIDENCE_DELIM) + 4, full.length - 30), full.slice(full.length - 30)];
let shown = "";
const f = evidenceFilter((t) => (shown += t));
for (const c of chunks) f.push(c);
const { visible, evidence } = splitEvidence(full);
f.flush(visible);
check(!shown.includes("###") && !shown.includes("{"), "learner never sees the evidence block");
check(shown.trimEnd() === visible, "learner sees the full visible reply");
check(evidence?.graded.answered === true && evidence?.graded.correct === false, "graded evidence parsed");
check(evidence?.asked.concept === "post_increment" && evidence?.asked.answer_key === "10", "asked question parsed");

// No delimiter: everything is visible, evidence null, held-back tail flushed.
let shown2 = "";
const f2 = evidenceFilter((t) => (shown2 += t));
const plain = "Sure! Strings compare by content with .equals.";
f2.push(plain);
const s2 = splitEvidence(plain);
f2.flush(s2.visible);
check(shown2 === plain && s2.evidence === null, "no evidence: whole reply shown, evidence null");

// Malformed JSON after delimiter: reply still clean, evidence null (caller falls back to extract call).
const bad = splitEvidence(`Hello there\n${EVIDENCE_DELIM}\n{"language": "English", oops`);
check(bad.visible === "Hello there" && bad.evidence === null, "malformed evidence -> null, reply intact");

// Fenced JSON is tolerated.
const fenced = splitEvidence(`Hi\n${EVIDENCE_DELIM}\n\`\`\`json\n${ev}\n\`\`\``);
check(fenced.evidence?.language === "Hinglish", "fenced evidence JSON parsed");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
