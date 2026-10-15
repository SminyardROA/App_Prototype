"""Prepare (never apply) targeted repairs from a completed default-namespace audit.

Uses Poppler page extraction for verified ROA PDFs; official same-date eCFR
XML replaces damaged PDF extraction without claiming live-current verification.
All fetched bytes and candidate text stay in ignored generated-artifacts.
"""
import concurrent.futures
import datetime
import gzip
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "generated-artifacts/source-quality"
ORIGINALS = OUT / "originals"
ORIGINALS.mkdir(parents=True, exist_ok=True)
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"


def download(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0", "Accept-Encoding": "gzip",
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return body, response.url


def pieces(text, size=2100, overlap=180):
    text = re.sub(r"[ \t]+", " ", text).strip()
    for start in range(0, len(text), size - overlap):
        value = text[start:start + size].strip()
        if value:
            yield value


def article_number(url):
    found = re.search(r"/(?:lr)?(\d{4,5})[^/]*\.pdf$", url, re.I)
    return found[1] if found else None


def prepare_cfr(filename, records):
    match = re.fullmatch(r"38 CFR (?:Part (\d+)|(\d+\.\d+)) \(up to date as of (\d+)-(\d+)-(\d+)\)\.pdf", filename)
    if not match:
        raise ValueError("Unrecognized uploaded CFR identity")
    part, section, month, day, year = match.groups()
    date = datetime.date(int(year), int(month), int(day)).isoformat()
    part = part or section.split(".")[0]
    url = f"https://www.ecfr.gov/api/versioner/v1/full/{date}/title-38.xml?part={part}"
    if section:
        url += f"&section={section}"
    data, final_url = download(url)
    tree = ET.fromstring(data)
    sections = ([tree] if tree.tag == "DIV8" else tree.findall(".//DIV8"))
    if section:
        sections = [s for s in sections if s.get("N") == section]
    else:
        if tree.get("N") != part or tree.get("TYPE") != "PART":
            raise ValueError("Official XML does not match requested part")
    if not sections:
        raise ValueError("Official XML contains no matching sections")
    digest = hashlib.sha256(data).hexdigest()
    (ORIGINALS / f"{digest}.xml").write_bytes(data)
    chunks = []
    for s in sections:
        heading = s.findtext("HEAD") or ""
        if not heading.startswith("§"):
            continue
        # itertext preserves table cells and hierarchical text without PDF
        # glyph spacing. Keep line breaks for tables and paragraph labels.
        text = "\n".join(" ".join("".join(child.itertext()).split()) for child in s)
        for piece in pieces(text):
            chunks.append({"text": f"38 CFR § {s.get('N')} — {heading}\n{piece}",
                           "section": s.get("N"), "sectionTitle": heading})
    if not chunks:
        raise ValueError("Official XML yielded no text")
    title = f"38 CFR {'§ ' + section if section else 'Part ' + part} — " + (tree.findtext("HEAD") or "").strip()
    metadata = {
        "title": title, "url": final_url, "documentDate": date,
        "sourceKind": "official-regulation", "currency": "indexed-snapshot",
        "originalSource": records[0]["metadata"].get("source", filename),
        "originalFilename": filename, "sourceSha256": digest,
        "extractionMethod": "ecfr-same-date-xml", "type": "official-policy",
        "provenanceNote": "Damaged uploaded PDF text replaced from official eCFR XML for the same snapshot date. Original PDF bytes unavailable; original page numbers are not transferred to XML.",
    }
    return {"identity": filename, "existingIds": [r["id"] for r in records],
            "metadata": metadata, "chunks": chunks, "catalog": False}


def prepare_pdf(url, records, catalog_urls):
    number = article_number(url)
    data, final_url = download(url)
    if not data.startswith(b"%PDF"):
        raise ValueError("Not a PDF")
    if not re.search(r"(^|\.)roa\.org$", urllib.parse.urlparse(final_url).hostname or ""):
        raise ValueError("PDF redirected outside authoritative ROA host")
    digest = hashlib.sha256(data).hexdigest()
    pdf = ORIGINALS / f"{digest}.pdf"
    pdf.write_bytes(data)
    text = subprocess.check_output(["pdftotext", "-layout", str(pdf), "-"], timeout=60).decode("utf8")
    pages = text.split("\f")
    first = pages[0]
    # Identify the number from the actual document, not the URL alone.
    normalized = re.sub(r"\s+", "", first[:700]).lower()
    if not number or not re.search(r"(?:lawreview|no\.?)1?" + number.lstrip("0"), normalized):
        raise ValueError(f"Cannot verify article {number} against PDF header")
    date = re.search(rf"({MONTH})\s+(\d{{4}})", first[:900], re.I)
    if not date:
        raise ValueError("No publication date in actual PDF header")
    document_date = datetime.datetime.strptime(" ".join(date.groups()).title(), "%B %Y").strftime("%Y-%m")
    # Keep an existing meaningful title; replace number-only placeholders
    # using the actual heading between the date and byline.
    title = next((r["metadata"].get("title") for r in records
                  if r["metadata"].get("title") and not re.fullmatch(r"(?:No\.? *)?\d+", r["metadata"]["title"])), "")
    if not title:
        after_date = first[date.end():]
        heading = re.split(r"\bBy\b|\bCaptain\b|\bMajor\b|\bSergeant\b", after_date, maxsplit=1)[0]
        title = " ".join(heading.split())[:500] or f"ROA Law Review {number}"
    chunks = []
    for page, page_text in enumerate(pages, 1):
        for piece in pieces(page_text):
            chunks.append({"text": piece, "pageStart": page, "pageEnd": page})
    if not chunks or any("\ufffd" in c["text"] for c in chunks):
        raise ValueError("PDF extraction is empty or damaged")
    proposal = bool(re.search(r"\bpropos(?:ed|al)\b", title, re.I))
    metadata = {
        "title": title, "url": url, "documentDate": document_date,
        "source": "ROA Service Members Law Center", "sourceKind": "roa-analysis",
        "currency": "dated-analysis", "documentIdentity": f"roa-law-review-{number}",
        "sourceSha256": digest, "extractionMethod": "pdftotext-layout-pages",
        "type": "law-center-pdf", "legalStatus": "proposal-discussion" if proposal else "analysis-not-authority",
        "verifiedUrl": final_url,
    }
    return {"identity": url, "existingIds": [r["id"] for r in records], "metadata": metadata,
            "chunks": chunks, "catalog": url not in catalog_urls}


def main():
    records = [json.loads(line) for line in (OUT / "records.jsonl").open()]
    catalog_urls = {a["url"] for a in json.loads((ROOT / "lr-articles.json").read_text())}
    groups = {}
    for record in records:
        m = record["metadata"]
        key = m.get("url") or m.get("filename") or m.get("source") or record["id"]
        groups.setdefault(key, []).append(record)
    work = []
    for key, group in groups.items():
        if key.startswith("38 CFR ") and "up to date as of" in key:
            work.append((prepare_cfr, (key, group)))
        elif "roa.org" in key and key.lower().endswith(".pdf"):
            header = "\n".join(r["metadata"].get("text", "")[:650] for r in group
                               if re.search(r"-chunk-[01]$", r["id"]))
            # Repair current uncataloged articles and VA/exposure documents;
            # do not rebuild the rest of the approved corpus.
            if ((re.search(r"/lr26\d{3}", key, re.I) and key not in catalog_urls) or
                re.search(r"cancer|Agent Orange|burn pits|PACT Act|Camp Lejeune|VA disabilit|veteran status|VA Proposed Updates", header, re.I)):
                work.append((prepare_pdf, (key, group, catalog_urls)))
    results, failures = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        jobs = {pool.submit(fn, *args): args[0] for fn, args in work}
        for future in concurrent.futures.as_completed(jobs):
            identity = jobs[future]
            try:
                result = future.result()
                results.append(result)
                print("Verified", identity, len(result["chunks"]), flush=True)
            except Exception as error:
                failures.append({"identity": identity, "error": str(error)})
                print("FAILED", identity, str(error), flush=True)
    plan = {"namespace": "", "documents": sorted(results, key=lambda d: d["identity"]), "failures": failures}
    (OUT / "repair-plan.json").write_text(json.dumps(plan, indent=2))
    print(json.dumps({"verified": len(results), "failures": len(failures), "chunks": sum(len(d["chunks"]) for d in results)}))


if __name__ == "__main__":
    main()
