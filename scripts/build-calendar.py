"""Turn the government's working-day calendar into the one file both sides read.

    python scripts/build-calendar.py <115.csv> <116.csv> --source <url> --source <url>

The input is 行政院人事行政總處's 中華民國政府行政機關辦公日曆表 (data.gov.tw
dataset 14718), one CSV per ROC year: `西元日期,星期,是否放假,備註`, UTF-8 with a
BOM, CRLF line endings, `是否放假` 0 for a workday and 2 for a day off.

The output is written twice, byte for byte -- `src/parkcast/holidays_tw.json`
for the collector and `web/src/holidaysTw.json` for the app -- because a
calendar the two sides disagree about would put the collector and the browser
on different days. `tests/test_holidays.py` checks they still match.

**What counts as a holiday.** A day off that is a weekday, or a day off on a
weekend that carries a name. Weekends are days off in this calendar too, so "day
off" alone would move every ordinary Saturday out of its own climatology bucket.
A named Saturday -- 國慶日 on 2026-10-10 -- is a holiday: it is not an ordinary
Saturday, and the compensatory Friday before it (補假) is its own holiday row.

**Two things stop the build rather than guess.** A make-up workday (a weekend
marked 0): none exist in 2026 or 2027, so none is modelled, and one appearing in
a future year needs a decision about how it behaves. And a holiday name with no
English translation below, because the English UI names the holiday.
"""
import argparse
import csv
import io
import json
import pathlib
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUTS = (ROOT / "src" / "parkcast" / "holidays_tw.json", ROOT / "web" / "src" / "holidaysTw.json")

#: Every `備註` a holiday row carried in 2026-2027. A new one stops the build.
ENGLISH = {
    "開國紀念日": "New Year's Day",
    "小年夜": "Day before Lunar New Year's Eve",
    "農曆除夕": "Lunar New Year's Eve",
    "春節": "Lunar New Year",
    "補假": "Compensatory holiday",
    "和平紀念日": "Peace Memorial Day",
    "兒童節": "Children's Day",
    "清明節": "Tomb-Sweeping Day",
    "勞動節": "Labour Day",
    "端午節": "Dragon Boat Festival",
    "中秋節": "Mid-Autumn Festival",
    "孔子誕辰紀念日/教師節": "Teachers' Day",
    "國慶日": "National Day",
    "臺灣光復暨金門古寧頭大捷紀念日": "Retrocession Day",
    "行憲紀念日": "Constitution Day",
}

DAY_OFF = "2"
WORKDAY = "0"


def build(csv_texts: list[str], *, sources: list[str]) -> dict:
    """The calendar document from the raw CSV texts. Pure, so it can be tested."""
    holidays: dict[str, list[str]] = {}
    days = []
    for text in csv_texts:
        rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
        for raw_date, _weekday, flag, note in rows[1:]:
            day = datetime.strptime(raw_date, "%Y%m%d").date()
            days.append(day)
            weekend = day.weekday() >= 5
            note = note.strip()
            if weekend and flag == WORKDAY:
                raise ValueError(f"{day} is a make-up workday ({note or 'unnamed'}); "
                                 "decide how it behaves before building")
            if flag != DAY_OFF or (weekend and not note):
                continue
            if note not in ENGLISH:
                raise ValueError(f"{day}: holiday {note!r} has no English name; add it to ENGLISH")
            holidays[day.isoformat()] = [note, ENGLISH[note]]
    if not days:
        raise ValueError("no calendar rows")
    return {
        "covers": [min(days).isoformat(), max(days).isoformat()],
        "holidays": dict(sorted(holidays.items())),
        "source": list(sources),
    }


def render(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("csv", nargs="+", type=pathlib.Path)
    parser.add_argument("--source", action="append", required=True,
                        help="the URL each CSV came from, in the same order")
    args = parser.parse_args(argv)
    texts = [path.read_bytes().decode("utf-8-sig") for path in args.csv]
    text = render(build(texts, sources=args.source))
    for out in OUTPUTS:
        out.write_bytes(text.encode("utf-8"))
        print(f"wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
