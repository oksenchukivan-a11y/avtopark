#!/usr/bin/env python3
"""Робот-тестувальник «Рейсу» (рішення власника 26.11.2026: «роби зараз», далі — для всіх ботів).

Проганяє логіку рейсу на ТЕСТОВІЙ копії бази (бойова reports.db не чіпається), без 1С, на демо-путівці:
  1. Сценарії — кожна дія, як її робить водій (забрав усе, частково, сума, не забрав, віддав, товар, витрата, здача).
  2. Гроші після КОЖНОГО кроку: суми накладних не мінус, «на руки» = зібрано − витрати, відмова зменшує накладну
     рівно на кількість × ціну, підсумок здачі = сума по точках.
  3. Захист від помилок людини: подвійне натискання, здача з невідміченими точками, «абв» замість суми, мінус,
     неіснуюча точка/позиція — має бути ввічлива відмова, а не збій.
  4. «Хаотичний водій»: тисячі випадкових натискань (зерно фіксоване — будь-яку знахідку можна повторити).
  5. Кнопки бота: кожна кнопка кожного екрана — текст не порожній, дані кнопки ≤ 64 байти (ліміт Telegram);
     кожен код кнопки ловить рівно один обробник.
Результат: data/robot/reys_YYYY-MM-DD_HHMM.json + короткий підсумок у вивід (і власнику в Telegram з ключем --tg).

Файл лежить у теці tests/ поруч із текою reys/ — і на сервері, і в репозиторії; шляхи рахуються від нього.
Теку для звітів можна задати змінною REYS_ROBOT_OUT.
"""
import asyncio, json, os, random, shutil, sys, tempfile, time, traceback
from datetime import datetime

HOME = os.environ.get("REYS_HOME") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("REYS_ROBOT_OUT") or os.path.join(HOME, "data", "robot")
sys.path.insert(0, HOME)
TMP = tempfile.mkdtemp(prefix="reys-robot-")
os.environ["DB_PATH"] = os.path.join(TMP, "robot.db")
os.environ.pop("PK_MCP_URL", None)
os.environ.pop("REYS_1C_URL", None)
os.environ.pop("REYS_CASHIER", None)

from reys import build, engine, onec, store, ui, view, web  # noqa: E402,F401
from reys import handlers as hd  # noqa: E402

store.DB_PATH = os.environ["DB_PATH"]
onec.URL = ""
web.STATE["bot"] = None
store.init()

UID = 999000001
FIND = []          # знахідки: {"тип", "де", "що", "кроки"}
STATS = {"кроків": 0, "відмов_ввічливих": 0, "сценаріїв": 0}


def finding(kind, where, what, steps=None):
    FIND.append({"тип": kind, "де": where, "що": what, "кроки": steps or []})


async def call(act, **a):
    STATS["кроків"] += 1
    try:
        return "ok", await web.ACTIONS[act](UID, a)
    except web.Bad as e:
        STATS["відмов_ввічливих"] += 1
        return "bad", str(e)


def run_now():
    return store.open_run(UID)[1]


def check(tag, orig, steps):
    """Гроші й стан після кроку. orig — початкові суми накладних {ref: sum}."""
    run = run_now()
    if not run:
        return
    for s in run["stops"]:
        for inv in s["inv"]:
            if inv["sum"] < -0.005:
                finding("гроші", tag, f"накладна {inv['no']} у мінусі: {inv['sum']}", steps)
        cuts = {}
        for p in s["probs"]:
            cuts[p["inv"]] = cuts.get(p["inv"], 0) + p["cut"]
        for inv in s["inv"]:
            want = round(orig.get(inv["ref"], inv["sum"]) - cuts.get(inv["no"], 0), 2)
            if abs(want - inv["sum"]) > 0.01:
                finding("гроші", tag, f"накладна {inv['no']}: {inv['sum']} ≠ {want} (початок − відмови)", steps)
        st = s["status"]
        if st:
            if st["cash"] < -0.005:
                finding("гроші", tag, f"{s['name']}: зібрано в мінусі {st['cash']}", steps)
            if st["cash"] - st["due"] > 0.01:
                finding("гроші", tag, f"{s['name']}: зібрано {st['cash']} більше за належне {st['due']}", steps)
    t = engine.totals(run)
    if abs(t["hand"] - (t["cash"] - t["spent"])) > 0.01:
        finding("гроші", tag, f"на руки {t['hand']} ≠ зібрано {t['cash']} − витрати {t['spent']}", steps)
    try:
        view.run_view(run)
    except Exception as e:
        finding("збій", tag, f"екран рейсу не будується: {e!r}", steps)


def originals():
    run = run_now()
    return {inv["ref"]: inv["sum"] for s in run["stops"] for inv in s["inv"]}


async def fresh():
    run = run_now()
    if run:                          # закрити попередній тестовий рейс
        rid = store.open_run(UID)[0]
        store.close(rid, run)
    r = await call("start", id="demo")
    assert r[0] == "ok", r
    return originals()


def route_idx(run):
    return [k for k, s in enumerate(run["stops"]) if s["where"] == "route"]


# ---------------- 1–2. сценарії і гроші ----------------
async def scenario_full():
    STATS["сценаріїв"] += 1
    orig = await fresh()
    steps = []
    run = run_now()
    idx = route_idx(run)
    plan = ["problem_multi", "all", "amount", "pick", "none_acct", "today", "given", "none_closed"]
    expected_cash = 0.0
    for n, k in enumerate(idx):
        act = plan[n % len(plan)]
        await call("open", i=k)
        st = run_now()["stops"][k]
        if act == "problem_multi":
            r = await call("items", i=k)
            items = r[1].get("items", []) if r[0] == "ok" else []
            picked = items[:3]
            before = {inv["ref"]: inv["sum"] for inv in st["inv"]}
            want_cut = 0.0
            for it in picked:
                q = 1 if it["qty"] > 1 else it["qty"]
                rr = await call("problem", i=k, kind="refuse", ii=it["ii"], li=it["li"], qty=q)
                steps.append(f"problem {it['name']} ×{q}: {rr[0]}")
                want_cut += q * it["price"]
                # часткова відмова: решта штук має лишитись доступною (як у боті)
                if it["qty"] > 1:
                    r2 = await call("items", i=k)
                    left = [x for x in r2[1].get("items", []) if x["ii"] == it["ii"] and x["li"] == it["li"]]
                    if not left or abs(left[0]["qty"] - (it["qty"] - q)) > 0.001:
                        finding("логіка", "міні-застосунок · Товар",
                                f"повернули {q} з {it['qty']} шт «{it['name']}» — решта {it['qty'] - q} шт зникла зі "
                                f"списку (у боті лишається). Друге повернення цієї позиції вже не внести.", steps[:])
            after = {inv["ref"]: inv["sum"] for inv in run_now()["stops"][k]["inv"]}
            got_cut = round(sum(before[r] - after[r] for r in before), 2)
            if abs(got_cut - want_cut) > 0.01:
                finding("гроші", "Товар (кілька позицій)", f"накладна зменшилась на {got_cut}, а мала на {want_cut}", steps)
            await call("all", i=k)
        elif act == "all":
            await call("all", i=k)
        elif act == "amount":
            d = engine.due(st)
            await call("amount", i=k, sum=str(round(d / 2, 2)).replace(".", ","))
        elif act == "pick":
            await call("pick", i=k, ks=[0])
        elif act == "none_acct":
            await call("none", i=k, reason="acct")
        elif act == "today":
            await call("today", i=k)
        elif act == "given":
            r = await call("given", i=k)
            if r[0] == "bad":
                await call("all", i=k)
        elif act == "none_closed":
            await call("none", i=k, reason="closed")
        steps.append(f"{act} @{k}")
        if not run_now()["stops"][k]["status"]:      # дія не підходить точці (напр. сума на «без оплати»)
            for alt in ("given", "all"):
                if (await call(alt, i=k))[0] == "ok":
                    steps.append(f"{alt} @{k} (замість {act})")
                    break
        check(f"сценарій: {act}", orig, steps)
    await call("expense", sum="150", kind="Пальне")
    await call("expense", sum="80,50", kind="Нова пошта")
    run = run_now()
    expected_cash = round(sum(s["status"]["cash"] for s in run["stops"] if s["status"]), 2)
    r = await call("close")
    if r[0] != "ok":
        finding("логіка", "здача каси", f"не здається після всіх точок: {r[1]}", steps)
    else:
        d = r[1]["done"]
        if abs(d["hand"] - round(expected_cash - 230.5, 2)) > 0.01:
            finding("гроші", "здача каси", f"на руки {d['hand']} ≠ {expected_cash} − 230,50", steps)


async def scenario_list():
    """Повернення списком одним запитом: або всі позиції, або жодна."""
    STATS["сценаріїв"] += 1
    await fresh()
    run = run_now()
    for k in route_idx(run):
        r = await call("items", i=k)
        items = r[1].get("items", []) if r[0] == "ok" else []
        if len(items) < 2:
            continue
        before = engine.due(run_now()["stops"][k])
        rows = [{"ii": x["ii"], "li": x["li"], "qty": x["qty"]} for x in items[:2]]
        bad = await call("problem", i=k, kind="refuse", rows=rows + [{"ii": 77, "li": 77, "qty": 1}])
        if bad[0] == "ok" or abs(engine.due(run_now()["stops"][k]) - before) > 0.005:
            finding("логіка", "Товар списком", "список з неіснуючою позицією записався частково або повністю")
        ok = await call("problem", i=k, kind="refuse", rows=rows)
        want = round(before - sum(x["qty"] * x["price"] for x in items[:2]), 2)
        if ok[0] != "ok" or abs(engine.due(run_now()["stops"][k]) - want) > 0.01:
            finding("гроші", "Товар списком", f"після двох позицій до збору {engine.due(run_now()['stops'][k])}, а має бути {want}")
        return
    finding("збій", "Товар списком", "у демо-рейсі немає точки з двома позиціями — сценарій не перевірено")


async def scenario_other():
    """Рішення власника 26.11: «Інший товар» — один дотик, сума накладної не змінюється, запис лишається."""
    STATS["сценаріїв"] += 1
    orig = await fresh()
    k = route_idx(run_now())[0]
    before = engine.due(run_now()["stops"][k])
    for kind in engine.OTHER_KINDS:
        r = await call("other", i=k, kind=kind)
        if r[0] != "ok":
            finding("логіка", "Інший товар", f"«{kind}» не записався: {r[1]}")
    st = run_now()["stops"][k]
    if abs(engine.due(st) - before) > 0.005:
        finding("гроші", "Інший товар", f"сума до збору змінилась: було {before}, стало {engine.due(st)}")
    got = [p for p in st["probs"] if p["item"] == engine.OTHER_ITEM]
    if len(got) != len(engine.OTHER_KINDS) or any(p["cut"] or p["qty"] for p in got):
        finding("логіка", "Інший товар", f"записів {len(got)} з {len(engine.OTHER_KINDS)} або в них є сума чи кількість")
    v = view.run_view(run_now())["stops"][k]
    if any("×" in p["text"] for p in v["probs"]):
        finding("кнопки", "Інший товар", "на картці показано «×0» біля іншого товару")
    walk_buttons(*hd.card(run_now(), k), "картка з іншим товаром")
    check("інший товар", orig, [])
    await call("all", i=k)
    if (await call("other", i=k, kind="miss"))[0] == "ok":
        finding("захист", "Інший товар", "записався в уже відміченій точці")


async def scenario_managers():
    """Рішення власника 26.11: салон ведуть двоє (манікюр і волосся) — кнопка дзвінка на кожного менеджера."""
    STATS["сценаріїв"] += 1
    await fresh()
    run = run_now()
    known = set()
    for s in run["stops"]:
        names = engine.managers(s)
        known |= set(names)
        if s["inv"] and not names:
            finding("логіка", "менеджери", f"{s['name']}: є накладні, а менеджера немає — дзвонити нікому")
        for inv in s["inv"]:
            if not inv.get("manager"):
                finding("логіка", "менеджери", f"{s['name']}: у накладної {inv['no']} не вказано менеджера")
    for n, name in enumerate(sorted(known)):
        store.set_phone(name, f"+38050000{n:04d}")
    v = view.run_view(run_now())
    for k, s in enumerate(run["stops"]):
        names = engine.managers(s)
        got = [m["name"] for m in v["stops"][k]["mgrs"] if m["phone"]]
        if got != names:
            finding("кнопки", "дзвінок у застосунку", f"{s['name']}: менеджери {names}, а кнопок дзвінка {got}")
        text, rows = hd.card(run, k)
        calls = [b for row in rows for b in row if str(b[1]).startswith("r:cl:")]
        if len(calls) != max(1, len(names)):
            finding("кнопки", "дзвінок у чаті", f"{s['name']}: менеджерів {len(names)}, кнопок дзвінка {len(calls)}")
        walk_buttons(text, rows, f"картка з телефонами · {s['name']}")
        walk_buttons(*ui.screen_block(s, k), f"боржник з телефонами · {s['name']}")
    with store.db() as c:
        c.execute("DELETE FROM reys_phones")


# ---------------- 3. захист від помилок людини ----------------
async def scenario_guards():
    STATS["сценаріїв"] += 1
    await fresh()
    run = run_now()
    k = route_idx(run)[0]
    must_refuse = [
        ("close", {}, "здача з невідміченими точками"),
        ("amount", {"i": k, "sum": "абв"}, "сума літерами"),
        ("amount", {"i": k, "sum": "-50"}, "мінусова сума"),
        ("amount", {"i": k, "sum": "0"}, "нульова сума"),
        ("all", {"i": 999}, "неіснуюча точка"),
        ("all", {"i": -1}, "точка -1"),
        ("pick", {"i": k, "ks": []}, "частково без вибору накладних"),
        ("pick", {"i": k, "ks": [99]}, "неіснуюча накладна"),
        ("none", {"i": k, "reason": "щось"}, "невідома причина"),
        ("problem", {"i": k, "kind": "refuse", "ii": 0, "li": 0, "qty": 999}, "повернути більше, ніж є"),
        ("problem", {"i": k, "kind": "refuse", "ii": 0, "li": 0, "qty": 0}, "повернути 0"),
        ("problem", {"i": k, "kind": "лол", "ii": 0, "li": 0, "qty": 1}, "невідома проблема"),
        ("problem", {"i": k, "kind": "refuse", "rows": []}, "порожній список повернення"),
        ("problem", {"i": k, "kind": "refuse", "rows": [{"ii": 0, "li": 0, "qty": 1}] * 2}, "позиція у списку двічі"),
        ("other", {"i": k, "kind": "refuse"}, "«інший товар» у відмові клієнта"),
        ("other", {"i": k, "kind": "лол"}, "«інший товар» з невідомою проблемою"),
        ("other", {"i": 999, "kind": "miss"}, "«інший товар» у неіснуючій точці"),
        ("expense", {"sum": "abc"}, "витрата літерами"),
        ("expense_del", {"k": 5}, "видалити неіснуючу витрату"),
        ("start", {"id": "../../etc/passwd"}, "дивна путівка"),
    ]
    await call("items", i=k)
    for act, a, what in must_refuse:
        try:
            r = await call(act, **a)
            if r[0] == "ok":
                finding("захист", what, f"дія «{act}» пройшла, а мала бути відмова", [f"{act} {a}"])
        except Exception as e:
            finding("збій", what, f"замість ввічливої відмови — збій: {e!r}", [f"{act} {a}"])
    # подвійне натискання «забрав усе»
    r1 = await call("all", i=k)
    r2 = await call("all", i=k)
    if r1[0] == "ok" and r2[0] == "ok":
        finding("захист", "подвійне натискання", "«Забрав усе» двічі по одній точці — обидва пройшли", [])


# ---------------- 4. хаотичний водій ----------------
async def scenario_chaos(seed, n_steps=250):
    STATS["сценаріїв"] += 1
    rnd = random.Random(seed)
    orig = await fresh()
    steps = []
    acts = ["open", "all", "today", "given", "pick", "amount", "none", "fix", "items", "problem", "other", "expense",
            "expense_del", "close", "state", "menu"]
    for _ in range(n_steps):
        run = run_now()
        if not run:
            orig = await fresh()
            continue
        act = rnd.choice(acts)
        k = rnd.choice(route_idx(run) + [rnd.randint(-3, 40)])
        a = {"i": k}
        if act == "pick":
            a["ks"] = [rnd.randint(-1, 4) for _ in range(rnd.randint(0, 3))]
        elif act == "amount":
            a["sum"] = rnd.choice(["100", "1 500,50", "0", "-1", "абв", "99999999", str(rnd.randint(1, 9000))])
        elif act == "none":
            a.update(reason=rnd.choice(list(engine.REASONS) + ["x"]), left=rnd.choice([True, False, None]))
        elif act == "problem":
            a.update(kind=rnd.choice(list(engine.PROBLEMS)), ii=rnd.randint(0, 2), li=rnd.randint(0, 3),
                     qty=rnd.choice([1, 2, 3, 0.5, -1, 10]))
        elif act == "other":
            a["kind"] = rnd.choice(list(engine.PROBLEMS) + ["x"])
        elif act == "expense":
            a = {"sum": rnd.choice(["50", "0", "x", "120,5"]), "kind": rnd.choice(["Пальне", "Інше"])}
        elif act == "expense_del":
            a = {"k": rnd.randint(-1, 3)}
        steps.append(f"{act} {json.dumps(a, ensure_ascii=False)}")
        try:
            r = await call(act, **a)
        except Exception as e:
            finding("збій", f"хаос (зерно {seed})", f"«{act}» впала: {e!r}", steps[-12:])
            orig = await fresh()
            continue
        if act == "start" or (act == "close" and r[0] == "ok"):
            if run_now():
                orig = originals()
            else:
                orig = await fresh()
            continue
        check(f"хаос (зерно {seed})", orig, steps[-12:])


# ---------------- 5. кнопки бота ----------------
import re as _re  # noqa: E402
BTN_DATA = []      # усі дані кнопок, які бачив робот


def routes(path=None):
    """Які коди кнопок ловить кожен обробник (у порядку реєстрації — перший перехоплює)."""
    src = open(path or os.path.join(HOME, "reys", "handlers.py"), encoding="utf-8").read()
    out = []
    for m in _re.finditer(r"@router\.callback_query\(F\.data(?:\.startswith\((.*?)\)|\s*==\s*\"([^\"]+)\"|\.in_\((.*?)\))\)\s*\n(?:@.*\n)*async def (\w+)", src):
        pref, eq, many, fn = m.group(1), m.group(2), m.group(3), m.group(4)
        if eq:
            out.append(("==", eq, fn))
        elif many:
            for x in _re.findall(r"\"([^\"]+)\"", many):
                out.append(("==", x, fn))
        else:
            for x in _re.findall(r"\"([^\"]+)\"", pref or ""):
                out.append(("^", x, fn))
    return out


def scenario_routing():
    """Знахідка 26.11: «Готово» товару (r:pd) перехоплював обробник «Готово» накладних."""
    STATS["сценаріїв"] += 1
    rt = routes()
    seen = {}
    for kind, x, fn in rt:
        if (kind, x) in seen and seen[(kind, x)] != fn:
            finding("кнопки", "коди кнопок", f"код «{x}» зареєстровано двічі: {seen[(kind, x)]} і {fn} — спрацює лише перший")
        seen.setdefault((kind, x), fn)
    for data in set(BTN_DATA):
        hit = [fn for kind, x, fn in rt if (data == x if kind == "==" else data.startswith(x))]
        if not hit:
            finding("кнопки", "коди кнопок", f"кнопку «{data}» ніхто не обробляє — натискання нічого не зробить")
        elif len(set(hit)) > 1:
            finding("кнопки", "коди кнопок", f"кнопку «{data}» ловлять кілька обробників: {', '.join(dict.fromkeys(hit))} — спрацює {hit[0]}")


def walk_buttons(text, rows, where):
    if not (text or "").strip():
        finding("кнопки", where, "екран без тексту")
    for row in rows:
        for b in row:
            label, data = b[0], b[1]
            if str(data).startswith("r:"):
                BTN_DATA.append(str(data))
            if not str(label).strip():
                finding("кнопки", where, f"кнопка без напису ({data})")
            if len(str(data).encode()) > 64:
                finding("кнопки", where, f"«{label}»: дані кнопки {len(str(data).encode())} байт > 64 (Telegram не прийме)")


async def scenario_bot_buttons():
    STATS["сценаріїв"] += 1
    await fresh()
    run = run_now()
    walk_buttons(*ui.screen_list(run), "список точок")
    walk_buttons(*ui.screen_list(run, True), "список точок (розгорнуто)")
    walk_buttons(*ui.screen_close(run), "здача каси")
    walk_buttons(*ui.screen_skip(run), "не їдуть")
    walk_buttons(*ui.screen_debtors(run), "борги поруч")
    for k, st in enumerate(run["stops"]):
        try:
            walk_buttons(*hd.card(run, k), f"картка точки {st['name']}")
            walk_buttons(*ui.screen_part({**st, "sel": [0]}, k), f"накладні · {st['name']}")
            walk_buttons(*ui.screen_sum(st, k, 100.0), f"сума · {st['name']}")
            walk_buttons(*ui.screen_reasons(st, k), f"причини · {st['name']}")
            walk_buttons(*ui.screen_block(st, k), f"боржник · {st['name']}")
            walk_buttons(*ui.screen_problem(st, k), f"Товар · {st['name']}")
            items = [tuple(x) for x in (await hd.load_items(st))]
            for kind in engine.PROBLEMS:
                walk_buttons(*ui.screen_items(st, k, kind, items, 0, {}), f"список позицій · {st['name']}")
                sel = {f"{x[0]}:{x[1]}": x[3] for x in items}
                walk_buttons(*ui.screen_items(st, k, kind, items, 0, sel), f"список (усі позначені) · {st['name']}")
                for x in items:
                    walk_buttons(*ui.screen_qty(st, k, kind, x[0], x[1], x[2], x[3], 0, True), f"кількість · {x[2]}")
        except Exception as e:
            finding("збій", f"екрани бота · {st['name']}", repr(e))
    # довгі назви й великі номери — щоб дані кнопок не вилізли за 64 байти
    st = run["stops"][0]
    long_items = [(9, 99, "Дуже-дуже довга назва товару з купою слів і цифр 1000 мл " * 3, 120.0, 99999.99)]
    for kind in engine.PROBLEMS:
        walk_buttons(*ui.screen_items(st, 199, kind, long_items, 12, {"9:99": 120.0}), "довга назва / великі номери")
        walk_buttons(*ui.screen_qty(st, 199, kind, 9, 99, long_items[0][2], 120.0, 12, True), "кількість / великі номери")


async def main():
    t0 = time.time()
    for name, coro in [("сценарій", scenario_full()), ("товар списком", scenario_list()),
                       ("інший товар", scenario_other()), ("менеджери", scenario_managers()),
                       ("захист", scenario_guards()),
                       ("кнопки бота", scenario_bot_buttons())]:
        try:
            await coro
        except Exception:
            finding("збій", f"сам прогін «{name}»", traceback.format_exc()[-600:])
    try:
        scenario_routing()
    except Exception:
        finding("збій", "сам прогін «коди кнопок»", traceback.format_exc()[-600:])
    for seed in range(1, 21):
        try:
            await scenario_chaos(seed)
        except Exception:
            finding("збій", f"хаос (зерно {seed})", traceback.format_exc()[-600:])
    # однакові знахідки — один раз
    uniq, seen = [], set()
    for f in FIND:
        key = (f["тип"], f["що"][:90])
        if key not in seen:
            seen.add(key)
            uniq.append(f)
    out = {"коли": datetime.now().isoformat(timespec="seconds"), "секунд": round(time.time() - t0, 1),
           **STATS, "знахідок": len(uniq), "знахідки": uniq}
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"reys_{datetime.now():%Y-%m-%d_%H%M}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    shutil.rmtree(TMP, ignore_errors=True)
    print(f"Робот «Рейс»: {STATS['сценаріїв']} сценаріїв, {STATS['кроків']} натискань "
          f"({STATS['відмов_ввічливих']} ввічливих відмов), {out['секунд']} с. Знахідок: {len(uniq)}")
    for f in uniq:
        print(f"- [{f['тип']}] {f['де']}: {f['що']}")
    print("Звіт:", path)
    if "--tg" in sys.argv and uniq:      # власнику — лише коли є що виправляти
        tell("🤖 Робот перевірив «Рейс»: знайшов " + str(len(uniq)) + "\n\n" +
             "\n".join(f"• {f['де']}: {f['що']}"[:300] for f in uniq[:8]) + "\n\nВиправлю й повідомлю.")
    return len(uniq)


def tell(text):
    import urllib.parse, urllib.request
    env = dict(l.strip().split("=", 1) for l in open(os.path.join(HOME, ".env"), encoding="utf-8")
               if "=" in l and not l.startswith("#"))
    tok, admin = env["BOT_TOKEN"].strip().strip('"'), env["ADMIN_ID"].strip().strip('"')
    data = urllib.parse.urlencode({"chat_id": admin, "text": text}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/sendMessage", data, timeout=20)
    except Exception as e:
        print("telegram:", e)


if __name__ == "__main__":
    asyncio.run(main())
