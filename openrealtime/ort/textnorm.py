"""Text normalisation for speech.

Two views of the same assistant text:
  * display text (`to_display`): what goes into transcripts — markdown markup removed, numbers
    and symbols kept as written ("$50").
  * spoken text (`to_speech`): what Kokoro is asked to say — no markdown, code, emoji or URLs;
    numbers, currency, percentages, times, dates, ordinals, units expanded to words
    ("$50" -> "fifty dollars").

Number expansion uses num2words with the target language when available (en, es, fr, it, pt,
de, hi, ja, ...); English is the default.
"""
from __future__ import annotations

import re
import unicodedata

try:
    from num2words import num2words as _n2w
except Exception:  # pragma: no cover
    _n2w = None

__all__ = ["to_display", "to_speech", "strip_markdown", "number_to_words", "SpeechNormalizer"]

# ---------------------------------------------------------------- markdown / symbols
_FENCE = re.compile(r"```.*?(```|$)", re.S)
_INLINE_CODE = re.compile(r"`([^`\n]*)`")
_IMG = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)]*)\)")
_HEADER = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?", re.M)
_HR = re.compile(r"^\s*([-*_]\s*){3,}$", re.M)
_BULLET = re.compile(r"^(\s*)([-*+•]|\d+[.)])\s+", re.M)
_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", re.S)
_ITAL = re.compile(r"(?<![\w*])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*])")
_STRIKE = re.compile(r"~~(.+?)~~")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$", re.M)
_HTML = re.compile(r"</?[a-zA-Z][^>]*>")
_URL = re.compile(r"\b(?:https?://|www\.)[^\s<>()\"']+", re.I)
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")


def _is_emoji(ch: str) -> bool:
    o = ord(ch)
    return (0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF
            or 0xFE00 <= o <= 0xFE0F or o == 0x200D or 0x1F1E6 <= o <= 0x1F1FF
            or 0xE0020 <= o <= 0xE007F or o in (0x203C, 0x2049, 0x2122, 0x2139, 0x3030, 0x303D))


def strip_emoji(s: str) -> str:
    return "".join(ch for ch in s if not _is_emoji(ch))


def strip_markdown(s: str, drop_code: bool = True) -> str:
    """Remove markdown markup, keep the words."""
    s = _FENCE.sub(" " if drop_code else (lambda m: m.group(0).strip("`")), s)
    s = _INLINE_CODE.sub(r"\1", s)
    s = _IMG.sub(r"\1", s)
    s = _LINK.sub(r"\1", s)
    s = _HTML.sub("", s)
    s = _TABLE_SEP.sub("", s)
    s = _HR.sub("", s)
    s = _HEADER.sub("", s)
    s = _BLOCKQUOTE.sub("", s)
    s = _BULLET.sub(r"\1", s)
    s = _BOLD.sub(r"\2", s)
    s = _STRIKE.sub(r"\1", s)
    s = _ITAL.sub(r"\2", s)
    s = s.replace("|", ", ") if s.count("|") >= 2 else s
    return s


def to_display(s: str) -> str:
    """Transcript text: markdown removed, otherwise as written. Leading/trailing spaces kept."""
    lead = s[: len(s) - len(s.lstrip())]
    trail = s[len(s.rstrip()):]
    core = strip_emoji(strip_markdown(s.strip()))
    core = re.sub(r"[ \t]+", " ", core)
    core = re.sub(r"\s*\n\s*", " ", core).strip()
    return (lead + core + trail) if core else ""


# ---------------------------------------------------------------- numbers
def number_to_words(n, lang: str = "en", to: str = "cardinal") -> str:
    if _n2w is None:
        return str(n)
    for lg in (lang, "en"):
        try:
            return _n2w(n, lang=lg, to=to).replace(",", "")
        except (NotImplementedError, OverflowError, ValueError, TypeError, KeyError):
            continue
    return str(n)


_CURRENCY = {
    "$": ("dollar", "dollars", "cent", "cents"),
    "€": ("euro", "euros", "cent", "cents"),
    "£": ("pound", "pounds", "penny", "pence"),
    "¥": ("yen", "yen", "", ""),
    "₹": ("rupee", "rupees", "paisa", "paise"),
    "₺": ("lira", "lira", "kurus", "kurus"),
}
_CURRENCY_CODES = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "INR": "₹", "TRY": "₺"}
_SCALE = {"k": "thousand", "K": "thousand", "m": "million", "M": "million", "mn": "million",
          "b": "billion", "B": "billion", "bn": "billion", "t": "trillion", "T": "trillion",
          "thousand": "thousand", "million": "million", "billion": "billion", "trillion": "trillion"}

_UNITS = {
    "km": ("kilometer", "kilometers"), "m": ("meter", "meters"), "cm": ("centimeter", "centimeters"),
    "mm": ("millimeter", "millimeters"), "kg": ("kilogram", "kilograms"), "g": ("gram", "grams"),
    "mg": ("milligram", "milligrams"), "lb": ("pound", "pounds"), "lbs": ("pound", "pounds"),
    "oz": ("ounce", "ounces"), "mi": ("mile", "miles"), "ft": ("foot", "feet"), "in": ("inch", "inches"),
    "l": ("liter", "liters"), "ml": ("milliliter", "milliliters"), "mph": ("mile per hour", "miles per hour"),
    "km/h": ("kilometer per hour", "kilometers per hour"), "kmh": ("kilometer per hour", "kilometers per hour"),
    "ms": ("millisecond", "milliseconds"), "sec": ("second", "seconds"),
    "min": ("minute", "minutes"), "h": ("hour", "hours"), "hr": ("hour", "hours"), "hrs": ("hour", "hours"),
    "GB": ("gigabyte", "gigabytes"), "MB": ("megabyte", "megabytes"), "KB": ("kilobyte", "kilobytes"),
    "TB": ("terabyte", "terabytes"), "GHz": ("gigahertz", "gigahertz"), "MHz": ("megahertz", "megahertz"),
    "kHz": ("kilohertz", "kilohertz"), "Hz": ("hertz", "hertz"), "°C": ("degree Celsius", "degrees Celsius"),
    "°F": ("degree Fahrenheit", "degrees Fahrenheit"), "°": ("degree", "degrees"),
    "kW": ("kilowatt", "kilowatts"), "W": ("watt", "watts"), "V": ("volt", "volts"),
}
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
           "October", "November", "December"]

_SYMBOLS_EN = {"&": " and ", "%": " percent", "+": " plus ", "=": " equals ", "@": " at ",
               "#": " number ", "°": " degrees", "×": " times ", "÷": " divided by ",
               "≈": " about ", "→": " to ", "←": " from ", "~": " about "}

_ABBR_EN = {
    "e.g.": "for example", "i.e.": "that is", "etc.": "et cetera", "vs.": "versus", "vs": "versus",
    "approx.": "approximately", "Dr.": "Doctor", "Mr.": "Mister", "Mrs.": "Missus", "Ms.": "Miz",
    "St.": "Saint", "Jr.": "Junior", "Sr.": "Senior", "Prof.": "Professor", "No.": "number",
    "a.m.": "a m", "p.m.": "p m",
}


_COMMA_DECIMAL = {"de", "fr", "es", "it", "pt", "tr", "nl", "ru", "pl", "sv", "da", "nb", "fi", "cs"}
_POINT = {"en": "point", "de": "Komma", "fr": "virgule", "es": "coma", "it": "virgola",
          "pt": "vírgula", "tr": "virgül", "nl": "komma"}


def _num_str_to_words(tok: str, lang: str) -> str:
    """'1,234.56' -> words; handles thousands separators, decimals (incl. decimal commas),
    leading zeros (read digit by digit)."""
    t = tok
    if lang in _COMMA_DECIMAL:
        if re.fullmatch(r"\d{1,3}(\.\d{3})+(,\d+)?", t):
            t = t.replace(".", "")
        t = t.replace(",", ".") if re.fullmatch(r"\d+,\d+", t) else t
    if re.fullmatch(r"\d{1,3}(,\d{3})+(\.\d+)?", t):
        t = t.replace(",", "")
    try:
        if re.fullmatch(r"0\d+", t):  # zip codes, ids
            return " ".join(number_to_words(int(d), lang) for d in t)
        if re.fullmatch(r"\d*\.\d+", t):
            a, b = t.split(".", 1)
            whole = number_to_words(int(a or 0), lang)
            return f"{whole} {_POINT.get(lang, 'point')} " + " ".join(number_to_words(int(d), lang) for d in b)
        return number_to_words(int(t), lang)
    except ValueError:
        parts = re.split(r"[^\d]+", t)
        return " ".join(number_to_words(int(p), lang) for p in parts if p)


def _plural(n_str: str, one: str, many: str) -> str:
    try:
        return one if float(n_str.replace(",", "")) == 1 else many
    except ValueError:
        return many


_CURRENCY_L10N = {
    "de": {"$": ("Dollar", "Dollar", "Cent", "Cent"), "€": ("Euro", "Euro", "Cent", "Cent"),
           "£": ("Pfund", "Pfund", "Penny", "Pence")},
    "es": {"$": ("dólar", "dólares", "centavo", "centavos"), "€": ("euro", "euros", "céntimo", "céntimos")},
    "fr": {"$": ("dollar", "dollars", "cent", "cents"), "€": ("euro", "euros", "centime", "centimes")},
    "it": {"$": ("dollaro", "dollari", "centesimo", "centesimi"), "€": ("euro", "euro", "centesimo", "centesimi")},
    "pt": {"$": ("dólar", "dólares", "centavo", "centavos"), "€": ("euro", "euros", "cêntimo", "cêntimos")},
    "tr": {"$": ("dolar", "dolar", "sent", "sent"), "€": ("euro", "euro", "sent", "sent"),
           "₺": ("lira", "lira", "kuruş", "kuruş")},
}


def _money(m: re.Match, lang: str) -> str:
    gd = m.groupdict()
    sym, amount, scale = gd["sym"].strip(), gd["amt"], gd.get("scale")
    sym = _CURRENCY_CODES.get(sym, sym)
    one, many, c1, cn = _CURRENCY_L10N.get(lang, {}).get(sym) or _CURRENCY.get(sym, ("", "", "", ""))
    amt = amount.replace(",", "")
    if scale:
        return f"{_num_str_to_words(amt, lang)} {_SCALE.get(scale, scale)} {many}".strip()
    if "." in amt:
        whole, frac = amt.split(".", 1)
        frac = (frac + "0")[:2]
        w = int(whole or 0)
        c = int(frac)
        parts = []
        if w or not c:
            parts.append(f"{number_to_words(w, lang)} {one if w == 1 else many}")
        if c and c1:
            parts.append(f"{number_to_words(c, lang)} {c1 if c == 1 else cn}")
        return " and ".join(parts)
    return f"{_num_str_to_words(amt, lang)} {_plural(amt, one, many)}".strip()


def _time(m: re.Match, lang: str) -> str:
    h, mi = int(m.group(1)), int(m.group(2))
    ampm = (m.group(3) or "").replace(".", "").lower()
    hw = number_to_words(h, lang)
    if mi == 0:
        s = hw + ("" if ampm else (" o'clock" if lang == "en" and h <= 12 else " hundred" if lang == "en" else ""))
    elif mi < 10 and lang == "en":
        s = f"{hw} oh {number_to_words(mi, lang)}"
    else:
        s = f"{hw} {number_to_words(mi, lang)}"
    if ampm:
        s += " " + " ".join(ampm.upper())
    return s


def _year(y: int, lang: str) -> str:
    if lang != "en":
        return number_to_words(y, lang, "year") if _n2w else str(y)
    if 2000 <= y <= 2009:
        return number_to_words(y, lang)
    if 1100 <= y <= 2099:
        hi, lo = divmod(y, 100)
        if lo == 0:
            return f"{number_to_words(hi, lang)} hundred"
        if lo < 10:
            return f"{number_to_words(hi, lang)} oh {number_to_words(lo, lang)}"
        return f"{number_to_words(hi, lang)} {number_to_words(lo, lang)}"
    return number_to_words(y, lang)


_RE_MONEY = re.compile(
    r"(?P<sym>[$€£¥₹₺]|\b(?:USD|EUR|GBP|JPY|INR|TRY)\s?)(?P<amt>\d(?:[\d,]*\d)?(?:\.\d+)?)"
    r"(?:\s?(?P<scale>(?:[kKmMbBtT]|mn|bn)\b|thousand|million|billion|trillion))?")
_RE_MONEY_POST = re.compile(r"(?P<amt>\d(?:[\d,]*\d)?(?:\.\d+)?)\s?(?P<sym>[€£₺])")
_RE_PERCENT = re.compile(r"(\d(?:[\d,]*\d)?(?:\.\d+)?)\s?%")
_RE_TIME = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)(?:\s?([AaPp](?:\.[Mm]\.|[Mm]\b)))?")
_RE_AMPM = re.compile(r"\b(1[0-2]|0?[1-9])\s?([AaPp])(?:\.[Mm]\.|[Mm]\b)")
_RE_ISO_DATE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_RE_ORD = re.compile(r"\b(\d+)(st|nd|rd|th)\b", re.I)
_RE_RANGE = re.compile(r"\b(\d+)\s?[-–]\s?(\d+)\b")
_RE_YEAR = re.compile(r"\b(1[1-9]\d\d|20\d\d)\b(?!\s?(%|[.,]\d))")
_RE_UNIT = re.compile(r"(\d(?:[\d,]*\d)?(?:\.\d+)?)\s?(" + "|".join(
    re.escape(u) for u in sorted(_UNITS, key=len, reverse=True)) + r")(?![\w])")
_RE_NUM = re.compile(r"(?<![\w.])-?\d(?:[\d,]*\d)?(?:\.\d+)?(?![\w])|(?<![\w.])\d+(?=[a-zA-Z])")
_RE_FRACTION = re.compile(r"\b(\d+)/(\d+)\b")
_RE_PHONEish = re.compile(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b")


def _expand_numbers(s: str, lang: str) -> str:
    en = lang == "en"
    s = _RE_PHONEish.sub(lambda m: " ".join(number_to_words(int(d), lang) for d in re.sub(r"\D", "", m.group(0))), s)
    if en:
        s = re.sub(r"(?<![\w\d])-(?=\d)", "minus ", s)
    s = _RE_MONEY.sub(lambda m: _money(m, lang), s)
    s = _RE_MONEY_POST.sub(lambda m: _money(m, lang), s)
    pct = {"en": "percent", "de": "Prozent", "fr": "pour cent", "es": "por ciento", "it": "per cento",
           "pt": "por cento", "tr": "yüzde"}.get(lang, "percent")
    if lang == "tr":
        s = _RE_PERCENT.sub(lambda m: f"{pct} {_num_str_to_words(m.group(1), lang)}", s)
    else:
        s = _RE_PERCENT.sub(lambda m: f"{_num_str_to_words(m.group(1), lang)} {pct}", s)
    s = _RE_TIME.sub(lambda m: _time(m, lang), s)
    if en:
        s = _RE_AMPM.sub(lambda m: f"{number_to_words(int(m.group(1)), lang)} {m.group(2).upper()} M", s)
        s = _RE_ISO_DATE.sub(lambda m: (f"{_MONTHS[int(m.group(2)) - 1]} "
                                        f"{number_to_words(int(m.group(3)), lang, 'ordinal')}, {_year(int(m.group(1)), lang)}")
                             if 1 <= int(m.group(2)) <= 12 else m.group(0), s)
    if en:
        s = _RE_DECADE.sub(lambda m: _decade(m.group(1)), s)
    s = _RE_VERSION.sub(lambda m: f" {_POINT.get(lang, 'point')} ".join(
        number_to_words(int(p), lang) for p in m.group(0).split(".")), s)
    s = _RE_ORD.sub(lambda m: number_to_words(int(m.group(1)), lang, "ordinal"), s)
    s = _RE_FRACTION.sub(lambda m: _fraction(int(m.group(1)), int(m.group(2)), lang), s)
    if en:
        def unit(m):
            one, many = _UNITS[m.group(2)]
            return f"{_num_str_to_words(m.group(1), lang)} {_plural(m.group(1), one, many)}"
        s = _RE_UNIT.sub(unit, s)
        s = _RE_RANGE.sub(lambda m: f"{m.group(1)} to {m.group(2)}", s)
        s = _RE_YEAR.sub(lambda m: _year(int(m.group(1)), lang), s)
    s = _RE_NUM.sub(lambda m: (("minus " if en else "-") if m.group(0).startswith("-") else "")
                    + _num_str_to_words(m.group(0).lstrip("-"), lang), s)
    return s


_RE_DECADE = re.compile(r"\b(\d{1,3}0)'?s\b")
_RE_VERSION = re.compile(r"\b\d+(?:\.\d+){2,}\b")


def _decade(d: str) -> str:
    n = int(d)
    w = _year(n, "en") if n >= 1000 else number_to_words(n, "en")
    if w.endswith("y"):
        return w[:-1] + "ies"
    return w + "s"


def _fraction(a: int, b: int, lang: str) -> str:
    if lang != "en" or b == 0 or b > 31 or a > 99:
        return f"{number_to_words(a, lang)} {'over' if lang == 'en' else '/'} {number_to_words(b, lang)}"
    special = {2: ("half", "halves"), 4: ("quarter", "quarters")}
    if b in special:
        name = special[b][0 if a == 1 else 1]
    else:
        o = number_to_words(b, lang, "ordinal")
        name = o if a == 1 else o + "s"
    return f"{'one' if a == 1 else number_to_words(a, lang)} {name}"


# ---------------------------------------------------------------- speech
def _url_to_speech(m: re.Match) -> str:
    u = re.sub(r"^(https?://)?(www\.)?", "", m.group(0), flags=re.I)
    host = u.split("/")[0].rstrip(".,;:!?")
    return " " + host.replace(".", " dot ") + " "


def to_speech(s: str, lang: str = "en") -> str:
    """Text Kokoro should say. Returns '' if nothing speakable remains."""
    lang = (lang or "en").lower().split("-")[0]
    s = unicodedata.normalize("NFKC", s)
    s = strip_markdown(s, drop_code=True)
    s = strip_emoji(s)
    s = _EMAIL.sub(lambda m: m.group(0).replace("@", " at ").replace(".", " dot "), s)
    s = _URL.sub(_url_to_speech, s)
    if lang == "en":
        for k, v in _ABBR_EN.items():
            s = re.sub(r"(?<!\w)" + re.escape(k) + r"(?!\w)", v, s)
    s = _expand_numbers(s, lang)
    if lang == "en":
        s = re.sub(r"(?<=\w)\s?&\s?(?=\w)", " and ", s)
        for k, v in _SYMBOLS_EN.items():
            if k in "&%°":
                s = s.replace(k, v)
        s = re.sub(r"(?<=\s)[+=×÷≈→←~](?=\s)", lambda m: _SYMBOLS_EN[m.group(0)], s)
        s = re.sub(r"(?<=\w)/(?=\w)", " or ", s)
    # dashes/bullets/brackets -> pauses
    s = re.sub(r"\s[-–—]{1,2}\s|—|–", ", ", s)
    s = re.sub(r"[()\[\]{}]", ", ", s)
    s = re.sub(r"[*_#`^|<>\\]", " ", s)
    s = re.sub(r'["“”„«»]', "", s)
    s = re.sub(r"([.!?:;,])\s*\n+\s*", r"\1 ", s)
    s = re.sub(r"\s*\n+\s*", ". ", s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    s = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", s)
    s = re.sub(r"^[\s,;:.]+", "", s)
    s = re.sub(r",\s*([.!?])", r"\1", s)
    s = re.sub(r"[\s,;:]+$", "", s).strip()
    return s if re.search(r"\w", s) else ""


class SpeechNormalizer:
    """Stateful helper for streams: drops text inside ``` fences that span chunks."""

    def __init__(self, lang: str = "en"):
        self.lang = lang
        self.in_fence = False

    def __call__(self, segment: str) -> tuple[str, str]:
        """segment (raw) -> (display_text, spoken_text)."""
        out, rest = [], segment
        while rest:
            i = rest.find("```")
            if i < 0:
                if not self.in_fence:
                    out.append(rest)
                break
            if not self.in_fence:
                out.append(rest[:i])
            self.in_fence = not self.in_fence
            rest = rest[i + 3:]
        raw = "".join(out)
        return to_display(raw), to_speech(raw, self.lang)
