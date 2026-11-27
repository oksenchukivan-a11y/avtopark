"""«Хвіст дня»: накладні міста поза путівкою. 1С тут підставна — маленька база в пам'яті з тими самими запитами."""
import asyncio
import datetime as dt
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from reys import engine, handlers, onec, store, tail, view  # noqa: E402

REAL, SHEET, ORDER = "Document_РеализацияТоваровУслуг", "Document_ПутевойЛист", "Document_ЗаказПокупателя"


class Fake1C:
    """Розуміє рівно ті умови, якими модуль питає 1С: ключі, проміжок дат, «проведено»."""
    def __init__(self):
        self.data, self.calls = {}, []

    async def call(self, tool, **a):
        flt = a.get("filter") or ""
        self.calls.append((a.get("object"), flt))
        keys = {}
        for field, val in re.findall(r"(\w+) eq guid'([^']+)'", flt):
            keys.setdefault(field, set()).add(val)
        dates = re.findall(r"Date (ge|gt|le|lt) datetime'([^']+)'", flt)
        ops = {"ge": lambda x, y: x >= y, "gt": lambda x, y: x > y, "le": lambda x, y: x <= y, "lt": lambda x, y: x < y}
        out = []
        table = self.data.get(a.get("object"), [])
        if a.get("object") == SHEET + "_Контрагенты":                # рядки путівок як окрема таблиця, як у справжній 1С
            table = [dict(row, Ref_Key=s["Ref_Key"]) for s in self.data[SHEET] for row in s["Контрагенты"]]
        for r in table:
            if any(r.get(f) not in v for f, v in keys.items()):
                continue
            if any(not ops[op](r.get("Date", "")[:19], v[:19]) for op, v in dates):
                continue
            if "Posted eq true" in flt and not r.get("Posted", True):
                continue
            out.append(dict(r))
        keep = set((a.get("select") or "").split(","))
        return [{k: v for k, v in r.items() if not keep or k in keep} for r in out]


def base():
    f = Fake1C()
    cl = [("c1", "Салон Один (вул. А 1)", "Сумы"), ("c2", "Салон Два (вул. Б 2)", "сумы"), ("c3", "Салон Три (вул. В 3)", "г. Сумы"),
          ("c4", "Свій Магазин №2", "Сумы"), ("c5", "Салон Ромни", "Ромны"), ("c6", "Салон Шість (вул. Г 6)", "Сумы")]
    f.data["Catalog_Контрагенты"] = [{"Ref_Key": k, "Description": n, "ДополнительноеОписание": c} for k, n, c in cl]
    f.data["Catalog_ФизическиеЛица"] = [{"Ref_Key": "a1", "Description": "Манікюр Тестова Олена"}]
    inv = [("i1", "c1", "2026-11-23T10:00:00", 500, "доставка на середу"), ("i2", "c2", "2026-11-23T10:05:00", 300, ""),
           ("i3", "c3", "2026-11-23T14:30:00", 700, "набрати за 10 хв"),      # після друку — у жодній путівці
           ("i4", "c4", "2026-11-23T15:00:00", 900, ""),                      # свій магазин
           ("i5", "c2", "2026-11-24T09:00:00", 250, ""),
           ("i6", "c5", "2026-11-24T15:00:00", 400, ""),                      # область
           ("i7", "c6", "2026-11-24T14:00:00", 150, "НП, склад 5"),           # пошта
           ("i9", "c6", "2026-11-24T15:30:00", 620, "на п'ятницю"),           # після друку й відкладена
           ("i8", "c3", "2026-11-25T10:00:00", 810, "")]
    f.data[REAL] = [{"Ref_Key": r, "Number": f"ОСПК00007{n:02d}", "Date": d, "СуммаДокумента": float(s), "Контрагент_Key": c,
                     "Агент_Key": "a1", "Posted": True} for n, (r, c, d, s, _) in enumerate(inv)]
    f.data[ORDER] = [{"Ref_Key": "o" + r, "Date": d[:11] + "08:00:00", "Комментарий": cm, "СуммаДокумента": float(s),
                      "Контрагент_Key": c, "Posted": True} for r, c, d, s, cm in inv]
    row = lambda c, i: {"Контрагент_Key": c, "Документ_Key": i, "Долг": 0.0}          # noqa: E731
    f.data[SHEET] = [
        {"Ref_Key": "s1", "Number": "0008001", "Date": "2026-11-23T13:00:00", "Контрагенты": [row("c1", "i1"), row("c2", "i2")]},
        {"Ref_Key": "s2", "Number": "0008002", "Date": "2026-11-24T13:00:00", "Контрагенты": [row("c2", "i5")]},
        {"Ref_Key": "s3", "Number": "0008003", "Date": "2026-11-25T13:00:00", "Контрагенты": [row("c3", "i8")]}]
    return f


def add_invoice(f, ref, client, when, total, comment=""):
    f.data[REAL].append({"Ref_Key": ref, "Number": "ОСПК0000" + re.sub(r"\D", "", ref).zfill(3) + "9", "Date": when,
                         "СуммаДокумента": float(total), "Контрагент_Key": client, "Агент_Key": "a1", "Posted": True})
    f.data[ORDER].append({"Ref_Key": "o" + ref, "Date": when[:11] + "08:00:00", "Комментарий": comment,
                          "СуммаДокумента": float(total), "Контрагент_Key": client, "Posted": True})


def refs(run, where="route"):
    return {st["name"]: [(i["ref"], i.get("tail", "")) for i in st["inv"]] for st in run["stops"] if st["where"] == where}


class World:
    def __enter__(self):
        store.DB_PATH = os.path.join(tempfile.mkdtemp(), "t.db")
        store.init()
        tail.init()
        self.f = base()
        self.keep = (onec.call, onec.URL, handlers.ADMIN)
        onec.call, onec.URL, handlers.ADMIN = self.f.call, "http://stub", 111
        handlers.AGENTS.clear()
        os.environ.update(REYS_TAIL="1", REYS_OWN_SHOPS="свій магазин, Ще Один")
        return self.f

    def __exit__(self, *a):
        onec.call, onec.URL, handlers.ADMIN = self.keep
        os.environ.pop("REYS_TAIL", None)
        os.environ.pop("REYS_OWN_SHOPS", None)


def close_run(uid, run):
    store.close(store.create(uid, run), run)


def test_tail_adds_what_the_sheet_missed():
    """Відкладена приїжджає у свій день, виписана після друку — наступного дня, привезена назад — знову в рейс."""
    async def go():
        with World() as f:
            mon = await handlers.load_run("s1")                                   # понеділок: у путівці відкладена «на середу»
            assert mon["tailable"] and refs(mon) == {"Салон Два": [("i2", "")]} and refs(mon, "skip") == {"Салон Один": [("i1", "")]}
            assert [w["ref"] for w in tail.waits_for("2026-11-25")] == ["i1"]     # запам'ятали, на коли вона
            tue = await handlers.load_run("s2")                                   # вівторок: + виписана вчора після друку
            assert refs(tue) == {"Салон Два": [("i5", "")], "Салон Три": [("i3", "new")]}     # ні свій магазин, ні область
            three = next(s for s in tue["stops"] if s["name"] == "Салон Три")
            assert three["addr"] == "вул. В 3" and three["inv"][0]["manager"] and "CALL" in three["inv"][0]["tags"]
            v = view.run_view(tue)["stops"]
            assert [s["tails"] for s in v] == [[], ["🆕 після путівки"]] and v[1]["ride"][0]["tail"] == "🆕 після путівки"
            # водій розвіз: Два оплатив, у Три зачинено — товар не залишив
            engine.pay_all(tue["stops"][0], 333)
            engine.mark_none(three, 333, "closed", left=False)
            close_run(333, tue)
            wed = await handlers.load_run("s3")                                   # середа
            got = refs(wed)
            assert got == {"Салон Три": [("i8", ""), ("i3", "back")],             # та сама точка, не дубль
                           "Салон Один": [("i1", "moved")]}                       # відкладена приїхала у свій день
            labels = {s["name"]: s["tails"] for s in view.run_view(wed)["stops"]}
            assert labels == {"Салон Три": ["↩️ не доставлено вт 24.11"], "Салон Один": ["📌 перенесено з пн 23.11"]}
            assert "DATE" not in next(s for s in wed["stops"] if s["name"] == "Салон Один")["inv"][0]["tags"]
            assert [w["ref"] for w in tail.waits_for("2026-11-27", strict=True)] == ["i9"]    # «на п'ятницю» чекає п'ятниці
            assert engine.totals(wed)["stops"] == 2
            # те, що доставлено, наступного дня не повертається
            for st in wed["stops"]:
                engine.pay_all(st, 333)
            close_run(333, wed)
            again = await handlers.load_run("s3")
            assert refs(again) == {"Салон Три": [("i8", "")]}                     # лише те, що в самій путівці
            # пробний рейс власника нічого не «доставляє»
            done, back = tail.past(ignore={333})
            assert done == set() and back == {}
    asyncio.run(go())


def test_invoice_from_a_deleted_sheet_counts_as_not_in_any_sheet():
    async def go():
        with World() as f:
            row = lambda c, i: {"Контрагент_Key": c, "Документ_Key": i, "Долг": 0.0}      # noqa: E731
            f.data[SHEET].append({"Ref_Key": "sx", "Number": "0008009", "Date": "2026-11-24T10:00:00", "DeletionMark": True,
                                  "Контрагенты": [row("c5", "i6"), row("c5", "x1"), row("c3", "i3")]})   # обласна путівка
            tue = await handlers.load_run("s2")                                   # i3 була лише у вилученій путівці
            assert refs(tue)["Салон Три"] == [("i3", "new")]
            f.data[SHEET][-1]["DeletionMark"] = False                             # путівка жива — накладна вже чиясь
            assert "Салон Три" not in refs(await handlers.load_run("s2"))
    asyncio.run(go())


def test_tail_is_off_by_default_and_only_for_city():
    async def go():
        with World() as f:
            os.environ["REYS_TAIL"] = "0"
            run = await handlers.load_run("s2")
            assert "tailable" not in run and refs(run) == {"Салон Два": [("i5", "")]}
            os.environ["REYS_TAIL"] = "1"
            for c in f.data["Catalog_Контрагенты"]:                               # та сама путівка, але клієнти обласні
                if c["Ref_Key"] == "c2":
                    c["ДополнительноеОписание"] = "Ромны"
            run = await handlers.load_run("s2")
            assert "tailable" not in run and refs(run) == {"Салон Два": [("i5", "")]}
    asyncio.run(go())


def test_1c_trouble_does_not_stop_the_run():
    """1С мовчить на «хвості» — рейс відкривається таким, як у путівці; відкладене з нашої бази все одно додається."""
    async def go():
        with World() as f:
            await handlers.load_run("s1")
            real = f.call

            async def flaky(tool, **a):
                if a.get("object") == REAL and "Date gt" in (a.get("filter") or ""):
                    raise onec.OneCError("немає зв'язку")
                return await real(tool, **a)
            onec.call = flaky
            wed = await handlers.load_run("s3")
            assert refs(wed) == {"Салон Три": [("i8", "")], "Салон Один": [("i1", "moved")]}
    asyncio.run(go())


def test_urgent_orders_arrive_while_the_run_is_open():
    """Поки рейс відкритий: нова накладна міста → точка «терміново» й одне повідомлення; нічого нового — один запит."""
    class Bot:
        def __init__(self):
            self.sent = []

        async def send_message(self, chat_id, text, **kw):
            self.sent.append((chat_id, text))

    async def go():
        with World() as f:
            wed = await handlers.load_run("s3")
            for t in (333, 444):
                store.crew_add("s3", t, 111)
            wed["sheet_ref"] = "s3"
            run_id = store.create(333, wed)
            bot, at = Bot(), dt.datetime(2026, 11, 25, 14, 30)
            f.calls.clear()
            assert await tail.tick(bot, now=at) == [] and len(f.calls) == 1        # тихо: один запит до 1С
            assert await tail.tick(bot, now=dt.datetime(2026, 11, 25, 19, 0)) == [] and len(f.calls) == 1   # після 18 не питаємо
            add_invoice(f, "i10", "c3", "2026-11-25T14:40:00", 333)                 # дозамовив клієнт, який уже в рейсі
            add_invoice(f, "i11", "c2", "2026-11-25T14:45:00", 444)                 # і ще один, якого в рейсі не було
            add_invoice(f, "i12", "c5", "2026-11-25T14:50:00", 555)                 # область — не наше
            got = await tail.tick(bot, now=dt.datetime(2026, 11, 25, 15, 0))
            assert [x["ref"] for x in got] == ["i10", "i11"]
            run = store.get(run_id)
            assert refs(run) == {"Салон Три": [("i8", ""), ("i10", "urgent")], "Салон Два": [("i11", "urgent")]}
            assert [c for c, _ in bot.sent] == [333, 444] and "Терміново додалось у рейс: 2" in bot.sent[0][1]
            assert await tail.tick(bot, now=dt.datetime(2026, 11, 25, 15, 10)) == [] and len(bot.sent) == 2   # вдруге не шле
            # точку вже відмічено, а клієнт дозамовив ще — це нова точка, гроші першої не чіпаємо
            run = store.get(run_id)
            three = next(s for s in run["stops"] if s["name"] == "Салон Три")
            engine.pay_all(three, 333)
            cash = three["status"]["cash"]
            store.save(run_id, run)
            add_invoice(f, "i13", "c3", "2026-11-25T15:20:00", 99)
            await tail.tick(bot, now=dt.datetime(2026, 11, 25, 15, 30))
            run = store.get(run_id)
            same = [s for s in run["stops"] if s["name"] == "Салон Три"]
            assert len(same) == 2 and same[0]["status"]["cash"] == cash and [i["ref"] for i in same[1]["inv"]] == ["i13"]
            with store.db() as c:
                assert c.execute("SELECT COUNT(*) n FROM reys_events WHERE action='tail'").fetchone()["n"] == 2
            # після здачі каси власник бачить, що лишилось на складі
            for s in run["stops"]:
                if not s["status"]:
                    engine.mark_none(s, 333, "closed", left=False) if s["name"] == "Салон Два" else engine.pay_all(s, 333)
            add_invoice(f, "i14", "c6", "2026-11-25T16:10:00", 77)                  # виписали, коли рейс уже закінчувався
            text = await tail.left_behind(run, now=dt.datetime(2026, 11, 25, 17, 0))
            assert "не поїхала: 2" in text and "Салон Два" in text and "Салон Шість" in text and "Тестова Олена" in text
            for s in run["stops"]:
                if s["name"] == "Салон Два":
                    s["status"]["kind"] = "paid"
            f.data[REAL] = [d for d in f.data[REAL] if d["Ref_Key"] != "i14"]
            assert await tail.left_behind(run, now=dt.datetime(2026, 11, 25, 17, 0)) is None     # усе розвезли — мовчимо
    asyncio.run(go())


def test_history_counts_what_tail_would_have_added():
    async def go():
        with World():
            lines = []
            total = await tail.history(dt.date(2026, 11, 24), dt.date(2026, 11, 25), out=lines.append)
            assert total == {"a": [1, 500.0], "b": [1, 700.0]}                     # i1 у середу, i3 у вівторок
            assert any(x.startswith("24.11 вт") for x in lines) and any(x.startswith("25.11 ср") for x in lines)
            with store.db() as c:
                assert c.execute("SELECT COUNT(*) n FROM reys_wait").fetchone()["n"] == 0   # перевірка в базу не пише
    asyncio.run(go())
