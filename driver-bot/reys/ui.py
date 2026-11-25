"""Екрани рейсу: текст і кнопки. Жодної роботи з Telegram чи 1С — щоб легко перевіряти."""
from html import escape as h

from . import engine as e
from .tags import LABELS

SKIP_WHY = {"SV": "самовивіз", "NP": "Нова пошта", "DATE": "доставка в інший день"}


def dm(iso: str) -> str:
    return f"{iso[8:10]}.{iso[5:7]}" if iso and len(iso) >= 10 else ""


def _btn(st, i):
    marks = ("🔴" if e.debt_due(st) > 0.5 else "") + ("⚪" if e.free(st) else "") + \
            ("📞" if any("CALL" in x["tags"] for x in st["inv"]) else "")
    name = st["name"][:26]
    return (f"{marks + ' ' if marks else ''}{name} · {e.money(e.due(st))}", f"r:o:{i}")


def screen_list(run, show_done=False):
    stops = run["stops"]
    opened = [(i, s) for i, s in enumerate(stops) if s["where"] == "route" and not s["status"]]
    done = [(i, s) for i, s in enumerate(stops) if s["status"]]
    t = e.totals(run)
    left = sum(e.due(s) for _, s in opened)
    title = "Демо-рейс" if run.get("demo") else h(run.get("title") or f"Рейс {dm(run['day'])}")
    text = (f"🚚 <b>{title} · лишилось {len(opened)} з {t['stops']}</b>\n"
            f"До збору лишилось: {e.money(left)}\nЗібрано: {e.money(t['cash'])}")
    rows = [[_btn(s, i)] for i, s in opened]
    if done:
        rows.append([(f"✅ Зроблено: {len(done)} {'▲' if show_done else '▼'}", "r:ld")])
        if show_done:
            rows += [[(f"{s['name'][:22]} · {s['status']['text'][:18]} · {e.money(s['status']['cash'])}", f"r:o:{i}")]
                     for i, s in done]
    extra = []
    nd = sum(1 for s in stops if s["where"] == "debt" and not s["status"])
    ns = sum(1 for s in stops if s["where"] == "skip")
    if nd:
        extra.append((f"🔴 Борги поруч ({nd})", "r:db:0"))
    if ns:
        extra.append((f"⏸ Не їдуть ({ns})", "r:sk"))
    if extra:
        rows.append(extra)
    rows.append([("💸 Витрата з каси", "r:ex"), ("🏁 Здати касу", "r:cz")])
    return text, rows


def card_text(st):
    lines = [f"📍 <b>{h(st['name'].upper())}</b>"]
    if st["addr"]:
        lines.append(h(st["addr"]))
    if st["manager"]:
        lines.append(f"👤 Менеджер: {h(st['manager'])}")
    seen = set()
    for i in st["inv"]:
        if i["comment"] and i["comment"] not in seen:
            seen.add(i["comment"])
            lines.append(f"💬 «{h(i['comment'])}»")
    tg = {t for i in e.riding(st) for t in i["tags"]} & {"CALL", "DEBT", "RET"}
    if tg:
        lines.append("❗ " + ", ".join(LABELS[t] for t in sorted(tg)))
    if e.free(st):
        lines.append("⚪ <b>Без оплати</b> — так написав менеджер")
    lines.append("")
    for i in e.riding(st):
        bo = " (без оплати)" if "BO" in i["tags"] else ""
        lines.append(f"📦 Сьогодні: накл. {h(i['no'])} — {e.money(i['sum'])}{bo}")
    for i in st["inv"]:
        why = [SKIP_WHY[t] for t in ("SV", "NP", "DATE") if t in i["tags"]]
        if why:
            when = f" {dm(i['deliver'])}" if i.get("deliver") else ""
            lines.append(f"⏸ Не їде: накл. {h(i['no'])} — {e.money(i['sum'])} ({why[0]}{when})")
    for p in st["probs"]:
        lines.append(f"⚠️ {e.PROBLEMS[p['kind']]}: {h(p['item'])} ×{p['qty']} (−{e.money(p['cut'])})")
    ds = e.debts(st)
    if ds:
        lines.append(f"🔴 <b>БОРГ {e.money(e.debt_due(st))}</b>")
        for d in sorted(ds, key=lambda d: d.get("date", "")):
            when = f" від {dm(d['date'])}" if d.get("date") else ""
            lines.append(f"   накл. {h(d['no'])}{when} — {e.money(d['sum'])}")
    elif st["sheet_debt"] < -0.5:
        lines.append(f"Переплата клієнта: {e.money(-st['sheet_debt'])}")
    lines.append(f"\n<b>До збору: {e.money(e.due(st))}</b>")
    return "\n".join(lines)


def screen_card(st, i):
    text, rows = card_text(st), []
    if st["status"]:
        s = st["status"]
        text += f"\n\n✅ Відмічено: {h(s['text'])} · {e.money(s['cash'])}"
        for a in s["alloc"]:
            if a["paid"] > 0:
                text += f"\n   накл. {h(a['no'])}: {e.money(a['paid'])} з {e.money(a['of'])}"
        rows.append([("✏️ Виправити", f"r:fx:{i}")])
    else:
        d, td, dd = e.due(st), e.today_due(st), e.debt_due(st)
        if d > 0:
            rows.append([(f"💵 Забрав усе — {e.money(d)}", f"r:all:{i}")])
            if dd > 0.5 and td > 0:
                rows.append([(f"💵 Тільки сьогоднішнє — {e.money(td)}", f"r:tod:{i}")])
            rows.append([("💵 Інша сума або окремі накладні", f"r:pt:{i}")])
            rows.append([("🚫 Не забрав", f"r:no:{i}")])
        if e.free(st):
            rows.append([("✅ Віддав товар", f"r:gv:{i}")])
        if e.riding(st):
            rows.append([("⚠️ Проблема з товаром", f"r:pr:{i}")])
    rows.append([("📞 Менеджер", f"r:cl:{i}"), ("← До списку", "r:l")])
    return text, rows


def screen_part(st, i):
    pay, sel = e.payable(st), set(st.get("sel", []))
    total = sum(p["sum"] for k, p in enumerate(pay) if k in sel)
    text = f"<b>{h(st['name'])}</b>\nЗа що заплатили? Натискай накладні, за які віддали гроші."
    rows = []
    for k, p in enumerate(pay):
        when = f" від {dm(p['date'])}" if p["old"] and p["date"] else (" · сьогодні" if not p["old"] else "")
        rows.append([(f"{'✅' if k in sel else '⬜'} накл. {p['no']}{when} — {e.money(p['sum'])}", f"r:tg:{i}:{k}")])
    if sel:
        rows.append([(f"Готово — {e.money(total)}", f"r:pd:{i}")])
    rows.append([("✏️ Ввести суму", f"r:sm:{i}")])
    rows.append([("← Назад", f"r:o:{i}")])
    return text, rows


def screen_sum(st, i, amount=None):
    text = (f"<b>{h(st['name'])}</b>\nДо збору {e.money(e.due(st))}.\n"
            "Напиши суму, яку забрав, цифрами. Розкладу від найстарішої накладної.")
    rows = []
    if amount is not None:
        alloc, extra = e.allocate(st, amount)
        text = f"<b>{h(st['name'])}</b>\nЗабрав {e.money(amount)}:"
        for a in alloc:
            state = "закрита" if abs(a["paid"] - a["of"]) < 0.005 else ("частково" if a["paid"] else "не оплачена")
            text += f"\n   накл. {h(a['no'])} — {state}: {e.money(a['paid'])} з {e.money(a['of'])}"
        if extra > 0:
            text += f"\nБільше, ніж треба, на {e.money(extra)} — решту не записую."
        rows.append([("✅ Так, записати", f"r:sy:{i}")])
    rows.append([("← Назад", f"r:o:{i}")])
    return text, rows


def screen_reasons(st, i):
    return (f"<b>{h(st['name'])}</b>\nЧому не забрав?",
            [[("💳 Скине на рахунок", f"r:rs:{i}:acct")], [("🤝 Домовилась з менеджером", f"r:rs:{i}:mgr")],
             [("⏳ Нема грошей", f"r:rs:{i}:nomoney")], [("🔒 Зачинено, нікого нема", f"r:rs:{i}:closed")],
             [("← Назад", f"r:o:{i}")]])


def screen_block(st, i):
    return (f"⛔ <b>{h(st['name'])}</b>\nУ клієнта борг {e.money(e.debt_due(st))}.\n"
            "Не залишай товар, поки не набереш менеджера.",
            [[("📞 Набрати менеджера", f"r:cl:{i}")], [("Менеджер дозволив залишити", f"r:al:{i}")],
             [("Товар не залишив", f"r:dn:{i}")], [("← Назад", f"r:o:{i}")]])


def screen_problem(st, i):
    return (f"<b>{h(st['name'])}</b>\nЩо з товаром?",
            [[("Не вистачає", f"r:pk:{i}:miss"), ("Не той товар", f"r:pk:{i}:wrong")],
             [("Пошкоджено", f"r:pk:{i}:dmg"), ("Клієнт відмовився", f"r:pk:{i}:refuse")],
             [("← Назад", f"r:o:{i}")]])


def screen_items(st, i, kind, items, page=0, per=8):
    """items — [(номер накладної в точці, номер позиції, назва, кількість, ціна)]."""
    text = f"<b>{h(st['name'])}</b>\n{e.PROBLEMS[kind].capitalize()}: яка позиція?"
    part = items[page * per:(page + 1) * per]
    rows = [[(f"{n[:30]} · {q:g} шт · {e.money(p)}", f"r:pi:{i}:{kind}:{ii}:{li}")] for ii, li, n, q, p in part]
    nav = []
    if page:
        nav.append(("◀", f"r:pg:{i}:{kind}:{page - 1}"))
    if (page + 1) * per < len(items):
        nav.append(("▶", f"r:pg:{i}:{kind}:{page + 1}"))
    if nav:
        rows.append(nav)
    rows.append([("← Назад", f"r:o:{i}")])
    return text, rows


def screen_qty(st, i, kind, ii, li, name, qty):
    opts = [q for q in (1, 2, 3) if q < qty] + [qty]
    return (f"<b>{h(st['name'])}</b>\n{e.PROBLEMS[kind].capitalize()}: {h(name)}\nСкільки штук?",
            [[(f"{q:g}" if q != qty else f"усі {q:g}", f"r:pq:{i}:{kind}:{ii}:{li}:{q:g}") for q in opts],
             [("← Назад", f"r:o:{i}")]])


def screen_skip(run):
    text = "⏸ <b>Не їдуть сьогодні</b>\n"
    for s in run["stops"]:
        if s["where"] == "skip":
            for inv in s["inv"]:
                why = [SKIP_WHY[t] for t in ("SV", "NP", "DATE") if t in inv["tags"]]
                when = f" {dm(inv['deliver'])}" if inv.get("deliver") else ""
                text += f"\n• {h(s['name'])} — накл. {h(inv['no'])}, {e.money(inv['sum'])} · {why[0] if why else ''}{when}"
    return text, [[("← До списку", "r:l")]]


def screen_debtors(run, page=0, per=10):
    ds = sorted(((i, s) for i, s in enumerate(run["stops"]) if s["where"] == "debt" and not s["status"]),
                key=lambda x: -x[1]["sheet_debt"])
    text = f"🔴 <b>Борги поруч</b> — клієнти без доставки сьогодні ({len(ds)})"
    rows = [[(f"{s['name'][:26]} · {e.money(s['sheet_debt'])}", f"r:o:{i}")] for i, s in ds[page * per:(page + 1) * per]]
    nav = []
    if page:
        nav.append(("◀", f"r:db:{page - 1}"))
    if (page + 1) * per < len(ds):
        nav.append(("▶", f"r:db:{page + 1}"))
    if nav:
        rows.append(nav)
    rows.append([("← До списку", "r:l")])
    return text, rows


def screen_close(run):
    t = e.totals(run)
    text = (f"🏁 <b>Здача каси</b>\nГотівка: {e.money(t['cash'])} · {t['paid_stops']} точ.")
    if t["spent"]:
        for x in run["expenses"]:
            text += f"\n− {h(x['kind'])}: {e.money(x['sum'])}"
        text += f"\n<b>До здачі: {e.money(t['hand'])}</b>"
    text += f"\nНе забрано: {e.money(t['unpaid'])}"
    for k, v in t["why"].items():
        text += f"\n   {h(k)}: {v}"
    text += f"\nТовар повернувся: {t['back']}\nПроблеми з товаром: {t['probs']}"
    if t["left"]:
        text += f"\n\n⚠️ Ще {t['left']} точ. без відмітки — касу здати не можна."
        return text, [[("← До списку", "r:l")]]
    return text, [[(f"Здаю касу — {e.money(t['hand'])}", "r:hd")], [("← До списку", "r:l")]]


def report(run, driver=""):
    """Підсумок рейсу для касира: розклад по накладних. Лишається в чаті після здачі."""
    t = e.totals(run)
    out = [f"🧾 <b>Рейс {dm(run['day'])}</b>" + (f" · {h(driver)}" if driver else ""),
           f"Готівка: {e.money(t['cash'])}" + (f", витрати {e.money(t['spent'])}, до здачі <b>{e.money(t['hand'])}</b>"
                                                  if t["spent"] else ""), ""]
    for s in run["stops"]:
        st = s["status"]
        if not st:
            continue
        if st["cash"] > 0:
            parts = ", ".join(f"№{a['no']} {e.money(a['paid'])}" for a in st["alloc"] if a["paid"] > 0)
            out.append(f"✅ {h(s['name'])}: {e.money(st['cash'])} ({h(parts)})")
        else:
            out.append(f"▫️ {h(s['name'])}: {h(st['text'])}")
        for p in s["probs"]:
            out.append(f"   ⚠️ накл. {h(p['inv'])}: {e.PROBLEMS[p['kind']]} — {h(p['item'])} ×{p['qty']}")
    out.append(f"\nТочок у рейсі: {t['stops']}")
    return "\n".join(out)
