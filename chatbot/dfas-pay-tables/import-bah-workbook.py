"""Convert the user-supplied 2026 BAH workbook to checked, exact-lookup JSON.

Uses only the Python standard library. Usage:
    python chatbot/dfas-pay-tables/import-bah-workbook.py path/to/2026-BAH.xlsx
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
GRADES = (
    [f"E{i:02}" for i in range(1, 10)]
    + [f"W{i:02}" for i in range(1, 6)]
    + [f"O{i:02}E" for i in range(1, 4)]
    + [f"O{i:02}" for i in range(1, 8)]
)


def read_sheet(archive, filename, shared):
    root = ET.fromstring(archive.read(filename))
    rows = []
    for row in root.findall(f".//{NS}sheetData/{NS}row"):
        values = {}
        for cell in row.findall(f"{NS}c"):
            match = re.match(r"[A-Z]+", cell.attrib["r"])
            value = cell.find(f"{NS}v")
            text = value.text if value is not None else None
            if cell.attrib.get("t") == "s" and text is not None:
                text = shared[int(text)]
            values[match.group()] = text
        rows.append(values)
    if len(rows) < 3:
        raise ValueError(f"{filename}: no data rows")
    header = {
        re.match(r"[A-Z]+", cell.attrib["r"]).group(): (
            shared[int(cell.find(f"{NS}v").text)] if cell.attrib.get("t") == "s"
            else cell.find(f"{NS}v").text
        )
        for cell in root.findall(f".//{NS}sheetData/{NS}row[2]/{NS}c")
        if cell.find(f"{NS}v") is not None
    }
    columns = {column: grade for column, grade in header.items() if grade in GRADES}
    if set(columns.values()) != set(GRADES) or len(columns) != len(GRADES):
        raise ValueError(f"{filename}: unexpected or missing pay-grade columns")
    result = {}
    for row in rows[2:]:
        code, name = row.get("A"), row.get("B")
        if not code and not name:
            continue
        if not code or not name or not re.fullmatch(r"[A-Z]{2}\d{3}", code):
            raise ValueError(f"{filename}: invalid housing area {code!r}, {name!r}")
        if code in result:
            raise ValueError(f"{filename}: duplicate housing area {code}")
        rates = {}
        for column, grade in columns.items():
            value = row.get(column)
            if value is None or not re.fullmatch(r"\d+", value):
                raise ValueError(f"{filename}: missing or invalid {code} {grade} rate")
            rates[grade] = int(value)
        result[code] = {"name": name.strip(), "rates": rates}
    return result


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Expected one XLSX path")
    with zipfile.ZipFile(sys.argv[1]) as archive:
        strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        shared = ["".join(node.itertext()) for node in strings.findall(f"{NS}si")]
        with_deps = read_sheet(archive, "xl/worksheets/sheet1.xml", shared)
        without_deps = read_sheet(archive, "xl/worksheets/sheet2.xml", shared)
    if set(with_deps) != set(without_deps) or len(with_deps) != 338:
        raise ValueError("BAH sheets must have the same 338 housing areas")
    if any(with_deps[code]["name"] != without_deps[code]["name"] for code in with_deps):
        raise ValueError("BAH sheets have mismatched housing area names")
    # Independently cross-checked with the official May 2026 Abilene notice.
    if (with_deps["TX270"]["rates"]["E05"], without_deps["TX270"]["rates"]["E05"]) != (1872, 1545):
        raise ValueError("TX270 temporary increase does not match official DoD notice")
    areas = {
        code: {
            "name": row["name"],
            "state": code[:2],
            "with": row["rates"],
            "without": without_deps[code]["rates"],
        }
        for code, row in with_deps.items()
    }
    result = {
        "year": 2026,
        "scope": "locality BAH table amounts; not an entitlement or BAH-RC table",
        "source": "User-provided 2026 BAH workbook, with/without dependent sheets",
        "officialLookup": "https://www.travel.dod.mil/Allowances/Basic-Allowance-for-Housing/BAH-Rate-Lookup/",
        "tx270Notice": "https://media.defense.gov/2026/May/13/2003930228/-1/-1/0/2026-ABILENE-TEMPORARY-INCREASE-BAH-RATES.PDF",
        "tx270Effective": "2026-05-16",
        "tx270Expires": "2026-12-31",
        "areas": areas,
    }
    output = Path(__file__).with_name("bah-2026.json")
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"Validated {len(areas)} matching housing areas, {len(GRADES)} grades, two dependent statuses -> {output}")


if __name__ == "__main__":
    main()