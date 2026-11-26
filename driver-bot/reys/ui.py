"""Екрани рейсу: текст і кнопки. Оформлення — як у бота оплат: велика сума, блоки-цитати, статус кружечком.

Жодної роботи з Telegram чи 1С — щоб легко перевіряти.
Між номером накладної і сумою стоїть «·», а не тире: інакше Telegram підсвічує їх як телефон.
"""
from html import escape as h

from . import engine as e
from . import store
from .tags import LABELS, driver_comment
from .view import mgr_view

SKIP_WHY = {"SV": "самовивіз", "NP": "Нова пошта", "DATE": "доставка в інший день"}


def dm(iso: str) -> str:
    return f"{iso[8:10]}.{iso[5:7]}" if iso and len(iso) >= 10 else ""


def q(*lines) -> str:
    """Блок-цитата: у Telegram це картка з кольоровою смугою зліва."""
    return "<blockquote>" + "\n".join(x for x in lines if x) + "</blockquote>"


def plural(n, one, few, many):
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    return few if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else many


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
    text = (f"🚚 <b>{title}</b>\n"
            + q(f"Лишилось <b>{len(opened)}</b> з {t['stops']} {plural(t['stops'], 'точки', 'точок', 'точок')}",
                f"До збору <b>{e.money(left)}</b>", f"Зібрано <b>{e.money(t['cash'])}</b>"))
    if not opened:
        text += "\n🟢 Усі точки відмічено — можна здавати касу"
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


def card_text(st, head=""):
    d, dd = e.due(st), e.debt_due(st)
    out = []
    if head:
        out.append(h(head))
    if e.free(st) and d <= 0:
        out.append("⚪ <b>Без оплати</b> — так написав менеджер")
    else:
        out.append(f"💰 <b>{e.money(d)}</b> до збору")
    who = [f"📍 <b>{h(st['name'].upper())}</b>", h(st["addr"])]
    people = store.people()
    for n in e.managers(st):
        who.append(f"👤 {h(mgr_view(n, people)['label'])}")
    seen = set()
    for i in st["inv"]:
        c = driver_comment(i["comment"])
        if c and c not in seen:
            seen.add(c)
            who.append(f"💬 «{h(c)}»")
    tg = {t for i in e.riding(st) for t in i["tags"]} & {"CALL", "DEBT", "RET"}
    if tg:
        who.append("❗ " + ", ".join(LABELS[t] for t in sorted(tg)))
    out.append(q(*who))
    ride = e.riding(st)
    if ride:
        lines = [f"📦 <b>Сьогодні</b>" + (" · 🟨 <b>БЕЗ ОПЛАТИ</b>" if e.free(st) else "")]
        for i in ride:
            bo = " · 🟨 <b>БЕЗ ОПЛАТИ</b>" if "BO" in i["tags"] and not e.free(st) else ""
            lines.append(f"№ {h(i['no'])} · {e.money(e.orig_sum(st, i))}{bo}")       # сума як у накладній
        for p in st["probs"]:
            lines.append(f"⚠️ {e.PROBLEMS[p['kind']]}: {h(p['item'])}{e.qty_txt(p)}"
                         + (f" (−{e.money(p['cut'])})" if p["cut"] else ""))
        if e.has_cuts(st):                              # щоб було видно: повернення відняте
            lines.append(f"💰 <b>Після повернення: {e.money(sum(i['sum'] for i in ride))}</b>")
        out.append(q(*lines))
    wait = []
    for i in st["inv"]:
        why = [SKIP_WHY[t] for t in ("SV", "NP", "DATE") if t in i["tags"]]
        if why:
            when = f" {dm(i['deliver'])}" if i.get("deliver") else ""
            wait.append(f"№ {h(i['no'])} · {e.money(i['sum'])} · {why[0]}{when}")
    if wait:
        out.append(q("⏸ <b>Не їде сьогодні</b>", *wait))
    ds = e.debts(st)
    if ds:
        lines = [f"🔴 <b>Борг {e.money(dd)}</b>"]
        for x in sorted(ds, key=lambda x: x.get("date", "")):
            when = f" від {dm(x['date'])}" if x.get("date") else ""
            name = f"№ {h(x['no'])}{when}" if x["no"] not in ("борг", "давня") else \
                ("давня накладна" if x["no"] == "давня" else "за попередні накладні")
            lines.append(f"{name} · {e.money(x['sum'])}")
        out.append(q(*lines))
    elif st["sheet_debt"] < -0.5:
        out.append(f"🟢 У клієнта переплата {e.money(-st['sheet_debt'])}")
    else:
        out.append("🟢 Боргу немає")
    return "\n".join(out)


def screen_card(st, i, head=""):
    text, rows = card_text(st, head), []
    if st["status"]:
        s = st["status"]
        lines = [f"✅ <b>Відмічено: {h(s['text'])}</b> · {e.money(s['cash'])}"]
        lines += [f"№ {h(a['no'])} · {e.money(a['paid'])} з {e.money(a['of'])}" for a in s["alloc"] if a["paid"] > 0]
        text += "\n" + q(*lines)
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
    rows += call_rows(st, i)
    rows.append([("← До списку", "r:l")])
    return text, rows


def call_rows(st, i, names=None):
    """Кнопка дзвінка на кожного менеджера, у кого є телефон. Немає жодного — одна кнопка, яка це пояснить."""
    people, every = store.people(), e.managers(st)
    out = [[(f"📞 {mgr_view(n, people)['label']}"[:40], f"r:cl:{i}:{every.index(n)}")]
           for n in (names or every) if n in every and mgr_view(n, people)["phone"]]
    return out or [[("📞 Менеджер", f"r:cl:{i}")]]


def screen_part(st, i):
    pay, sel = e.payable(st), set(st.get("sel", []))
    total = sum(p["sum"] for k, p in enumerate(pay) if k in sel)
    text = (f"📍 <b>{h(st['name'].upper())}</b>\n💰 <b>{e.money(total)}</b> вибрано з {e.money(e.due(st))}\n"
            + q("Натискай накладні, за які віддали гроші."))
    rows = []
    for k, p in enumerate(pay):
        when = f" від {dm(p['date'])}" if p["old"] and p["date"] else (" · сьогодні" if not p["old"] else "")
        rows.append([(f"{'✅' if k in sel else '⬜'} № {p['no']}{when} · {e.money(p['sum'])}", f"r:tg:{i}:{k}")])
    if sel:
        rows.append([(f"Готово — {e.money(total)}", f"r:pd:{i}")])
    rows.append([("✏️ Ввести суму", f"r:sm:{i}")])
    rows.append([("← Назад", f"r:o:{i}")])
    return text, rows


def screen_sum(st, i, amount=None):
    name = f"📍 <b>{h(st['name'].upper())}</b>\n"
    if amount is None:
        return (name + f"💰 До збору <b>{e.money(e.due(st))}</b>\n"
                + q("Напиши суму, яку забрав, цифрами.", "Розкладу від найстарішої накладної."),
                [[("← Назад", f"r:o:{i}")]])
    alloc, extra = e.allocate(st, amount)
    lines = []
    for a in alloc:
        mark = "🟢" if abs(a["paid"] - a["of"]) < 0.005 else ("🟡" if a["paid"] else "🔴")
        state = "закрита" if mark == "🟢" else ("частково" if mark == "🟡" else "не оплачена")
        lines.append(f"{mark} № {h(a['no'])} {state} · {e.money(a['paid'])} з {e.money(a['of'])}")
    text = name + f"💰 Забрав <b>{e.money(amount)}</b>\n" + q(*lines)
    if extra > 0:
        text += f"\nБільше, ніж треба, на {e.money(extra)} — решту не записую."
    return text, [[("✅ Так, записати", f"r:sy:{i}")], [("← Назад", f"r:o:{i}")]]


def screen_reasons(st, i):
    return (f"📍 <b>{h(st['name'].upper())}</b>\n🚫 <b>Не забрав {e.money(e.due(st))}</b>\n" + q("Чому?"),
            [[("💳 Скине на рахунок", f"r:rs:{i}:acct")], [("🤝 Домовилась з менеджером", f"r:rs:{i}:mgr")],
             [("⏳ Нема грошей", f"r:rs:{i}:nomoney")], [("🔒 Зачинено, нікого нема", f"r:rs:{i}:closed")],
             [("📦 Залишив на точці", f"r:rs:{i}:atpoint")], [("🤝 Залишив у іншого клієнта", f"r:rs:{i}:other")],
             [("← Назад", f"r:o:{i}")]])


def screen_block(st, i):
    return (f"📍 <b>{h(st['name'].upper())}</b>\n⛔ <b>Борг {e.money(e.debt_due(st))}</b>\n"
            + q("Не залишай товар, поки не набереш менеджера.",
                *[f"👤 {h(n)}" for n in e.debt_managers(st)]),
            call_rows(st, i, e.debt_managers(st)) + [[("Менеджер дозволив залишити", f"r:al:{i}")],
                                                      [("Товар не залишив", f"r:dn:{i}")], [("← Назад", f"r:o:{i}")]])


def screen_problem(st, i):
    return (f"📍 <b>{h(st['name'].upper())}</b>\n⚠️ <b>Проблема з товаром</b>\n" + q("Що сталося?"),
            [[("Не вистачає", f"r:pk:{i}:miss"), ("Не той товар", f"r:pk:{i}:wrong")],
             [("Пошкоджено", f"r:pk:{i}:dmg"), ("Клієнт відмовився", f"r:pk:{i}:refuse")],
             [("← Назад", f"r:o:{i}")]])


def screen_items(st, i, kind, items, page=0, sel=None, per=8):
    """items — [(номер накладної в точці, номер позиції, назва, кількість, ціна)]. Кілька позицій — одним «Готово»."""
    sel = sel or {}
    text = (f"📍 <b>{h(st['name'].upper())}</b>\n⚠️ <b>{e.PROBLEMS[kind].capitalize()}</b>\n"
            + q("Познач усі позиції, потім «Готово».", "Не всі штуки — олівець ✏️ поруч."))
    rows = []
    for ii, li, n, qty, p in items[page * per:(page + 1) * per]:
        k = f"{ii}:{li}"
        lab = f"✅ {n[:24]} · {sel[k]:g} з {qty:g} шт" if k in sel else f"▫️ {n[:24]} · {qty:g} шт · {e.money(p)}"
        row = [(lab, f"r:pi:{i}:{kind}:{ii}:{li}:{page}")]       # один дотик — уся кількість у списку
        if qty > 1:
            row.append(("✏️", f"r:pi:{i}:{kind}:{ii}:{li}:{page}:q"))
        rows.append(row)
    nav = []
    if page:
        nav.append(("◀", f"r:pg:{i}:{kind}:{page - 1}"))
    if (page + 1) * per < len(items):
        nav.append(("▶", f"r:pg:{i}:{kind}:{page + 1}"))
    if nav:
        rows.append(nav)
    if len(items) > 1:
        allsel = len(sel) == len(items)
        rows.append([("☐ Зняти всі" if allsel else "☑️ Позначити всі", f"r:pa:{i}:{kind}")])
    last = [("← Назад", f"r:o:{i}")]
    if sel:
        price = {f"{ii}:{li}": p for ii, li, n, qty, p in items}
        total = sum(qv * price.get(k, 0) for k, qv in sel.items())
        last.append((f"✔️ Готово · {len(sel)} поз · {e.money(total)}", f"r:px:{i}:{kind}"))
    if kind in e.OTHER_KINDS:                           # рішення власника 26.11: без пошуку, один дотик
        rows.append([("❓ Інший товар — розберуться на складі", f"r:po:{i}:{kind}")])
    rows.append(last)                                   # головна дія внизу праворуч, «назад» ліворуч
    return text, rows


def screen_qty(st, i, kind, ii, li, name, qty, page=0, chosen=False):
    opts = [n for n in (1, 2, 3) if n < qty] + [qty]
    rows = [[(f"{n:g}" if n != qty else f"усі {n:g}", f"r:pq:{i}:{kind}:{ii}:{li}:{n:g}:{page}") for n in opts]]
    if chosen:
        rows.append([("✖ Прибрати зі списку", f"r:pq:{i}:{kind}:{ii}:{li}:x:{page}")])
    rows.append([("← До списку", f"r:pg:{i}:{kind}:{page}")])
    return (f"📍 <b>{h(st['name'].upper())}</b>\n⚠️ <b>{e.PROBLEMS[kind].capitalize()}</b>\n"
            + q(h(name), "Скільки штук?"), rows)


def screen_skip(run):
    blocks = []
    for s in run["stops"]:
        if s["where"] == "skip":
            lines = [f"<b>{h(s['name'])}</b>"]
            for inv in s["inv"]:
                why = [SKIP_WHY[t] for t in ("SV", "NP", "DATE") if t in inv["tags"]]
                when = f" {dm(inv['deliver'])}" if inv.get("deliver") else ""
                lines.append(f"№ {h(inv['no'])} · {e.money(inv['sum'])} · {why[0] if why else ''}{when}")
            blocks.append(q(*lines))
    return "⏸ <b>Не їдуть сьогодні</b>\n" + "\n".join(blocks), [[("← До списку", "r:l")]]


def screen_debtors(run, page=0, per=10):
    ds = sorted(((i, s) for i, s in enumerate(run["stops"]) if s["where"] == "debt" and not s["status"]),
                key=lambda x: -x[1]["sheet_debt"])
    total = sum(s["sheet_debt"] for _, s in ds)
    text = ("🔴 <b>Борги поруч</b>\n"
            + q(f"<b>{len(ds)}</b> {plural(len(ds), 'клієнт', 'клієнти', 'клієнтів')} без доставки сьогодні",
                f"Разом <b>{e.money(total)}</b>"))
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
    text = f"🏁 <b>Здача каси</b>\n💰 <b>{e.money(t['hand'])}</b> до здачі\n"
    cash = [f"Готівка {e.money(t['cash'])} · {t['paid_stops']} {plural(t['paid_stops'], 'точка', 'точки', 'точок')}"]
    cash += [f"− {h(x['kind'])} {e.money(x['sum'])}" for x in run["expenses"]]
    text += q(*cash) + "\n"
    rest = [f"Не забрано {e.money(t['unpaid'])}"] + [f"{h(k)} · {v}" for k, v in t["why"].items()]
    rest += [f"Товар повернувся · {t['back']}", f"Проблеми з товаром · {t['probs']}"]
    text += q(*rest)
    if t["left"]:
        text += f"\n🔴 Ще {t['left']} {plural(t['left'], 'точка', 'точки', 'точок')} без відмітки — касу здати не можна"
        return text, [[("← До списку", "r:l")]]
    text += "\n🟢 Усі точки відмічено"
    return text, [[(f"Здаю касу — {e.money(t['hand'])}", "r:hd")], [("← До списку", "r:l")]]


def report(run, driver=""):
    """Підсумок рейсу для касира: розклад по накладних. Лишається в чаті після здачі."""
    t = e.totals(run)
    title = h(run.get("title") or f"Рейс {dm(run['day'])}")
    out = [f"🧾 <b>{title}</b>" + (f" · {h(driver)}" if driver else ""),
           f"💰 <b>{e.money(t['hand'])}</b> здано"]
    if t["spent"]:
        out.append(q(f"Готівка {e.money(t['cash'])}", *[f"− {h(x['kind'])} {e.money(x['sum'])}" for x in run["expenses"]]))
    paid, rest = [], []
    for s in run["stops"]:
        st = s["status"]
        if not st:
            continue
        if st["cash"] > 0:
            parts = ", ".join(f"№ {a['no']} · {e.money(a['paid'])}" for a in st["alloc"] if a["paid"] > 0)
            paid.append(f"<b>{h(s['name'])}</b> · {e.money(st['cash'])}\n{h(parts)}")
        else:
            rest.append(f"<b>{h(s['name'])}</b> · {h(st['text'])}")
        for p in s["probs"]:
            rest.append(f"⚠️ {h(s['name'])}, № {h(p['inv'])}: {e.PROBLEMS[p['kind']]} — {h(p['item'])}{e.qty_txt(p)}")
    if paid:
        out.append("🟢 <b>Оплатили</b>\n" + q(*paid))
    if rest:
        out.append("🟡 <b>Без грошей і зауваження</b>\n" + q(*rest))
    out.append(f"Точок у рейсі: {t['stops']}")
    return "\n".join(out)
