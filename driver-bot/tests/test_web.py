"""Застосунок рейсу: підпис Telegram, доступ і повний прохід через API. Дані вигадані."""
import asyncio
import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlencode

from aiogram.methods import DeleteMessage, SendMessage
from aiohttp.test_utils import TestClient, TestServer

from reys import handlers, store, web
from test_flow import ME, STRANGER, Tg

TOKEN = "42:TEST"


def init_data(uid, token=TOKEN, age=0, **extra):
    pairs = {"auth_date": str(int(time.time()) - age), "query_id": "AAE",
             "user": json.dumps({"id": uid, "first_name": "Тест"}, ensure_ascii=False), **extra}
    line = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    pairs["hash"] = hmac.new(web.secret_for(token), line.encode(), hashlib.sha256).hexdigest()
    return urlencode(pairs)


class App:
    """Бот із підставним Telegram + веб-застосунок на випадковому порту."""
    async def __aenter__(self):
        os.environ["REYS_WEB_URL"] = "https://reys.example.test/"
        self.tg = Tg()
        web.STATE.update(bot=self.tg.bot, secret=web.secret_for(TOKEN), runner=object())
        self.client = TestClient(TestServer(web.make_app()))
        await self.client.start_server()
        return self

    async def __aexit__(self, *a):
        await self.client.close()
        web.STATE.update(bot=None, secret=b"", runner=None)
        os.environ.pop("REYS_WEB_URL", None)
        os.environ.pop("REYS_CASHIER", None)

    async def call(self, act, who=ME, init=None, **args):
        r = await self.client.post("/api", json={"init": init or init_data(who), "act": act, "args": args})
        return r.status, await r.json()


def test_signature_and_access():
    async def go():
        async with App() as app:
            assert (await app.call("state"))[0] == 200
            assert (await app.call("state", init="user=%7B%22id%22%3A111%7D&hash=00"))[0] == 401
            assert (await app.call("state", init=init_data(ME, token="42:OTHER")))[0] == 401      # чужий бот
            assert (await app.call("state", init=init_data(ME, age=3 * 24 * 3600)))[0] == 401     # старий підпис
            forged = init_data(STRANGER).replace(str(STRANGER), str(ME))                          # підмінили id
            assert (await app.call("state", init=forged))[0] == 401
            code, j = await app.call("state", who=STRANGER)                                       # не тестувальник
            assert code == 403 and "run" not in j and "menu" not in j
            assert (await app.client.post("/api", data=b"{")).status == 400
            assert (await app.call("no_such"))[0] == 400
            page = await app.client.get("/")
            assert page.status == 200 and "telegram-web-app.js" in await page.text()
            assert (await app.client.get("/t/380501234567")).status == 200
            assert (await app.client.get("/t/12")).status == 404
    asyncio.run(go())


def test_launcher_button_opens_app():
    async def go():
        async with App() as app:
            sent, _ = await app.tg.text("/reys")
            msg = [m for m in sent if isinstance(m, SendMessage)][-1]
            btn = msg.reply_markup.inline_keyboard[0][0]
            assert btn.web_app.url.startswith("https://reys.example.test/?v=") and "Відкрити" in btn.text
            assert len(msg.text.split("\n")[-1]) >= 30          # широкий текст — широка кнопка під ним
            assert store.screen(ME)[1]                                               # кнопку запам'ятали
            sent, _ = await app.tg.text("/reys")                                     # друга — стара зникає
            assert sum(isinstance(m, DeleteMessage) for m in sent) == 2
    asyncio.run(go())


def test_full_run_through_app():
    async def go():
        async with App() as app:
            os.environ["REYS_CASHIER"] = "777"
            await app.tg.text("/reys")
            code, j = await app.call("state")
            assert j["run"] is None and "sheets" in j["menu"]
            code, j = await app.call("start", id="demo")
            r = j["run"]
            assert j["ok"] and len(r["order"]) == 5 and r["totals"]["left"] == 5
            a = r["stops"][0]
            assert a["due"] == 1501.0 and a["pay"][0]["name"] == "№ 1204 · сьогодні"
            # А: забрав усе
            j = (await app.call("all", i=0))[1]
            assert j["run"]["totals"]["cash"] == 1501.0 and j["run"]["stops"][0]["status"]["kind"] == "paid"
            assert not (await app.call("all", i=0))[1]["ok"]                          # двічі не можна
            # Б: сума 2500 при боргу 3600 + 500 сьогодні — розклад від найстарішої
            b = j["run"]["stops"][1]
            assert b["debt"] == 3600.0 and b["debts"][0]["name"] == "№ 1101 від 04.11"
            assert not (await app.call("amount", i=1, sum="абв"))[1]["ok"]
            j = (await app.call("amount", i=1, sum="2 500"))[1]
            st = j["run"]["stops"][1]["status"]
            assert st["cash"] == 2500.0 and [x["paid"] for x in st["alloc"]] == [2000.0, 500.0]
            # В: без оплати
            assert j["run"]["stops"][2]["free"]
            await app.call("given", i=2)
            # Г: нестача, потім окрема накладна
            items = (await app.call("items", i=3))[1]["items"]
            j = (await app.call("problem", i=3, kind="miss", ii=items[1]["ii"], li=items[1]["li"], qty=1))[1]
            assert j["run"]["stops"][3]["due"] == 1380.0 and "не вистачає" in j["run"]["stops"][3]["probs"][0]["text"]
            assert not (await app.call("pick", i=3, ks=[]))[1]["ok"]
            j = (await app.call("pick", i=3, ks=[1]))[1]
            assert j["run"]["stops"][3]["status"]["cash"] == 380.0
            # Д: боржник без грошей — без відповіді про менеджера не пускає
            assert not (await app.call("none", i=4, reason="nomoney"))[1]["ok"]
            assert not (await app.call("close"))[1]["ok"]                             # ще є точка
            j = (await app.call("none", i=4, reason="nomoney", left=False))[1]
            assert j["run"]["stops"][4]["status"]["kind"] == "back"
            # виправити і записати інакше
            await app.call("fix", i=4)
            j = (await app.call("none", i=4, reason="acct"))[1]
            assert j["run"]["stops"][4]["status"]["reason"] == "acct"
            # витрата, помилкова витрата, здача
            await app.call("expense", sum="683,50", kind="Нова пошта")
            await app.call("expense", sum=100, kind="Інше")
            j = (await app.call("expense_del", k=1))[1]
            assert j["run"]["totals"]["spent"] == 683.5
            rid, real = store.open_run(ME)                                           # навчальний рейс не звітує — робимо його справжнім
            real.pop("demo")
            store.save(rid, real)
            before = len(app.tg.session.sent)
            code, j = await app.call("close")
            assert j["ok"] and j["run"] is None and j["done"]["hand"] == round(1501 + 2500 + 380 - 683.5, 2)
            sent = app.tg.session.sent[before:]
            assert any(isinstance(m, DeleteMessage) for m in sent)                    # чат чистий
            report = [m for m in sent if isinstance(m, SendMessage)]
            assert len(report) == 1 and report[0].chat_id == 777 and "здано" in report[0].text   # підсумок — касиру
            assert store.open_run(ME) == (None, None) and store.screen(ME) == (None, None)
            assert (await app.call("state"))[1]["run"] is None
    asyncio.run(go())


def test_small_debts_hidden_and_phones():
    from reys import build, engine, view
    st = {"key": "k", "name": "Салон", "addr": "", "sheet_debt": 7.5, "inv": [], "debts": None, "manager": "",
          "status": None, "probs": []}
    build.classify(st)
    assert st["where"] == "none" and engine.debts(st) == []
    st.update(sheet_debt=1207.5, debts=[{"ref": "a", "no": "5", "date": "2026-11-01", "sum": 7.5},
                                        {"ref": "b", "no": "643", "date": "2026-11-19", "sum": 1200.0}])
    build.classify(st)
    v = view.stop_view(st, 0, {})
    assert st["where"] == "debt" and v["debt"] == 1200.0 and [d["name"] for d in v["debts"]] == ["№ 643 від 19.11"]
    assert handlers.norm_phones("050 123-45-67, (066)1234567; 380971112233 / 12") == \
        ["+380501234567", "+380661234567", "+380971112233"]


def test_hours_and_rate_limit():
    import datetime as dt
    os.environ["REYS_TESTERS"] = "333"
    try:
        async def go():
            async with App() as app:
                night = dt.datetime(2026, 11, 25, 22, 0, tzinfo=handlers.TZ)
                day = dt.datetime(2026, 11, 25, 12, 0, tzinfo=handlers.TZ)
                assert web.working(ME, night) and web.working(333, day) and not web.working(333, night)
                os.environ["REYS_HOURS"] = "8-20"
                assert web.hours() == (8, 20) and web.hours(333) == (8, 20)
                os.environ["REYS_HOURS"] = "333=8-17, 444=9-19"                # свій графік кожному
                assert web.hours(333) == (8, 17) and web.hours(444) == (9, 19) and web.hours(555) == (9, 18)
                os.environ["REYS_HOURS"] = "7-20,333=8-17,сміття,5=30-2"
                assert web.hours(333) == (8, 17) and web.hours(555) == (7, 20) and web.hours(5) == (7, 20)
                os.environ["REYS_HOURS"] = "0-1" if dt.datetime.now(handlers.TZ).hour >= 1 else "23-24"
                code, j = await app.call("state", who=333)                 # водій поза годинами
                assert j["shut"] and "run" not in j and "menu" not in j
                assert (await app.call("state"))[1]["ok"]                  # власника години не стосуються
                web.HITS.clear()
                codes = [(await app.call("state"))[0] for _ in range(web.RATE + 2)]
                assert codes[0] == 200 and codes[-1] == 429
                web.HITS.clear()
        asyncio.run(go())
    finally:
        os.environ.pop("REYS_TESTERS", None)
        os.environ.pop("REYS_HOURS", None)


def test_manager_phone_from_shared_contact():
    import datetime as dt
    from aiogram.types import Chat, Contact, Message, Update, User

    async def go():
        async with App() as app:
            tg = app.tg
            await app.call("start", id="demo")                       # з рейсу бот знає імена менеджерів

            async def share(who):
                tg.uid += 1
                m = Message(message_id=tg.uid, date=dt.datetime.now(), chat=Chat(id=who, type="private"),
                            from_user=User(id=who, is_bot=False, first_name="Тест"),
                            contact=Contact(phone_number="+380 50 111 22 33", first_name="Оля"))
                before = len(tg.session.sent)
                res = await tg.dp.feed_update(tg.bot, Update(update_id=tg.uid, message=m))
                return tg.session.sent[before:], res
            sent, _ = await share(ME)
            ask = [m for m in sent if isinstance(m, SendMessage)][-1]
            names = [b.text for row in ask.reply_markup.inline_keyboard for b in row]
            assert "+380501112233" in ask.text and "Оля" in names and any(isinstance(m, DeleteMessage) for m in sent)
            tg.screen = 2000
            sent = await tg.tap(f"r:ph:{names.index('Оля')}")
            assert store.phone("Оля") == "+380501112233" and any(isinstance(m, DeleteMessage) for m in sent)
            stops = (await app.call("state"))[1]["run"]["stops"]
            olya = [m for s in stops for m in s["mgrs"] if m["name"] == "Оля"]
            assert olya and all(m["phone"] == "+380501112233" for m in olya)
            os.environ["REYS_TESTERS"] = "333"                       # тестувальник-водій номери не вносить
            handlers.TESTERS.add(333)
            sent, _ = await share(333)
            assert not [m for m in sent if isinstance(m, SendMessage)]
            handlers.TESTERS.discard(333)
            os.environ.pop("REYS_TESTERS", None)
    asyncio.run(go())


def test_returns_as_a_list():
    """Рішення власника 26.11: кілька позицій повернення одним «Готово»; частина — залишок лишається."""
    async def go():
        async with App() as app:
            await app.call("start", id="demo")
            items = (await app.call("items", i=3))[1]["items"]            # фарба ×2, окисник ×1, шампунь ×3
            assert [x["qty"] for x in items] == [2, 1, 3]
            before = (await app.call("state"))[1]["run"]["stops"][3]["due"]
            rows = [{"ii": x["ii"], "li": x["li"], "qty": q} for x, q in zip(items, (1, 1, 2))]
            bad = rows[:1] + [{"ii": 0, "li": 99, "qty": 1}]              # одна з позицій не існує — нічого не пишемо
            assert not (await app.call("problem", i=3, kind="refuse", rows=bad))[1]["ok"]
            assert not (await app.call("problem", i=3, kind="refuse", rows=rows[:1] * 2))[1]["ok"]
            assert not (await app.call("problem", i=3, kind="refuse", rows=[{**rows[0], "qty": 5}]))[1]["ok"]
            assert (await app.call("state"))[1]["run"]["stops"][3]["due"] == before
            code, j = await app.call("problem", i=3, kind="refuse", rows=rows)
            st = j["run"]["stops"][3]
            assert j["ok"] and j["n"] == 3 and len(st["probs"]) == 3
            assert st["due"] == round(before - (185 + 240 + 2 * 320), 2)
            left = (await app.call("items", i=3))[1]["items"]             # лишились одна фарба й один шампунь
            assert [(x["name"], x["qty"]) for x in left] == [(items[0]["name"], 1), (items[2]["name"], 1)]
    asyncio.run(go())


def test_nightly_robot_finds_nothing():
    """Той самий робот, що щоночі ганяє рейс на сервері: сценарії, гроші, захист, хаос, коди кнопок."""
    import subprocess
    import sys
    import tempfile
    here = os.path.dirname(os.path.abspath(__file__))
    env = {**os.environ, "REYS_ROBOT_OUT": tempfile.mkdtemp()}
    out = subprocess.run([sys.executable, os.path.join(here, "reys_robot.py")], capture_output=True, text=True,
                         env=env, timeout=300)
    assert out.returncode == 0 and "Знахідок: 0" in out.stdout, out.stdout[-2000:] + out.stderr[-2000:]


def test_two_managers_on_one_stop():
    """Салон ведуть двоє: кнопка дзвінка на кожного, з напрямком; у накладній видно, чия вона."""
    from aiogram.methods import SendContact

    async def go():
        async with App() as app:
            tg = app.tg
            store.set_phone("Іра", "+380500000001")
            store.set_phone("Оля", "+380500000002")
            store.set_direction("Іра", "волосся")
            store.set_direction("Оля", "манікюр")
            st = (await app.call("start", id="demo"))[1]["run"]["stops"][3]          # Барбершоп: дві накладні
            assert [(m["name"], m["label"], m["phone"]) for m in st["mgrs"]] == \
                [("Іра", "Іра · волосся", "+380500000001"), ("Оля", "Оля · манікюр", "+380500000002")]
            assert [(x["no"], x["mgr"], x["who"]) for x in st["ride"]] == [("1211", "Іра", "Іра"), ("1212", "Оля", "Оля")]
            items = (await app.call("items", i=3))[1]["items"]
            assert {(x["no"], x["mgr"]) for x in items} == {("1211", "Іра")}
            one = (await app.call("state"))[1]["run"]["stops"][0]                    # один менеджер — без підпису в накладній
            assert len(one["mgrs"]) == 1 and one["ride"][0]["who"] == "" and one["mgrs"][0]["phone"] == ""
            debtor = (await app.call("state"))[1]["run"]["stops"][4]                 # боржник: дзвонити менеджеру боргу
            assert debtor["debt_mgrs"] == ["Оля"] and debtor["debts"][0]["mgr"] == "Оля"
            # чат: кнопка на кожного менеджера з телефоном, код кнопки з номером менеджера
            await tg.text("/reys")
            os.environ.pop("REYS_WEB_URL")
    asyncio.run(go())


def test_call_buttons_in_chat():
    from aiogram.methods import SendContact
    from reys import build, ui
    from test_flow import Tg

    async def go():
        tg = Tg()
        store.set_phone("Оля", "+380500000002")
        store.set_direction("Оля", "манікюр")
        await tg.text("/reys")
        tg.screen = 1001
        await tg.tap("r:demo")
        text, btns = tg.last_screen(await tg.tap("r:o:3"))                           # Іра без телефону, Оля з телефоном
        assert "👤 Іра" in text and "👤 Оля · манікюр" in text and "r:cl:3:1" in btns and "r:cl:3:0" not in btns
        sent = await tg.tap("r:cl:3:1")
        assert [m.phone_number for m in sent if isinstance(m, SendContact)] == ["+380500000002"]
        text, btns = tg.last_screen(await tg.tap("r:o:0"))                           # телефону немає — одна кнопка-пояснення
        assert "r:cl:0" in btns and not [m for m in await tg.tap("r:cl:0") if isinstance(m, SendContact)]
    asyncio.run(go())


def test_manager_names_as_written_in_1c():
    """1С пише напрямок першим словом і не стежить за пробілами: телефон і підпис від цього не залежать."""
    import sqlite3
    import tempfile
    from reys import engine, view
    store.DB_PATH = os.path.join(tempfile.mkdtemp(), "t.db")
    store.init()
    store.set_phone("Манікюр Тестова  Олена", "+380500000009")              # подвійний пробіл, як у 1С
    people = store.people()
    for raw in ("Манікюр Тестова Олена", "манікюр тестова олена ", "Манікюр  Тестова  Олена"):
        m = view.mgr_view(raw, people)
        assert (m["label"].casefold(), m["phone"], m["name"]) == ("олена · манікюр", "+380500000009", " ".join(raw.split()))
    assert view.mgr_view("Niceme Тестов Сергій ", people)["label"] == "Сергій · волосся"
    assert view.mgr_view("офис 1", people)["label"] == "офис 1" and view.mgr_view("Т.Т Місто", people)["label"] == "Т.Т Місто"
    store.set_direction("niceme тестов сергій", "манікюр")                  # таблиця перекриває префікс
    assert view.mgr_view("Niceme Тестов Сергій", store.people())["label"] == "Сергій · манікюр"
    st = {"inv": [{"tags": [], "manager": "Манікюр Тестова  Олена"}, {"tags": [], "manager": "Манікюр Тестова Олена "}],
          "debts": [{"sum": 50, "manager": "Niceme Тестов Сергій "}], "sheet_debt": 50, "manager": ""}
    assert engine.managers(st) == ["Манікюр Тестова Олена", "Niceme Тестов Сергій"]     # той самий — один раз
    with sqlite3.connect(store.DB_PATH) as c:                                # старі «сирі» записи переходять під ключ
        c.execute("INSERT INTO reys_phones(name, phone) VALUES('Стара  Назва ', '+380500000001')")
    store.init()
    assert store.phone("стара назва") == "+380500000001"


def test_other_product_keeps_the_sum():
    """Рішення власника 26.11: привезли не те, чого в накладній немає — один дотик, сума не змінюється."""
    from test_flow import Tg

    async def go():
        async with App() as app:
            run = (await app.call("start", id="demo"))[1]["run"]
            assert run["other_kinds"] == ["miss", "wrong", "dmg"]
            before = run["stops"][0]["due"]
            assert not (await app.call("other", i=0, kind="refuse"))[1]["ok"]          # відмова — завжди з накладної
            st = (await app.call("other", i=0, kind="wrong"))[1]["run"]["stops"][0]
            assert st["due"] == before and st["probs"] == [{"text": "не той товар: інший товар, не з накладної", "cut": 0.0}]
        tg = Tg()                                                                      # те саме кнопкою в чаті
        await tg.text("/reys")
        tg.screen = 1001
        await tg.tap("r:demo")
        await tg.tap("r:o:0")
        await tg.tap("r:pr:0")
        text, btns = tg.last_screen(await tg.tap("r:pk:0:miss"))
        assert "r:po:0:miss" in btns and btns[-2] == "r:o:0" or btns[-1] == "r:o:0"
        assert "r:po:0:refuse" not in tg.last_screen(await tg.tap("r:pk:0:refuse"))[1]
        text, btns = tg.last_screen(await tg.tap("r:po:0:miss"))
        assert "не вистачає: інший товар, не з накладної" in text and "×" not in text and "1 501 ₴ до збору" in text
    asyncio.run(go())


def test_card_shows_invoice_sum_and_total_after_return():
    """Власник 26.11: на картці сума накладної як виписано, повернення окремим рядком, унизу — що лишилось."""
    from test_flow import Tg

    async def go():
        async with App() as app:
            run = (await app.call("start", id="demo"))[1]["run"]
            assert run["stops"][0]["after"] is None and run["stops"][0]["ride"][0]["orig"] == 1501.0
            items = (await app.call("items", i=0))[1]["items"]
            st = (await app.call("problem", i=0, kind="refuse", rows=[{"ii": items[0]["ii"], "li": items[0]["li"], "qty": 2}]))[1]["run"]["stops"][0]
            assert (st["ride"][0]["orig"], st["ride"][0]["sum"], st["after"], st["due"]) == (1501.0, 1131.0, 1131.0, 1131.0)
            st = (await app.call("other", i=0, kind="miss"))[1]["run"]["stops"][0]      # «інший товар» суми не чіпає
            assert st["after"] == 1131.0 and st["ride"][0]["orig"] == 1501.0
        tg = Tg()
        await tg.text("/reys")
        tg.screen = 1001
        await tg.tap("r:demo")
        await tg.tap("r:o:0")
        await tg.tap("r:pr:0")
        await tg.tap("r:pk:0:refuse")
        await tg.tap("r:pi:0:refuse:0:0:0")
        text, _ = tg.last_screen(await tg.tap("r:px:0:refuse"))
        assert "№ 1204 · 1 501 ₴" in text and "(−370 ₴)" in text and "Після повернення: 1 131 ₴" in text
        assert "1 131 ₴ до збору" in text
    asyncio.run(go())


def test_service_replies_do_not_stay_in_chat():
    """Чиста стрічка: службова команда стирається, відповідь зникає після «Зрозуміло»."""
    from test_flow import Tg

    async def go():
        tg = Tg()
        for cmd in ("/reys_tel Тестова Олена 0501112233", "/reys_tel", "/reys_dir Тестова Олена = волосся", "/reys_dir"):
            sent, _ = await tg.text(cmd)
            ans = [m for m in sent if isinstance(m, SendMessage)][-1]
            assert any(isinstance(m, DeleteMessage) for m in sent), cmd
            assert [b.callback_data for row in ans.reply_markup.inline_keyboard for b in row] == ["r:ph:x"], cmd
        tg.screen = 3000
        assert any(isinstance(m, DeleteMessage) for m in await tg.tap("r:ph:x"))
        assert store.phone("тестова  олена") == "+380501112233" and store.direction("Тестова Олена") == "волосся"
    asyncio.run(go())


def test_on_sent_hook_reports_leftover_messages():
    """Бот може підключити свою чистку стрічки: модуль каже про кожне повідомлення, яке лишив, крім екрана рейсу."""
    import tempfile
    from aiogram import Dispatcher
    from aiogram.fsm.storage.memory import MemoryStorage
    import reys
    from test_flow import Tg

    async def go():
        tg, seen = Tg(), []
        handlers.router._parent_router = None
        tg.dp = Dispatcher(storage=MemoryStorage())
        reys.setup(tg.dp, admin_id=ME, db_path=os.path.join(tempfile.mkdtemp(), "t.db"),
                   on_sent=lambda chat, mid: seen.append((chat, mid)))
        sent, _ = await tg.text("/reys_dir")
        ans = [m for m in sent if isinstance(m, SendMessage)]
        assert len(ans) == 1 and seen == [(ME, tg.session.n)]                 # службову відповідь повідомлено
        await tg.text("/reys")                                                # екран рейсу — ні
        assert len(seen) == 1
        handlers.ON_SENT = lambda *a: 1 / 0                                   # зламана функція бота рейс не зупиняє
        sent, _ = await tg.text("/reys_dir")
        assert [m for m in sent if isinstance(m, SendMessage)]
        handlers.ON_SENT = None
    asyncio.run(go())


# ---------- безпека (перевірка 26.11) ----------

SHEET = "11111111-2222-3333-4444-555555555555"
OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class Drivers:
    """Двоє водіїв-тестувальників і підставна 1С з двома путівками."""
    async def __aenter__(self):
        os.environ["REYS_TESTERS"] = "333,444"
        os.environ["REYS_HOURS"] = "0-24"
        self.app = await App().__aenter__()
        self._onec = (web.onec.URL, handlers.list_sheets, handlers.load_run)
        web.onec.URL = "http://stub"

        async def sheets(day):
            return [{"Ref_Key": SHEET, "Number": "0008389", "Date": "2026-11-26T13:01:00"},
                    {"Ref_Key": OTHER, "Number": "0008390", "Date": "2026-11-26T16:26:00"}]

        async def load(ref):
            from reys import build
            run = build.demo_run(handlers.today())
            run.pop("demo")
            run.update(sheet_ref=ref, sheet_no=ref[:4])
            return run
        handlers.list_sheets, handlers.load_run = sheets, load
        return self.app

    async def __aexit__(self, *a):
        web.onec.URL, handlers.list_sheets, handlers.load_run = self._onec
        os.environ.pop("REYS_TESTERS", None)
        os.environ.pop("REYS_HOURS", None)
        await self.app.__aexit__(*a)


def test_driver_opens_only_own_sheet():
    """Чужу путівку не відкрити ні зі списку, ні за її кодом; власник закріплює путівку за водієм."""
    async def go():
        async with Drivers() as app:
            j = (await app.call("state", who=333))[1]
            assert j["menu"]["sheets"] == [] and "не закріплено" in j["menu"]["note"] and "people" not in j["menu"]
            assert not (await app.call("start", who=333, id="1c:" + SHEET))[1]["ok"]           # знає код — все одно ні
            assert not (await app.call("start", who=333, id="sn:2026-11-25_1301_8389"))[1]["ok"]   # знімки — лише власнику
            assert not (await app.call("assign", who=333, id="1c:" + SHEET, to=333))[1]["ok"]  # сам собі не закріпить
            await app.call("state", who=444)
            m = (await app.call("state"))[1]["menu"]                                             # власник бачить усе
            assert [s["id"] for s in m["sheets"]] == ["1c:" + SHEET, "1c:" + OTHER]
            assert {p["id"] for p in m["people"]} == {333, 444}
            assert not (await app.call("assign", id="1c:" + SHEET, to=999))[1]["ok"]           # не з нашого списку
            m = (await app.call("assign", id="1c:" + SHEET, to=333))[1]["menu"]
            assert m["sheets"][0]["to"] == 333 and m["sheets"][0]["who"] == "Тест"
            j = (await app.call("state", who=333))[1]
            assert [s["id"] for s in j["menu"]["sheets"]] == ["1c:" + SHEET]                    # тепер бачить свою
            assert (await app.call("state", who=444))[1]["menu"]["sheets"] == []                # сусід — ні
            assert not (await app.call("start", who=444, id="1c:" + SHEET))[1]["ok"]
            assert (await app.call("start", who=333, id="1c:" + SHEET))[1]["run"]["totals"]["left"] == 5
            assert not (await app.call("assign", id="1c:" + SHEET, to=444))[1]["ok"]           # уже в роботі — не перекинути
            assert (await app.call("start", id="1c:" + SHEET))[1]["ok"]                         # власник — будь-яку
    asyncio.run(go())


def test_open_run_with_marks_is_not_dropped():
    """Відкритий рейс з грошима не скидається новим: водій спершу здає касу; повторне відкриття нічого не стирає."""
    async def go():
        async with Drivers() as app:
            await app.call("assign", id="1c:" + SHEET, to=333)
            await app.call("assign", id="1c:" + OTHER, to=333)
            await app.call("start", who=333, id="1c:" + SHEET)
            assert (await app.call("start", who=333, id="demo"))[1]["ok"]                       # порожній рейс можна замінити
            await app.call("start", who=333, id="1c:" + SHEET)
            await app.call("all", who=333, i=0)
            j = (await app.call("start", who=333, id="1c:" + SHEET))[1]                         # той самий — лишається як є
            assert j["ok"] and j["run"]["totals"]["cash"] == 1501.0
            for other in ("1c:" + OTHER, "demo"):
                j = (await app.call("start", who=333, id=other, force=True))[1]                  # force від водія не діє
                assert not j["ok"] and "здай" in j["msg"] and j["run"]["totals"]["cash"] == 1501.0
            assert (await app.call("menu", who=333))[1]["menu"]["locked"]
            await app.call("start", id="demo")                                                   # власник: без force — теж ні
            await app.call("all", i=0)
            assert not (await app.call("start", id="demo"))[1]["ok"]
            j = (await app.call("start", id="demo", force=True))[1]                              # з підтвердженням — так
            assert j["ok"] and j["run"]["totals"]["cash"] == 0
            with store.db() as c:
                assert c.execute("SELECT COUNT(*) n FROM reys_events WHERE action='drop'").fetchone()["n"] == 1
    asyncio.run(go())


def test_every_app_request_reaches_the_guard():
    """Сторож бота бачить кожен запит застосунку, відмови й перевищення ліміту."""
    async def go():
        async with Drivers() as app:
            seen = []
            handlers.ON_ACT = lambda uid, what: seen.append((uid, what))
            try:
                await app.call("state")
                await app.call("state", init="user=x&hash=0")
                await app.call("state", who=STRANGER)
                await app.call("assign", id="1c:" + SHEET, to=333)
                assert seen == [(ME, "app:state"), (0, "401"), (STRANGER, "403"), (ME, "app:assign"), (ME, "assign:333")]
                web.HITS.clear()
                seen.clear()
                codes = [(await app.call("state", who=333))[0] for _ in range(web.RATE + 1)]
                assert web.RATE == 40 and codes[-1] == 429 and seen[-1] == (333, "429") and len(seen) == web.RATE + 1
                handlers.ON_ACT = lambda *a: 1 / 0                                               # зламаний сторож рейс не зупиняє
                web.HITS.clear()
                assert (await app.call("state"))[0] == 200
            finally:
                handlers.ON_ACT = None
                web.HITS.clear()
    asyncio.run(go())


def test_closed_real_run_reaches_someone():
    """Рейс відкрито водіям: підсумок справжнього рейсу не має загубитись. Касира немає — отримує власник."""
    async def go():
        async with Drivers() as app:
            store.set_name(333, "Водій Перший")
            await app.call("state", who=333)                                   # ім'я з Telegram бота не перебиває
            assert store.known_people()[333] == "Водій Перший"
            await app.call("assign", id="1c:" + SHEET, to=333)
            run = (await app.call("start", who=333, id="1c:" + SHEET))[1]["run"]
            for s in run["stops"]:
                if s["where"] == "route":
                    await app.call("all" if s["due"] > 0 else "given", who=333, i=s["i"])
            before = len(app.tg.session.sent)
            assert (await app.call("close", who=333))[1]["ok"]
            got = [m for m in app.tg.session.sent[before:] if isinstance(m, SendMessage)]
            assert [m.chat_id for m in got] == [ME] and "Водій Перший" in got[0].text and "здано" in got[0].text
            await app.call("start", who=333, id="demo")                        # навчальний — нікому
            for s in (await app.call("state", who=333))[1]["run"]["stops"]:
                if s["where"] == "route":
                    await app.call("all" if s["due"] > 0 else "given", who=333, i=s["i"])
            before = len(app.tg.session.sent)
            await app.call("close", who=333)
            assert not [m for m in app.tg.session.sent[before:] if isinstance(m, SendMessage)]
    asyncio.run(go())
