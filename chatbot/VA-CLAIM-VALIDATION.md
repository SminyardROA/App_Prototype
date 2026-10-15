# Source-grounded answers: current runtime policy

The owner requested removal of the mandatory AI claim-by-claim source check
because it was withholding useful responses despite relevant indexed material.

The chat route no longer calls `validateVaAnswer`, waits for an independent
reviewer's verdict, or returns claim-review failure/unavailable messages.
Existing review helpers and their tests are retained only for optional offline
evaluation; they are not an active chat requirement.

## What remains

- Full member-approved RAG retrieval, including the Law Center and relevant CFRs.
- Relevant source URLs for substantive disability/benefit explanations.
- Missing-source and unknown-citation checks on disability answers.
- Source-date and proposed-versus-enacted-law distinctions.
- Instructions not to diagnose, guess percentages, guarantee outcomes, or infer
  individual eligibility from incomplete information.
- Prior conversation facts, privacy controls and crisis handling.

Limb-loss language additionally searches the amputation schedule, anatomical-loss
special monthly compensation provisions, and service-connection framework.
These are research hints, not an eligibility or rating determination.

## Important limitation

A matching citation URL is not proof that every assertion is correct. Removing
the independent reviewer reduces false refusals and extra latency but removes
that additional factual-review layer. The model must still explain only what
the retrieved evidence supports, with clear uncertainty and no personal award
predictions.

Run `node --test va-claim-streaming.test.js` to check that the extra review call
is absent while retrieval/citation boundaries still operate.
