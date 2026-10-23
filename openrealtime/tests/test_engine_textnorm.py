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
    ("Call 555-123-4567", "Call five five five one two three four five six seven"),
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
