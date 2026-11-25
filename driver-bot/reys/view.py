"""Готує рейс для екрана застосунку: усі суми й підписи рахує сервер, екран тільки малює."""
import os

from . import engine as e
from . import store
from .tags import LABELS, driver_comment

SKIP_WHY = {"SV": "самовивіз", "NP": "Нова пошта", "DATE": "доставка в інший день"}


def dm(iso: str) -> str:
    return f"{iso[8:10]}.{iso[5:7]}" if iso and len(iso) >= 10 else ""


def _debt_name(d):
    if d["no"] == "борг":
        return "за попередні накладні"
    if d["no"] == "давня":
        return "давня накладна"
    return f"№ {d['no']}" + (f" від {dm(d['date'])}" if d.get("date") else "")


def prefixes():
    """Напрямок, який 1С сама пише першим словом в імені менеджера. Перекривається таблицею напрямків."""
    raw = os.environ.get("REYS_PREFIXES", "Манікюр=манікюр,Niceme=волосся")
    return {k.strip().casefold(): v.strip() for k, _, v in (x.partition("=") for x in raw.split(",")) if k.strip() and v.strip()}


def mgr_view(name, people):
    """Менеджер для кнопки дзвінка: «Манікюр Прізвище Ім'я» → підпис «Ім'я · манікюр»."""
    name = e.clean(name)
    phone, direction = people.get(store.key(name), ("", ""))
    words = name.split()
    by_prefix = prefixes().get(words[0].casefold(), "") if len(words) > 1 else ""
    if by_prefix:
        words = words[1:]                               # префікс-напрямок у підписі не повторюємо
    direction = direction or by_prefix
    short = (words[1] if len(words) > 1 else " ".join(words)) if direction else " ".join(words)
    return {"name": name, "short": short, "dir": direction, "phone": phone or "",
            "label": short + (f" · {direction}" if direction else "")}


def stop_view(st, i, people):
    ride = e.riding(st)
    free = e.free(st)
    comments = []
    for inv in st["inv"]:
        c = driver_comment(inv["comment"])
        if c and c not in comments:
            comments.append(c)
    flags = sorted({t for inv in ride for t in inv["tags"]} & {"CALL", "DEBT", "RET"})
    wait = []
    for inv in st["inv"]:
        why = [SKIP_WHY[t] for t in ("SV", "NP", "DATE") if t in inv["tags"]]
        if why:
            wait.append({"no": inv["no"], "sum": inv["sum"], "why": why[0], "when": dm(inv.get("deliver", ""))})
    mgrs = [mgr_view(n, people) for n in e.managers(st)]
    many = len(mgrs) > 1
    mgr = mgrs[0]["name"] if mgrs else ""
    s = st["status"]
    return {
        "i": i, "where": st["where"], "name": st["name"], "addr": st["addr"], "manager": mgr,
        "mgrs": mgrs, "debt_mgrs": e.debt_managers(st), "phones": st.get("phones") or [],
        "comments": comments, "flags": [LABELS[t] for t in flags], "free": free,
        "due": e.due(st), "today": e.today_due(st), "debt": e.debt_due(st),
        "ride": [{"ref": x["ref"], "no": x["no"], "sum": x["sum"], "bo": "BO" in x["tags"],
                  "mgr": e.clean(x.get("manager", "")), "who": mgr_view(x.get("manager", ""), people)["short"] if many else ""} for x in ride],
        "wait": wait,
        "debts": [{"name": _debt_name(d), "sum": d["sum"], "mgr": e.clean(d.get("manager", "")),
                   "who": mgr_view(d.get("manager", ""), people)["short"] if many else ""}
                  for d in sorted(e.debts(st), key=lambda d: d.get("date", ""))],
        "pay": [{"k": k, "name": _debt_name(p) if p["old"] else f"№ {p['no']} · сьогодні", "sum": p["sum"],
                 "old": p["old"]} for k, p in enumerate(e.payable(st))],
        "over": round(-st["sheet_debt"], 2) if st["sheet_debt"] <= -e.MIN_DEBT else 0,
        "probs": [{"text": f"{e.PROBLEMS[p['kind']]}: {p['item']}{e.qty_txt(p)}", "cut": p["cut"]}
                  for p in st["probs"]],
        "status": None if not s else {
            "kind": s["kind"], "text": s["text"], "cash": s["cash"], "reason": s.get("reason", ""),
            "alloc": [{"no": a["no"], "paid": a["paid"], "of": a["of"]} for a in s["alloc"] if a["paid"] > 0]},
    }


def run_view(run):
    people = store.people()
    stops = [stop_view(st, i, people) for i, st in enumerate(run["stops"])]
    t = e.totals(run)
    left = round(sum(s["due"] for s in stops if s["where"] == "route" and not s["status"]), 2)
    order = [s["i"] for s in stops if s["where"] == "route"]
    title = "Демо-рейс" if run.get("demo") else (run.get("title") or f"Рейс {dm(run['day'])}")
    return {"title": title, "demo": bool(run.get("demo")), "closed": bool(run.get("closed")),
            "stops": stops, "order": order, "left_sum": left, "totals": t,
            "expenses": [{"kind": x["kind"], "sum": x["sum"]} for x in run["expenses"]],
            "reasons": e.REASONS, "problems": e.PROBLEMS, "other_kinds": list(e.OTHER_KINDS)}
