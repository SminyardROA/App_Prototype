# Read-only source packs

`POST https://roa-chatbot-backend.onrender.com/api/source-pack` is an operator-only passage retrieval API for ROA's
course-building agent. It does not generate an answer, invoke Claude, ingest
documents, or write to Pinecone. It is not exposed in either chat UI.

## Enable on Render

Add a strong, independently generated `SOURCE_PACK_TOKEN` to the Render
service's environment. Give the same token to the course-building agent through
its secret store. Never put it in a URL, Git, a browser widget, or a chat message.
The existing `PINECONE_API_KEY` and `VOYAGE_API_KEY` must also be configured.

The route returns **404** until the token is configured, and **401** for a
missing or incorrect `x-source-pack-token`. Authentication happens before JSON
body parsing. Existing CORS and Origin restrictions remain unchanged: use a
server-to-server caller without a browser Origin header.

## Request and limits

```json
{
  "queries": [
    "grey area retirement health insurance",
    "transfer to the IRR"
  ],
  "topK": 8
}
```

To search only staff research in the new namespace, select it explicitly and
optionally constrain document type and publication dates:

```json
{
  "queries": ["National security policy reports for curriculum lessons"],
  "topK": 8,
  "namespaces": ["roa-nationalsecurity"],
  "filter": {
    "doc_type": "report",
    "publication_date": {
      "from": "2023-01-01",
      "to": "2025-12-31"
    }
  }
}
```

- `namespaces` is optional. Omit it to retain the existing behavior: search
  default `""` plus every populated namespace on the shared index. When
  supplied, it must be a non-empty array of existing namespace names; `""`
  means default. Unknown (or not-yet-created) namespaces return **400**
  instead of falling back to other sources. Duplicate names are searched once.
  For the staff-only corpus, **always specify `["roa-nationalsecurity"]`**.
- `filter` is optional. `doc_type` matches Pinecone metadata `doc_type` and
  accepts `report`, `law`, `testimony`, `policy`, `article`, `data`, or `other`.
  `publication_date.from` and `publication_date.to` are optional, inclusive
  bounds; supply at least one. They must be real calendar dates in `YYYY-MM-DD`
  format. The API converts them to `YYYYMMDD` numbers for Pinecone's
  `publication_date_num` range filter (e.g., `2023-01-01` → `20230101`).
  Both conditions are combined when supplied. Records missing the filtered
  metadata field are excluded, not returned as errors. Malformed, impossible,
  or reversed dates return **400**. The readable `publication_date` text
  field is **not** used for range comparisons.
- 1–40 non-empty query strings; at most 2,000 characters per query.
- `topK` defaults to 8; integer values 1–20 are accepted. It limits the final
  combined results for each query, not the whole request.
- The existing 64 KB JSON body limit still applies.
- Four queries run concurrently, with a 20-second deadline for the full request.
- Authenticated callers are limited to 10 requests per minute per client IP.
- The response has `Cache-Control: no-store`.

The route calls the existing `embedQuery` function, using `voyage-law-2` with
`input_type: "query"`, then the same raw Pinecone transport as chat's primary
search. It uses the current shared dense index, never the mixed-model legacy
index. When no namespaces are selected, it inventories every populated
namespace and also searches the default namespace. Each query is embedded
once; its vector is reused across selected namespaces. Namespace matches are combined, sorted by score, deduplicated
by **exact full passage text**, and capped at `topK`.

This is raw passage retrieval, not the chatbot's answer-specific ranking,
similarity floors, pinned policy insertion, legal fallback, or referral logic.
Those chat behaviors are unchanged. `chatbot2` is not present in this repository;
enumerating all namespaces covers additional readers of this same index without
depending on a hard-coded namespace list.

## Response

```json
{
  "results": [
    {
      "query": "grey area retirement health insurance",
      "matches": [
        {
          "score": 0.83,
          "text": "The complete indexed passage, without truncation.",
          "source_title": "Document title or filename",
          "source_url_or_file": "https://example.org/document.pdf",
          "date": "2024-03-15",
          "publication_date": "2024-03-15",
          "publication_date_precision": "day",
          "doc_type": "report",
          "namespace": "roa-nationalsecurity",
          "chunk_id": "original-vector-id",
          "metadata": {}
        }
      ]
    }
  ],
  "namespaces_searched": 1,
  "searched_namespaces": ["roa-nationalsecurity"]
}
```

The `metadata` object contains **all original Pinecone metadata**, including
fields copied into the convenient top-level aliases. Missing existing aliases
are `null`; `publication_date`, `publication_date_precision`, and `doc_type`
are included as top-level fields when present. Namespace `""` denotes the
default namespace. `namespaces_searched` counts the actual searched namespaces
per request, including an empty default namespace when no selection is given.
`searched_namespaces` lists them; a zero-match result with a nonzero count
means the search ran but did not find matching passages.

The top-level `date` prefers `publication_date` or legacy `published_date`
over a generic `date` or `effective_date`, then `ingestionDate` or
`ingestion_date`. **An ingestion timestamp is not a
publication date or proof that a policy is current.** Inspect the original
metadata and verify the document's applicability before using a passage.

Live samples of the current index contained these metadata field names:

`text`, `title`, `url`, `source`, `filename`, `type`, `model`,
`embedding_input_type`, `ingestionDate`, `pageStart`, `pageEnd`, `statute`,
`parentUrls`.

They are not a uniform schema or an exhaustive list. Some records have only a
relative path or a local file reference rather than a public citation URL.
The endpoint preserves those references instead of inventing public links.

## Curl test

Load `SOURCE_PACK_TOKEN` into your local shell through a secret store.
The header is supplied on curl's standard input so the token is not part of
curl's command-line arguments.

```bash
printf 'x-source-pack-token: %s\n' "$SOURCE_PACK_TOKEN" |
  curl --fail-with-body --silent --show-error --max-time 25 \
    --request POST 'https://roa-chatbot-backend.onrender.com/api/source-pack' \
    --header @- \
    --header 'Content-Type: application/json' \
    --data '{"queries":["grey area retirement health insurance","transfer to the IRR"],"topK":8}'
```

## Failures

- **400:** Invalid query list, `topK`, namespace selection (including unknown
  namespaces), filter, date range, or malformed JSON.
- **401:** Missing or incorrect access token.
- **404:** Endpoint disabled because the token is not configured.
- **413:** JSON body exceeds the existing limit.
- **429:** Request rate limit; respect `Retry-After`.
- **503:** Knowledge-base retrieval is unavailable.
- **502:** Embedding, namespace inventory, or passage retrieval failed.
- **504:** Deadline exceeded; retry with fewer queries.

A failed batch returns an error rather than silently presenting incomplete
namespace coverage as a complete pack. Outbound calls are aborted on deadline,
client disconnect, or a sibling failure. The endpoint logs only the query count:
no queries, passages, metadata, tokens, or raw provider errors.
