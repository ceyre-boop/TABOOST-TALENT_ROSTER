#!/usr/bin/env python3
"""Pull TikTok profile pictures for handles that have no cached avatar.

Writes assets/avatars/<handle>.jpg so the live page never has to depend on
the unavatar.io fallback (which rate-limits at 429 under any burst).
Reports which handles could not be resolved rather than writing a placeholder.
"""
import json, os, re, sys, time, urllib.request

DEST = "assets/avatars"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

HANDLES = sys.argv[1:]
if not HANDLES:
    sys.exit("usage: fetch_avatars.py <handle> [handle ...]")


def get(url, referer=None):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        **({"Referer": referer} if referer else {}),
    })
    return urllib.request.urlopen(req, timeout=30).read()


def avatar_url(handle):
    html = get(f"https://www.tiktok.com/@{handle}").decode("utf-8", "replace")
    # avatarLarger appears in the embedded SIGI/universal JSON blob
    for key in ("avatarLarger", "avatarMedium", "avatarThumb"):
        m = re.search(r'"%s":"([^"]+)"' % key, html)
        if m:
            return json.loads('"%s"' % m.group(1))
    return None


ok, failed = [], []
for i, h in enumerate(HANDLES):
    try:
        url = avatar_url(h)
        if not url:
            failed.append((h, "no avatar in page (handle may not exist)"))
        else:
            img = get(url, referer="https://www.tiktok.com/")
            if len(img) < 1000:
                failed.append((h, f"image too small ({len(img)}b)"))
            else:
                with open(os.path.join(DEST, f"{h}.jpg"), "wb") as f:
                    f.write(img)
                ok.append((h, len(img)))
    except Exception as e:
        failed.append((h, f"{type(e).__name__}: {e}"))
    if i < len(HANDLES) - 1:
        time.sleep(2)  # pace requests

print(f"\nSAVED {len(ok)}/{len(HANDLES)}")
for h, n in ok:
    print(f"  ok    {h:<24} {n:,}b")
if failed:
    print(f"\nFAILED {len(failed)}")
    for h, why in failed:
        print(f"  FAIL  {h:<24} {why}")
