import test from "node:test";
import assert from "node:assert/strict";
import { veteranIntakeQuestion, formatServiceCharacterizationQuestions } from "./veteran-intake.js";

const turn = (role, content) => ({ role, content });
const member = content => turn("user", content);
const assistant = content => turn("assistant", content);

test("the intake advances without treating bare duration as a duty type", () => {
  assert.match(veteranIntakeQuestion("90 days", [
    assistant("What kind of duty have you performed and roughly how long on active duty?"),
  ]), /What kind of duty/);
  assert.match(veteranIntakeQuestion("Active duty other than training"), /how many days/);
});

test("drilling service asks discharge, records, training disability then Selected Reserve years", () => {
  const history = [member("Only monthly drills and annual training in the Army Reserve Selected Reserve for six years, no other active duty.")];
  assert.match(veteranIntakeQuestion(history[0].content), /characterization of service \(Honorable, Under Honorable Conditions, etc\.\)/);
  history.push(assistant("How was the service characterized?"), member("Honorable discharge"));
  assert.match(veteranIntakeQuestion("Honorable discharge", history.slice(0, -1)), /DD Form 214/);
  history.push(assistant("Do you have a DD Form 214 or another record available?"), member("No"));
  assert.match(veteranIntakeQuestion("No", history.slice(0, -1)), /line of duty/);
  history.push(assistant("Have you had an injury or disease incurred or aggravated in line of duty during training?"));
  assert.equal(veteranIntakeQuestion("No", history), null);
});

test("a typed 16 answers the Selected Reserve years question instead of repeating it", () => {
  const history = [
    member("I served in the Selected Reserve, only drills, honorably discharged, have a DD214 and no injury."),
    assistant("How many years have you completed in the Selected Reserve (a drilling unit or full-time support role, not the Individual Ready Reserve)? If that doesn't apply to your service, let me know."),
  ];
  for (const answer of ["16", "16 years", "sixteen", "0", "16.5"]) {
    assert.equal(veteranIntakeQuestion(answer, history), null, answer);
  }
  assert.match(veteranIntakeQuestion("16", [
    member("Only drills in the Selected Reserve, honorably discharged and no injury."),
    assistant("Do you have a DD Form 214 or another record available?"),
  ]), /DD Form 214/, "a number must not silently answer a yes/no records question");
});

test("numeric active-duty answers use the question's unit and clarify only a missing unit", () => {
  const history = [
    member("I performed active duty other than training."),
    assistant("Roughly how many days of active duty other than training have you performed?"),
  ];
  for (const answer of ["90", "0", "90 days", "six", "6 months"]) {
    assert.match(veteranIntakeQuestion(answer, history), /characterization of service/, answer);
  }
  const ambiguous = [
    history[0], assistant("Roughly how long have you served on active duty other than training?"),
  ];
  const clarification = veteranIntakeQuestion("90", ambiguous);
  assert.match(clarification, /For the 90 you entered/);
  assert.match(clarification, /days, weeks, months, or years/);
  assert.match(veteranIntakeQuestion("days", [
    ...ambiguous, member("90"), assistant(clarification),
  ]), /characterization of service/);
});

test("Under Honorable Conditions answers the characterization question", () => {
  const history = [
    member("I served 90 days on active duty other than training."),
    assistant("What was the characterization of service (Honorable, Under Honorable Conditions, etc.) for the relevant discharge or release?"),
  ];
  assert.match(veteranIntakeQuestion("Under Honorable Conditions", history), /DD Form 214/);
});

test("generated characterization questions include parenthesized examples without duplication", () => {
  for (const question of [
    "What was your characterization of service?",
    "Under what characterization of service — Honorable, Under Honorable Conditions, etc.?",
    "What was the discharge characterization?",
  ]) {
    const formatted = formatServiceCharacterizationQuestions(question);
    assert.match(formatted, /\(Honorable, Under Honorable Conditions, etc\.\)/);
    assert.equal(formatServiceCharacterizationQuestions(formatted), formatted);
  }
  const withExamples = "What was your characterization of service (Honorable, Under Honorable Conditions, etc.)?";
  assert.equal(formatServiceCharacterizationQuestions(withExamples), withExamples);
  const statement = "A characterization of service is recorded on service documents.";
  assert.equal(formatServiceCharacterizationQuestions(statement), statement);
});

test("fully volunteered facts skip intake; home-loan research does not require an injury or a DD214", () => {
  const known = "I served six years in the Selected Reserve, only monthly drills and annual training, no other active duty. I was honorably discharged and don't have a DD214.";
  assert.equal(veteranIntakeQuestion(known + " I want to explore a VA home loan."), null);
  assert.match(veteranIntakeQuestion(known), /line of duty/);
  assert.equal(veteranIntakeQuestion(known + " I have no injury from training and no VA disability rating."), null);
  assert.match(veteranIntakeQuestion("I was in the Reserve for six years, only drills, honorably discharged, have a DD214 and no injury."), /How many years.*Selected Reserve/,
    "calendar Reserve years alone do not establish Selected Reserve years");
});

test("unknown records answers are accepted without a loop, and other people's facts do not fill member intake", () => {
  const history = [
    member("Only drills in the Selected Reserve for six years, honorably discharged, no injury."),
    assistant("Do you have a DD Form 214 or another service record available?"),
  ];
  assert.equal(veteranIntakeQuestion("I don't know", history), null);
  assert.equal(veteranIntakeQuestion("I'm not sure", history), null);
  assert.equal(veteranIntakeQuestion("My buddy served six years. Could he get a VA home loan?", history), null);
  assert.match(veteranIntakeQuestion("No", [
    ...history, member("My buddy was on active duty for 90 days"),
    assistant("Does he have a DD214?"),
  ]), /What kind of duty/);
});
