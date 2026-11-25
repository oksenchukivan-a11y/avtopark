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
            assert [s["mphone"] for s in stops if s["manager"] == "Оля"][0] == "+380501112233"
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
