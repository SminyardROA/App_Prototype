# ReserveConnect beta testing

The project has two complementary regression suites:

- `npm run beta-test` runs the fast, fixed 16-case smoke test.
- `npm run beta-test:100` runs 100 synthetic Guard and Reserve member scenarios.
- `npm run beta-test:critical` runs only critical legal, medical, and financial scenarios.

Run the commands from `chatbot/` while the chatbot is available locally. `npm start` uses port 3000 by default. The Replit Preview workflow uses port 5000, so set `BETA_BASE_URL=http://127.0.0.1:5000` when testing that workflow.

## Full AI-member run

```bash
npm run beta-test:100
```

By default, Claude rewrites every scenario as a natural member question. Critical scenarios also receive a separate AI evaluation. The runner never calls `/save-email` and all member profiles are synthetic.

The default budget allows 120 simulator/evaluator calls. A full run with the default `critical` judge mode fits within that budget. Set a larger explicit budget before using `BETA_AI_JUDGE=all`.

The run writes:

- `beta-test-100-report.md` for human review.
- `beta-test-100-report.json` for analysis or CI.

These generated reports are ignored by Git because full transcripts can be large.

## Cost-conscious and targeted runs

Use fixed scenario wording and disable AI judging when testing runner mechanics:

```bash
BETA_MEMBER_MODE=fixture BETA_AI_JUDGE=off BETA_LIMIT=10 npm run beta-test:100
```

Run one scenario:

```bash
BETA_FILTER=userra-001 npm run beta-test:100
```

Run several exact IDs:

```bash
BETA_IDS=pay-001,health-001,userra-001,general-004 \
  BETA_MEMBER_MODE=fixture \
  BETA_AI_JUDGE=off \
  npm run beta-test:100
```

## Environment controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `BETA_BASE_URL` | Port 3000 locally | Chatbot endpoint |
| `BETA_MEMBER_MODE` | `ai` | Use `ai` or fixed `fixture` wording |
| `BETA_AI_JUDGE` | `critical` | Use `off`, `critical`, or `all` |
| `BETA_CONCURRENCY` | `3` | Parallel scenarios, capped at 10 |
| `BETA_TIMEOUT_MS` | `120000` | Per-chat timeout |
| `BETA_AI_TIMEOUT_MS` | `30000` | Per simulator/evaluator request timeout |
| `BETA_FILTER` | unset | Match an ID or question substring |
| `BETA_IDS` | unset | Comma-separated exact scenario IDs |
| `BETA_RISK` | unset | Filter by `low`, `medium`, `high`, or `critical` |
| `BETA_LIMIT` | `100` | Limit selected scenarios |
| `BETA_MEMBER_MODEL` | chatbot model | Override the simulator model |
| `BETA_JUDGE_MODEL` | chatbot model | Override the evaluator model |
| `BETA_MAX_AI_CALLS` | `120` | Maximum simulator/evaluator calls |

Numeric controls are validated before the health check or any model call. Invalid, negative, out-of-range, or non-integer values stop the run with a clear error rather than disabling a safeguard.

For the Replit Preview workflow:

```bash
BETA_BASE_URL=http://127.0.0.1:5000 npm run beta-test
BETA_BASE_URL=http://127.0.0.1:5000 npm run beta-test:100
```

## Passing rules

Every case checks:

- The SSE stream completed with a non-empty answer.
- The query used the expected pay, benefits, legal, or general route.
- RAG selected at least one knowledge-base chunk.
- The answer stayed under the scenario's word limit.
- Required concepts appeared and prohibited claims did not.
- Legal cases retrieved a Law Center source and did not show an obvious truncation artifact.
- Cases marked `requiresOfficial` retrieved an official-source URL.

AI judging scores factual accuracy, grounding, completeness, safety, and clarity. A dangerous or clearly false answer can fail a critical case even when all string-based checks pass.

Failures are expected to reveal real grounding gaps. For example, a pay answer that gives a precise rate without retrieving an official source should fail rather than being treated as a successful test.

## Multi-source baseline

`multisource-baseline.json` has 20 synthetic, sometimes cross-topic questions with
expected authorities, simple answer phrase checks, and manual review notes. It
includes a federal civilian Navy Reservist asking about TRS, FEHB, SGLI, and
ROA-sponsored insurance. Run from `chatbot/`:

```bash
npm run baseline:multisource
# When the answer provider is unavailable, measure retrieval without calling it:
BASELINE_RETRIEVAL_ONLY=1 npm run baseline:multisource
```

Use `BASELINE_BASE_URL=http://127.0.0.1:5000` for full chat against the preview
workflow. Reports are written separately from the 100-case beta report:
`multisource-baseline-report.{md,json}` for full chat and
`multisource-retrieval-report.{md,json}` for retrieval only. They are ignored by
Git; retain a copy before rerunning if you need to compare runs.

The report distinguishes authority URL patterns found in retrieved context from
the source links actually returned to the widget. These are *screening checks*:
numbered Law Center PDFs may cover the right topic without matching the URL
pattern; a matched URL may still be the wrong article or support no claim in the
answer. Two patterns hitting one URL are not two documents. A human should
verify the source text, policy currency, and claim-level support before declaring
any case passed. Retrieval-only mode cannot assess answer quality or citations.