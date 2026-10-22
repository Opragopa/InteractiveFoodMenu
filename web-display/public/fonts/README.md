# Onest on old TVs

`onest-variable.ttf` is for modern browsers. Legacy screens use the static TTFs.

The static files must not contain the `OVERLAP_SIMPLE` glyph flag (bit 6).
FontTools instancing can set this flag; Chromium 38's OpenType Sanitizer treats
it as reserved and rejects the entire font with `glyf: Bad flag value (83)`.
Removing this flag leaves the glyph coordinates, character map and advances
unchanged. Do not regenerate the static fonts without this compatibility step:

```sh
python3 -m pip install fonttools
python3 scripts/fix-legacy-fonts.py
python3 scripts/fix-legacy-fonts.py --check
```

The script also fixes the historical regular/semibold/bold aliases and the two
backend measurement fonts. It deliberately leaves the modern variable font alone.
Static font URLs use `?v=2` in both CSS and server HTML to bypass cached copies.
Bump that version in both places when replacing these assets again.

The repaired files were checked with the August 2014 OTS source at
https://github.com/khaledhosny/ots/tree/2a1859a6629bdb6f2915b1d3041621dbd396a4f7
(built with `OTS_DISABLE_WOFF2`). All 12 web static TTFs pass without warnings;
all 12 originals fail at the first glyph. This checks the old sanitizer, not an
actual webOS/Tizen device.
