"""An RSS or Atom feed, read with feedparser - Agent-Reach's RSS channel (github.com/Panniantong/Agent-Reach).
JSON job on stdin ({"url": ..., "limit": ...}); one "ULTRON_RESULT {...}" line back."""
import json
import sys


def emit(obj):
    print("ULTRON_RESULT " + json.dumps(obj), flush=True)


try:
    import feedparser

    job = json.load(sys.stdin)
    d = feedparser.parse(job["url"], agent="Ultron personal assistant (feedparser)")
    entries = [
        {
            "title": e.get("title"),
            "link": e.get("link"),
            "published": e.get("published") or e.get("updated"),
            "summary": (e.get("summary") or "")[:500],
        }
        for e in d.entries[: int(job.get("limit", 15))]
    ]
    if not entries:
        emit({"ok": False, "error": f"No feed entries found at {job['url']}" + (f" ({d.bozo_exception})" if d.get("bozo") else "")})
    else:
        emit({"ok": True, "feed": d.feed.get("title"), "site": d.feed.get("link"), "entries": entries})
except Exception as e:  # noqa: BLE001
    emit({"ok": False, "error": f"{type(e).__name__}: {e}"[:400]})
