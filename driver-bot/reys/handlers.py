"""Склейка з Telegram (aiogram 3). Один екран на рейс: повідомлення переписується, стрічка не росте."""
import json
import logging
import os
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject, ExceptionTypeFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, ErrorEvent, InlineKeyboardButton, InlineKeyboardMarkup, Message, WebAppInfo

from . import build, daily, engine, onec, store, ui

log = logging.getLogger("reys")
TZ = ZoneInfo("Europe/Kyiv")
router = Router(name="reys")
TESTERS: set = set()
ADMIN = 0                    # власника не обмежують робочі години
REG = "AccumulationRegister_ВзаиморасчетыСКонтрагентамиПоДокументамРасчетов"
REAL = "Document_РеализацияТоваровУслуг"


class Reys(StatesGroup):
    amount = State()
    expense = State()
    phone = State()


def ids_from_env(name: str) -> set:
    return {int(x) for x in os.environ.get(name, "").replace(" ", "").split(",") if x.isdigit()}


ON_SENT = None               # необов'язкова функція бота: (chat_id, message_id) — «це повідомлення лишилось у чаті»
ON_ACT = None                # необов'язкова функція бота: (tg_id, що зроблено) — журнал дій і сторож сплесків


def act(uid, what):
    """Каже боту про дію в рейсі (кнопка в чаті чи запит застосунку). Помилка тут не має зупиняти рейс."""
    if ON_ACT:
        try:
            ON_ACT(int(uid or 0), str(what)[:40])
        except Exception as e:
            log.warning("reys: on_act: %s", e)


class Refused(Exception):
    """Відмова, яку показуємо людині як є."""


def trial_ids() -> set:
    """Чиї рейси пробні: власника і його «водійського» акаунта для перегляду (REYS_PREVIEW).
    Пробний рейс не ховає путівку з меню і не заважає водієві її відкрити."""
    return ({ADMIN} if ADMIN else set()) | ids_from_env("REYS_PREVIEW")


CREW_MAX = 2                 # рішення власника 27.11: путівку везе екіпаж з одного-двох водіїв, усе навпіл


def may_open(uid, sheet_ref) -> bool:
    """Чужу путівку не відкрити: власник — будь-яку, водій — тільки ту, де він в екіпажі."""
    return uid == ADMIN or uid in store.crew(sheet_ref)


def guard_start(uid, new_run, force=False):
    """Перед відкриттям рейсу. Повертає True, якщо цей самий рейс уже відкрито (нічого робити не треба).
    Рейс з відмітками не скидається: у ньому гроші, які ще не здано касиру."""
    ref = new_run.get("sheet_ref", "")
    real = not new_run.get("demo") and not new_run.get("snap")
    team = set(store.crew(ref)) if real else set()
    if real and uid != ADMIN:
        if uid not in team:
            raise Refused("Цю путівку за тобою не закріплено")
        if ref in store.closed_refs(ignore=trial_ids()):
            raise Refused("По цій путівці касу вже здано")
        if store.taken_by(ref, team | trial_ids()):
            raise Refused("Цю путівку вже відкрив інший водій")
    run_id, old = store.open_run(uid)
    mine = bool(old) and store.owner(run_id) == uid
    same = bool(old) and real and old.get("sheet_ref") == ref and (mine or uid in team)
    if same:
        if not mine:
            store.drop_idle(uid)                             # свій порожній (навчальний) рейс більше не потрібен
        return True
    if old and not mine and engine.has_marks(old):           # рейс відкрив напарник — його не скинути й не обійти
        raise Refused("У твого екіпажу відкритий рейс з відмітками. Спершу здайте в ньому касу.")
    if old and engine.has_marks(old) and not (uid == ADMIN and force):
        raise Refused("У тебе відкритий рейс з відмітками. Спершу здай у ньому касу.")
    if real and uid in team:
        rid, by, _ = store.sheet_run(ref)                    # напарник уже відкрив цю путівку — заходимо в його рейс
        if rid and by != uid:
            store.drop_idle(uid)
            return True
    if old and mine and engine.has_marks(old):
        store.log(run_id, uid, "drop", **{k: v for k, v in engine.totals(old).items() if k != "why"})
    return False


def shares(day=None):
    """Для автозвіту: хто з ким їхав. {tg_id: [(путівка, частка 1.0 або 0.5, [напарники])]}.
    Ящики й кілограми путівки діляться на цю частку."""
    return store.shares(day or today())


def sent(msg):
    """Каже боту про повідомлення, яке модуль лишив у чаті, щоб його прибрала загальна чистка стрічки.
    Екран рейсу сюди не потрапляє: його модуль прибирає сам. Помилка тут не має зупиняти рейс."""
    if ON_SENT and msg is not None:
        try:
            ON_SENT(msg.chat.id, msg.message_id)
        except Exception as e:
            log.warning("reys: on_sent: %s", e)
    return msg


def setup(dp, admin_id: int = 0, db_path: str = "", on_sent=None, on_act=None, people=None,
          vehicles=None, km_for=None, to_reports=None, on_damage_photo=None, expected_parcels=None):
    """Викликати один раз у main() ПЕРЕД підключенням основного роутера бота.
    people — необов'язковий словник {tg_id: ім'я водія}, щоб власник бачив імена, а не номери.
    vehicles — {код авто: назва}: з ним у рейсі з'являється «Звіт за день» (авто, ящики, пошта, стан авто).
    km_for(коди, день) → (км, деталі) або None; to_reports(рядок) — запис у старий звіт (лише з REYS_TO_REPORTS=1);
    on_damage_photo(bot, tg_id, file_id, авто, опис) — що бот робить із фото пошкодження;
    expected_parcels(день) → [{supplier, ttn, places}] — посилки, які мають прийти (підказка водієві)."""
    global ON_SENT, ON_ACT
    ON_SENT, ON_ACT = on_sent, on_act
    from . import web                       # тут, а не вгорі: web сам користується цим файлом
    if db_path:
        store.DB_PATH = db_path
    global ADMIN
    ADMIN = int(admin_id or 0)
    ids = ids_from_env("REYS_TESTERS")
    if admin_id:
        ids.add(int(admin_id))
    TESTERS.clear()
    TESTERS.update(ids)
    store.init()
    from . import wh_report
    wh_report.init()
    daily.init()
    daily.VEHICLES = {str(k): str(v) for k, v in (vehicles or {}).items()}
    daily.KM_FOR, daily.TO_REPORTS, daily.ON_PHOTO, daily.PARCELS = km_for, to_reports, on_damage_photo, expected_parcels
    for tg_id, name in (people or {}).items():
        store.set_name(tg_id, name)
    router.message.filter(F.from_user.id.in_(TESTERS))
    router.callback_query.filter(F.from_user.id.in_(TESTERS))
    dp.include_router(router)
    dp.startup.register(web.start)
    dp.shutdown.register(web.stop)
    log.info("reys: модуль увімкнено для %d тестувальників", len(TESTERS))


def today() -> date:
    return datetime.now(TZ).date()


def markup(rows):
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows])


def scr(run, chat_id):
    """Екран рейсу в чаті цієї людини. Рейс в екіпажу один, а чат у кожного свій — тому екран теж у кожного свій."""
    if "screens" in run:
        return run["screens"].get(str(chat_id))
    return run.get("screen")                                  # рейси, відкриті до екіпажів


def set_scr(run, chat_id, mid):
    run.setdefault("screens", {})[str(chat_id)] = mid


async def show(cb: CallbackQuery, text, rows):
    try:
        await cb.message.edit_text(text, reply_markup=markup(rows), parse_mode="HTML")
    except TelegramBadRequest as e:
        if "not modified" not in str(e):
            raise


async def reshow(bot: Bot, chat_id, run, text, rows):
    """Після введеного з клавіатури числа переписуємо той самий екран, а не шлемо новий."""
    mid = scr(run, chat_id)
    if mid:
        try:
            await bot.edit_message_text(text, chat_id=chat_id, message_id=mid, reply_markup=markup(rows),
                                        parse_mode="HTML")
            return
        except TelegramBadRequest:
            pass
    m = await bot.send_message(chat_id, text, reply_markup=markup(rows), parse_mode="HTML")
    set_scr(run, chat_id, m.message_id)


# ---------- знімки путівок ----------
# Поки сервер бота не має шляху до 1С, готову путівку можна покласти файлом у теку знімків.

SNAP_RX = re.compile(r"^[0-9A-Za-z_-]{1,40}$")


def snap_dir() -> str:
    return os.environ.get("REYS_SNAP_DIR") or os.path.join(os.path.dirname(os.path.abspath(store.DB_PATH)),
                                                           "reys_snapshots")


def snapshots():
    """[(назва файлу без .json, підпис кнопки)] — найновіші зверху."""
    d, out = snap_dir(), []
    if os.path.isdir(d):
        for f in sorted(os.listdir(d), reverse=True):
            stem = f[:-5]
            if f.endswith(".json") and SNAP_RX.match(stem):
                try:
                    with open(os.path.join(d, f), encoding="utf-8") as fh:
                        out.append((stem, json.load(fh).get("title") or stem))
                except (OSError, ValueError):
                    log.warning("reys: знімок %s не читається", f)
    return out[:12]


def load_snapshot(stem: str):
    if not SNAP_RX.match(stem):
        raise onec.OneCError("неправильна назва знімка")
    try:
        with open(os.path.join(snap_dir(), stem + ".json"), encoding="utf-8") as fh:
            run = json.load(fh)
    except (OSError, ValueError) as e:
        raise onec.OneCError(f"знімок не читається: {e}") from e
    for st in run["stops"]:
        st["status"], st.setdefault("probs", [])[:] = None, []
        build.classify(st)                  # правила могли змінитись після того, як знімок зроблено
    run["stops"] = [st for st in run["stops"] if st["where"] != "none"]
    run.update(expenses=[], closed=False, snap=True)
    return run


# ---------- завантаження з 1С ----------

async def read_sheets(since: str, until: str):
    rows = await onec.call("query", object="Document_ПутевойЛист", select="Ref_Key,Number,Date,DeletionMark",
                           filter=f"Date ge datetime'{since}' and Date le datetime'{until}'", orderby="Date", top=40)
    return [r for r in rows if not r.get("DeletionMark")]          # помічені на видалення не показуємо


async def list_sheets(day: date):
    """Путівки на день: надруковані цього дня і вечірні з попереднього робочого дня, по яких касу ще не здано.
    Обласні в 1С створюють напередодні близько 16:30 — без цього водій уранці своєї путівки не бачить."""
    back = 3 if day.weekday() == 0 else 1                 # у понеділок дивимось до п'ятниці
    since = f"{(day - timedelta(days=back)).isoformat()}T{build.EVENING:02d}:00:00"
    rows = await read_sheets(since, f"{day.isoformat()}T23:59:59")
    done, out = store.closed_refs(ignore=trial_ids()), []
    for s in rows:
        printed = datetime.fromisoformat(s["Date"][:19])
        if printed.date() == day or (printed.hour >= build.EVENING and s["Ref_Key"] not in done):
            out.append(s)
    # спершу те, що везуть сьогодні (учорашні вечірні), потім надруковане сьогодні на завтра
    return sorted(out, key=lambda s: (datetime.fromisoformat(s["Date"][:19]).date() == day
                                      and int(s["Date"][11:13]) >= build.EVENING, s["Date"]))


async def sheet_cities(ref: str):
    """Міста клієнтів путівки і скільки в ній точок з доставкою. Одна путівка — два-три запити до 1С."""
    rows = await onec.call("query", object="Document_ПутевойЛист", filter=f"Ref_Key eq guid'{ref}'",
                           select="Ref_Key,Контрагенты", top=1)
    lines = rows[0]["Контрагенты"] if rows else []
    deliver = {r["Контрагент_Key"] for r in lines if r["Документ_Key"] != onec.ZERO}
    keys = deliver or {r["Контрагент_Key"] for r in lines}
    cards = await onec.by_keys("Catalog_Контрагенты", keys, "Ref_Key,ДополнительноеОписание")
    return [c.get("ДополнительноеОписание", "") for c in cards], len(deliver)


async def sheet_label(stub):
    """Назва путівки для людини: напрямок замість номера. Власник: «просто номера, як понять»."""
    ref, hhmm, no = stub["Ref_Key"], stub["Date"][11:16], stub["Number"].lstrip("0")
    got = store.title(ref, max_age_min=360)      # напрямок путівки за день не змінюється — у 1С по нього раз
    if got is None:
        try:
            cities, points = await sheet_cities(ref)
            got = (build.direction(cities), points)
            store.set_title(ref, *got)
        except (onec.OneCError, KeyError, IndexError) as e:        # без назви меню теж працює
            log.warning("reys: напрямок путівки %s не визначено: %s", no, e)
            got = ("", 0)
    name, points = got
    ride = build.ride_day(datetime.fromisoformat(stub["Date"][:19]), name)      # вечірню обласну везуть завтра
    sub = " · ".join(x for x in (f"{build.WEEKDAYS[ride.weekday()]} {ride:%d.%m}",
                                 f"{points} {ui.plural(points, 'точка', 'точки', 'точок')}" if points else "",
                                 f"№ {no}") if x)
    return (name or f"Путівка {hhmm}"), sub


async def load_run(ref: str):
    rows = await onec.call("query", object="Document_ПутевойЛист", filter=f"Ref_Key eq guid'{ref}'",
                           select="Ref_Key,Number,Date,Контрагенты", top=1)
    if not rows:
        raise onec.OneCError("путівку не знайдено")
    sheet = rows[0]
    lines = sheet["Контрагенты"]
    inv_keys = {r["Документ_Key"] for r in lines}
    invoices = await onec.by_keys(REAL, inv_keys, "Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,Агент_Key")
    with_inv = {i["Контрагент_Key"] for i in invoices}
    wanted = with_inv | {r["Контрагент_Key"] for r in lines if r["Долг"] > 0.5}
    cards = await onec.by_keys("Catalog_Контрагенты", wanted, "Ref_Key,Description,ДополнительноеОписание")
    names = {r["Ref_Key"]: r["Description"] for r in cards}
    agents = {r["Ref_Key"]: r["Description"] for r in await onec.by_keys(
        "Catalog_ФизическиеЛица", {i.get("Агент_Key") for i in invoices}, "Ref_Key,Description")}
    day = datetime.fromisoformat(sheet["Date"][:19])
    since = (day - timedelta(days=10)).date().isoformat()
    orders = await onec.by_keys(
        "Document_ЗаказПокупателя", with_inv, "Date,Комментарий,СуммаДокумента,Контрагент_Key",
        field="Контрагент_Key",
        extra=f"Date ge datetime'{since}T00:00:00' and Date le datetime'{sheet['Date'][:19]}' and Posted eq true")
    where = build.direction([r.get("ДополнительноеОписание", "") for r in cards if r["Ref_Key"] in with_inv])
    ride = build.ride_day(day, where)                            # вечірню обласну везуть наступного дня
    run = build.build_run(sheet, invoices, names, agents, orders, day=ride)
    if where:                                                    # у шапці рейсу — куди їдемо, а не номер
        run["title"] = f"{where} · {ride:%d.%m}"
    AGENTS.update(agents)
    await load_phones(run)
    await load_recent_managers(run, day)
    return run


AGENTS: dict = {}            # ключ менеджера в 1С → ім'я; наповнюється під час роботи


async def agent_names(keys):
    need = {k for k in keys if k and k != onec.ZERO and k not in AGENTS}
    if need:
        AGENTS.update({r["Ref_Key"]: r["Description"] for r in await onec.by_keys(
            "Catalog_ФизическиеЛица", need, "Ref_Key,Description")})
    return AGENTS


async def load_recent_managers(run, day, days=90):
    """Хто продавав клієнтові за останні місяці. Поле «основний менеджер» у картці клієнта в 1С порожнє,
    тому менеджерів точки беремо з факту: з накладних. Так видно й другого менеджера салону."""
    keys = sorted({st["key"] for st in run["stops"] if st["where"] in ("route", "debt")})
    since = (day - timedelta(days=days)).date().isoformat()
    seen = {}
    try:
        for part in onec.chunks(keys, 15):
            flt = (f"({onec.guid_filter('Контрагент_Key', part)}) and Posted eq true and "
                   f"Date ge datetime'{since}T00:00:00'")
            for r in await onec.call("query", object=REAL, filter=flt, select="Контрагент_Key,Агент_Key,Date",
                                     orderby="Date desc", top=3000):
                lst = seen.setdefault(r["Контрагент_Key"], [])
                if r.get("Агент_Key") and r["Агент_Key"] != onec.ZERO and r["Агент_Key"] not in lst:
                    lst.append(r["Агент_Key"])
        names = await agent_names({k for lst in seen.values() for k in lst})
    except (onec.OneCError, KeyError) as e:      # без цього рейс теж працює: лишаються менеджери накладних
        log.warning("reys: недавні менеджери не завантажились: %s", e)
        return
    for st in run["stops"]:
        st["recent_mgrs"] = [names[k] for k in seen.get(st["key"], []) if names.get(k)][:4]


def norm_phones(text: str):
    """«050 123-45-67, 0661234567» → ['+380501234567', '+380661234567']."""
    out = []
    for part in re.split(r"[,;/]", text or ""):
        d = re.sub(r"\D", "", part)
        if len(d) == 10 and d[0] == "0":
            d = "38" + d
        elif len(d) == 9:
            d = "380" + d
        if len(d) == 12 and d.startswith("380") and "+" + d not in out:
            out.append("+" + d)
    return out


async def load_phones(run):
    """Телефони салонів із картки клієнта в 1С — щоб дзвонити прямо зі списку."""
    keys = sorted({st["key"] for st in run["stops"] if st["where"] in ("route", "debt")})
    found = {}
    try:
        for part in onec.chunks(keys, 20):
            flt = "Тип eq 'Телефон' and (" + " or ".join(
                f"Объект eq cast(guid'{k}', 'Catalog_Контрагенты')" for k in part) + ")"
            for r in await onec.call("query", object="InformationRegister_КонтактнаяИнформация", filter=flt,
                                     select="Объект,Представление", top=1000):
                found.setdefault(r["Объект"], [])
                found[r["Объект"]] += [p for p in norm_phones(r["Представление"]) if p not in found[r["Объект"]]]
    except (onec.OneCError, KeyError) as e:     # без телефонів рейс теж працює
        log.warning("reys: телефони клієнтів не завантажились: %s", e)
    for st in run["stops"]:
        st["phones"] = found.get(st["key"], [])[:3]


async def load_debts(st):
    """Неоплачені накладні клієнта з 1С. Сьогоднішні з путівки сюди не входять — вони показані окремо."""
    if st["debts"] is not None or st["key"].startswith("demo") or not onec.configured():
        return
    try:
        bal = await onec.call("register_totals", register=REG, table="Balance",
                              condition=f"Контрагент_Key eq guid'{st['key']}'", top=300)
        mine = {i["ref"] for i in st["inv"]}
        owed = {b["ДокументРасчетовСКонтрагентом"]: b["СуммаВзаиморасчетовBalance"] for b in bal
                if b.get("СуммаВзаиморасчетовBalance", 0) > 0.005 and b["ДокументРасчетовСКонтрагентом"] not in mine
                and "РеализацияТоваровУслуг" in b.get("ДокументРасчетовСКонтрагентом_Type", "")}
        docs = await onec.by_keys(REAL, owed, "Ref_Key,Number,Date,Агент_Key") if owed else []
        names = await agent_names({d.get("Агент_Key") for d in docs})
        st["debts"] = [{"ref": d["Ref_Key"], "no": build.short_no(d["Number"]), "date": d["Date"][:10],
                        "sum": round(owed[d["Ref_Key"]], 2), "manager": names.get(d.get("Агент_Key"), "")}
                       for d in docs]
    except onec.OneCError as e:          # без зв'язку працюємо з боргом із путівки одним рядком
        log.warning("reys: борги по накладних не завантажились: %s", e)


async def load_items(st):
    """Позиції накладних, що їдуть: [(номер накладної в точці, рядок, назва, кількість, ціна за штуку)]."""
    if st.get("items") is not None:
        return st["items"]
    items = []
    if st["key"].startswith("demo"):
        demo = [("Фарба для волосся 6.0", 2, 185.0), ("Окисник 6 % 1 л", 1, 240.0), ("Шампунь 1 л", 3, 320.0)]
        items = [(0, n, name, q, p) for n, (name, q, p) in enumerate(demo)]
    elif not onec.configured():
        raise onec.OneCError("позиції накладної зʼявляться, коли бот матиме звʼязок з 1С")
    else:
        for ii, inv in enumerate(st["inv"]):
            if {"SV", "NP", "DATE"} & set(inv["tags"]):
                continue
            doc = await onec.call("query", object=REAL, filter=f"Ref_Key eq guid'{inv['ref']}'",
                                  select="Ref_Key,Товары", top=1)
            lines = doc[0]["Товары"] if doc else []
            names = {r["Ref_Key"]: r["Description"] for r in await onec.by_keys(
                "Catalog_Номенклатура", {x["Номенклатура_Key"] for x in lines}, "Ref_Key,Description")}
            for x in lines:
                q = x.get("Количество") or 1
                items.append((ii, int(x["LineNumber"]), names.get(x["Номенклатура_Key"], "позиція"),
                              q, round(x["Сумма"] / q, 2)))
    st["items"] = items
    return items


# ---------- вхід ----------

@router.message(Command("reys"))
async def cmd_reys(m: Message, command: CommandObject, state: FSMContext):
    await state.clear()
    run_id, run = store.open_run(m.from_user.id)
    arg = (command.args or "").strip()
    for mid in (m.message_id, scr(run or {}, m.chat.id)):       # у чаті лишається один екран рейсу
        if mid:
            try:
                await m.bot.delete_message(m.chat.id, mid)
            except TelegramBadRequest:
                pass
    from . import web
    chat_id, old = store.screen(m.from_user.id)
    if old:
        try:
            await m.bot.delete_message(chat_id, old)
        except TelegramBadRequest:
            pass
        store.set_screen(m.from_user.id, None, None)
    if web.ready():                                             # рейс відкривається застосунком
        kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(
            text="🚚 Продовжити рейс" if run else "🚚 Відкрити рейс", web_app=WebAppInfo(url=web.launch_url()))]])
        # рішення власника 26.11: кнопка під повідомленням не ширша за текст — тому текст на всю ширину телефона
        sent = await m.answer(f"🚚 <b>Рейс · {today():%d.%m}</b>\nПутівка, точки й оплати — в одному вікні ⬇️",
                              reply_markup=kb, parse_mode="HTML")
        store.set_screen(m.from_user.id, m.chat.id, sent.message_id)
        return
    rows = []
    if run:
        rows.append([("▶️ Продовжити рейс", "r:l")])
    text = "🧾 <b>Рейс</b>\n<blockquote>Пробний режим — бачиш тільки ти</blockquote>\n"
    if onec.configured():
        try:
            day = datetime.strptime(arg + f".{today().year}", "%d.%m.%Y").date() if arg else today()
            sheets = await list_sheets(day)
            text += f"Путівки за {day:%d.%m}:" if sheets else f"За {day:%d.%m} путівок у 1С ще немає."
            for s in sheets:
                if may_open(m.from_user.id, s["Ref_Key"]):
                    name, sub = await sheet_label(s)
                    rows.append([(f"{name} · {sub}"[:60], f"r:ld1:{s['Ref_Key']}")])
        except ValueError:
            text += "Дата не розпізнана. Приклад: /reys 24.11"
        except onec.OneCError as e:
            text += f"1С не відповідає: {e}"
    snaps = snapshots() if m.from_user.id == ADMIN else []
    if snaps:
        text += ("\n" if onec.configured() else "") + "Справжні путівки з 1С:"
        rows += [[(f"📄 {title}"[:60], f"r:sn:{stem}")] for stem, title in snaps]
    elif not onec.configured():
        text += "1С ще не підключено — можна пройти демо-рейс із вигаданими клієнтами."
    rows.append([("🎓 Демо-рейс (вигадані клієнти)", "r:demo")])
    await m.answer(text, reply_markup=markup(rows), parse_mode="HTML")


@router.message(Command("reys_tel"))
async def cmd_tel(m: Message, command: CommandObject):
    """/reys_tel Прізвище Ім'я 0501234567 — телефон менеджера для кнопки «Набрати»."""
    parts = (command.args or "").rsplit(" ", 1)
    digits = "".join(ch for ch in parts[-1] if ch.isdigit()) if len(parts) == 2 else ""
    if len(digits) < 10:
        return await note(m, "Приклад: /reys_tel Петренко Олена 0501234567\nІм'я — як у 1С, у картці точки.")
    store.set_phone(parts[0].strip(), "+38" + digits[-10:])
    await note(m, f"Записав: {parts[0].strip()} — +38{digits[-10:]}")


async def note(m: Message, text: str):
    """Службова відповідь власникові, яка не лишається в стрічці: команду стираємо, відповідь зникає після «Зрозуміло»."""
    try:
        await m.delete()
    except TelegramBadRequest:
        pass
    sent(await m.answer(text, reply_markup=markup([[("Зрозуміло", "r:ph:x")]])))


# ---------- телефони менеджерів без набору з клавіатури ----------
# У 1С їх немає. Адмін пересилає боту контакт із телефонної книжки і одним дотиком каже, чий він.

def manager_names():
    """Менеджери з останніх рейсів — так, як їх показує картка точки."""
    names = set()
    with store.db() as c:
        for r in c.execute("SELECT data FROM reys_runs ORDER BY id DESC LIMIT 15"):
            try:
                for st in json.loads(r["data"])["stops"]:
                    names |= set(engine.managers(st))
            except (ValueError, KeyError):
                pass
    names.discard("")
    return sorted(names)


@router.message(F.photo, lambda m: daily.photo_wait(m.from_user.id) is not None)
async def msg_damage_photo(m: Message):
    """Фото пошкодження після здачі каси: file_id — у звіт за день, саме фото — власникові."""
    uid, file_id = m.from_user.id, m.photo[-1].file_id
    run_id = daily.photo_wait(uid)
    row = next(iter(daily.rows(run_id=run_id)), {})
    daily.set_photo(uid, run_id, file_id)
    car, desc = row.get("damage_vehicle") or "", row.get("damage_desc") or ""
    if daily.ON_PHOTO:
        try:
            got = daily.ON_PHOTO(m.bot, uid, file_id, car, desc)
            if hasattr(got, "__await__"):
                await got
        except Exception as e:
            log.warning("reys: фото пошкодження бот не прийняв: %s", e)
    if ADMIN and ADMIN != uid and not row.get("test"):
        try:
            who = store.known_people().get(uid, "")
            await m.bot.send_photo(ADMIN, file_id, caption=f"⚠️ Пошкодження: {daily.VEHICLES.get(car, car)}\n{desc}\n{who}"[:1000])
        except Exception as e:
            log.warning("reys: фото пошкодження власникові не надіслано: %s", e)
    sent(await m.answer("📷 Фото записав. Дякую."))          # саме фото не стираємо: воно — доказ


@router.message(F.contact, lambda m: m.from_user.id == ADMIN)
async def msg_contact(m: Message, state: FSMContext):
    nums = norm_phones(m.contact.phone_number)
    names = manager_names()
    try:
        await m.delete()
    except TelegramBadRequest:
        pass
    if not nums or not names:
        why = "Номер не розпізнано." if not nums else "Спершу відкрий будь-який рейс — тоді знатиму імена менеджерів."
        return sent(await m.answer(why, reply_markup=markup([[("Зрозуміло", "r:ph:x")]])))
    names.sort(key=lambda n: (bool(store.phone(n)), n))             # без телефону — зверху
    who = " ".join(x for x in (m.contact.first_name, m.contact.last_name) if x)
    rows = [[(("✓ " if store.phone(n) else "") + n[:40], f"r:ph:{k}")] for k, n in enumerate(names[:20])]
    rows.append([("← Не записувати", "r:ph:x")])
    await state.set_state(Reys.phone)
    await state.update_data(phone=nums[0], names=names[:20])
    sent(await m.answer(f"📞 <b>{nums[0]}</b>\n<blockquote>{who}</blockquote>\nЧий це номер?",
                        reply_markup=markup(rows), parse_mode="HTML"))


@router.callback_query(F.data.startswith("r:ph:"))
async def cb_phone(cb: CallbackQuery, state: FSMContext):
    data, k = await state.get_data(), cb.data.split(":")[2]
    await state.clear()
    text = "Не записано"
    if k.isdigit() and data.get("phone") and int(k) < len(data.get("names", [])):
        name = data["names"][int(k)]
        store.set_phone(name, data["phone"])
        text = f"Записав: {name}"
    await cb.answer(text)
    try:
        await cb.message.delete()                                   # у чаті нічого не лишається
    except TelegramBadRequest:
        pass


@router.message(Command("reys_dir"), lambda m: m.from_user.id == ADMIN)
async def cmd_dir(m: Message, command: CommandObject):
    """/reys_dir Прізвище Ім'я = манікюр — напрямок менеджера для підпису кнопки дзвінка. Порожньо після «=» — прибрати."""
    name, sep, value = (command.args or "").partition("=")
    name, value = name.strip(), value.strip()[:20]
    if not name or not sep:
        people = store.people()
        rows = [f"{v['name']} — {v['dir'] or 'напрямок не задано'}{'' if v['phone'] else ' · телефону немає'}"
                for v in (ui.mgr_view(n, people) for n in manager_names())]
        return await note(m, "Приклад: /reys_dir Петренко Олена = волосся\n\n" + "\n".join(rows))
    store.set_direction(name, value)
    await note(m, f"Записав: {name} — {value or 'без напрямку'}")


async def ctx(cb: CallbackQuery):
    run_id, run = store.open_run(cb.from_user.id)
    if not run:
        await cb.answer("Рейс не відкрито. Відкрий його кнопкою 🚚 Рейс", show_alert=True)
    return run_id, run


async def start_run(cb: CallbackQuery, run):
    try:
        if guard_start(cb.from_user.id, run, force=cb.from_user.id == ADMIN):
            return await show(cb, *ui.screen_list(store.open_run(cb.from_user.id)[1]))
    except Refused as e:
        return await cb.answer(str(e), show_alert=True)
    set_scr(run, cb.message.chat.id, cb.message.message_id)
    run_id = store.create(cb.from_user.id, run)
    store.log(run_id, cb.from_user.id, "start", sheet=run["sheet_no"], stops=len(engine.route(run)))
    await show(cb, *ui.screen_list(run))


@router.callback_query(F.data == "r:demo")
async def cb_demo(cb: CallbackQuery):
    await cb.answer()
    await start_run(cb, build.demo_run(today()))


@router.callback_query(F.data.startswith("r:sn:"))
async def cb_snapshot(cb: CallbackQuery):
    if cb.from_user.id != ADMIN:
        return await cb.answer("Це тільки для власника", show_alert=True)
    try:
        run = load_snapshot(cb.data.split(":", 2)[2])
    except onec.OneCError as e:
        return await cb.answer(str(e)[:190], show_alert=True)
    await cb.answer()
    await start_run(cb, run)


@router.callback_query(F.data.startswith("r:ld1:"))
async def cb_load(cb: CallbackQuery):
    ref = cb.data.split(":", 2)[2]
    if not may_open(cb.from_user.id, ref):
        return await cb.answer("Цю путівку за тобою не закріплено", show_alert=True)
    await cb.answer("Читаю путівку з 1С…")
    try:
        run = await load_run(ref)
    except onec.OneCError as e:
        sent(await cb.message.answer(f"Не вдалося прочитати путівку: {e}"))
        return
    await start_run(cb, run)


# ---------- список ----------

@router.callback_query(F.data.in_({"r:l", "r:ld"}))
async def cb_list(cb: CallbackQuery, state: FSMContext):
    await state.clear()
    run_id, run = await ctx(cb)
    if not run:
        return
    await cb.answer()
    if cb.data == "r:ld":
        run["show_done"] = not run.get("show_done")
    set_scr(run, cb.message.chat.id, cb.message.message_id)
    store.save(run_id, run)
    await show(cb, *ui.screen_list(run, run.get("show_done", False)))


@router.callback_query(F.data == "r:sk")
async def cb_skip(cb: CallbackQuery):
    run_id, run = await ctx(cb)
    if run:
        await cb.answer()
        await show(cb, *ui.screen_skip(run))


@router.callback_query(F.data.startswith("r:db:"))
async def cb_debtors(cb: CallbackQuery):
    run_id, run = await ctx(cb)
    if run:
        await cb.answer()
        await show(cb, *ui.screen_debtors(run, int(cb.data.split(":")[2])))


# ---------- точка ----------

def parts(cb):
    return cb.data.split(":")


def card(run, i):
    """Картка точки з рядком «Точка 3 з 8»."""
    order = [k for k, s in enumerate(run["stops"]) if s["where"] == "route"]
    head = f"Точка {order.index(i) + 1} з {len(order)}" if i in order else "Борг без доставки"
    return ui.screen_card(run["stops"][i], i, head)


async def stop_ctx(cb: CallbackQuery):
    run_id, run = await ctx(cb)
    if not run:
        return None, None, None, None
    i = int(parts(cb)[2])
    if i >= len(run["stops"]):
        await cb.answer("Список змінився. Відкрий рейс заново кнопкою 🚚 Рейс", show_alert=True)
        return None, None, None, None
    return run_id, run, i, run["stops"][i]


async def back_to_list(cb, run_id, run):
    store.save(run_id, run)
    await show(cb, *ui.screen_list(run, run.get("show_done", False)))


@router.callback_query(F.data.startswith("r:o:"))
async def cb_open(cb: CallbackQuery, state: FSMContext):
    await state.clear()
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    await cb.answer()
    await load_debts(st)
    st.pop("sel", None)
    store.save(run_id, run)
    await show(cb, *card(run, i))


@router.callback_query(F.data.startswith(("r:all:", "r:tod:", "r:gv:")))
async def cb_quick(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run or st["status"]:
        return await cb.answer()
    act = parts(cb)[1]
    {"all": engine.pay_all, "tod": engine.pay_today, "gv": engine.mark_given}[act](st, cb.from_user.id)
    store.log(run_id, cb.from_user.id, act, stop=st["name"], cash=st["status"]["cash"])
    await cb.answer("Записано")
    await back_to_list(cb, run_id, run)


@router.callback_query(F.data.startswith("r:fx:"))
async def cb_fix(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    if run.get("closed"):
        return await cb.answer("Касу вже здано — виправити може тільки касир.", show_alert=True)
    store.log(run_id, cb.from_user.id, "fix", stop=st["name"], was=st["status"])
    st["status"] = None
    store.save(run_id, run)
    await cb.answer("Відмітку знято")
    await show(cb, *card(run, i))


@router.callback_query(F.data.startswith("r:pt:"))
async def cb_part(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if run:
        await cb.answer()
        st["sel"] = []
        store.save(run_id, run)
        await show(cb, *ui.screen_part(st, i))


@router.callback_query(F.data.startswith("r:tg:"))
async def cb_toggle(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    k = int(parts(cb)[3])
    sel = set(st.get("sel", []))
    sel ^= {k}
    st["sel"] = sorted(sel)
    store.save(run_id, run)
    await cb.answer()
    await show(cb, *ui.screen_part(st, i))


@router.callback_query(F.data.startswith("r:pd:"))
async def cb_part_done(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run or st["status"]:
        return await cb.answer()
    pay = engine.payable(st)
    picked = [(pay[k]["ref"], pay[k]["sum"]) for k in st.get("sel", []) if k < len(pay)]
    engine.pay(st, cb.from_user.id, picked, note="окремі накладні")
    st.pop("sel", None)
    store.log(run_id, cb.from_user.id, "part", stop=st["name"], cash=st["status"]["cash"])
    await cb.answer("Записано")
    await back_to_list(cb, run_id, run)


@router.callback_query(F.data.startswith("r:sm:"))
async def cb_sum(cb: CallbackQuery, state: FSMContext):
    run_id, run, i, st = await stop_ctx(cb)
    if run:
        await cb.answer()
        set_scr(run, cb.message.chat.id, cb.message.message_id)
        store.save(run_id, run)
        await state.set_state(Reys.amount)
        await state.update_data(stop=i)
        await show(cb, *ui.screen_sum(st, i))


def parse_money(text: str):
    try:
        v = float(text.strip().replace(" ", "").replace(",", "."))
        return round(v, 2) if 0 < v < 1_000_000 else None
    except ValueError:
        return None


@router.message(Reys.amount, F.text)
async def msg_amount(m: Message, state: FSMContext, bot: Bot):
    run_id, run = store.open_run(m.from_user.id)
    i = (await state.get_data()).get("stop")
    try:
        await m.delete()
    except TelegramBadRequest:
        pass
    if not run or i is None:
        return await state.clear()
    st, v = run["stops"][i], parse_money(m.text)
    if v is None:
        text, rows = ui.screen_sum(st, i)
        return await reshow(bot, m.chat.id, run, "Потрібне число, наприклад 2500.\n\n" + text, rows)
    st["typed"] = v
    store.save(run_id, run)
    await reshow(bot, m.chat.id, run, *ui.screen_sum(st, i, v))
    store.save(run_id, run)


@router.callback_query(F.data.startswith("r:sy:"))
async def cb_sum_yes(cb: CallbackQuery, state: FSMContext):
    await state.clear()
    run_id, run, i, st = await stop_ctx(cb)
    if not run or st["status"] or "typed" not in st:
        return await cb.answer()
    engine.pay_amount(st, cb.from_user.id, st.pop("typed"))
    store.log(run_id, cb.from_user.id, "amount", stop=st["name"], cash=st["status"]["cash"])
    await cb.answer("Записано")
    await back_to_list(cb, run_id, run)


@router.callback_query(F.data.startswith("r:no:"))
async def cb_no(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if run:
        await cb.answer()
        await show(cb, *ui.screen_reasons(st, i))


@router.callback_query(F.data.startswith("r:rs:"))
async def cb_reason(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run or st["status"]:
        return await cb.answer()
    reason = parts(cb)[3]
    if reason not in engine.REASONS:
        return await cb.answer()
    if reason in engine.LEAVE and engine.debt_due(st) > 0.5 and engine.riding(st):
        st["why"] = reason                                   # щоб після дзвінка менеджеру записати саме цю причину
        store.save(run_id, run)
        await cb.answer()
        return await show(cb, *ui.screen_block(st, i))      # боржник: спершу дзвінок менеджеру
    engine.mark_none(st, cb.from_user.id, reason, left=reason != "closed")
    store.log(run_id, cb.from_user.id, "none", stop=st["name"], reason=reason)
    await cb.answer("Записано")
    await back_to_list(cb, run_id, run)


@router.callback_query(F.data.startswith(("r:al:", "r:dn:")))
async def cb_block(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run or st["status"]:
        return await cb.answer()
    allowed = parts(cb)[1] == "al"
    reason = st.pop("why", "nomoney")
    reason = reason if reason in engine.LEAVE else "nomoney"
    engine.mark_none(st, cb.from_user.id, reason, left=allowed)
    st["status"]["text"] = engine.REASONS[reason] + " · " + ("менеджер дозволив залишити" if allowed else "товар не залишив")
    store.log(run_id, cb.from_user.id, "debtor", stop=st["name"], manager=st["manager"], left=allowed)
    await cb.answer("Записано")
    await back_to_list(cb, run_id, run)


@router.callback_query(F.data.startswith("r:cl:"))
async def cb_call(cb: CallbackQuery, bot: Bot):
    """r:cl:{точка} — перший менеджер точки; r:cl:{точка}:{k} — k-й зі списку менеджерів."""
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    p, names = parts(cb), engine.managers(st)
    k = int(p[3]) if len(p) > 3 and p[3].isdigit() else 0
    who = names[k] if k < len(names) else ""
    ph = store.phone(who) if who else None
    if not ph:
        who = who or "менеджера не вказано"
        return await cb.answer(f"Телефону ще немає: {who}.\nВласник додає його, переславши боту контакт.",
                               show_alert=True)
    await cb.answer()
    name = who.split()
    sent(await bot.send_contact(cb.message.chat.id, phone_number=ph, first_name=name[-1] if name else "Менеджер",
                                last_name=name[0] if len(name) > 1 else None))


# ---------- проблема з товаром ----------

@router.callback_query(F.data.startswith("r:pr:"))
async def cb_problem(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if run:
        await cb.answer()
        await show(cb, *ui.screen_problem(st, i))


@router.callback_query(F.data.startswith(("r:pk:", "r:pg:")))
async def cb_items(cb: CallbackQuery):
    """Рішення власника 26.11: повернення й відмова — списком. Позначаєш кілька позицій, потім «Готово»."""
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    p = parts(cb)
    try:
        await load_items(st)
    except onec.OneCError as e:
        return await cb.answer(f"Не вдалося прочитати накладну: {e}", show_alert=True)
    if p[1] == "pk":
        st["psel"] = {}
    store.save(run_id, run)
    await cb.answer()
    await show_list(cb, st, i, p[3], int(p[4]) if p[1] == "pg" else 0)


async def show_list(cb, st, i, kind, page):
    await show(cb, *ui.screen_items(st, i, kind, [tuple(x) for x in st.get("items") or []], page,
                                    st.get("psel") or {}))


def find_item(st, ii, li):
    for x in st.get("items") or []:
        if x[0] == ii and x[1] == li:
            return x
    return None


@router.callback_query(F.data.startswith("r:pi:"))
async def cb_item(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    p = parts(cb)
    it = find_item(st, int(p[4]), int(p[5]))
    if not it:
        return await cb.answer("Позицію не знайдено", show_alert=True)
    page = int(p[6]) if len(p) > 6 else 0
    sel = st.setdefault("psel", {})
    k = f"{it[0]}:{it[1]}"
    await cb.answer()
    if len(p) > 7 and p[7] == "q" and it[3] > 1:     # олівець: не всі штуки
        return await show(cb, *ui.screen_qty(st, i, p[3], it[0], it[1], it[2], it[3], page, k in sel))
    if k in sel:                                     # дотик ставить у список усю кількість або знімає
        sel.pop(k)
    else:
        sel[k] = it[3]
    store.save(run_id, run)
    await show_list(cb, st, i, p[3], page)


@router.callback_query(F.data.startswith("r:pq:"))
async def cb_qty(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    p = parts(cb)
    it = find_item(st, int(p[4]), int(p[5]))
    if not it:
        return await cb.answer("Позицію не знайдено", show_alert=True)
    sel = st.setdefault("psel", {})
    k = f"{it[0]}:{it[1]}"
    if p[6] == "x":
        sel.pop(k, None)
    else:
        sel[k] = min(float(p[6]), it[3])
    store.save(run_id, run)
    await cb.answer()
    await show_list(cb, st, i, p[3], int(p[7]) if len(p) > 7 else 0)


@router.callback_query(F.data.startswith("r:pa:"))
async def cb_all(cb: CallbackQuery):
    """Позначити всі позиції повною кількістю або зняти всі."""
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    allk = {f"{x[0]}:{x[1]}": x[3] for x in st.get("items") or []}
    st["psel"] = {} if set(st.get("psel") or {}) == set(allk) else allk
    store.save(run_id, run)
    await cb.answer()
    await show_list(cb, st, i, parts(cb)[3], 0)


@router.callback_query(F.data.startswith("r:po:"))
async def cb_other(cb: CallbackQuery):
    """Рішення власника 26.11: «Інший товар» — без пошуку позиції, сума не змінюється."""
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    kind = parts(cb)[3]
    if kind not in engine.OTHER_KINDS or st["status"]:
        return await cb.answer("Не вийшло — відкрий точку заново", show_alert=True)
    engine.add_other(st, kind)
    store.log(run_id, cb.from_user.id, "problem", stop=st["name"], inv="—", kind=kind, item=engine.OTHER_ITEM,
              qty=0, cut=0)
    store.save(run_id, run)
    await cb.answer("Записано: інший товар. Склад і менеджер розберуться")
    await show(cb, *card(run, i))


@router.callback_query(F.data.startswith("r:px:"))
async def cb_done(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    kind, sel = parts(cb)[3], st.get("psel") or {}
    if not sel or kind not in engine.PROBLEMS:
        return await cb.answer("Нічого не позначено", show_alert=True)
    n = 0
    for k, qty in list(sel.items()):
        ii, li = map(int, k.split(":"))
        it = find_item(st, ii, li)
        if it:
            apply_one(cb.from_user.id, run_id, st, kind, it, qty)
            n += 1
    st["psel"] = {}
    store.save(run_id, run)
    await cb.answer(f"Записано позицій: {n}")
    await show(cb, *card(run, i))


def apply_one(uid, run_id, st, kind, it, qty):
    """Записує одну позицію. Якщо повернули частину, залишок лишається в списку на своєму місці."""
    inv = st["inv"][it[0]]
    qty = min(qty, it[3])
    cut = engine.add_problem(st, inv["ref"], kind, it[2], qty, it[4])
    left = round(it[3] - qty, 3)
    rest = [it[0], it[1], it[2], left, it[4]]
    st["items"] = [(rest if x[0] == it[0] and x[1] == it[1] else x) for x in st["items"]
                   if left > 0 or not (x[0] == it[0] and x[1] == it[1])]
    store.log(run_id, uid, "problem", stop=st["name"], inv=inv["no"], kind=kind, item=it[2], qty=qty, cut=cut)
    return cut


# ---------- витрата і здача каси ----------

@router.callback_query(F.data == "r:ex")
async def cb_expense(cb: CallbackQuery, state: FSMContext):
    run_id, run = await ctx(cb)
    if not run:
        return
    await cb.answer()
    set_scr(run, cb.message.chat.id, cb.message.message_id)
    store.save(run_id, run)
    await state.set_state(Reys.expense)
    await show(cb, "💸 <b>Витрата з каси рейсу</b>\nНова пошта чи інше, що оплатив із зібраних грошей.\n"
                   "Напиши суму цифрами.", [[("← До списку", "r:l")]])


@router.message(Reys.expense, F.text)
async def msg_expense(m: Message, state: FSMContext, bot: Bot):
    run_id, run = store.open_run(m.from_user.id)
    try:
        await m.delete()
    except TelegramBadRequest:
        pass
    if not run:
        return await state.clear()
    v = parse_money(m.text)
    if v is None:
        return await reshow(bot, m.chat.id, run, "Потрібне число, наприклад 683,50.", [[("← До списку", "r:l")]])
    run["expenses"].append({"kind": "Нова пошта", "sum": v, "ts": store.now()})
    store.log(run_id, m.from_user.id, "expense", sum=v)
    await state.clear()
    await reshow(bot, m.chat.id, run, *ui.screen_list(run, run.get("show_done", False)))
    store.save(run_id, run)


@router.callback_query(F.data == "r:cz")
async def cb_close(cb: CallbackQuery):
    run_id, run = await ctx(cb)
    if run:
        await cb.answer()
        await show(cb, *ui.screen_close(run))


@router.callback_query(F.data == "r:hd")
async def cb_hand(cb: CallbackQuery):
    run_id, run = await ctx(cb)
    if not run or engine.open_stops(run):
        return await cb.answer()
    run["closed"] = True
    store.log(run_id, cb.from_user.id, "close", **{k: v for k, v in engine.totals(run).items() if k != "why"})
    store.close(run_id, run)
    await cb.answer("Касу здано")
    # екран рейсу замінюється одним підсумком — стрічка не росте
    await show(cb, ui.report(run, cb.from_user.full_name), [])


@router.errors(ExceptionTypeFilter(store.Stale))
async def on_stale(event: ErrorEvent):
    """Двоє з екіпажу натиснули одночасно: другий запис відхилено, щоб не затерти перший."""
    cb = event.update.callback_query
    if cb:
        try:
            await cb.answer("Напарник щойно щось відмітив. Відкрий список і повтори.", show_alert=True)
        except TelegramBadRequest:
            pass
    return True
