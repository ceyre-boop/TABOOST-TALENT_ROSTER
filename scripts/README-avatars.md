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

## Secondary accounts

The roster publishes **one card per sheet row**, keyed on the primary
`TikTok Account` column. Secondary handles are deliberately not expanded
into cards — doing so took the roster from 95 to 110 and broke parity
with the sheet's row count, which is how the roster gets reviewed.

Their pictures stay cached in `assets/avatars/` (`thisblondieee`,
`shopaholicallee2`, `brittaniehammershop`, `hanasfaves`, `only_cups`,
`only_supps`, `kategrs`, `honeyquiche`, `everydayaudur`, `peytonxshops`,
`petitewithjessy`, `nataleezyyirl`, `kristinanicoletall`, `kindafitky`,
`ashleyorganicedits`), so reinstating them is a data change only — no
refetching needed.

`samjones_2` was in the sheet but returns a not-found page on TikTok. It
was removed from the sheet on 2026-08-17 and has no cached avatar.
