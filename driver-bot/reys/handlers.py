"""Склейка з Telegram (aiogram 3). Один екран на рейс: повідомлення переписується, стрічка не росте."""
import json
import logging
import os
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message

from . import build, engine, onec, store, ui

log = logging.getLogger("reys")
TZ = ZoneInfo("Europe/Kyiv")
router = Router(name="reys")
TESTERS: set = set()
REG = "AccumulationRegister_ВзаиморасчетыСКонтрагентамиПоДокументамРасчетов"
REAL = "Document_РеализацияТоваровУслуг"


class Reys(StatesGroup):
    amount = State()
    expense = State()


def setup(dp, admin_id: int = 0, db_path: str = ""):
    """Викликати один раз у main() ПЕРЕД підключенням основного роутера бота."""
    if db_path:
        store.DB_PATH = db_path
    ids = {int(x) for x in os.environ.get("REYS_TESTERS", "").replace(" ", "").split(",") if x.isdigit()}
    if admin_id:
        ids.add(int(admin_id))
    TESTERS.clear()
    TESTERS.update(ids)
    store.init()
    router.message.filter(F.from_user.id.in_(TESTERS))
    router.callback_query.filter(F.from_user.id.in_(TESTERS))
    dp.include_router(router)
    log.info("reys: модуль увімкнено для %d тестувальників", len(TESTERS))


def today() -> date:
    return datetime.now(TZ).date()


def markup(rows):
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows])


async def show(cb: CallbackQuery, text, rows):
    try:
        await cb.message.edit_text(text, reply_markup=markup(rows), parse_mode="HTML")
    except TelegramBadRequest as e:
        if "not modified" not in str(e):
            raise


async def reshow(bot: Bot, chat_id, run, text, rows):
    """Після введеного з клавіатури числа переписуємо той самий екран, а не шлемо новий."""
    mid = run.get("screen")
    if mid:
        try:
            await bot.edit_message_text(text, chat_id=chat_id, message_id=mid, reply_markup=markup(rows),
                                        parse_mode="HTML")
            return
        except TelegramBadRequest:
            pass
    m = await bot.send_message(chat_id, text, reply_markup=markup(rows), parse_mode="HTML")
    run["screen"] = m.message_id


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
    run.update(expenses=[], closed=False, snap=True)
    return run


# ---------- завантаження з 1С ----------

async def list_sheets(day: date):
    d0 = day.isoformat()
    return await onec.call("query", object="Document_ПутевойЛист", select="Ref_Key,Number,Date",
                           filter=f"Date ge datetime'{d0}T00:00:00' and Date le datetime'{d0}T23:59:59'",
                           orderby="Date", top=20)


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
    names = {r["Ref_Key"]: r["Description"]
             for r in await onec.by_keys("Catalog_Контрагенты", wanted, "Ref_Key,Description")}
    agents = {r["Ref_Key"]: r["Description"] for r in await onec.by_keys(
        "Catalog_ФизическиеЛица", {i.get("Агент_Key") for i in invoices}, "Ref_Key,Description")}
    day = datetime.fromisoformat(sheet["Date"][:19])
    since = (day - timedelta(days=10)).date().isoformat()
    orders = await onec.by_keys(
        "Document_ЗаказПокупателя", with_inv, "Date,Комментарий,СуммаДокумента,Контрагент_Key",
        field="Контрагент_Key",
        extra=f"Date ge datetime'{since}T00:00:00' and Date le datetime'{sheet['Date'][:19]}' and Posted eq true")
    return build.build_run(sheet, invoices, names, agents, orders)


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
        docs = await onec.by_keys(REAL, owed, "Ref_Key,Number,Date") if owed else []
        st["debts"] = [{"ref": d["Ref_Key"], "no": build.short_no(d["Number"]), "date": d["Date"][:10],
                        "sum": round(owed[d["Ref_Key"]], 2)} for d in docs]
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
    rows = []
    if run:
        rows.append([("▶️ Продовжити рейс", "r:l")])
    text = "🧾 <b>Рейс</b> (пробний режим — бачиш тільки ти)\n"
    if onec.configured():
        try:
            day = datetime.strptime(arg + f".{today().year}", "%d.%m.%Y").date() if arg else today()
            sheets = await list_sheets(day)
            text += f"Путівки за {day:%d.%m}:" if sheets else f"За {day:%d.%m} путівок у 1С ще немає."
            rows += [[(f"Путівка {s['Date'][11:16]} · №{s['Number'].lstrip('0')}", f"r:ld1:{s['Ref_Key']}")]
                     for s in sheets]
        except ValueError:
            text += "Дата не розпізнана. Приклад: /reys 24.11"
        except onec.OneCError as e:
            text += f"1С не відповідає: {e}"
    snaps = snapshots()
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
        await m.answer("Приклад: /reys_tel Петренко Олена 0501234567\nІм'я — як у 1С, у картці точки.")
        return
    store.set_phone(parts[0].strip(), "+38" + digits[-10:])
    await m.answer(f"Записав: {parts[0].strip()} — +38{digits[-10:]}")


async def ctx(cb: CallbackQuery):
    run_id, run = store.open_run(cb.from_user.id)
    if not run:
        await cb.answer("Рейс не відкрито. Напиши /reys", show_alert=True)
    return run_id, run


async def start_run(cb: CallbackQuery, run):
    run["screen"] = cb.message.message_id
    run_id = store.create(cb.from_user.id, run)
    store.log(run_id, cb.from_user.id, "start", sheet=run["sheet_no"], stops=len(engine.route(run)))
    await show(cb, *ui.screen_list(run))


@router.callback_query(F.data == "r:demo")
async def cb_demo(cb: CallbackQuery):
    await cb.answer()
    await start_run(cb, build.demo_run(today()))


@router.callback_query(F.data.startswith("r:sn:"))
async def cb_snapshot(cb: CallbackQuery):
    try:
        run = load_snapshot(cb.data.split(":", 2)[2])
    except onec.OneCError as e:
        return await cb.answer(str(e)[:190], show_alert=True)
    await cb.answer()
    await start_run(cb, run)


@router.callback_query(F.data.startswith("r:ld1:"))
async def cb_load(cb: CallbackQuery):
    await cb.answer("Читаю путівку з 1С…")
    try:
        run = await load_run(cb.data.split(":", 2)[2])
    except onec.OneCError as e:
        await cb.message.answer(f"Не вдалося прочитати путівку: {e}")
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
    run["screen"] = cb.message.message_id
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


async def stop_ctx(cb: CallbackQuery):
    run_id, run = await ctx(cb)
    if not run:
        return None, None, None, None
    i = int(parts(cb)[2])
    if i >= len(run["stops"]):
        await cb.answer("Список змінився, відкрий рейс заново: /reys", show_alert=True)
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
    await show(cb, *ui.screen_card(st, i))


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
    await show(cb, *ui.screen_card(st, i))


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
        run["screen"] = cb.message.message_id
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
    if reason == "nomoney" and engine.debt_due(st) > 0.5 and engine.riding(st):
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
    engine.mark_none(st, cb.from_user.id, "nomoney", left=allowed)
    st["status"]["text"] = "нема грошей · " + ("менеджер дозволив залишити" if allowed else "товар не залишив")
    store.log(run_id, cb.from_user.id, "debtor", stop=st["name"], manager=st["manager"], left=allowed)
    await cb.answer("Записано")
    await back_to_list(cb, run_id, run)


@router.callback_query(F.data.startswith("r:cl:"))
async def cb_call(cb: CallbackQuery, bot: Bot):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    ph = store.phone(st["manager"]) if st["manager"] else None
    if not ph:
        who = st["manager"] or "менеджера не вказано"
        return await cb.answer(f"Телефону ще немає: {who}.\nДодати: /reys_tel {who} 050…", show_alert=True)
    await cb.answer()
    name = st["manager"].split()
    await bot.send_contact(cb.message.chat.id, phone_number=ph, first_name=name[-1] if name else "Менеджер",
                           last_name=name[0] if len(name) > 1 else None)


# ---------- проблема з товаром ----------

@router.callback_query(F.data.startswith("r:pr:"))
async def cb_problem(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if run:
        await cb.answer()
        await show(cb, *ui.screen_problem(st, i))


@router.callback_query(F.data.startswith(("r:pk:", "r:pg:")))
async def cb_items(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    p = parts(cb)
    try:
        items = await load_items(st)
    except onec.OneCError as e:
        return await cb.answer(f"Не вдалося прочитати накладну: {e}", show_alert=True)
    store.save(run_id, run)
    await cb.answer()
    await show(cb, *ui.screen_items(st, i, p[3], [tuple(x) for x in items], int(p[4]) if p[1] == "pg" else 0))


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
    await cb.answer()
    if it[3] <= 1:
        return await apply_problem(cb, run_id, run, i, st, p[3], it, 1)
    await show(cb, *ui.screen_qty(st, i, p[3], it[0], it[1], it[2], it[3]))


@router.callback_query(F.data.startswith("r:pq:"))
async def cb_qty(cb: CallbackQuery):
    run_id, run, i, st = await stop_ctx(cb)
    if not run:
        return
    p = parts(cb)
    it = find_item(st, int(p[4]), int(p[5]))
    if it:
        await cb.answer()
        await apply_problem(cb, run_id, run, i, st, p[3], it, float(p[6]))


async def apply_problem(cb, run_id, run, i, st, kind, it, qty):
    inv = st["inv"][it[0]]
    cut = engine.add_problem(st, inv["ref"], kind, it[2], qty, it[4])
    st["items"] = [x for x in st["items"] if not (x[0] == it[0] and x[1] == it[1])]
    store.log(run_id, cb.from_user.id, "problem", stop=st["name"], inv=inv["no"], kind=kind, item=it[2],
              qty=qty, cut=cut)
    store.save(run_id, run)
    await show(cb, *ui.screen_card(st, i))


# ---------- витрата і здача каси ----------

@router.callback_query(F.data == "r:ex")
async def cb_expense(cb: CallbackQuery, state: FSMContext):
    run_id, run = await ctx(cb)
    if not run:
        return
    await cb.answer()
    run["screen"] = cb.message.message_id
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
