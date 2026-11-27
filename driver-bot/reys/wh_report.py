"""Помилки складу з рейсу (рішення власника 27.11): «не вистачає», «не той товар», «пошкоджено» —
ознака, що комірник помилився при зборі. Після закриття рейсу позиції збираються, до кожної — хто збирав
(Кладовщик у накладній 1С), записуються в reys_wh_probs. Звідти — підсумок місяця на кожного комірника.
Поки — лише власникові як приклад; комірникам — після його «запускай»."""
import logging
from datetime import date, datetime
from html import escape as h

from . import engine as e
from . import onec, store

log = logging.getLogger(__name__)
KINDS = ("miss", "wrong", "dmg")           # «клієнт відмовився» — не помилка складу
ICON = {"miss": "➖", "wrong": "🔁", "dmg": "💥"}
DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"]
MONTHS = ["", "січень", "лютий", "березень", "квітень", "травень", "червень", "липень",
          "серпень", "вересень", "жовтень", "листопад", "грудень"]
NOBODY = "комірник не вказаний у 1С"
SHOW = 15                                  # скільки позицій на комірника показуємо в повідомленні (ліміт Telegram)


def init():
    with store.db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS reys_wh_probs(
            day TEXT NOT NULL, inv_no TEXT NOT NULL, client TEXT, kind TEXT NOT NULL, item TEXT NOT NULL,
            qty REAL, picker TEXT, driver TEXT, test INTEGER DEFAULT 0, ts TEXT,
            UNIQUE(day, inv_no, client, kind, item))""")


def _found(run):
    """[(точка, проблема, накладна або None, усі накладні точки)] — лише помилки складу.
    Ту саму позицію, відмічену кілька разів (по одній штуці), зводимо в один рядок із сумою."""
    out, seen = [], {}
    for n, st in enumerate(run["stops"]):
        by_no = {i["no"]: i["ref"] for i in st.get("inv", [])}
        for p in st.get("probs", []):
            if p["kind"] not in KINDS:
                continue
            k = (n, p["inv"], p["kind"], p["item"])
            if k in seen:
                was = seen[k]
                was["qty"] = (was["qty"] or 1) + (p.get("qty") or 1)      # «інший товар» двічі — це дві позиції
                continue
            ref = by_no.get(p["inv"])
            if not ref and len(by_no) == 1:          # «інший товар» на точці з однією накладною
                ref = next(iter(by_no.values()))
            seen[k] = dict(p, qty=p.get("qty") or 0)
            out.append((st, seen[k], ref, list(by_no.values())))
    return out


async def _pickers(refs):
    """{ref накладної: ім'я комірника} з 1С (лише читання)."""
    rows = await onec.by_keys("Document_РеализацияТоваровУслуг", refs, "Ref_Key,Кладовщик_Key")
    keys = {r["Ref_Key"]: r.get("Кладовщик_Key") for r in rows}
    names = {n["Ref_Key"]: " ".join(n["Description"].split())
             for n in await onec.by_keys("Catalog_ФизическиеЛица", set(keys.values()), "Ref_Key,Description")}
    return {ref: names.get(k, NOBODY) for ref, k in keys.items()}


def _month(day: str):
    with store.db() as c:
        return c.execute("""SELECT picker, kind, SUM(CASE WHEN qty>0 THEN qty ELSE 1 END) n FROM reys_wh_probs
                            WHERE test=0 AND substr(day,1,7)=? GROUP BY picker, kind""", (day[:7],)).fetchall()


async def collect(run, title="", driver="", trial=False):
    """Записує помилки складу рейсу і повертає html для власника (None — помилок нема).
    trial — пробний рейс власника по справжній путівці: у місячний підсумок комірників він не йде."""
    found = _found(run)
    if not found:
        return None
    refs = {ref for _, _, ref, _ in found if ref} | {r for *_, all_ in found for r in all_}
    try:
        who = await _pickers(refs)
    except onec.OneCError as ex:
        log.warning("reys: комірників з 1С не взято: %s", ex)
        who = {}
    day, test = run.get("day", ""), 1 if trial or run.get("demo") or run.get("snap") else 0
    rows = []
    for st, p, ref, all_ in found:
        picker = who.get(ref) if ref else None
        if not picker:                              # кілька накладних — комірник однаковий? тоді він
            ps = {who.get(r) for r in all_} - {None}
            picker = ps.pop() if len(ps) == 1 else NOBODY
        rows.append((day, p["inv"], st["name"], p["kind"], p["item"], p.get("qty") or 0, picker, driver, test,
                     datetime.now().isoformat(timespec="seconds")))
    with store.db() as c:
        # повторний збір того самого рейсу нічого не задвоює; справжній рейс замінює пробний запис про ту саму позицію
        c.executemany("""INSERT INTO reys_wh_probs VALUES(?,?,?,?,?,?,?,?,?,?)
                         ON CONFLICT(day, inv_no, client, kind, item) DO UPDATE SET qty=excluded.qty,
                         picker=excluded.picker, driver=excluded.driver, test=0, ts=excluded.ts
                         WHERE reys_wh_probs.test=1 AND excluded.test=0""", rows)
    try:
        dd = date.fromisoformat(day)
        dtxt = f"{DAYS[dd.weekday()]} {dd:%d.%m}"
    except ValueError:
        dd, dtxt = None, day
    by = {}
    for r in rows:
        by.setdefault(r[6], []).append(r)
    n_all = sum(r[5] or 1 for r in rows)
    lines = ["📦 <b>Склад · помилки збору</b>", f"рейс {h(dtxt)}" + (f" · {h(title)}" if title else "")
             + (f" · {h(driver)}" if driver else ""), "", f"Позицій: <b>{n_all:g}</b>"]
    for picker, rs in sorted(by.items(), key=lambda x: -len(x[1])):
        lines += ["", f"👤 <b>{h(picker)}</b> — {sum(r[5] or 1 for r in rs):g} шт"]
        lines.append("<blockquote>" + "\n\n".join(
            f"{ICON[r[3]]} {h(e.PROBLEMS[r[3]])}: <b>{h(r[4])}</b>" + (f" × {r[5]:g}" if r[5] else "")
            + f"\n{h(r[2])} · № {h(r[1])}" for r in rs[:SHOW])
            + (f"\n\n… і ще {len(rs) - SHOW}" if len(rs) > SHOW else "") + "</blockquote>")
    if dd:
        tot = {}
        for m in _month(day):
            tot.setdefault(m["picker"], {})[m["kind"]] = m["n"]
        if tot:
            lines += ["", f"🗓 <b>За {MONTHS[dd.month]}</b>"]
            for picker, ks in sorted(tot.items(), key=lambda x: -sum(x[1].values())):
                parts = " · ".join(f"{e.PROBLEMS[k]} {ks[k]:g}" for k in KINDS if ks.get(k))
                lines.append(f"{h(picker)} — <b>{sum(ks.values()):g}</b>\n<i>{parts}</i>")
    if test:
        lines += ["", "<i>пробний рейс — у місячний підсумок не йде</i>"]
    return "\n".join(lines)
