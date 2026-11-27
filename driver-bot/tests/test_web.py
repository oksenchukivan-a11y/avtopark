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
        web.SHEETS.clear()
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
            report = [m for m in sent if isinstance(m, SendMessage) and m.chat_id == 777]
            assert len(report) == 1 and "здано" in report[0].text                     # підсумок — касиру
            prev = [m for m in sent if isinstance(m, SendMessage) and m.chat_id == ME]      # звіт менеджерам — приклад власникові
            mgr = [m for m in prev if m.text.startswith("🚚")]
            assert prev[0].text.startswith("👁") and len(mgr) == int(prev[0].text.rsplit("· ", 1)[1]) >= 2
            wh = [m for m in prev if m.text.startswith("📦")]                              # помилки збору — теж приклад власникові
            assert len(wh) <= 1 and len(prev) == 1 + len(mgr) + len(wh)
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
                [("Іра", "💇‍♀️✂️ Іра", "+380500000001"), ("Оля", "💅 Оля", "+380500000002")]
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
        assert "👤 Іра" in text and "👤 💅 Оля" in text and "r:cl:3:1" in btns and "r:cl:3:0" not in btns
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
        assert (m["label"].casefold(), m["phone"], m["name"]) == ("💅 олена", "+380500000009", " ".join(raw.split()))
    assert view.mgr_view("Niceme Тестов Сергій ", people)["label"] == "💇‍♀️✂️ Сергій"
    store.set_direction("Тестова Ніна", "інше")                             # напрямок без картинки — словом, як раніше
    assert view.mgr_view("Тестова Ніна", store.people())["label"] == "Ніна · інше"
    assert view.mgr_view("офис 1", people)["label"] == "офис 1" and view.mgr_view("Т.Т Місто", people)["label"] == "Т.Т Місто"
    store.set_direction("niceme тестов сергій", "манікюр")                  # таблиця перекриває префікс
    assert view.mgr_view("Niceme Тестов Сергій", store.people())["label"] == "💅 Сергій"
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
        self._onec = (web.onec.URL, handlers.list_sheets, handlers.load_run, handlers.sheet_cities)
        web.onec.URL = "http://stub"

        async def cities(ref):
            return (["Ахтырка"] * 34 + ["тростянец"] * 33 + ["Сумы"], 68) if ref == OTHER else (["Сумы"] * 9, 9)
        handlers.sheet_cities = cities

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
        web.onec.URL, handlers.list_sheets, handlers.load_run, handlers.sheet_cities = self._onec
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
            assert m["sheets"][0]["crew"] == [333] and m["sheets"][0]["who"] == "Тест"
            j = (await app.call("state", who=333))[1]
            assert [s["id"] for s in j["menu"]["sheets"]] == ["1c:" + SHEET]                    # тепер бачить свою
            assert (await app.call("state", who=444))[1]["menu"]["sheets"] == []                # сусід — ні
            assert not (await app.call("start", who=444, id="1c:" + SHEET))[1]["ok"]
            assert (await app.call("start", who=333, id="1c:" + SHEET))[1]["run"]["totals"]["left"] == 5
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
            assert {m.chat_id for m in got} == {ME}                            # і підсумок, і приклад звіту менеджерам — власникові
            total = [m for m in got if "здано" in m.text]
            assert len(total) == 1 and "Водій Перший" in total[0].text
            mgr = [m for m in got if m.text.startswith("🚚")]
            assert mgr and all("водій: Водій Перший" in m.text and "твої клієнти" in m.text for m in mgr)
            await app.call("start", who=333, id="demo")                        # навчальний — нікому
            for s in (await app.call("state", who=333))[1]["run"]["stops"]:
                if s["where"] == "route":
                    await app.call("all" if s["due"] > 0 else "given", who=333, i=s["i"])
            before = len(app.tg.session.sent)
            await app.call("close", who=333)
            assert not [m for m in app.tg.session.sent[before:] if isinstance(m, SendMessage)]
    asyncio.run(go())


def test_sheet_is_named_by_direction_not_number():
    """Власник 27.11: «просто номера, як понять» — у меню напрямок, номер і час дрібно."""
    from reys import build
    d = build.direction
    assert d(["Сумы"] * 9 + ["сумы"]) == "Суми · місто"
    assert d(["Ахтырка"] * 34 + ["Тростянец"] * 33) == "Охтирка · Тростянець"
    assert d(["Ромны"] * 41 + ["Недригайлов"] * 5 + ["Л.Долина"] * 3) == "Ромни"          # дрібні заїзди в назву не йдуть
    assert d(["Глухов"] * 24 + ["Кролевец"] * 9 + ["С-Буда", "Ямполь"]) == "Глухів · Кролевець"
    assert d(["шостка "] * 63) == "Шостка" and d(["", None]) == "" and d(["г. Конотоп"]) == "Конотоп"

    async def go():
        async with Drivers() as app:
            m = (await app.call("state"))[1]["menu"]["sheets"]
            assert (m[0]["title"], m[0]["sub"]) == ("Суми · місто", "чт 26.11 · 9 точок · № 8389")
            assert (m[1]["title"], m[1]["sub"]) == ("Охтирка · Тростянець", "пт 27.11 · 68 точок · № 8390")   # вечірня — на завтра
            calls = []

            async def boom(ref):
                calls.append(ref)
                raise web.onec.OneCError("немає зв'язку")
            handlers.sheet_cities = boom
            assert (await app.call("menu"))[1]["menu"]["sheets"][0]["title"] == "Суми · місто" and not calls   # з кешу
            with store.db() as c:
                c.execute("DELETE FROM reys_titles")
            m = (await app.call("menu"))[1]["menu"]["sheets"]                                   # 1С мовчить — меню живе
            assert m[0]["title"] == "Путівка 13:01" and m[0]["sub"] == "чт 26.11 · № 8389" and len(calls) == 2
    asyncio.run(go())


def test_evening_regional_sheet_is_seen_next_morning():
    """Обласні путівки в 1С створюють напередодні близько 16:30 — уранці водій має їх бачити."""
    import datetime as dt
    from reys import build
    rd = build.ride_day
    assert rd(dt.datetime(2026, 11, 26, 13, 1), "Суми · місто") == dt.date(2026, 11, 26)        # міська — того ж дня
    assert rd(dt.datetime(2026, 11, 26, 16, 31), "Охтирка · Тростянець") == dt.date(2026, 11, 27)
    assert rd(dt.datetime(2026, 11, 26, 14, 30), "Суми · місто") == dt.date(2026, 11, 26)       # пізно надрукована міська
    assert rd(dt.datetime(2026, 11, 28, 16, 30), "Ромни") == dt.date(2026, 11, 30)              # субота ввечері → понеділок

    rows = [{"Ref_Key": "fri-eve", "Number": "1", "Date": "2026-11-27T16:30:00"},
            {"Ref_Key": "sat-day", "Number": "2", "Date": "2026-11-28T13:00:00"},
            {"Ref_Key": "sun-eve", "Number": "3", "Date": "2026-11-29T16:30:00"},
            {"Ref_Key": "mon-day", "Number": "4", "Date": "2026-11-30T13:00:00"},
            {"Ref_Key": "mon-eve", "Number": "5", "Date": "2026-11-30T16:30:00"}]
    asked = []

    async def read(since, until):
        asked.append((since, until))
        return [r for r in rows if since <= r["Date"] <= until and not r.get("DeletionMark")]

    async def go():
        async with App():
            old, handlers.read_sheets = handlers.read_sheets, read
            try:
                mon = [s["Ref_Key"] for s in await handlers.list_sheets(dt.date(2026, 11, 30))]
                assert mon == ["fri-eve", "sun-eve", "mon-day", "mon-eve"] and asked[-1][0] == "2026-11-27T14:00:00"
                rows.append({"Ref_Key": "gone", "Number": "9", "Date": "2026-11-30T12:00:00", "DeletionMark": True})
                tue = [s["Ref_Key"] for s in await handlers.list_sheets(dt.date(2026, 12, 1))]
                assert tue == ["mon-eve"] and asked[-1][0] == "2026-11-30T14:00:00"            # учорашня денна вже не показується
                run = {"sheet_ref": "mon-eve", "sheet_no": "5", "day": "2026-12-01", "stops": [], "expenses": []}
                store.close(store.create(ME, dict(run)), run)                                    # пробний рейс власника путівку не ховає
                assert [s["Ref_Key"] for s in await handlers.list_sheets(dt.date(2026, 12, 1))] == ["mon-eve"]
                store.close(store.create(333, dict(run)), run)                                   # водій здав касу — зникає
                assert await handlers.list_sheets(dt.date(2026, 12, 1)) == []
            finally:
                handlers.read_sheets = old
    asyncio.run(go())


def test_delivery_date_counts_from_ride_day():
    """«Доставка 27.11» у путівці, надрукованій 26.11 ввечері на 27.11, — це сьогоднішня точка, а не «не їде»."""
    import datetime as dt
    from reys import build
    sheet = {"Ref_Key": "s", "Number": "0008393", "Date": "2026-11-26T16:31:00",
             "Контрагенты": [{"Контрагент_Key": "c1", "Документ_Key": "i1", "Долг": 0},
                             {"Контрагент_Key": "c2", "Документ_Key": "i2", "Долг": 0}]}
    inv = [{"Ref_Key": "i1", "Number": "1", "Date": "2026-11-26T15:00:00", "СуммаДокумента": 100.0, "Контрагент_Key": "c1"},
           {"Ref_Key": "i2", "Number": "2", "Date": "2026-11-26T15:10:00", "СуммаДокумента": 200.0, "Контрагент_Key": "c2"}]
    orders = [{"Date": "2026-11-26T12:00:00", "Комментарий": "доставка 27.11", "СуммаДокумента": 100.0, "Контрагент_Key": "c1"},
              {"Date": "2026-11-26T12:05:00", "Комментарий": "доставка 30.11", "СуммаДокумента": 200.0, "Контрагент_Key": "c2"}]
    names = {"c1": "Салон Один", "c2": "Салон Два"}
    old = build.build_run(sheet, inv, names, {}, orders)                                        # як було: день друку
    new = build.build_run(sheet, inv, names, {}, orders, day=dt.date(2026, 11, 27))
    assert [s["where"] for s in old["stops"]] == ["skip", "skip"]
    assert [s["where"] for s in new["stops"]] == ["route", "skip"] and new["day"] == "2026-11-27"


def test_day_hours_come_from_the_bot_schedule():
    """Ранні обласні рейси: графік дня веде бот (reys_hours.day_hours); свій графік людини в REYS_HOURS важливіший."""
    import sys
    import types
    os.environ.pop("REYS_HOURS", None)
    assert web.hours(333) == (9, 18)                                                             # файлу бота немає
    mod = types.ModuleType("reys_hours")
    mod.day_hours = lambda: (5, 21)
    sys.modules["reys_hours"] = mod
    try:
        assert web.hours(333) == (5, 21)
        os.environ["REYS_HOURS"] = "333=8-17"
        assert web.hours(333) == (8, 17) and web.hours(444) == (5, 21)
        mod.day_hours = lambda: (30, 2)                                                          # нісенітниця → 9–18
        assert web.hours(444) == (9, 18)
        mod.day_hours = lambda: 1 / 0
        assert web.hours(444) == (9, 18)
    finally:
        sys.modules.pop("reys_hours", None)
        os.environ.pop("REYS_HOURS", None)


# ---------- екіпаж (рішення власника 27.11: путівку везуть один або двоє, усе навпіл) ----------

def runs_count(status="open"):
    with store.db() as c:
        return c.execute("SELECT COUNT(*) n FROM reys_runs WHERE status=?", (status,)).fetchone()["n"]


def test_crew_of_two_shares_one_run_and_one_cash():
    """Двоє в екіпажі бачать один рейс: відмітка одного видна другому, каса одна й не задвоюється."""
    async def go():
        async with Drivers() as app:
            store.set_name(333, "Перший")
            store.set_name(444, "Другий")
            handlers.TESTERS.add(555)
            m = (await app.call("assign", id="1c:" + SHEET, to=333))[1]["menu"]
            m = (await app.call("assign", id="1c:" + SHEET, to=444))[1]["menu"]
            assert m["sheets"][0]["crew"] == [333, 444] and m["sheets"][0]["who"] == "Перший + Другий" and m["crew_max"] == 2
            j = (await app.call("assign", id="1c:" + SHEET, to=555))[1]                         # третій не влазить
            assert not j["ok"] and "двоє" in j["msg"] and store.crew(SHEET) == [333, 444]
            assert (await app.call("state", who=444))[1]["menu"]["sheets"][0]["mates"] == ["Перший"]
            await app.call("start", who=444, id="demo")                                          # другий тим часом тренується
            run = (await app.call("start", who=333, id="1c:" + SHEET))[1]["run"]
            assert run["crew"] == ["Перший", "Другий"] and runs_count() == 2
            j = (await app.call("start", who=444, id="1c:" + SHEET))[1]                         # заходить у рейс напарника
            assert j["ok"] and not j["run"]["demo"] and runs_count() == 1                        # другого рейсу не створено
            assert (await app.call("all", who=333, i=0))[1]["ok"]
            j = (await app.call("state", who=444))[1]
            assert j["run"]["totals"]["cash"] == 1501.0 and j["run"]["stops"][0]["status"]       # бачить відмітку напарника
            j = (await app.call("all", who=444, i=0))[1]                                         # ту саму точку вдруге — ні
            assert not j["ok"] and j["run"]["totals"]["cash"] == 1501.0
            assert (await app.call("amount", who=444, i=1, sum=2500))[1]["ok"]
            for who in (333, 444):
                assert (await app.call("state", who=who))[1]["run"]["totals"]["cash"] == 4001.0  # каса одна, не задвоєна
            for who in (333, 444):                                                               # рейс екіпажу не обійти
                j = (await app.call("start", who=who, id="demo"))[1]
                assert not j["ok"] and j["run"]["totals"]["cash"] == 4001.0
            j = (await app.call("assign", id="1c:" + SHEET, to=444, on=False))[1]                # у роботі — екіпаж не міняємо
            assert not j["ok"] and "відмітки" in j["msg"] and store.crew(SHEET) == [333, 444]
            assert store.shares(handlers.today()) == {333: [(SHEET, 0.5, [444])], 444: [(SHEET, 0.5, [333])]}
            # здає касу другий: рейс закрито в обох, кнопку рейсу прибрано в обох, у підсумку — обидва
            for s in (await app.call("state", who=333))[1]["run"]["stops"]:
                if s["where"] == "route" and not s["status"]:
                    await app.call("all" if s["due"] > 0 else "given", who=333 if s["i"] % 2 else 444, i=s["i"])
            store.set_screen(333, 333, 9001)
            store.set_screen(444, 444, 9002)
            before = len(app.tg.session.sent)
            j = (await app.call("close", who=444))[1]
            assert j["ok"] and j["done"]["crew"] == ["Перший", "Другий"]
            sent = app.tg.session.sent[before:]
            assert {m.message_id for m in sent if isinstance(m, DeleteMessage)} == {9001, 9002}
            total = [m for m in sent if isinstance(m, SendMessage) and "здано" in m.text]
            assert len(total) == 1 and total[0].chat_id == ME and "Перший + Другий" in total[0].text
            j = (await app.call("state", who=333))[1]
            assert j["run"] is None and runs_count("closed") == 1 and j["menu"]["sheets"] == []   # здана путівка зникає
            for who in (333, 444):                                                               # і вдруге не відкривається
                j = (await app.call("start", who=who, id="1c:" + SHEET))[1]
                assert not j["ok"] and "вже здано" in j["msg"] and j["run"] is None
            assert (await app.call("state"))[1]["menu"]["sheets"][0]["done"] is True             # власник бачить «касу здано»
            handlers.TESTERS.discard(555)
    asyncio.run(go())


def test_two_at_once_do_not_erase_each_other():
    """Поки один чекає на 1С, другий відмічає точку: відмітка не губиться. Стара копія рейсу поверх нової не лягає."""
    async def go():
        async with Drivers() as app:
            for who in (333, 444):
                await app.call("assign", id="1c:" + SHEET, to=who)
            await app.call("start", who=333, id="1c:" + SHEET)
            old = handlers.load_debts

            async def slow(st):                                    # 1С думає, а напарник за цей час записує оплату
                assert (await app.call("all", who=444, i=0))[1]["ok"]
                st["debts"] = [{"ref": "x", "no": "9", "date": "2026-11-01", "sum": 50.0, "manager": ""}]
            handlers.load_debts = slow
            try:
                rid, run = store.open_run(333)
                run["stops"][2]["debts"] = None
                store.save(rid, run)
                assert (await app.call("open", who=333, i=2))[1]["ok"]
            finally:
                handlers.load_debts = old
            rid, run = store.open_run(333)
            assert run["stops"][0]["status"]["cash"] == 1501.0 and run["stops"][2]["debts"][0]["no"] == "9"
            a, b = store.open_run(333)[1], store.open_run(444)[1]  # дві копії одного рейсу
            a["expenses"].append({"kind": "Інше", "sum": 10, "ts": ""})
            store.save(rid, a)
            b["stops"][0]["status"] = None
            try:
                store.save(rid, b)
                raise AssertionError("стара копія затерла нову")
            except store.Stale:
                pass
            assert store.open_run(444)[1]["stops"][0]["status"]["cash"] == 1501.0
    asyncio.run(go())


def test_crew_rules_and_trial_runs():
    """Один водій — уся путівка його; знятий з екіпажу путівки не бачить; пробний рейс власника нікому не заважає."""
    async def go():
        async with Drivers() as app:
            await app.call("assign", id="1c:" + SHEET, to=333)
            await app.call("start", who=333, id="1c:" + SHEET)
            assert store.shares(handlers.today()) == {333: [(SHEET, 1.0, [])]}                   # сам — 100 %
            assert (await app.call("state", who=333))[1]["run"]["crew"] == ["Тест"]
            j = (await app.call("assign", id="1c:" + SHEET, to=333, on=False))[1]                # порожній рейс знятого водія зникає
            assert j["ok"] and store.crew(SHEET) == [] and runs_count() == 0
            assert (await app.call("state", who=333))[1]["run"] is None
            assert not (await app.call("start", who=333, id="1c:" + SHEET))[1]["ok"]
            await app.call("assign", id="1c:" + SHEET, to=333)
            await app.call("assign", id="1c:" + SHEET, to=444)
            assert (await app.call("assign", id="1c:" + SHEET, to=0))[1]["ok"] and store.crew(SHEET) == []   # зняти всіх
            # власник проїхав путівку сам для проби й здав касу — водієві вона все одно відкривається
            run = (await app.call("start", id="1c:" + OTHER))[1]["run"]
            for s in run["stops"]:
                if s["where"] == "route":
                    await app.call("all" if s["due"] > 0 else "given", i=s["i"])
            assert (await app.call("close"))[1]["ok"]
            await app.call("assign", id="1c:" + OTHER, to=333)
            assert (await app.call("start", who=333, id="1c:" + OTHER))[1]["ok"]
            assert (await app.call("state", who=444))[1]["run"] is None                          # сторонній у рейс не потрапляє
            os.environ["REYS_PREVIEW"] = "444"
            try:
                assert handlers.trial_ids() == {ME, 444}
            finally:
                os.environ.pop("REYS_PREVIEW")
            # пробний рейс власника по путівці екіпажу водій не підхоплює
            await app.call("assign", id="1c:" + SHEET, to=444)
            await app.call("start", id="1c:" + SHEET)
            assert (await app.call("state", who=444))[1]["run"] is None
    asyncio.run(go())


def test_manager_report_shows_each_manager_only_own_clients():
    """Звіт менеджерам: суми менеджера — це оплати по його накладних; двоє на одній точці бачать кожен своє."""
    import tempfile
    from reys import build, engine, mgr_report
    store.DB_PATH = os.path.join(tempfile.mkdtemp(), "t.db")
    store.init()
    run = build.demo_run(handlers.today())
    st = run["stops"][3]                                                   # дві накладні, два менеджери
    a, b = engine.riding(st)
    assert engine.clean(a["manager"]) != engine.clean(b["manager"])
    engine.pay(st, 1, [(a["ref"], a["sum"])])                              # оплатили тільки накладну першого
    engine.pay_all(run["stops"][0], 1)
    reps = mgr_report.build(run, "Суми · місто", "Перший + Другий")
    first, second = reps[engine.clean(a["manager"])], reps[engine.clean(b["manager"])]
    assert f"Забрано <b>{engine.money(a['sum'])}</b>" in first and "Не забрано" not in first
    assert "✅ <b>Забрав гроші — 1</b>" in first and "водій: Перший + Другий" in first
    assert "Забрано <b>" + engine.money(0) in second and f"Не забрано <b>{engine.money(b['sum'])}</b>" in second
    assert engine.money(a["sum"]) not in second                             # чужих грошей не видно
    for m, text in reps.items():                                            # сума зверху = оплати по накладних менеджера
        refs = {i["ref"] for s in run["stops"] for i in s["inv"] if engine.clean(i.get("manager")) == m}
        refs |= {d["ref"] for s in run["stops"] for d in engine.debts(s) if engine.clean(d.get("manager")) == m}
        got = sum(x["paid"] for s in run["stops"] if s["status"] for x in s["status"]["alloc"] if x["ref"] in refs)
        assert f"Забрано <b>{engine.money(round(got, 2))}</b>" in text
    assert not mgr_report.build(build.demo_run(handlers.today()))           # без відміток — нема про що звітувати


def test_warehouse_errors_go_to_the_picker_once():
    """Власник 27.11: «не вистачає / не той / пошкоджено» — це помилка збору; до кожної — хто збирав, підсумок за місяць."""
    import tempfile
    from reys import build, engine, wh_report
    store.DB_PATH = os.path.join(tempfile.mkdtemp(), "t.db")
    store.init()
    wh_report.init()
    day = handlers.today()

    def make():
        run = build.demo_run(day)
        run.pop("demo")
        one, two = run["stops"][0], run["stops"][3]                       # одна накладна; дві накладні різних комірників
        engine.add_problem(one, one["inv"][0]["ref"], "miss", "Шампунь 1 л", 1, 10.0)
        engine.add_problem(one, one["inv"][0]["ref"], "miss", "Шампунь 1 л", 1, 10.0)   # ту саму позицію ще раз, по штуці
        engine.add_problem(one, one["inv"][0]["ref"], "refuse", "Фарба 6.0", 2, 10.0)   # відмова клієнта — не склад
        engine.add_other(one, "wrong")
        engine.add_other(two, "dmg")
        return run, one, two

    run, one, two = make()
    pick = {one["inv"][0]["ref"]: "k1", two["inv"][0]["ref"]: "k1", two["inv"][1]["ref"]: "k2"}

    async def by_keys(obj, keys, select, **kw):
        if "Реализация" in obj:
            return [{"Ref_Key": r, "Кладовщик_Key": pick[r]} for r in keys if r in pick]
        return [{"Ref_Key": k, "Description": f"Комірник  {k}"} for k in keys if k]

    def table():
        with store.db() as c:
            return [tuple(r) for r in c.execute("SELECT kind, item, qty, picker, test FROM reys_wh_probs ORDER BY kind, item")]

    async def go():
        old, wh_report.onec.by_keys = wh_report.onec.by_keys, by_keys
        try:
            assert await wh_report.collect(build.demo_run(day)) is None      # без проблем — нема про що писати
            text = await wh_report.collect(run, "Суми · місто", "Перший", trial=True)   # пробний рейс власника
            assert "пробний рейс" in text and "🗓" not in text and {r[4] for r in table()} == {1}
            text = await wh_report.collect(make()[0], "Суми · місто", "Перший")         # справжній — замінює пробні записи
            rows = table()
            assert rows == [("dmg", engine.OTHER_ITEM, 0.0, wh_report.NOBODY, 0),      # дві накладні, комірники різні
                            ("miss", "Шампунь 1 л", 2.0, "Комірник k1", 0),             # дві штуки — один рядок
                            ("wrong", engine.OTHER_ITEM, 0.0, "Комірник k1", 0)]        # одна накладна — її комірник
            assert "Фарба 6.0" not in text and "Комірник k1" in text and "За " in text and "Позицій: <b>4</b>" in text
            await wh_report.collect(make()[0], "Суми · місто", "Перший")               # повторний збір нічого не задвоює
            assert table() == rows
            pick[two["inv"][1]["ref"]] = "k1"                                           # обидві накладні збирав один — тоді він
            store.db().execute("DELETE FROM reys_wh_probs").connection.commit()
            await wh_report.collect(make()[0])
            assert {r[3] for r in table()} == {"Комірник k1"}
        finally:
            wh_report.onec.by_keys = old
    asyncio.run(go())


def test_menu_does_not_wait_for_1c_on_every_tap():
    """Власник 27.11: «підвисає, довго реагує». Список путівок читаємо з 1С раз на хвилину, а не на кожен дотик."""
    async def go():
        async with Drivers() as app:
            calls, labels = [], []
            real, cities = handlers.list_sheets, handlers.sheet_cities

            async def sheets(day):
                calls.append(day)
                return await real(day)

            async def slow_cities(ref):
                labels.append(ref)
                return await cities(ref)
            handlers.list_sheets, handlers.sheet_cities = sheets, slow_cities
            try:
                await app.call("state")                                        # перше відкриття — один похід у 1С
                assert len(calls) == 1 and len(labels) == 2
                for who in (333, 444, 333):
                    assert (await app.call("assign", id="1c:" + SHEET, to=who))[1]["ok"]
                await app.call("menu")
                assert (await app.call("start", id="demo"))[1]["ok"]           # навчальний рейс 1С не чекає взагалі
                await app.call("state", who=333)
                assert len(calls) == 1 and len(labels) == 2                    # жодного нового запиту
                day, (at, rows) = next(iter(web.SHEETS.items()))
                web.SHEETS[day] = (at - web.SHEETS_TTL - 1, rows)              # минула хвилина — список оновлюється
                await app.call("menu", who=333)
                assert len(calls) == 2 and len(labels) == 2                    # назви путівок удруге не читаємо
                web.SHEETS[day] = (0, rows)                                    # екіпаж складається з прочитаного, хоч і давнього
                await app.call("assign", id="1c:" + OTHER, to=444)
                assert len(calls) == 2
            finally:
                handlers.list_sheets, handlers.sheet_cities = real, cities
    asyncio.run(go())


def test_manager_is_told_which_clients_have_no_phone():
    """Власник 27.11: у клієнта немає телефону в 1С — менеджер бачить це у звіті після рейсу і вносить."""
    import tempfile
    from reys import build, engine, mgr_report
    store.DB_PATH = os.path.join(tempfile.mkdtemp(), "t.db")
    store.init()
    run = build.demo_run(handlers.today())
    assert not any("📵" in t for t in mgr_report.build(run).values())          # телефони не читались — нікого не лякаємо
    for st in run["stops"]:
        st["phones"] = ["+380500000001"]
    quiet = run["stops"][0]
    quiet["phones"] = []                                                       # точку не відмічено, а телефону немає
    engine.pay_all(run["stops"][1], 1)
    reps = mgr_report.build(run, "Суми · місто", "Перший")
    owner = engine.clean(quiet["inv"][0]["manager"])
    assert f"внеси в 1С: 1</b>" in reps[owner] and quiet["name"] in reps[owner]
    assert sum("📵" in t for t in reps.values()) == len({engine.clean(i.get("manager")) for i in quiet["inv"]} | {engine.clean(quiet.get("manager"))} - {""})
    skip = next((s for s in run["stops"] if s["where"] == "skip"), None)
    if skip:
        skip["phones"] = []
        assert all(skip["name"] not in t.split("📵")[-1] for t in mgr_report.build(run).values() if "📵" in t)
