# DFAS pay-table snapshots

These files are source snapshots collected from the [DFAS Military Pay Tables &
Information index](https://www.dfas.mil/MilitaryMembers/payentitlements/Pay-Tables/).
`manifest.json` enumerates every linked rate page, its original URL, index posting
label, and the year/date evidence found on the page. `source/` retains the full
text extraction; `tables/` removes the shared DFAS navigation and feedback form
while retaining rates, headings, and notes.

**These snapshots have not been ingested into the live search index or installed
as an amount lookup.** A posting date is not an effective date. In particular,
FY2026 tables may begin October 1, 2025 and need replacement after September 30,
2026; a page without an explicit 2026 rate label is not proof of a 2026 amount.
Multi-year tables require selecting the applicable effective-date row.

When these rates are used, make exact amount selection from validated structured
data (pay type, effective period, grade, years of service, drill count, and any
other required dimensions). Keep the official URL and applicable notes with the
selected row. Use embeddings for finding a relevant source or policy explanation,
not as the sole mechanism for selecting a dollar value.

## Locality BAH workbook

`bah-2026.json` is generated from the user-supplied Excel workbook using
`import-bah-workbook.py`. Both dependent-status sheets have 338 matching
military housing areas and 24 grade columns. The workbook is keyed by MHA
(for example TX270), **not ZIP code**; the official [BAH rate
lookup](https://www.travel.dod.mil/Allowances/Basic-Allowance-for-Housing/BAH-Rate-Lookup/)
is the ZIP-code authority. The TX270 figures were cross-checked against the
[DoD temporary increase notice](https://media.defense.gov/2026/May/13/2003930228/-1/-1/0/2026-ABILENE-TEMPORARY-INCREASE-BAH-RATES.PDF)
and apply May 16 through December 31, 2026. The other workbook rows were
checked for completeness and matching sheet dimensions, **not independently
compared one by one with the official lookup**. BAH-RC/T is not in this file.