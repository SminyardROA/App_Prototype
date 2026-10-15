# SCRA Guard lease and interest review

The automated checks and statutory cross-check below are **not** a substitute for legal review. On September 24, 2026, the project owner reported that the requested subject-matter review was approved and recommended directing users with other SCRA questions unsupported by Law Center articles or ingested sources to the [current official SCRA chapter](https://uscode.house.gov/view.xhtml?path=/prelim@title50/chapter50&edition=prelim). The reviewer was not identified to the agent, so this file records the owner's report rather than an independently verified reviewer identity or signed approval.

Official current U.S. Code consulted on September 24, 2026:

- [50 U.S.C. § 3911(2)(A)(ii)](https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A3911%20edition%3Aprelim%29): covered Guard service under Title 32 § 502(f) requires a call authorized by the President or Secretary of Defense for **more than 30 consecutive days**, to respond to a **national emergency declared by the President**, supported by **federal funds**. Funding alone does not establish SCRA coverage.
- [50 U.S.C. § 3937](https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A3937%20edition%3Aprelim%29): 6% limit on qualifying debts incurred **before** military service; the statutory notice/proof rules differ from lease termination.
- [50 U.S.C. § 3955](https://uscode.house.gov/view.xhtml?req=%28title%3A50%20section%3A3955%20edition%3Aprelim%29): residential and motor-vehicle lease termination, including pre-service residential leases and certain during-service leases followed by qualifying PCS/deployment orders; written notice and military orders (or other statutory proof) are addressed separately from § 3937. **§ 3956 is not the residential-lease termination section.**

Reviewer checklist:

1. Confirm these sections and the exact Title 32 conditions remain current.
2. Check the model prompt, safety fallback, and all four Guard case expectations against the statutes, especially routine 14-day orders versus qualifying 45-day emergency orders.
3. Check lease timing, written notice/delivery and proof requirements; distinguish pre-service loan dates and § 3937 notice deadlines.
4. Keep the project owner's reported approval and any later formal reviewer sign-off in the project's normal legal review records.

## Statutory change monitor

The `SCRA Statute Monitor` workflow runs `scripts/monitor-scra-statutes.sh` daily. It fetches the **current** OLRC U.S. Code text of §§ 3911, 3937, and 3955, extracts only the `statute` field (not site navigation, editorial notes or the "current through" date), and compares normalized statutory text with the hashes in `scra-statute-baseline.json`. This snapshot was captured from the official section pages on September 24, 2026. A text change is a **review trigger**, not an assertion about its legal effect. Formatting changes that affect the normalized text can also trigger review.

If a section differs, the workflow logs `STATUTE CHANGE` and opens one GitHub issue per changed section using `GITHUB_TOKEN`. An existing open issue is reused, not duplicated. Fetch, parsing, or issue delivery failures are printed as `MONITOR WARNING` or `ALERT DELIVERY FAILED` and retried at the next check. Monitor logs must remain visible to maintainers; no alert can be delivered if GitHub access is unavailable.

On an alert: read the linked official section, have legal counsel assess the change, check `config.js`, `scra-safety.js`, this review record and `multisource-baseline.json`, and run `npm test` plus the four live Guard scenarios from `multisource-baseline.json` (for example, `npm run baseline:multisource` in `chatbot`, with the chatbot server running). Update guidance and test expectations **only after review**. Then update the corresponding hash in `scra-statute-baseline.json` manually to the newly reviewed text and close the issue. The monitor never changes legal guidance or the snapshot automatically.