#!/usr/bin/env python3
"""Робот-тестувальник «Рейсу» (рішення власника 26.11.2026: «роби зараз», далі — для всіх ботів).

Проганяє логіку рейсу на ТЕСТОВІЙ копії бази (бойова reports.db не чіпається), без 1С, на демо-путівці:
  1. Сценарії — кожна дія, як її робить водій (забрав усе, частково, сума, не забрав, віддав, товар, витрата, здача).
  2. Гроші після КОЖНОГО кроку: суми накладних не мінус, «на руки» = зібрано − витрати, відмова зменшує накладну
     рівно на кількість × ціну, підсумок здачі = сума по точках.
  3. Захист від помилок людини: подвійне натискання, здача з невідміченими точками, «абв» замість суми, мінус,
     неіснуюча точка/позиція — має бути ввічлива відмова, а не збій.
  4. «Хаотичний водій»: тисячі випадкових натискань (зерно фіксоване — будь-яку знахідку можна повторити).
  5. Екіпаж із двох: один рейс і одна каса на двох, відмітки не губляться й не задвоюються, частки 50/50 і 100 %.
  6. Звіт менеджерам: сума менеджера = оплати по його накладних, двоє на одній точці бачать кожен своє.
  7. Помилки складу: кожна позиція — один рядок, відмова клієнта туди не йде, пробний рейс у місяць не рахується.
  8. Звіт за день: без авто й ящиків касу не здати, частки екіпажу в сумі дають ціле, навчальний рейс у зарплату не йде.
  9. Кнопки бота: кожна кнопка кожного екрана — текст не порожній, дані кнопки ≤ 64 байти (ліміт Telegram);
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
from reys import daily, wh_report  # noqa: E402
wh_report.init()
daily.init()

UID = 999000001
FIND = []          # знахідки: {"тип", "де", "що", "кроки"}
STATS = {"кроків": 0, "відмов_ввічливих": 0, "сценаріїв": 0}


def finding(kind, where, what, steps=None):
    FIND.append({"тип": kind, "де": where, "що": what, "кроки": steps or []})


async def call(act, _uid=None, **a):
    STATS["кроків"] += 1
    try:
        return "ok", await web.ACTIONS[act](_uid or UID, a)
    except web.Bad as e:
        STATS["відмов_ввічливих"] += 1
        return "bad", str(e)


def run_now(uid=None):
    return store.open_run(uid or UID)[1]


def check(tag, orig, steps, uid=None):
    """Гроші й стан після кроку. orig — початкові суми накладних {ref: sum}."""
    run = run_now(uid)
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
BOSS, DRV_A, DRV_B = 999000010, 999000011, 999000012
CREW_REF = "00000000-0000-0000-0000-00000000c0de"
SOLO_REF = "00000000-0000-0000-0000-0000000050f0"


async def scenario_crew(seed=7):
    """Рішення власника 27.11: путівку везе екіпаж з одного-двох водіїв — рейс і каса одні, усе навпіл."""
    STATS["сценаріїв"] += 1
    rnd = random.Random(seed)
    keep = (hd.ADMIN, set(hd.TESTERS), hd.load_run, onec.URL)

    async def load(ref):
        run = build.demo_run(hd.today())
        run.pop("demo")
        run.update(sheet_ref=ref, sheet_no=ref[-4:])
        return run
    hd.ADMIN, hd.load_run = BOSS, load
    hd.TESTERS.clear()
    hd.TESTERS.update({BOSS, DRV_A, DRV_B})
    try:
        for d in (DRV_A, DRV_B):
            if (await call("assign", _uid=BOSS, id="1c:" + CREW_REF, to=d))[0] != "ok":
                finding("екіпаж", "закріплення", f"власник не зміг додати водія {d} в екіпаж")
        if (await call("assign", _uid=DRV_A, id="1c:" + SOLO_REF, to=DRV_A))[0] == "ok":
            finding("захист", "закріплення", "водій сам закріпив за собою путівку")
        if (await call("assign", _uid=BOSS, id="1c:" + CREW_REF, to=BOSS))[0] == "ok":
            finding("захист", "закріплення", "в екіпаж потрапила людина не зі списку водіїв")
        await call("start", _uid=DRV_A, id="1c:" + CREW_REF)
        await call("start", _uid=DRV_B, id="1c:" + CREW_REF)
        ida, idb = store.open_run(DRV_A)[0], store.open_run(DRV_B)[0]
        if not ida or ida != idb:
            finding("екіпаж", "один рейс на двох", f"у водіїв різні рейси: {ida} і {idb}")
        orig = {inv["ref"]: inv["sum"] for s in run_now(DRV_A)["stops"] for inv in s["inv"]}
        steps, events = [], 0
        for k in route_idx(run_now(DRV_A)):
            who, other = rnd.sample([DRV_A, DRV_B], 2)
            act = rnd.choice(["all", "today", "amount", "none"])
            a = {"i": k, "sum": str(rnd.randint(50, 900)), "reason": "acct"}
            first = await call(act, _uid=who, **a)
            steps.append(f"{who % 100}:{act}({k})→{first[0]}")
            again = await call(rnd.choice(["all", "today"]), _uid=other, i=k)          # напарник тисне ту саму точку
            marked = run_now(who)["stops"][k]["status"]
            if marked and again[0] == "ok":
                finding("екіпаж", "та сама точка двічі", f"точку {k} відмітили обидва — гроші могли задвоїтись", steps[-4:])
            ta, tb = engine.totals(run_now(DRV_A)), engine.totals(run_now(DRV_B))
            if ta != tb:
                finding("екіпаж", "каса", f"водії бачать різні підсумки: {ta['cash']} і {tb['cash']}", steps[-4:])
            real = round(sum(s["status"]["cash"] for s in run_now(DRV_A)["stops"] if s["status"]), 2)
            if abs(real - ta["cash"]) > 0.01:
                finding("гроші", "екіпаж", f"каса {ta['cash']} ≠ сума по точках {real}", steps[-4:])
            check("екіпаж", orig, steps[-4:], uid=DRV_A)
        # одночасно: поки один тримає стару копію рейсу, другий записує — стара копія не має лягти поверх
        rid, mine = store.open_run(DRV_A)
        _, theirs = store.open_run(DRV_B)
        mine["expenses"].append({"kind": "Інше", "sum": 10.0, "ts": store.now()})
        store.save(rid, mine)
        cash = engine.totals(theirs)["cash"]
        for s in theirs["stops"]:
            s["status"] = None
        try:
            store.save(rid, theirs)
            finding("екіпаж", "одночасний запис", f"стара копія рейсу затерла відмітки напарника (каса {cash} → 0)")
        except store.Stale:
            pass
        if engine.totals(run_now(DRV_A))["spent"] != 10.0:
            finding("екіпаж", "одночасний запис", "витрата напарника загубилась")
        got = store.shares(hd.today())
        want = {DRV_A: [(CREW_REF, 0.5, [DRV_B])], DRV_B: [(CREW_REF, 0.5, [DRV_A])]}
        if got != want:
            finding("екіпаж", "розподіл", f"двоє в екіпажі мають ділити навпіл, а вийшло {got}")
        if (await call("start", _uid=DRV_B, id="demo"))[0] == "ok" and store.open_run(DRV_B)[0] != rid:
            finding("екіпаж", "рейс з грошима", "водій пішов з рейсу екіпажу в інший, не здавши касу")
        if (await call("assign", _uid=BOSS, id="1c:" + CREW_REF, to=DRV_B, on=False))[0] == "ok":
            finding("екіпаж", "зміна екіпажу", "водія зняли з рейсу, у якому вже є відмітки")
        hand = engine.totals(run_now(DRV_A))["hand"]
        r = await call("close", _uid=DRV_B)
        if r[0] != "ok" or abs(r[1]["done"]["hand"] - hand) > 0.01:
            finding("екіпаж", "здача каси", f"напарник не зміг здати спільну касу або сума інша: {r}")
        if run_now(DRV_A) or run_now(DRV_B):
            finding("екіпаж", "здача каси", "після здачі в когось із екіпажу рейс лишився відкритим")
        with store.db() as c:
            n = c.execute("SELECT COUNT(*) n FROM reys_runs WHERE sheet_ref=? AND status='closed'", (CREW_REF,)).fetchone()["n"]
        if n != 1:
            finding("гроші", "екіпаж", f"по путівці екіпажу здано {n} кас замість однієї — каса задвоїлась")
        if (await call("start", _uid=DRV_A, id="1c:" + CREW_REF))[0] == "ok" and run_now(DRV_A):
            finding("екіпаж", "здача каси", "здану путівку відкрили вдруге")
        # один водій — уся путівка його
        await call("assign", _uid=BOSS, id="1c:" + SOLO_REF, to=DRV_A)
        await call("start", _uid=DRV_A, id="1c:" + SOLO_REF)
        solo = store.shares(hd.today()).get(DRV_A, [])
        if (SOLO_REF, 1.0, []) not in solo:
            finding("екіпаж", "розподіл", f"один водій має отримати 100 %, а вийшло {solo}")
        if run_now(DRV_B):
            finding("захист", "екіпаж", "чужий рейс видно водієві, якого немає в екіпажі")
        for uid, rows in store.shares(hd.today()).items():
            for ref, part, mates in rows:
                if abs(part * (len(mates) + 1) - 1) > 0.01:
                    finding("екіпаж", "розподіл", f"частки по путівці {ref[-4:]} не дають 100 %: {part} × {len(mates) + 1}")
    finally:
        with store.db() as c:
            c.execute("UPDATE reys_runs SET status='dropped' WHERE tg_id IN (?,?,?) AND status='open'", (BOSS, DRV_A, DRV_B))
            c.execute("DELETE FROM reys_crew")
        hd.ADMIN, hd.load_run, onec.URL = keep[0], keep[2], keep[3]
        hd.TESTERS.clear()
        hd.TESTERS.update(keep[1])


async def scenario_mgr_report(seed=3):
    """Рішення власника 27.11: після здачі каси менеджер бачить своїх клієнтів — що забрано, що ні і чому."""
    from reys import mgr_report
    STATS["сценаріїв"] += 1
    rnd = random.Random(seed)
    await fresh()
    for k in route_idx(run_now()):
        act = rnd.choice(["all", "today", "amount", "none", "given"])
        await call(act, i=k, sum=str(rnd.randint(50, 900)), reason=rnd.choice(["acct", "mgr", "closed", "atpoint"]))
    run = run_now()
    reps = mgr_report.build(run, "перевірка", "робот")
    total = 0
    for m, text in reps.items():
        refs = {i["ref"] for s in run["stops"] for i in s["inv"] if engine.clean(i.get("manager")) == m}
        refs |= {d["ref"] for s in run["stops"] for d in engine.debts(s) if engine.clean(d.get("manager")) == m}
        got = round(sum(x["paid"] for s in run["stops"] if s["status"] for x in s["status"]["alloc"] if x["ref"] in refs), 2)
        total += got
        if f"Забрано <b>{engine.money(got)}</b>" not in text:
            finding("гроші", "звіт менеджеру", f"у звіті сума не та, що оплачено по накладних менеджера ({got})")
        if len(text) > 4000:
            finding("кнопки", "звіт менеджеру", f"звіт довший за ліміт Telegram: {len(text)} знаків")
        for other in reps:
            if other != m and view.mgr_view(other, {})["label"] in text.split("твої клієнти")[0]:
                finding("логіка", "звіт менеджеру", "у шапці звіту — чужий менеджер")
    if total - engine.totals(run)["cash"] > 0.01:
        finding("гроші", "звіт менеджерам", f"менеджерам разом показано {total}, а зібрано {engine.totals(run)['cash']}")
    two = [s for s in run["stops"] if s["status"] and len({engine.clean(i.get("manager")) for i in engine.riding(s)} - {""}) > 1]
    for s in two:
        seen = [m for m, text in reps.items() if s["name"] in text]
        names = {engine.clean(i.get("manager")) for i in engine.riding(s)}
        if set(seen) < names:
            finding("логіка", "звіт менеджерам", f"{s['name']}: точку ведуть двоє, а у звіті вона не в кожного")


async def scenario_warehouse(seed=5):
    """Рішення власника 27.11: «не вистачає / не той / пошкоджено» — помилка збору, до комірника й у підсумок місяця."""
    STATS["сценаріїв"] += 1
    rnd = random.Random(seed)
    await fresh()
    want = set()
    for k in route_idx(run_now()):
        r = await call("items", i=k)
        if r[0] != "ok":
            continue
        for it in r[1]["items"][:2]:
            kind = rnd.choice(list(engine.PROBLEMS))
            if (await call("problem", i=k, kind=kind, rows=[{"ii": it["ii"], "li": it["li"], "qty": 1}]))[0] == "ok" \
                    and kind in wh_report.KINDS:
                want.add((k, it["no"], kind, it["name"]))
        if rnd.random() < 0.5 and (await call("other", i=k, kind="wrong"))[0] == "ok":
            want.add((k, "—", "wrong", engine.OTHER_ITEM))
    run = run_now()

    def rows():
        with store.db() as c:
            return [tuple(r) for r in c.execute("SELECT inv_no, kind, item, test FROM reys_wh_probs")]
    with store.db() as c:
        c.execute("DELETE FROM reys_wh_probs")
    text = await wh_report.collect(run, "перевірка", "робот")
    got = rows()
    if len(got) != len(want):
        finding("логіка", "помилки складу", f"позначено {len(want)} позицій складу, а записано {len(got)}")
    if any(r[1] not in wh_report.KINDS for r in got):
        finding("логіка", "помилки складу", "у помилки складу потрапила відмова клієнта")
    if any(r[3] != 1 for r in got):
        finding("логіка", "помилки складу", "навчальний рейс пішов у місячний підсумок комірників")
    if want and (not text or "🗓" in text):
        finding("логіка", "помилки складу", "звіт навчального рейсу порожній або показує місячний підсумок")
    if text and len(text) > 4000:
        finding("кнопки", "помилки складу", f"звіт довший за ліміт Telegram: {len(text)} знаків")
    await wh_report.collect(run, "перевірка", "робот")
    if rows() != got:
        finding("логіка", "помилки складу", "повторний збір того самого рейсу задвоїв рядки")
    with store.db() as c:
        c.execute("DELETE FROM reys_wh_probs")


async def scenario_daily(seed=11):
    """Рішення власника 27.11: «Звіт за день» здається разом із касою — авто, ящики, пошта, стан авто."""
    STATS["сценаріїв"] += 1
    rnd = random.Random(seed)
    sent = []
    keep = (dict(daily.VEHICLES), daily.TO_REPORTS, os.environ.get("REYS_TO_REPORTS"))
    daily.VEHICLES = {"AA1111AA": "Бус 1", "BB2222BB": "Бус 2"}
    daily.TO_REPORTS = lambda row: sent.append(row) or "written"
    os.environ["REYS_TO_REPORTS"] = "1"
    try:
        await fresh()
        for k in route_idx(run_now()):
            await call("all", i=k)
            if not run_now()["stops"][k]["status"]:
                await call("given", i=k)
        good = {"boxes": 9, "sent": 1, "received": 2, "ok": True}
        if (await call("close", daily=good))[0] == "ok":
            finding("захист", "звіт за день", "касу здано без вибору авто")
            return
        for codes in ([], ["ZZ"], "AA1111AA", ["AA1111AA", "AA1111AA"], None):
            if (await call("vehicle", codes=codes))[0] == "ok":
                finding("захист", "вибір авто", f"прийнято неправильний список авто: {codes!r}")
        await call("vehicle", codes=["BB2222BB", "AA1111AA"])
        if run_now().get("vehicles") != ["BB2222BB", "AA1111AA"]:              # порядок — як вибирав водій
            finding("логіка", "вибір авто", f"авто записались не так: {run_now().get('vehicles')}")
        bad = [None, {}, {"boxes": "", "ok": True}, {"boxes": "абв", "ok": True}, {"boxes": -1, "ok": True},
               {"boxes": 99999, "ok": True}, {"boxes": 5}, {"boxes": 5, "ok": "так"}, {"boxes": 5, "ok": False},
               {"boxes": 5, "ok": False, "desc": "подряпина"},               # два авто — не сказано, яке
               {"boxes": 5, "ok": False, "car": "ZZ", "desc": "подряпина"}, {"boxes": 5, "sent": "x", "ok": True},
               {"boxes": 5, "received": -3, "ok": True}]
        for out, recv in (("x", 1), (-1, 0), (1, 99999)):
            if (await call("post", sent=out, received=recv))[0] == "ok":
                finding("захист", "пошта", f"прийнято неправильні числа: {out!r}, {recv!r}")
        await call("post", sent=1, received=0)                                 # зранку відправив
        await call("post", sent=1, received=2)                                 # у кінці маршруту ще й отримав
        for d in bad:
            if (await call("close", daily=d))[0] == "ok":
                finding("захист", "звіт за день", f"касу здано з неповним звітом: {d!r}")
                return
        rid = store.open_run(UID)[0]
        r = await call("close", daily={"boxes": 9, "ok": False, "car": "BB2222BB", "desc": "  тріщина   на склі "})
        if r[0] != "ok":
            finding("збій", "звіт за день", f"правильний звіт не прийнято: {r[1]}")
            return
        await daily.drain()
        rows = daily.rows(run_id=rid)
        if len(rows) != 1 or rows[0]["test"] != 1 or rows[0]["sent"] or sent:
            finding("гроші", "звіт за день", "навчальний рейс пішов у старий звіт (зарплату) або записався не одним рядком")
        elif (rows[0]["boxes"], rows[0]["boxes_sent"], rows[0]["boxes_received"], rows[0]["damage_vehicle"],
              rows[0]["damage_desc"], rows[0]["vehicle"]) != (9, 1, 2, "BB2222BB", "тріщина на склі", "BB2222BB,AA1111AA"):
            finding("логіка", "звіт за день", f"у рядку не те, що ввів водій: {rows[0]}")
        # частки екіпажу: скільки б не було ящиків, у сумі — рівно стільки, скільки ввели
        for n in range(40):
            boxes, post = rnd.randint(0, 300), rnd.randint(0, 40)
            run = build.demo_run(hd.today())
            run.pop("demo")
            run.update(sheet_ref=f"robot-{n}", vehicles=["AA1111AA"],
                       daily={"boxes": boxes, "sent": post // 3, "received": post - post // 3, "ok": True,
                              "damage_vehicle": "", "damage_desc": ""})
            for s in run["stops"][:rnd.randint(1, len(run["stops"]))]:
                s["status"] = {"kind": "paid", "cash": 0, "alloc": []}
            team = [DRV_A, DRV_B][:rnd.randint(1, 2)]
            run_id = store.create(DRV_A, run)
            got = daily.write(run_id, run, team, test=True)
            pts = sum(1 for s in run["stops"] if s["status"])
            if abs(sum(x["boxes"] for x in got) - boxes) > 0.011 or abs(sum(x["boxes_received"] + x["boxes_sent"] for x in got) - post) > 0.011 \
                    or abs(sum(x["points"] for x in got) - pts) > 0.011 or sum(x["km_owner"] for x in got) != 1:
                finding("гроші", "звіт за день", f"частки екіпажу з {len(team)} не дають цілого: ящиків {boxes}, пошта {post}, точок {pts}")
            store.drop(run_id)
    finally:
        daily.VEHICLES, daily.TO_REPORTS = keep[0], keep[1]
        os.environ.pop("REYS_TO_REPORTS", None) if keep[2] is None else os.environ.update(REYS_TO_REPORTS=keep[2])
        with store.db() as c:
            c.execute("DELETE FROM reys_daily")
            c.execute("UPDATE reys_runs SET status='dropped' WHERE tg_id IN (?,?) AND status='open'", (DRV_A, DRV_B))


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
        ("start", {"id": "1c:11111111-2222-3333-4444-555555555555"}, "чужа путівка за кодом"),
        ("start", {"id": "sn:2026-11-25_1301_8389"}, "знімок не власником"),
        ("assign", {"id": "1c:11111111-2222-3333-4444-555555555555", "to": UID}, "закріпити путівку не власником"),
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
    # рейс з грошима не можна загубити, відкривши інший
    cash = engine.totals(run_now())["cash"]
    for force in (False, True):
        r = await call("start", id="demo", force=force)
        now = run_now()
        if r[0] == "ok" or not now or abs(engine.totals(now)["cash"] - cash) > 0.005:
            finding("захист", "рейс з відмітками", f"новий рейс (force={force}) скинув відкритий з грошима {cash}")


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
                       ("захист", scenario_guards()), ("екіпаж", scenario_crew()),
                       ("звіт менеджерам", scenario_mgr_report()), ("помилки складу", scenario_warehouse()),
                       ("звіт за день", scenario_daily()),
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
