# Creator avatars

The roster page renders each card's picture from:

1. `assets/avatars/<tiktok-handle>.jpg` — the cached copy, committed here
2. `https://unavatar.io/tiktok/<handle>` — fallback, only if (1) 404s

**Treat the fallback as decorative.** unavatar returns `429 Too Many
Requests` under any burst, so a handle with no cached file will usually
render as bare initials on a page this size. Every handle in
`data/roster.csv` should have a file in `assets/avatars/`.

## When new talent is added to the sheet

```sh
python3 scripts/fetch_avatars.py <handle> [handle ...]
git add assets/avatars && git commit -m "Avatars: <handles>"
```

The script pulls each profile picture from the creator's public TikTok
page and writes `assets/avatars/<handle>.jpg`. It prints a FAILED line
for any handle it cannot resolve instead of writing a placeholder — a
failure almost always means the handle is misspelled in the sheet, or
the account no longer exists.

## Checking for gaps

```sh
python3 - <<'PY'
import csv, os
have = {f[:-4] for f in os.listdir('assets/avatars') if f.endswith('.jpg')}
want = [r[1] for r in list(csv.reader(open('data/roster.csv')))[1:]]
print("missing:", [h for h in want if h not in have] or "none")
PY
```

## Known bad data

`samjones_2` sits in Sam Jones's *Additional TikTok Accounts* cell but
returns a not-found page on TikTok. It is excluded from the current
`data/roster.csv`. The sync script does not know it is dead, so it will
come back as an initials-only card on the next sync — remove it from the
sheet to keep the two in step.
