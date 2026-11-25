"""Повний прохід рейсу кнопками без справжнього Telegram і читання з підставної 1С. Дані вигадані."""
import asyncio
import datetime as dt
import json
import os
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ.pop("REYS_1C_URL", None)
os.environ.pop("PK_MCP_URL", None)

from aiogram import Bot, Dispatcher                                    # noqa: E402
from aiogram.client.session.base import BaseSession                     # noqa: E402
from aiogram.fsm.storage.memory import MemoryStorage                    # noqa: E402
from aiogram.methods import EditMessageText, SendContact, SendMessage   # noqa: E402
from aiogram.types import CallbackQuery, Chat, Message, Update, User    # noqa: E402
from aiohttp import web                                                 # noqa: E402

import reys                                                             # noqa: E402
from reys import handlers, onec, store                                  # noqa: E402

ME, STRANGER = 111, 222


class FakeSession(BaseSession):
    """Замість Telegram: запам'ятовує, що бот надіслав, і повертає правдоподібну відповідь."""
    def __init__(self):
        super().__init__()
        self.sent, self.n = [], 1000

    async def make_request(self, bot, method, timeout=None):
        self.sent.append(method)
        if isinstance(method, (SendMessage, SendContact)):
            self.n += 1
            return Message(message_id=self.n, date=dt.datetime.now(), chat=Chat(id=method.chat_id, type="private"),
                           text=getattr(method, "text", None))
        if isinstance(method, EditMessageText):
            return Message(message_id=method.message_id, date=dt.datetime.now(),
                           chat=Chat(id=method.chat_id, type="private"), text=method.text)
        return True

    async def stream_content(self, *a, **k):
        yield b""

    async def close(self):
        pass


class Tg:
    def __init__(self):
        self.session = FakeSession()
        self.bot = Bot("42:TEST", session=self.session)
        self.dp = Dispatcher(storage=MemoryStorage())
        handlers.router._parent_router = None       # той самий роутер у кожному тесті підключаємо заново
        # кожен тест — на чистій базі, щоб порядок запуску не впливав на результат
        reys.setup(self.dp, admin_id=ME, db_path=os.path.join(tempfile.mkdtemp(), "t.db"))
        self.uid, self.screen = 0, None

    def user(self, who):
        return User(id=who, is_bot=False, first_name="Тест")

    async def text(self, text, who=ME):
        self.uid += 1
        m = Message(message_id=self.uid, date=dt.datetime.now(), chat=Chat(id=who, type="private"),
                    from_user=self.user(who), text=text)
        before = len(self.session.sent)
        res = await self.dp.feed_update(self.bot, Update(update_id=self.uid, message=m))
        return self.session.sent[before:], res

    async def tap(self, data, who=ME):
        self.uid += 1
        msg = Message(message_id=self.screen or 1001, date=dt.datetime.now(), chat=Chat(id=who, type="private"),
                      from_user=User(id=42, is_bot=True, first_name="bot"), text="екран")
        cb = CallbackQuery(id=str(self.uid), from_user=self.user(who), chat_instance="x", message=msg, data=data)
        before = len(self.session.sent)
        await self.dp.feed_update(self.bot, Update(update_id=self.uid, callback_query=cb))
        return self.session.sent[before:]

    def last_screen(self, sent):
        scr = [m for m in sent if isinstance(m, (EditMessageText, SendMessage))]
        assert scr, f"екран не оновився: {sent}"
        return scr[-1].text, [b.callback_data for row in (scr[-1].reply_markup.inline_keyboard
                                                        if scr[-1].reply_markup else []) for b in row]


def test_full_demo_run_by_buttons():
    async def go():
        tg = Tg()
        sent, _ = await tg.text("/reys")
        text, btns = tg.last_screen(sent)
        assert "пробний режим" in text and "r:demo" in btns
        tg.screen = 1001
        text, btns = tg.last_screen(await tg.tap("r:demo"))
        assert "лишилось 5 з 5" in text and "r:o:0" in btns
        # А: заплатив усе одним дотиком
        text, btns = tg.last_screen(await tg.tap("r:o:0"))
        assert "САЛОН А" in text and "r:all:0" in btns
        text, _ = tg.last_screen(await tg.tap("r:all:0"))
        assert "лишилось 4 з 5" in text and "Зібрано: 1 501 ₴" in text
        # Б: дав круглу суму 2500 при боргу
        await tg.tap("r:o:1")
        text, btns = tg.last_screen(await tg.tap("r:pt:1"))
        assert "r:tg:1:0" in btns
        await tg.tap("r:sm:1")
        sent, _ = await tg.text("2500")
        text, btns = tg.last_screen(sent)
        assert "накл. 1101 — закрита" in text and "накл. 1158 — частково: 500 ₴ з 1 600 ₴" in text
        assert any(type(m).__name__ == "DeleteMessage" for m in sent)       # набране число прибрано зі стрічки
        text, _ = tg.last_screen(await tg.tap("r:sy:1"))
        assert "Зібрано: 4 001 ₴" in text
        # В: без оплати
        text, btns = tg.last_screen(await tg.tap("r:o:2"))
        assert "Без оплати" in text and "r:gv:2" in btns and "r:all:2" not in btns
        await tg.tap("r:gv:2")
        # Г: нестача позиції, потім «домовилась з менеджером»
        await tg.tap("r:o:3")
        await tg.tap("r:pr:3")
        text, btns = tg.last_screen(await tg.tap("r:pk:3:miss"))
        assert "r:pi:3:miss:0:1" in btns
        text, btns = tg.last_screen(await tg.tap("r:pi:3:miss:0:1"))       # Окисник, 1 шт — одразу записано
        assert "не вистачає: Окисник 6 % 1 л ×1" in text and "До збору: 1 380 ₴" in text
        await tg.tap("r:no:3")
        await tg.tap("r:rs:3:mgr")
        # Д: боржник без грошей → спершу дзвінок, потім «товар не залишив»
        await tg.tap("r:o:4")
        await tg.tap("r:no:4")
        text, btns = tg.last_screen(await tg.tap("r:rs:4:nomoney"))
        assert "Не залишай товар" in text and "r:dn:4" in btns
        text, _ = tg.last_screen(await tg.tap("r:dn:4"))
        assert "лишилось 0 з 5" in text
        # витрата на Нову пошту з каси
        await tg.tap("r:ex")
        sent, _ = await tg.text("683,50")
        assert "лишилось 0 з 5" in tg.last_screen(sent)[0]
        text, btns = tg.last_screen(await tg.tap("r:cz"))
        assert "Готівка: 4 001 ₴" in text and "До здачі: 3 317,50 ₴" in text and "r:hd" in btns
        text, btns = tg.last_screen(await tg.tap("r:hd"))
        assert "🧾" in text and "Салон Б: 2 500 ₴ (№1101 2 000 ₴, №1158 500 ₴)" in text and btns == []
        assert "Барбершоп Г: домовилась з менеджером" in text and "не вистачає — Окисник" in text
        assert store.open_run(ME) == (None, None)                           # рейс закрито
        with store.db() as c:
            acts = [r[0] for r in c.execute("SELECT action FROM reys_events ORDER BY id")]
        assert acts == ["start", "all", "amount", "gv", "problem", "none", "debtor", "expense", "close"]
    asyncio.run(go())


def test_other_drivers_see_nothing():
    async def go():
        tg = Tg()
        sent, res = await tg.text("/reys", who=STRANGER)
        assert sent == []                                                   # модуль мовчить, бот працює як раніше
        assert await tg.tap("r:demo", who=STRANGER) == []
    asyncio.run(go())


def test_fix_and_cannot_close_early():
    async def go():
        tg = Tg()
        await tg.text("/reys")
        tg.screen = 1001
        await tg.tap("r:demo")
        await tg.tap("r:o:0")
        await tg.tap("r:all:0")
        text, btns = tg.last_screen(await tg.tap("r:cz"))
        assert "касу здати не можна" in text and "r:hd" not in btns
        text, btns = tg.last_screen(await tg.tap("r:o:0"))
        assert "Відмічено: забрав усе" in text and "r:fx:0" in btns
        text, btns = tg.last_screen(await tg.tap("r:fx:0"))
        assert "r:all:0" in btns
        assert await tg.tap("r:hd") != None and store.open_run(ME)[1]["closed"] is False
    asyncio.run(go())


def test_snapshot_of_real_sheet_is_offered_and_opens():
    async def go():
        tg = Tg()
        d = handlers.snap_dir()
        os.makedirs(d)
        snap = reys.build.demo_run(dt.date(2026, 11, 25))
        snap.pop("demo")
        snap["title"] = "Місто 25.11 · друк 13:01"
        snap["stops"][0]["status"] = {"kind": "paid"}            # чужі відмітки у знімку не мають переноситись
        with open(os.path.join(d, "2026-11-25_1301_8389.json"), "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False)
        open(os.path.join(d, "../evil.json"), "w").write("{}")
        sent, _ = await tg.text("/reys")
        text, btns = tg.last_screen(sent)
        assert "Справжні путівки з 1С" in text and "r:sn:2026-11-25_1301_8389" in btns
        tg.screen = 1001
        text, btns = tg.last_screen(await tg.tap("r:sn:2026-11-25_1301_8389"))
        assert "Місто 25.11 · друк 13:01 · лишилось 5 з 5" in text
        text, btns = tg.last_screen(await tg.tap("r:o:1"))
        assert "БОРГ 3 600 ₴" in text                              # борги по накладних узято зі знімка
        assert await tg.tap("r:sn:../evil") is not None and store.open_run(ME)[1]["title"].startswith("Місто")
    asyncio.run(go())


# ---------- підставна 1С ----------

Z = onec.ZERO
SHEET = {"Ref_Key": "s1", "Number": "000000777", "Date": "2026-11-17T13:03:08", "Контрагенты": [
    {"Контрагент_Key": "c1", "Документ_Key": Z, "Долг": 830.0, "СуммаДокументов": 0},
    {"Контрагент_Key": "c1", "Документ_Key": "i1", "Долг": 0, "СуммаДокументов": 1068.0},
    {"Контрагент_Key": "c2", "Документ_Key": "i2", "Долг": 0, "СуммаДокументов": 915.0},
    {"Контрагент_Key": "c3", "Документ_Key": "i3", "Долг": 0, "СуммаДокументов": 1260.0},
    {"Контрагент_Key": "c4", "Документ_Key": Z, "Долг": 2283.42, "СуммаДокументов": 0},
    {"Контрагент_Key": "c5", "Документ_Key": Z, "Долг": -0.99, "СуммаДокументов": 0}]}
DATA = {
    "Document_ПутевойЛист": [SHEET],
    "Document_РеализацияТоваровУслуг": [
        {"Ref_Key": "i1", "Number": "ТЕСТ0000786", "Date": "2026-11-17T12:08:47", "СуммаДокумента": 1068.0,
         "Контрагент_Key": "c1", "Агент_Key": "a1",
         "Товары": [{"LineNumber": "1", "Номенклатура_Key": "n1", "Количество": 2, "Сумма": 400.0},
                    {"LineNumber": "2", "Номенклатура_Key": "n2", "Количество": 1, "Сумма": 668.0}]},
        {"Ref_Key": "i2", "Number": "ТЕСТ0000783", "Date": "2026-11-17T12:20:38", "СуммаДокумента": 915.0,
         "Контрагент_Key": "c2", "Агент_Key": "a1"},
        {"Ref_Key": "i3", "Number": "ТЕСТ0000742", "Date": "2026-11-17T09:49:23", "СуммаДокумента": 1260.0,
         "Контрагент_Key": "c3", "Агент_Key": "a1"},
        {"Ref_Key": "old1", "Number": "ТЕСТ0000419", "Date": "2026-11-10T10:00:00", "СуммаДокумента": 830.0,
         "Контрагент_Key": "c1", "Агент_Key": "a1"}],
    "Catalog_Контрагенты": [{"Ref_Key": "c1", "Description": "Салон Один ( вул. Перша 20 )"},
                            {"Ref_Key": "c2", "Description": "Майстер Два (вул. Друга 15)"},
                            {"Ref_Key": "c3", "Description": "Перукарня Три (вул. Третя 39 )"},
                            {"Ref_Key": "c4", "Description": "Салон Чотири"}],
    "Catalog_ФизическиеЛица": [{"Ref_Key": "a1", "Description": "Тестова Олена"}],
    "Catalog_Номенклатура": [{"Ref_Key": "n1", "Description": "Фарба тест"}, {"Ref_Key": "n2", "Description": "Окисник тест"}],
    "Document_ЗаказПокупателя": [
        {"Date": "2026-11-17T12:08:20", "Комментарий": "в салон, забрати гроші", "СуммаДокумента": 1068.0, "Контрагент_Key": "c1"},
        {"Date": "2026-11-17T12:20:10", "Комментарий": "б/о", "СуммаДокумента": 915.0, "Контрагент_Key": "c2"},
        {"Date": "2026-11-17T09:49:04", "Комментарий": "На 20.11 доставку", "СуммаДокумента": 1260.0, "Контрагент_Key": "c3"}],
}
BALANCE = [{"ДокументРасчетовСКонтрагентом": "old1", "ДокументРасчетовСКонтрагентом_Type": "StandardODATA.Document_РеализацияТоваровУслуг", "СуммаВзаиморасчетовBalance": 830.0},
           {"ДокументРасчетовСКонтрагентом": "i1", "ДокументРасчетовСКонтрагентом_Type": "StandardODATA.Document_РеализацияТоваровУслуг", "СуммаВзаиморасчетовBalance": 1068.0}]


async def fake_1c(request):
    q = await request.json()
    a = q["params"]["arguments"]
    if q["params"]["name"] == "register_totals":
        rows = BALANCE if "c1" in a["condition"] else []
    else:
        flt = a.get("filter", "")
        rows = [r for r in DATA[a["object"]]
                if any(f"guid'{v}'" in flt for v in (r.get("Ref_Key"), r.get("Контрагент_Key")) if v)]
        keep = set(a["select"].split(","))
        rows = [{k: v for k, v in r.items() if k in keep} for r in rows]
    text = f"Рядків: {len(rows)}\n" + json.dumps(rows, ensure_ascii=False)
    return web.json_response({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}]}})


def test_load_run_from_1c():
    async def go():
        app = web.Application()
        app.router.add_post("/secret/mcp", fake_1c)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        onec.URL = f"http://127.0.0.1:{port}/secret/mcp"
        try:
            run = await handlers.load_run("s1")
            by = {s["name"]: s for s in run["stops"]}
            one = by["Салон Один"]
            assert one["addr"] == "вул. Перша 20" and one["manager"] == "Тестова Олена" and one["where"] == "route"
            assert one["inv"][0]["no"] == "786" and "DEBT" in one["inv"][0]["tags"] and one["sheet_debt"] == 830.0
            assert by["Майстер Два"]["inv"][0]["tags"] == ["BO"]
            three = by["Перукарня Три"]
            assert three["where"] == "skip" and three["inv"][0]["deliver"] == "2026-11-20"
            assert by["Салон Чотири"]["where"] == "debt"
            assert [s["where"] for s in run["stops"]].count("none") == 1          # копійчане сальдо сховано
            await handlers.load_debts(one)                                        # борг по накладних, без сьогоднішньої
            assert one["debts"] == [{"ref": "old1", "no": "419", "date": "2026-11-10", "sum": 830.0}]
            items = await handlers.load_items(one)
            assert (0, 1, "Фарба тест", 2, 200.0) in items and (0, 2, "Окисник тест", 1, 668.0) in items
            assert (await handlers.list_sheets(dt.date(2026, 11, 17))) is not None
        finally:
            onec.URL = ""
            await runner.cleanup()
    asyncio.run(go())


def test_1c_down_gives_clear_error():
    async def go():
        onec.URL = "http://127.0.0.1:1/x/mcp"
        try:
            await onec.call("query", object="X")
            assert False
        except onec.OneCError as e:
            assert "зв'язку" in str(e)
        finally:
            onec.URL = ""
    asyncio.run(go())


def test_truncated_answer_is_refused():
    try:
        onec.parse_rows('Рядків: 900\n[{"a":1},{"b"…[обрізано]\n(Відповідь завелика: звузьте)')
        assert False
    except onec.OneCError:
        pass
    assert onec.parse_rows('Рядків: 1\n[{"a": 1}]') == [{"a": 1}] and onec.parse_rows("Рядків: 0\n[]") == []
