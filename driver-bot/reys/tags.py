"""Розбір коментаря менеджера із заявки: мітки для водія і день доставки."""
import re
from datetime import date, timedelta

_L = r"[а-яіїєґёa-z]"
_RX = {
    "SV": re.compile(rf"(?<!{_L})св(?!{_L})|самовив|самовыв"),
    "BO": re.compile(r"без\s*оплат|(?<![а-яіїєґё])б\s*[/\\]\s*[о0o](?![а-яіїєґё])"),
    "NP": re.compile(rf"(?<!{_L})нп(?!{_L})|нов\w+\s+по[чш]т|поштомат|укрпо[чш]т"),
    "CALL": re.compile(r"набрат|зателеф|подзвон|позвон"),
    "DEBT": re.compile(r"забр\w*\.?\s*(борг|грош|деньг|долг)"),
    "RET": re.compile(r"поверненн|возврат|забр\w*\.?\s*возвр"),
}
_WD = [r"понеділ\w*|понедельн\w*", r"вівтор\w*|вторн\w*", r"серед[уаи]|сред[уаы]",
       r"четвер\w*|четверг\w*", r"п.?ятниц\w*", r"субот\w*|суббот\w*"]
_WD_RX = [re.compile(rf"(?<!{_L})(?:{p})") for p in _WD]
_DATE_RX = re.compile(r"(?<!\d)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?!\d)")

LABELS = {"SV": "самовивіз", "BO": "без оплати", "NP": "Нова пошта", "CALL": "набрати",
          "DEBT": "забрати борг", "RET": "забрати повернення", "DATE": "доставка пізніше"}


_SV_OFF = re.compile(r"з\s+св\s+на\s+доставк")      # «з св на доставку» — передумали, везти


def tags_of(comment: str) -> set:
    t = (comment or "").lower()
    out = {k for k, rx in _RX.items() if rx.search(t)}
    if "SV" in out and _SV_OFF.search(t):
        out.discard("SV")
    return out


def delivery_date(comment: str, ordered: date):
    """День, на який менеджер просив доставку, або None, якщо не вказано.

    Порядок: явна дата «20.11» → день тижня «на п'ятницю» → «завтра».
    Час («до 15.00») датою не вважається: місяця 00 чи 30 не буває.
    """
    t = (comment or "").lower()
    for m in _DATE_RX.finditer(t):
        d, mo = int(m.group(1)), int(m.group(2))
        if not (1 <= d <= 31 and 1 <= mo <= 12):
            continue
        y = ordered.year
        try:
            cand = date(y, mo, d)
        except ValueError:
            continue
        if cand < ordered - timedelta(days=30):      # «05.01» у грудні — це наступний рік
            cand = date(y + 1, mo, d)
        if -1 <= (cand - ordered).days <= 30:
            return cand
    for wd, rx in enumerate(_WD_RX):
        if rx.search(t):
            ahead = (wd - ordered.weekday()) % 7 or 7
            return ordered + timedelta(days=ahead)
    if "завтра" in t:
        nxt = ordered + timedelta(days=1)
        while nxt.weekday() >= 5:                    # сб, нд не возять
            nxt += timedelta(days=1)
        return nxt
    return None


def short_comment(comment: str, limit: int = 140) -> str:
    c = re.sub(r"\s+", " ", comment or "").strip()
    return c if len(c) <= limit else c[: limit - 1] + "…"


_PROMO = re.compile(r"акц|знижк|скидк|подар|пробн|сошет|каталог|\d\s*\+\s*\d|\d\s*%|%\s*\d|^-?\d+$"
                    r"|^факт$|провести сьогодні|скинь фото|напиши суму"
                    # рішення власника 27.11: «додай, доклади, вклади…» — це оператору складу, водієві не показуємо
                    r"|добав|додат|додай|долож|доклад|докин|дозбир|дозібр|вклад|вложи|поклад|положи|поклас")


def driver_comment(comment: str, limit: int = 140) -> str:
    """Лишає з коментаря менеджера те, що стосується доставки; акції й знижки — це для складу."""
    parts = [x.strip(" .") for x in re.split(r"[,;\n]|\.(?!\d)", comment or "")]   # крапку в «20.11» не чіпаємо
    keep = [x for x in parts if x and not _PROMO.search(x.lower())]
    return short_comment(", ".join(keep), limit)
