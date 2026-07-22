#!/usr/bin/env python3
"""Fetch the published Roster tab and write data/roster.csv for the live page.

Keeps only Full Name, TikTok handle, and Sales Level (column G) — the sheet
also contains emails, which must never land in this public repo. Sales Level
goes in output column G because the page reads index 6. Rows with no level or
N/A are skipped (the page shows no badge for them).
"""
import csv, io, sys, urllib.request

PUB_URL = ("https://docs.google.com/spreadsheets/d/e/"
           "2PACX-1vQPfMxEs8_tvPP7R-buib4qUDWlfY7oTELhWECOctLjkFnqqwnBrsgcsAt1calQqarsjSNP78mQrEmb"
           "/pub?gid=437028928&single=true&output=csv")

raw = urllib.request.urlopen(PUB_URL, timeout=60).read().decode("utf-8")
rows = list(csv.reader(io.StringIO(raw)))
header = [h.strip().lower() for h in rows[0]]

def col(name):
    for i, h in enumerate(header):
        if name in h:
            return i
    sys.exit(f"Column containing '{name}' not found in sheet header: {header}")

i_name, i_handle, i_level = col("full name"), col("tiktok account"), col("sales level")
i_cat, i_rate = col("category"), col("rate")

out = [["Full Name", "TikTok Handle", "Categories", "Rate", "", "", "Sales Level"]]
seen = set()
for r in rows[1:]:
    if len(r) <= max(i_name, i_handle, i_level, i_cat, i_rate):
        continue
    name, handle, level = r[i_name].strip(), r[i_handle].strip(), r[i_level].strip()
    cats, rate = r[i_cat].strip(), r[i_rate].strip()
    if not name or not handle or handle.lower() in seen:
        continue
    seen.add(handle.lower())
    if level.upper() == "N/A":
        level = ""
    out.append([name, handle, cats, rate, "", "", level])

with open("data/roster.csv", "w", newline="") as f:
    csv.writer(f).writerows(out)
print(f"Wrote {len(out)-1} creators to data/roster.csv")
