"""Збирає рейс із даних 1С: путівка + накладні + коментарі заявок → список точок."""
import re
from datetime import date, datetime

from .onec import ZERO
from .tags import delivery_date, short_comment, tags_of


def split_name(full: str):
    """«Салон (вул. Прикладна 12)» → («Салон», «вул. Прикладна 12»). Адресу тримають у назві."""
    full = re.sub(r"\s+", " ", full or "").strip()
    m = re.match(r"^(.*?)\s*\(\s*(.+?)\s*\)?\s*$", full)
    if m and m.group(1):
        return m.group(1).strip(), m.group(2).strip(" )")
    return full, ""


def short_no(number: str) -> str:
    """«ОСПК0000687» → «687»: так накладну називають водії й пишуть на путівці."""
    d = re.sub(r"\D", "", number or "")
    return d.lstrip("0") or (number or "").strip()


def _dt(s):
    return datetime.fromisoformat(s[:19])


def match_orders(invoices, orders):
    """Коментар лежить у заявці. Пара: той самий клієнт, та сама сума, заявка не пізніша за накладну."""
    used, out = set(), {}
    for inv in sorted(invoices, key=lambda x: x["Date"]):
        best = None
        for i, o in enumerate(orders):
            if i in used or o["Контрагент_Key"] != inv["Контрагент_Key"]:
                continue
            if abs(o["СуммаДокумента"] - inv["СуммаДокумента"]) > 0.011 or o["Date"] > inv["Date"]:
                continue
            if best is None or o["Date"] > orders[best]["Date"]:
                best = i
        if best is not None:
            used.add(best)
            out[inv["Ref_Key"]] = orders[best]
    return out


def build_run(sheet, invoices, names, agents, orders):
    """sheet — документ путівки з рядками; решта — довідкові вибірки. Повертає словник рейсу."""
    day = _dt(sheet["Date"]).date()
    inv_by = {i["Ref_Key"]: i for i in invoices}
    order_of = match_orders(invoices, orders)
    stops, index = [], {}
    for row in sheet["Контрагенты"]:
        key = row["Контрагент_Key"]
        if key not in index:
            title, addr = split_name(names.get(key, "Клієнт без назви"))
            index[key] = len(stops)
            stops.append({"key": key, "name": title, "addr": addr, "sheet_debt": 0.0,
                          "inv": [], "debts": None, "manager": "", "status": None, "probs": []})
        st = stops[index[key]]
        if row["Документ_Key"] == ZERO:
            st["sheet_debt"] = round(st["sheet_debt"] + row["Долг"], 2)
            continue
        inv = inv_by.get(row["Документ_Key"])
        if not inv:
            continue
        order = order_of.get(inv["Ref_Key"])
        comment = (order or {}).get("Комментарий", "")
        tg = tags_of(comment)
        when = delivery_date(comment, _dt(order["Date"]).date()) if order else None
        if when and when > day:
            tg.add("DATE")
        st["inv"].append({"ref": inv["Ref_Key"], "no": short_no(inv["Number"]), "sum": round(inv["СуммаДокумента"], 2),
                          "date": inv["Date"][:10], "tags": sorted(tg), "comment": short_comment(comment),
                          "deliver": when.isoformat() if when and when > day else "",
                          "manager": agents.get(inv.get("Агент_Key"), "")})       # менеджер — у кожної накладної свій
        st["manager"] = st["manager"] or agents.get(inv.get("Агент_Key"), "")
    for st in stops:
        classify(st)
    stops = [st for st in stops if st["where"] != "none"]      # копійчані й від'ємні сальдо водієві не потрібні
    return {"sheet_ref": sheet.get("Ref_Key", ""), "sheet_no": (sheet.get("Number") or "").lstrip("0"),
            "day": day.isoformat(), "printed": sheet["Date"][11:16], "stops": stops,
            "expenses": [], "closed": False}


def classify(st):
    """Куди потрапляє клієнт: у рейс, у «не їдуть сьогодні» чи в «борги поруч»."""
    riding = [i for i in st["inv"] if not {"SV", "NP", "DATE"} & set(i["tags"])]
    if riding:
        st["where"] = "route"
    elif st["inv"]:
        st["where"] = "skip"
        kinds = {t for i in st["inv"] for t in i["tags"]} & {"SV", "NP", "DATE"}
        st["skip_why"] = sorted(kinds)
    elif st["sheet_debt"] >= 10:
        st["where"] = "debt"
    else:
        st["where"] = "none"       # копійчане або від'ємне сальдо — водієві не показуємо


def demo_run(today: date):
    """Вигаданий рейс для знайомства з кнопками, коли 1С ще не підключено."""
    def inv(no, s, comment="", mgr=""):
        tg = tags_of(comment)
        when = delivery_date(comment, today)
        if when and when > today:
            tg.add("DATE")
        return {"ref": f"demo-{no}", "no": str(no), "sum": s, "date": today.isoformat(), "tags": sorted(tg),
                "comment": comment, "deliver": when.isoformat() if when and when > today else "", "manager": mgr}
    raw = [("Салон А", "вул. Прикладна, 12", "Саша", 0, [inv(1204, 1501.0, "доставка в салон")], None),
           ("Салон Б", "просп. Зразковий, 40", "Оля", 3600.0, [inv(1207, 500.0, "набрати за 10 хв")],
            [{"ref": "demo-1101", "no": "1101", "date": "2026-11-04", "sum": 2000.0},
             {"ref": "demo-1158", "no": "1158", "date": "2026-11-11", "sum": 1600.0}]),
           ("Студія В", "вул. Тестова, 3", "Саша", 0, [inv(1209, 860.0, "б/о, подарунок якщо є")], None),
           ("Барбершоп Г", "вул. Показова, 7", "Іра", 0, [inv(1211, 1240.0, "віддати Тані"), inv(1212, 380.0, mgr="Оля")], None),   # два менеджери в одній точці
           ("Салон Д", "вул. Умовна, 21", "Оля", 950.0, [inv(1215, 2007.01)],
            [{"ref": "demo-1160", "no": "1160", "date": "2026-11-12", "sum": 950.0}]),
           ("Майстер Е", "вул. Вигадана, 5", "Іра", 0, [inv(1216, 640.0, "св, забере сьогодні")], None),
           ("Салон Є", "вул. Пробна, 9", "Саша", 0, [inv(1217, 1090.0, "на п'ятницю доставку")], None),
           ("Перукарня Ж", "вул. Навчальна, 2", "Оля", 1332.0, [],
            [{"ref": "demo-950", "no": "950", "date": "2026-11-19", "sum": 1332.0}])]
    stops = []
    for name, addr, mgr, debt, invs, debts in raw:
        for x in invs:
            x["manager"] = x["manager"] or mgr
        st = {"key": f"demo-{name}", "name": name, "addr": addr, "sheet_debt": float(debt), "inv": invs,
              "debts": [{**d, "manager": mgr} for d in debts] if debts is not None else [],
              "manager": mgr, "status": None, "probs": []}
        classify(st)
        stops.append(st)
    return {"sheet_ref": "demo", "sheet_no": "демо", "day": today.isoformat(), "printed": "13:00",
            "stops": stops, "expenses": [], "closed": False, "demo": True}
