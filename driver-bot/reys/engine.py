"""Правила рейсу: скільки до збору, як розкласти оплату, коли рейс можна здати."""
from datetime import datetime

REASONS = {"acct": "скине на рахунок", "mgr": "домовилась з менеджером",
           "nomoney": "нема грошей", "closed": "зачинено"}
PROBLEMS = {"miss": "не вистачає", "wrong": "не той товар", "dmg": "пошкоджено", "refuse": "клієнт відмовився"}
MIN_DEBT = 10.0     # борг менший за це водієві не показуємо і не збираємо


def money(x: float) -> str:
    """1501 → «1 501 ₴», 2007.01 → «2 007,01 ₴»."""
    x = round(x + 0.0, 2)
    whole = abs(x - round(x)) < 0.005
    s = f"{x:,.0f}" if whole else f"{x:,.2f}"
    return s.replace(",", " ").replace(".", ",") + " ₴"


def riding(st):
    """Сьогоднішні накладні, які справді їдуть у рейсі."""
    return [i for i in st["inv"] if not {"SV", "NP", "DATE"} & set(i["tags"])]


def free(st) -> bool:
    """Менеджер написав «без оплати» на все, що їде."""
    r = riding(st)
    return bool(r) and all("BO" in i["tags"] for i in r)


def debts(st):
    """Старі неоплачені накладні. Поки не завантажені з 1С — один рядок із путівки."""
    if st["debts"] is not None:
        return [d for d in st["debts"] if d["sum"] >= MIN_DEBT]
    if st["sheet_debt"] >= MIN_DEBT:
        return [{"ref": "", "no": "борг", "date": "", "sum": st["sheet_debt"]}]
    return []


def today_due(st) -> float:
    return round(sum(i["sum"] for i in riding(st) if "BO" not in i["tags"]), 2)


def debt_due(st) -> float:
    return round(sum(d["sum"] for d in debts(st)), 2)


def due(st) -> float:
    return round(today_due(st) + debt_due(st), 2)


def payable(st):
    """Усе, за що можна взяти гроші: спершу старі накладні від найдавнішої, потім сьогоднішні."""
    old = [{"ref": d["ref"], "no": d["no"], "sum": d["sum"], "old": True, "date": d.get("date", "")}
           for d in sorted(debts(st), key=lambda d: d.get("date", ""))]
    new = [{"ref": i["ref"], "no": i["no"], "sum": i["sum"], "old": False, "date": i["date"]}
           for i in riding(st) if "BO" not in i["tags"]]
    return old + new


def allocate(st, amount: float):
    """Розкладає суму від найстарішої накладної. Повертає (розклад, надлишок)."""
    rest, out = round(amount, 2), []
    for p in payable(st):
        paid = round(min(rest, p["sum"]), 2)
        rest = round(rest - paid, 2)
        out.append({"ref": p["ref"], "no": p["no"], "paid": paid, "of": p["sum"], "old": p["old"]})
    return out, rest


def _stamp(st, tg_id, **kw):
    st["status"] = {"ts": datetime.now().isoformat(timespec="seconds"), "by": tg_id,
                    "due": due(st), "cash": 0.0, "alloc": [], **kw}


def pay(st, tg_id, picked, note="забрав"):
    """picked — список (ref, скільки). Усе інше лишається боргом."""
    want = dict(picked)
    alloc = [{"ref": p["ref"], "no": p["no"], "paid": round(want.get(p["ref"], 0.0), 2), "of": p["sum"],
              "old": p["old"]} for p in payable(st)]
    cash = round(sum(a["paid"] for a in alloc), 2)
    kind = "paid" if abs(cash - due(st)) < 0.005 else "part"
    _stamp(st, tg_id, kind=kind, cash=cash, alloc=alloc, text=note if kind == "part" else "забрав усе")


def pay_all(st, tg_id):
    pay(st, tg_id, [(p["ref"], p["sum"]) for p in payable(st)])


def pay_today(st, tg_id):
    pay(st, tg_id, [(p["ref"], p["sum"]) for p in payable(st) if not p["old"]], note="тільки сьогоднішнє")


def pay_amount(st, tg_id, amount):
    """Довільна сума: розкладаємо від найстарішої. Надлишок не обліковуємо (решта водієві)."""
    alloc, _ = allocate(st, amount)
    pay(st, tg_id, [(a["ref"], a["paid"]) for a in alloc], note="частково")


def mark_none(st, tg_id, reason, left=True):
    """Грошей не взяв. left=False — товар теж не залишив (зачинено або боржник)."""
    _stamp(st, tg_id, kind="none" if left else "back", text=REASONS.get(reason, reason), reason=reason)


def mark_given(st, tg_id):
    _stamp(st, tg_id, kind="given", text="віддав товар, без оплати")


def add_problem(st, inv_ref, kind, item, qty, price):
    """Нестача чи відмова: зменшує суму накладної, запис лишається для комірника."""
    for i in st["inv"]:
        if i["ref"] == inv_ref:
            cut = round(min(i["sum"], qty * price), 2)
            i["sum"] = round(i["sum"] - cut, 2)
            st["probs"].append({"inv": i["no"], "kind": kind, "item": item, "qty": qty, "cut": cut})
            return cut
    return 0.0


def route(run):
    return [s for s in run["stops"] if s["where"] == "route"]


def open_stops(run):
    return [s for s in route(run) if not s["status"]]


def totals(run):
    """Підсумок рейсу для екрана здачі каси."""
    done = [s for s in run["stops"] if s["status"]]
    cash = round(sum(s["status"]["cash"] for s in done), 2)
    spent = round(sum(e["sum"] for e in run["expenses"]), 2)
    unpaid, why = 0.0, {}
    for s in done:
        st = s["status"]
        if st["kind"] in ("part", "none"):
            unpaid += st["due"] - st["cash"]
            why[st["text"]] = why.get(st["text"], 0) + 1
    return {"cash": cash, "spent": spent, "hand": round(cash - spent, 2),
            "paid_stops": sum(1 for s in done if s["status"]["cash"] > 0),
            "unpaid": round(unpaid, 2), "why": why,
            "back": sum(1 for s in done if s["status"]["kind"] == "back"),
            "probs": sum(len(s["probs"]) for s in run["stops"]),
            "left": len(open_stops(run)), "stops": len(route(run))}
