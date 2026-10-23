import pytest

import engine_common  # noqa: F401
from ort.textnorm import SpeechNormalizer, to_display, to_speech


@pytest.mark.parametrize("src,expected", [
    ("It costs $50.", "It costs fifty dollars."),
    ("That's $3.99", "That's three dollars and ninety-nine cents"),
    ("€1,200 total", "one thousand two hundred euros total"),
    ("Valued at $1.5M", "Valued at one point five million dollars"),
    ("Growth was 12.5%.", "Growth was twelve point five percent."),
    ("Meet at 3:30 pm.", "Meet at three thirty P M."),
    ("At 9am.", "At nine A M."),
    ("On the 21st floor", "On the twenty-first floor"),
    ("In 1999 and 2024", "In nineteen ninety-nine and twenty twenty-four"),
    ("The 1990s", "The nineteen nineties"),
    ("It was -5°C", "It was minus five degrees Celsius"),
    ("Add 1/2 cup", "Add one half cup"),
    ("Pages 10-20", "Pages ten to twenty"),
    ("Run 5 km", "Run five kilometers"),
    ("I have 3 cats and 1 dog", "I have three cats and one dog"),
    ("Call 555-123-4567", "Call five five five, one two three, four five six seven"),
])
def test_numbers_en(src, expected):
    assert to_speech(src) == expected


def test_markdown_emoji_urls_code():
    s = to_speech("**Bold** and *italic* with `code` 😀 see https://www.example.com/a?b=1")
    assert s == "Bold and italic with code see example dot com"
    s = to_speech("# Title\n- item one\n- item two")
    assert "#" not in s and "-" not in s and "item one" in s
    s = to_speech("Here:\n```python\nprint(1)\n```\nDone.")
    assert "print" not in s and "Done" in s
    assert to_speech("😀🎉") == ""
    assert to_speech("```\ncode only\n```") == ""


def test_display_vs_spoken_separate():
    t = "Your total is **$42.50** 😊"
    assert to_display(t) == "Your total is $42.50"
    assert to_speech(t) == "Your total is forty-two dollars and fifty cents"
    # leading space kept so concatenated segments reproduce the transcript
    assert to_display(" and more.") == " and more."


def test_other_languages():
    assert to_speech("Es kostet 50 € und 3,5 Prozent.", "de") == "Es kostet fünfzig Euro und drei Komma fünf Prozent."
    assert "vingt euros" in to_speech("Il coûte 20 €.", "fr")
    assert "por ciento" in to_speech("Sube un 7%.", "es")


def test_stream_normalizer_drops_fence_across_segments():
    n = SpeechNormalizer("en")
    assert n("Look at this. ```py")[1] == "Look at this."
    assert n("x = 1\n")[1] == ""
    assert n("``` That was code.")[1] == "That was code."


# ---------------------------------------------------------------- hardening
import re  # noqa: E402

from ort.textnorm import number_to_words  # noqa: E402

EN_LEAKS = {"and", "point", "percent", "thousand", "million", "billion", "hundred", "oclock",
            "over", "number", "degrees", "cents", "pounds", "to", "oh"}   # ('minus', 'dollars' are German/French too)
NUMERIC_TEXTS = {
    "de": ["Das kostet 12,50 € und 1.234,56 € insgesamt.", "Es waren -5 Grad, 15% mehr und 3,5 kg.",
           "Am 3. Mai um 14:30 Uhr, Version v2.1, Telefon 030 1234567.", "Termin am 2024-03-15 oder 12.05.2024.",
           "Die 1990er Jahre, 10 km, $1.5M, 3/4 und 16:9."],
    "es": ["Cuesta 12,50 € y son las 14:30.", "El 15% de 1.234 personas, -5 grados, 10 km.",
           "La versión v2.1 salió el 2024-03-15, cuesta $1.5M."],
    "fr": ["Ça coûte 12,50 € et il est 14h30.", "15 % de 1 234 personnes, -5 degrés, 10 km.",
           "Le 1er mai 2023 à 9:05, la v2.1 coûte $1.5M."],
}


@pytest.mark.parametrize("lang", sorted(NUMERIC_TEXTS))
def test_no_english_words_in_other_languages(lang):
    for t in NUMERIC_TEXTS[lang]:
        out = to_speech(t, lang)
        words = set(re.sub(r"[^\w\s]", "", out.lower()).split())
        assert not (words & EN_LEAKS), (t, out)
        assert not re.search(r"\d", out), (t, out)          # every number was spoken


@pytest.mark.parametrize("lang,src,expected", [
    ("de", "Das kostet 12,50 €.", "Das kostet zwölf Euro und fünfzig Cent."),       # was 'eintausendzweihundertfünfzig'
    ("es", "Cuesta 12,50 €.", "Cuesta doce euros y cincuenta céntimos."),
    ("de", "Es waren -5 Grad.", "Es waren minus fünf Grad."),
    ("de", "Am 3. Mai.", "Am dritten Mai."),
    ("de", "Termin am 2024-03-15.", "Termin am fünfzehnten März zweitausendvierundzwanzig."),
    ("de", "Um 14:30 Uhr.", "Um vierzehn Uhr dreißig."),
    ("de", "Die 1990er Jahre.", "Die neunzehnhundertneunziger Jahre."),
    ("de", "Dr. Müller, z.B. hier.", "Doktor Müller, zum Beispiel hier."),
    ("de", "Telefon 030 1234567.", "Telefon null drei null, eins zwei drei vier fünf sechs sieben."),
    ("fr", "Il est 14h30.", "Il est quatorze heures trente."),
    ("fr", "Le 1er mai.", "Le premier mai."),
    ("fr", "Pour 1 234 personnes.", "Pour mille deux cent trente-quatre personnes."),
    ("fr", "À 9:05.", "À neuf heures cinq."),
    ("es", "La v2.1 y 10 km.", "La versión dos coma uno y diez kilómetros."),
])
def test_localized_numbers(lang, src, expected):
    assert to_speech(src, lang) == expected


def test_unsupported_language_keeps_digits_not_english():
    # num2words lacks Vietnamese (it even raised AttributeError) and Swedish ordinals: keep digits
    assert "nineteen" not in number_to_words(1990, "vi", "year")      # used to raise AttributeError
    assert number_to_words(3, "xx", "ordinal") == "3."
    assert number_to_words(5, "xx") == "5"
    assert "point" not in to_speech("Jag har 3,5 kg och 12 katter", "sv")
    assert "five" not in to_speech("Tôi có 5 con mèo, năm 1990", "vi")


@pytest.mark.parametrize("src,expected", [
    ("No. I don't think so.", "No. I don't think so."),      # was 'number I don't think so.'
    ("He is No. 1.", "He is number one."),
    ("We live on Main St.", "We live on Main Street"),
    ("St. Louis is nice.", "Saint Louis is nice."),
    ("Approx. 2 kg.", "approximately two kilograms."),
    ("E.g. this one.", "for example this one."),
    ("Upgrade to v2.1 now.", "Upgrade to version two point one now."),
    ("Version v2 is out.", "version two is out."),
    ("Call +1 (555) 123-4567.", "Call plus one, five five five, one two three, four five six seven."),
    ("Call +44 20 7946 0958.", "Call plus four four, two zero, seven nine four six, zero nine five eight."),
    ("The ratio is 16:9.", "The ratio is sixteen to nine."),
    ("It costs $1,234.56 today.", "It costs one thousand two hundred and thirty-four dollars and fifty-six cents today."),
    ("Down 3.5% to -12.5 degrees.", "Down three point five percent to minus twelve point five degrees."),
    ("Order #42.", "Order number forty-two."),
])
def test_english_edge_cases(src, expected):
    assert to_speech(src, "en") == expected


@pytest.mark.parametrize("src", ["", "   ", "\n\n", "```\ncode only\n```", "🎉🚀", "| --- | --- |", "**", "---"])
def test_nothing_speakable(src):
    assert to_speech(src, "en") == ""


def test_markdown_table_list_code_url_email():
    md = ("Here are the options:\n\n| Plan | Price |\n|---|---|\n| Basic | $5 |\n| Pro | €12.50 |\n\n"
          "1. **Fast** setup\n2. *Easy* config\n\n```bash\nrm -rf /\n```\n"
          "See https://example.com/docs?x=1 or mail support@example.com.")
    out = to_speech(md, "en")
    assert "rm" not in out and "|" not in out and "*" not in out and "http" not in out
    assert "five dollars" in out and "twelve euros and fifty cents" in out
    assert "example dot com" in out and "support at example dot com" in out
