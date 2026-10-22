#!/usr/bin/env python3
"""Remove OVERLAP_SIMPLE, which Chromium 38's OTS treats as a reserved bit.

Requires fonttools. Run with --check to validate without modifying files.
"""

import argparse
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]


def check_font(path: Path, check_only: bool) -> bool:
    font = TTFont(path, recalcTimestamp=False)
    assert "fvar" not in font, f"{path}: legacy font must be static"
    changed = 0
    for name in font.getGlyphOrder():
        glyph = font["glyf"][name]
        if glyph.numberOfContours <= 0:
            continue
        for index, flag in enumerate(glyph.flags):
            assert not flag & 0x80, f"{path}: reserved glyph flag in {name}"
            if flag & 0x40:
                changed += 1
                glyph.flags[index] = flag & ~0x40
    if changed and not check_only:
        font.save(path)
    font.close()
    print(f"{path.relative_to(ROOT)}: {changed} overlap flags"
          + (" (removed)" if changed and not check_only else ""))
    return not changed or not check_only


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    paths = sorted((ROOT / "web-display/public/fonts").glob("onest-*.ttf"))
    paths += sorted((ROOT / "backend-api/assets").glob("onest-static-*.ttf"))
    results = [check_font(path, args.check) for path in paths if path.name != "onest-variable.ttf"]
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
