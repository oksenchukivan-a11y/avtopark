"""Звіт менеджеру після рейсу (рішення власника 27.11: «після маршруту інформація від водія йде менеджеру —
що доставилось, що забралося, що ні і чому»). Кожен менеджер бачить лише своїх клієнтів:
сьогоднішні накладні й борги, де він менеджер. Поки власник не сказав «запускай» — приклад іде лише йому."""
from datetime import date
from html import escape as h

from . import engine as e
from . import store, view

DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"]


def _mine(st, mgr):
    ride = [i for i in e.riding(st) if e.clean(i.get("manager")) == mgr]
    debts = [d for d in e.debts(st) if e.clean(d.get("manager")) == mgr]
    return ride, debts


def _row(st, ride, debts):
    """(розділ, html, забрано, належало) для однієї точки з погляду менеджера."""
    s = st["status"] or {}
    refs = {i["ref"] for i in ride} | {d["ref"] for d in debts}
    owe = round(sum(i["sum"] for i in ride if "BO" not in i["tags"]) + sum(d["sum"] for d in debts), 2)
    got = round(sum(a["paid"] for a in s.get("alloc", []) if a["ref"] in refs), 2)
    name = f"<b>{h(st['name'])}</b>"
    probs = [p for p in st.get("probs", []) if p["inv"] in {i["no"] for i in ride} or p["inv"] == "—"]
    extra = "".join(f"\n⚠️ {h(e.PROBLEMS.get(p['kind'], p['kind']))}: {h(p['item'])}"
                    + (f" × {p['qty']}" if p.get("qty") else "") + (f" (−{e.money(p['cut'])})" if p["cut"] else "")
                    for p in probs)
    kind = s.get("kind")
    if kind == "given" or (owe < 0.01 and ride):
        return "free", f"{name}\nвіддав товар, без оплати{extra}", got, owe
    if got >= owe - 0.005 and got > 0:
        return "paid", f"{name}  <b>{e.money(got)}</b>{extra}", got, owe
    if got > 0:
        return "part", f"{name}\nвзяв <b>{e.money(got)}</b> з {e.money(owe)} · лишилось {e.money(owe - got)}{extra}", got, owe
    if kind == "back":
        return "back", f"{name} · {e.money(owe)}\n{h(s.get('text', ''))}{extra}", got, owe
    return "none", f"{name} · {e.money(owe)}\n{h(s.get('text', ''))}{extra}", got, owe


SECTIONS = [("paid", "✅", "Забрав гроші"), ("part", "🟡", "Частково"), ("none", "🚫", "Без грошей"),
            ("back", "↩️", "Товар не залишив"), ("free", "⚪", "Без оплати (за домовленістю)")]


def build(run, title="", drivers=""):
    """{менеджер: html} — по одному повідомленню на менеджера."""
    by = {}
    for st in run["stops"]:
        if not st.get("status"):
            continue
        mgrs = {e.clean(i.get("manager")) for i in e.riding(st)} | {e.clean(d.get("manager")) for d in e.debts(st)}
        for m in sorted(filter(None, mgrs)):
            ride, debts = _mine(st, m)
            if ride or debts:
                by.setdefault(m, []).append(_row(st, ride, debts))
    d = run.get("day", "")
    try:
        dd = date.fromisoformat(d)
        day = f"{DAYS[dd.weekday()]} {dd:%d.%m}"
    except ValueError:
        day = d
    people, out = store.people(), {}
    for m, rows in by.items():
        v = view.mgr_view(m, people)
        got = round(sum(r[2] for r in rows), 2)
        left = round(sum(r[3] - r[2] for r in rows if r[0] in ("part", "none", "back")), 2)
        lines = [f"🚚 <b>Рейс · {h(day)}</b>" + (f" · {h(title)}" if title else ""),
                 (f"водій: {h(drivers)}" if drivers else None), "",
                 f"{h(v['label'])} · твої клієнти: <b>{len(rows)}</b>",
                 f"💰 Забрано <b>{e.money(got)}</b>" + (f"\n🔴 Не забрано <b>{e.money(left)}</b>" if left > 0.005 else "")]
        groups = {k: [r[1] for r in rows if r[0] == k] for k, _, _ in SECTIONS}
        for k, ico, cap in SECTIONS:
            if groups[k]:
                lines += ["", f"{ico} <b>{cap} — {len(groups[k])}</b>",
                          "<blockquote>" + "\n\n".join(groups[k]) + "</blockquote>"]
        out[m] = "\n".join(x for x in lines if x is not None)
    return out
