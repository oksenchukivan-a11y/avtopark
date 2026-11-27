"""Застосунок рейсу всередині Telegram: маленький веб-сервер у тому самому процесі, що й бот.

Сторінка сама даних не містить. Кожен запит несе підпис Telegram (initData); сервер перевіряє його
ключем бота і пускає тільки тестувальників. Слухає лише локальну адресу — назовні його віддає Caddy.
"""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import time
from datetime import datetime
from urllib.parse import parse_qsl

from aiohttp import web

from . import build, daily, engine, onec, store, tail, ui, view
from . import handlers as hd

log = logging.getLogger("reys.web")
MAX_AGE = 36 * 3600          # застосунок можуть тримати відкритим увесь рейс
STATE = {"bot": None, "runner": None, "secret": b"", "tail": None}
PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.html")


SHEETS: dict = {}            # список путівок дня з 1С: {день: (коли прочитано, рядки)}
SHEETS_TTL = 60              # секунд: меню відкривають часто, а нова путівка з'являється двічі на день
HITS: dict = {}              # хто скільки запитів зробив за останню хвилину
RATE = 40                    # запитів на людину за хвилину: на точку йде 2–6 запитів, швидше ніж точка за 10 с не буває


def hours(uid=None):
    """Робочі години з REYS_HOURS. Формат як у сторожа бота: «9-18» для всіх або свій графік
    кожному — «111=8-17,222=9-19»; можна й разом: «9-18,111=8-17». Не розібралось — 9–18."""
    common, own = None, None
    for part in os.environ.get("REYS_HOURS", "").split(","):
        m = re.fullmatch(r"\s*(?:(\d+)\s*=)?\s*(\d{1,2})\s*-\s*(\d{1,2})\s*", part)
        if not m or not 0 <= int(m.group(2)) < int(m.group(3)) <= 24:
            continue
        span = (int(m.group(2)), int(m.group(3)))
        if m.group(1) is None:
            common = span
        elif uid is not None and int(m.group(1)) == uid:
            own = span
    if own or common:
        return own or common
    try:                                    # графік дня тижня веде бот (рання обласна — з 5–7 ранку)
        from reys_hours import day_hours
        a, b = day_hours()
        return (int(a), int(b)) if 0 <= int(a) < int(b) <= 24 else (9, 18)
    except Exception:
        return 9, 18


def working(uid, now: datetime = None) -> bool:
    if uid == hd.ADMIN:
        return True
    a, b = hours(uid)
    return a <= (now or datetime.now(hd.TZ)).hour < b


def too_fast(uid, now: float = None) -> bool:
    now = now or time.time()
    q = [t for t in HITS.get(uid, []) if now - t < 60]
    q.append(now)
    HITS[uid] = q
    return len(q) > RATE


class Bad(Exception):
    """Помилка, яку показуємо людині як є."""


def url() -> str:
    return os.environ.get("REYS_WEB_URL", "").strip()


def launch_url() -> str:
    """Адреса для кнопки: з міткою версії сторінки, щоб Telegram не відкривав застарілу копію."""
    try:
        v = int(os.path.getmtime(PAGE))
    except OSError:
        v = 0
    return url() + ("&" if "?" in url() else "?") + f"v={v}"


def secret_for(token: str) -> bytes:
    return hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()


def check_init(init: str, secret: bytes, now: float = None):
    """Перевіряє підпис Telegram. Повертає (id, ім'я) або None."""
    if not init or not secret or len(init) > 4096:
        return None
    pairs = dict(parse_qsl(init, keep_blank_values=True))
    got = pairs.pop("hash", "")
    line = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    want = hmac.new(secret, line.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, got):
        return None
    try:
        if abs((now or time.time()) - int(pairs.get("auth_date", "0"))) > MAX_AGE:
            return None
        user = json.loads(pairs.get("user", "{}"))
        return int(user["id"]), " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x)
    except (ValueError, KeyError, TypeError):
        return None


# ---------- дії ----------

def _run(uid):
    run_id, run = store.open_run(uid)
    if not run:
        raise Bad("Рейс не відкрито")
    return run_id, run


def _put(run_id, run, a, field):
    """Те, що прочитали з 1С, дописуємо у свіжу копію рейсу: поки чекали, напарник міг відмітити точку."""
    i = int(a.get("i"))
    fresh = store.get(run_id)
    if fresh and i < len(fresh["stops"]) and fresh["stops"][i].get(field) is None:
        fresh["stops"][i][field] = run["stops"][i][field]
        store.save(run_id, fresh)


def _stop(run, a, free=False):
    try:
        i = int(a.get("i"))
        st = run["stops"][i] if i >= 0 else None
    except (TypeError, ValueError, IndexError):
        st = None
    if st is None:
        raise Bad("Список змінився, відкрий рейс заново")
    if free and st["status"]:
        raise Bad("Точку вже відмічено")
    return st


def _money(v):
    try:
        v = round(float(str(v).replace(" ", "").replace(" ", "").replace(",", ".")), 2)
    except ValueError:
        v = 0
    if not 0 < v < 1_000_000:
        raise Bad("Потрібна сума цифрами, наприклад 2500")
    return v


async def day_sheets(day, quick=False):
    """Путівки дня. Щоб меню не чекало 1С на кожен дотик: хвилину віддаємо прочитане,
    а коли власник складає екіпаж (quick) — прочитане будь-якої давності."""
    at, rows = SHEETS.get(day, (0, None))
    if rows is None or not (quick or time.time() - at < SHEETS_TTL):
        rows = await hd.list_sheets(day)
        SHEETS.clear()
        SHEETS[day] = (time.time(), rows)
    return rows


async def menu(uid, day=None, quick=False):
    """Що ця людина може відкрити. Власник бачить усі путівки дня і складає екіпаж (один-двоє водіїв);
    водій — тільки ті, де він в екіпажі. Знімки — лише власникові, навчальний рейс — усім."""
    day = day or hd.today()
    admin = uid == hd.ADMIN
    sheets, note = [], ""
    names, own, done = store.known_people(), store.crews(), store.closed_refs(ignore=hd.trial_ids())
    if onec.configured():
        try:
            seen = []
            for s in await day_sheets(day, quick):
                team = own.get(s["Ref_Key"], [])
                if admin or (uid in team and s["Ref_Key"] not in done):   # здану путівку водієві вже не показуємо
                    seen.append((s, team))
            labels = await asyncio.gather(*(hd.sheet_label(s) for s, _ in seen))   # назви — разом, а не по черзі
            for (s, team), (name, sub) in zip(seen, labels):
                ref = s["Ref_Key"]
                row = {"id": "1c:" + ref, "title": name, "sub": sub,
                       "mates": [names.get(t, str(t)) for t in team if t != uid]}    # з ким їдеш
                if admin:
                    row.update(crew=team, who=" + ".join(names.get(t, str(t)) for t in team), done=ref in done)
                sheets.append(row)
            if not sheets:
                note = f"За {day:%d.%m} путівок у 1С ще немає." if admin else "Путівку за тобою ще не закріплено."
        except onec.OneCError as e:
            note = f"1С не відповідає: {e}"
    if admin:
        sheets += [{"id": "sn:" + stem, "title": title} for stem, title in hd.snapshots()]
    run_id, run = store.open_run(uid)
    out = {"sheets": sheets, "note": note, "locked": bool(run and engine.has_marks(run) and not admin)}
    if admin:
        out["people"] = [{"id": t, "name": names.get(t, str(t))} for t in sorted(hd.TESTERS) if t != hd.ADMIN]
        out["crew_max"] = hd.CREW_MAX
    return out


async def a_state(uid, a):
    run_id, run = store.open_run(uid)
    return {} if run else {"menu": await menu(uid)}


async def a_menu(uid, a):
    return {"menu": await menu(uid)}


async def a_assign(uid, a):
    """Власник складає екіпаж путівки: to — водій, on — додати чи зняти (to = 0 — зняти всіх).
    У екіпажі один або двоє; рейс і каса в них спільні, а ящики автозвіт ділить навпіл."""
    what, on = str(a.get("id", "")), a.get("on", True)
    try:
        to = int(a.get("to") or 0)
    except (TypeError, ValueError):
        to = -1
    if uid != hd.ADMIN or not what.startswith("1c:") or not re.fullmatch(r"[0-9a-f-]{36}", what[3:]):
        raise Bad("Закріплювати путівки може тільки власник")
    ref = what[3:]
    team = store.crew(ref)
    if to and on is not False:                                    # додати в екіпаж
        if to not in hd.TESTERS or to == hd.ADMIN:
            raise Bad("Такої людини в списку рейсу немає")
        if to not in team:
            if len(team) >= hd.CREW_MAX:
                raise Bad("В екіпажі вже двоє. Спершу зніми когось.")
            if store.taken_by(ref, set(team) | {to} | hd.trial_ids()):
                raise Bad("Цю путівку вже відкрив інший водій")
            store.crew_add(ref, to, uid)
    else:                                                         # зняти одного або всіх
        gone = [to] if to else list(team)
        rid, by, run = store.sheet_run(ref)
        if rid and engine.has_marks(run) and set(gone) & set(team):
            raise Bad("Рейс уже в роботі: у ньому є відмітки. Екіпаж зміниш після здачі каси.")
        if rid and by in gone:
            store.drop(rid)                                       # порожній рейс знятого водія більше нічий
        for t in gone:
            store.crew_del(ref, t)
    hd.act(uid, f"assign:{to}")
    return {"menu": await menu(uid, quick=True)}


async def a_start(uid, a):
    what, admin = str(a.get("id", "")), uid == hd.ADMIN
    if what == "demo":
        run = build.demo_run(hd.today())
    elif what.startswith("sn:") and admin:
        run = hd.load_snapshot(what[3:])
    elif what.startswith("1c:") and re.fullmatch(r"[0-9a-f-]{36}", what[3:]):
        if not hd.may_open(uid, what[3:]):                 # перевіряємо до 1С: чужу путівку навіть не читаємо
            raise Bad("Цю путівку за тобою не закріплено")
        if not admin and store.sheet_run(what[3:])[0]:     # напарник уже відкрив — у 1С вдруге не ходимо
            try:
                if hd.guard_start(uid, {"sheet_ref": what[3:]}):
                    return {}
            except hd.Refused as e:
                raise Bad(str(e)) from None
        run = await hd.load_run(what[3:])
    else:
        raise Bad("Не знаю такої путівки")
    try:
        if hd.guard_start(uid, run, force=a.get("force") is True):
            return {}                                       # цей рейс уже відкрито — нічого не скидаємо
    except hd.Refused as e:
        raise Bad(str(e)) from None
    run_id = store.create(uid, run)
    store.log(run_id, uid, "start", sheet=run["sheet_no"], stops=len(engine.route(run)), via="app")
    return {}


async def a_open(uid, a):
    run_id, run = _run(uid)
    st = _stop(run, a)
    if st["debts"] is None:
        await hd.load_debts(st)
        if st["debts"] is not None:
            _put(run_id, run, a, "debts")
    return {}


def _quick(fn, name):
    async def act(uid, a):
        run_id, run = _run(uid)
        st = _stop(run, a, free=True)
        fn(st, uid)
        store.log(run_id, uid, name, stop=st["name"], cash=st["status"]["cash"])
        store.save(run_id, run)
        return {}
    return act


async def a_pick(uid, a):
    run_id, run = _run(uid)
    st = _stop(run, a, free=True)
    pay = engine.payable(st)
    try:
        ks = sorted({int(k) for k in a.get("ks") or []})
    except (TypeError, ValueError):
        ks = []
    if not ks or ks[0] < 0 or ks[-1] >= len(pay):
        raise Bad("Вибери хоча б одну накладну")
    engine.pay(st, uid, [(pay[k]["ref"], pay[k]["sum"]) for k in ks], note="окремі накладні")
    store.log(run_id, uid, "part", stop=st["name"], cash=st["status"]["cash"])
    store.save(run_id, run)
    return {}


async def a_amount(uid, a):
    run_id, run = _run(uid)
    st = _stop(run, a, free=True)
    engine.pay_amount(st, uid, _money(a.get("sum")))
    store.log(run_id, uid, "amount", stop=st["name"], cash=st["status"]["cash"])
    store.save(run_id, run)
    return {}


async def a_none(uid, a):
    run_id, run = _run(uid)
    st = _stop(run, a, free=True)
    reason, left = a.get("reason"), a.get("left")
    if reason not in engine.REASONS:
        raise Bad("Вибери причину")
    debtor = reason in engine.LEAVE and engine.debt_due(st) > 0.5 and bool(engine.riding(st))
    if debtor:
        if not isinstance(left, bool):
            raise Bad("У клієнта борг: спершу набери менеджера")
        engine.mark_none(st, uid, reason, left=left)
        st["status"]["text"] = engine.REASONS[reason] + " · " + ("менеджер дозволив залишити" if left else "товар не залишив")
        store.log(run_id, uid, "debtor", stop=st["name"], manager=", ".join(engine.debt_managers(st)), left=left)
    else:
        engine.mark_none(st, uid, reason, left=reason != "closed")
        store.log(run_id, uid, "none", stop=st["name"], reason=reason)
    store.save(run_id, run)
    return {}


async def a_fix(uid, a):
    run_id, run = _run(uid)
    st = _stop(run, a)
    store.log(run_id, uid, "fix", stop=st["name"], was=st["status"])
    st["status"] = None
    store.save(run_id, run)
    return {}


async def a_items(uid, a):
    run_id, run = _run(uid)
    st = _stop(run, a)
    if not engine.riding(st):
        raise Bad("У цій точці сьогодні немає накладних")
    fresh = st.get("items") is None
    items = await hd.load_items(st)
    if fresh:
        _put(run_id, run, a, "items")
    return {"items": [{"ii": x[0], "li": x[1], "name": x[2], "qty": x[3], "price": x[4],
                       "no": st["inv"][x[0]]["no"], "mgr": engine.clean(st["inv"][x[0]].get("manager", ""))}
                      for x in items]}


def _one_problem(st, kind, row):
    try:
        it = hd.find_item(st, int(row.get("ii")), int(row.get("li")))
        qty = float(row.get("qty"))
    except (TypeError, ValueError, AttributeError):
        it, qty = None, 0
    if not it or not 0 < qty <= it[3]:
        raise Bad("Позицію не знайдено. Відкрий список заново.")
    return it, qty


async def a_problem(uid, a):
    """Одна позиція або список (rows) — список записується весь або не записується зовсім."""
    run_id, run = _run(uid)
    st = _stop(run, a, free=True)
    kind = a.get("kind")
    rows = a.get("rows") if isinstance(a.get("rows"), list) else [a]
    if kind not in engine.PROBLEMS or not rows or len(rows) > 200:
        raise Bad("Нічого не позначено")
    if not engine.riding(st):
        raise Bad("У цій точці сьогодні немає накладних")
    picked = [_one_problem(st, kind, r) for r in rows]
    if len({(it[0], it[1]) for it, _ in picked}) != len(picked):
        raise Bad("Позиція позначена двічі")
    for it, qty in picked:
        hd.apply_one(uid, run_id, st, kind, it, qty)
    st.pop("psel", None)
    store.save(run_id, run)
    return {"n": len(picked)}


async def a_other(uid, a):
    """Рішення власника 26.11: «Інший товар» без пошуку — сума не змінюється."""
    run_id, run = _run(uid)
    st = _stop(run, a, free=True)
    kind = a.get("kind")
    if kind not in engine.OTHER_KINDS:
        raise Bad("Тут інший товар не записується")
    if not engine.riding(st):
        raise Bad("У цій точці сьогодні немає накладних")
    engine.add_other(st, kind)
    store.log(run_id, uid, "problem", stop=st["name"], inv="—", kind=kind, item=engine.OTHER_ITEM, qty=0, cut=0)
    store.save(run_id, run)
    return {}


async def a_expense(uid, a):
    run_id, run = _run(uid)
    kind = str(a.get("kind") or "Нова пошта")[:30]
    v = _money(a.get("sum"))
    run["expenses"].append({"kind": kind, "sum": v, "ts": store.now()})
    store.log(run_id, uid, "expense", sum=v, kind=kind)
    store.save(run_id, run)
    return {}


async def a_expense_del(uid, a):
    run_id, run = _run(uid)
    try:
        gone = run["expenses"].pop(int(a.get("k")))
    except (TypeError, ValueError, IndexError):
        raise Bad("Витрату не знайдено") from None
    store.log(run_id, uid, "expense_del", **gone)
    store.save(run_id, run)
    return {}


async def a_vehicle(uid, a):
    """Яким авто їде рейс (одне чи кілька). Одне на весь екіпаж; можна змінити до здачі каси."""
    run_id, run = _run(uid)
    if not daily.enabled():
        raise Bad("Вибір авто ще не ввімкнено")
    was = list(run.get("vehicles") or [])
    try:
        cars = daily.set_vehicles(run, a.get("codes"))
    except ValueError as e:
        raise Bad(str(e)) from None
    if cars != was:
        store.log(run_id, uid, "vehicle", cars=cars, was=was)     # кожна пересадка лишається в журналі
        store.save(run_id, run)
    return {}


async def a_post(uid, a):
    """Пошта: відправив і отримав — будь-коли в рейсі (зранку або в кінці маршруту). Кожне введення — в журнал."""
    run_id, run = _run(uid)
    if not daily.enabled():
        raise Bad("Пошту ще не ввімкнено")
    was = dict(run.get("post") or {})
    try:
        now = daily.set_post(run, a.get("sent"), a.get("received"))
    except ValueError as e:
        raise Bad(str(e)) from None
    store.log(run_id, uid, "post", was=was, **now)
    store.save(run_id, run)
    return {}


async def a_parcels(uid, a):
    """Що сьогодні має прийти поштою — підказка над полем «Отримав»."""
    run_id, run = _run(uid)
    return {"parcels": await daily.expected(run.get("day", ""))}


async def a_close(uid, a, who=""):
    run_id, run = _run(uid)
    if engine.open_stops(run):
        raise Bad("Ще є точки без відмітки")
    if daily.enabled():                                  # «Звіт за день» здається разом із касою
        try:
            run["daily"] = daily.check(run, a.get("daily"))
        except ValueError as e:
            raise Bad(str(e)) from None
    run["closed"] = True
    t = engine.totals(run)
    store.log(run_id, uid, "close", **{k: v for k, v in t.items() if k != "why"})
    store.close(run_id, run)
    if run.get("daily"):
        try:                                             # каса вже здана — збій звіту її не скасовує
            test = bool(run.get("demo") or run.get("snap") or uid in hd.trial_ids())
            daily.write(run_id, run, team_of(uid, run), test)
            store.log(run_id, uid, "daily", **run["daily"])
            daily.start_enrich(run_id, run)              # штуки з 1С і кілометри — слідом, водій не чекає
            if not run["daily"]["ok"]:
                daily.wait_photo(uid, run_id)
        except Exception:
            log.exception("reys: звіт за день не записано (рейс %s)", run_id)
    await after_close(uid, run, who)
    v = view.run_view(run)
    return {"done": {"hand": t["hand"], "cash": t["cash"], "spent": t["spent"], "unpaid": t["unpaid"],
                     "title": v["title"], "crew": v["crew"]}, "run": None}


async def mgr_preview(bot, uid, run, who):
    """Звіт кожному менеджеру по його клієнтах. Менеджерам не шлемо, доки власник не скаже «запускай»."""
    try:
        from . import mgr_report
        reps = mgr_report.build(run, view.run_view(run).get("title", ""), who)
        if not reps or not hd.ADMIN:
            return
        hd.sent(await bot.send_message(hd.ADMIN, f"👁 <b>Приклад: так після рейсу отримають менеджери</b> · {len(reps)}",
                                       parse_mode="HTML"))
        for text in reps.values():
            hd.sent(await bot.send_message(hd.ADMIN, text, parse_mode="HTML"))
    except Exception as ex:
        log.warning("reys: звіт менеджерам не зібрано: %s", ex)


def team_of(uid, run):
    """Хто їхав цим рейсом: екіпаж путівки, якщо той, хто здає касу, в ньому; інакше він сам."""
    team = [] if run.get("demo") or run.get("snap") else store.crew(run.get("sheet_ref", ""))
    return team if uid in team else [uid]


async def after_close(uid, run, who):
    """Чат чиститься: кнопку рейсу прибираємо в усього екіпажу. Підсумок іде касиру, а не водієві."""
    bot = STATE["bot"]
    if not bot:
        return
    team, names = team_of(uid, run), store.known_people()
    for t in team:
        chat_id, msg_id = store.screen(t)
        if msg_id:
            try:
                await bot.delete_message(chat_id, msg_id)
            except Exception as e:                      # повідомлення могли стерти руками — це не біда
                log.info("reys: кнопку рейсу не прибрано: %s", e)
            store.set_screen(t, None, None)
    name = " + ".join(names.get(t) or (who if t == uid else str(t)) for t in team)
    d = run.get("daily") or {}
    if d and not d["ok"]:                                # фото пошкодження — у чаті, як у старому звіті
        try:
            car = daily.VEHICLES.get(d["damage_vehicle"], d["damage_vehicle"])
            hd.sent(await bot.send_message(uid, f"📷 <b>Надішли сюди фото пошкодження</b>\n{car}: {d['damage_desc']}",
                                           parse_mode="HTML"))
        except Exception as e:
            log.warning("reys: прохання про фото не надіслано: %s", e)
    if not run.get("demo") or uid == hd.ADMIN:        # рішення власника 27.11: звіт менеджерам — поки приклад лише йому
        await mgr_preview(bot, uid, run, name)
        try:                                          # 27.11: помилки збору — по комірниках (поки приклад власникові)
            from . import wh_report
            wh = await wh_report.collect(run, view.run_view(run).get("title", ""), name, trial=uid in hd.trial_ids())
            if wh and hd.ADMIN:
                hd.sent(await bot.send_message(hd.ADMIN, wh, parse_mode="HTML"))
        except Exception as ex:
            log.warning("reys: звіт складу не зібрано: %s", ex)
    if run.get("demo"):                              # навчальний рейс нікому не звітує
        return
    if tail.enabled() and run.get("tailable") and hd.ADMIN and uid not in hd.trial_ids():
        async def left():                            # що з міських накладних дня лишилось на складі — уже без водія
            try:
                text = await tail.left_behind(run, ignore=hd.trial_ids())
                if text:
                    hd.sent(await bot.send_message(hd.ADMIN, text, parse_mode="HTML"))
            except Exception as e:
                log.warning("reys: звірка складу не надіслана: %s", e)
        task = asyncio.get_running_loop().create_task(left())
        daily.TASKS.add(task)
        task.add_done_callback(daily.TASKS.discard)
    # Підсумок справжнього рейсу має хтось отримати. Касира не вписано — отримує власник.
    to = hd.ids_from_env("REYS_CASHIER") or ({hd.ADMIN} if hd.ADMIN else set())
    for cid in to - {uid}:
        try:
            await bot.send_message(cid, ui.report(run, name), parse_mode="HTML")
        except Exception as e:
            log.warning("reys: підсумок рейсу %s не надіслано: %s", cid, e)


ACTIONS = {"state": a_state, "menu": a_menu, "start": a_start, "assign": a_assign, "open": a_open,
           "all": _quick(engine.pay_all, "all"), "today": _quick(engine.pay_today, "tod"),
           "given": _quick(engine.mark_given, "gv"), "pick": a_pick, "amount": a_amount, "none": a_none,
           "fix": a_fix, "items": a_items, "problem": a_problem, "other": a_other, "expense": a_expense,
           "expense_del": a_expense_del, "close": a_close, "vehicle": a_vehicle,
           "post": a_post, "parcels": a_parcels}


# ---------- веб ----------

def _json(data, status=200):
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"},
                             dumps=lambda o: json.dumps(o, ensure_ascii=False))


async def api(request: web.Request):
    try:
        body = await request.json()
        act, args = body.get("act"), body.get("args") or {}
        init = body.get("init") or ""
    except (ValueError, AttributeError):
        return _json({"ok": False, "msg": "Запит не розібрано"}, 400)
    who = check_init(init, STATE["secret"])
    if not who:
        hd.act(0, "401")                                   # без підпису — теж видно сторожу бота
        return _json({"ok": False, "msg": "Відкрий рейс кнопкою в боті"}, 401)
    uid, name = who
    if uid not in hd.TESTERS:
        hd.act(uid, "403")
        return _json({"ok": False, "msg": "Рейс для тебе ще не ввімкнено"}, 403)
    if too_fast(uid):
        log.warning("reys: забагато запитів від %s", uid)
        hd.act(uid, "429")
        return _json({"ok": False, "msg": "Забагато запитів. Зачекай хвилину."}, 429)
    hd.act(uid, f"app:{act}")
    store.saw(uid, name)
    if not working(uid):
        a, b = hours(uid)
        return _json({"ok": False, "shut": True, "msg": f"Бот працює з {a}:00 до {b}:00"})
    fn = ACTIONS.get(act)
    if not fn or not isinstance(args, dict):
        return _json({"ok": False, "msg": "Невідома дія"}, 400)
    try:
        out = await (fn(uid, args, name) if act == "close" else fn(uid, args))
    except Bad as e:
        out = {"ok": False, "msg": str(e)}
    except store.Stale:                                    # напарник відмітив раніше — показуємо свіжий рейс
        out = {"ok": False, "msg": "Напарник щойно щось відмітив. Глянь список і повтори."}
    except onec.OneCError as e:
        out = {"ok": False, "msg": f"1С: {e}"}
    except Exception:
        log.exception("reys: дія %s", act)
        out = {"ok": False, "msg": "Щось пішло не так. Спробуй ще раз."}
    out.setdefault("ok", True)
    if "run" not in out:
        run_id, run = store.open_run(uid)
        out["run"] = view.run_view(run) if run else None
    out["cfg"] = {"call": os.environ.get("REYS_CALL", "link"), "daily": daily.enabled(),
                  "vehicles": daily.vehicles_view() if daily.enabled() else []}
    return _json(out)


async def page(request: web.Request):
    with open(PAGE, encoding="utf-8") as f:
        return web.Response(text=f.read(), content_type="text/html", headers={
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"})


async def dial(request: web.Request):
    """Запасний шлях дзвінка: сторінка у звичайному браузері, яка одразу відкриває набір номера."""
    n = request.match_info["n"]
    if not re.fullmatch(r"\d{10,12}", n):
        raise web.HTTPNotFound()
    html = (f'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            f'<title>Дзвінок</title><body style="font:20px system-ui;text-align:center;padding:40px 16px">'
            f'<a href="tel:+{n}" style="display:block;padding:20px;border-radius:14px;background:#1c8a4b;'
            f'color:#fff;font-weight:700;text-decoration:none">📞 +{n}</a>'
            f'<script>location.href="tel:+{n}"</script>')
    return web.Response(text=html, content_type="text/html", headers={"Cache-Control": "no-store"})


def make_app() -> web.Application:
    app = web.Application(client_max_size=64 * 1024)
    app.router.add_get("/", page)
    app.router.add_post("/api", api)
    app.router.add_get("/t/{n}", dial)
    return app


async def start(bot):
    """Викликається під час запуску бота. Що б тут не зламалось, бот має працювати далі."""
    runner = None
    try:
        if STATE["runner"]:
            return
        if not url():
            log.info("reys: REYS_WEB_URL не задано — застосунок вимкнено, рейс працює кнопками в чаті")
            return
        STATE.update(bot=bot, secret=secret_for(bot.token))
        runner = web.AppRunner(make_app(), access_log=None)
        await runner.setup()
        host, port = os.environ.get("REYS_WEB_HOST", "127.0.0.1"), int(os.environ.get("REYS_WEB_PORT", "8087"))
        await web.TCPSite(runner, host, port).start()
        STATE["runner"] = runner
        if tail.enabled() and not STATE["tail"]:               # дозамовлення в місто, поки рейс відкритий
            STATE["tail"] = asyncio.get_running_loop().create_task(tail.watch(bot))
        log.info("reys: застосунок слухає %s:%s (%s)", host, port, datetime.now().isoformat(timespec="seconds"))
    except Exception:
        log.exception("reys: застосунок не запустився — рейс працює кнопками в чаті")
        if runner:
            try:
                await runner.cleanup()
            except Exception:
                pass


async def stop():
    task, STATE["tail"] = STATE["tail"], None
    if task:
        task.cancel()
    runner, STATE["runner"] = STATE["runner"], None
    if runner:
        try:
            await runner.cleanup()
        except Exception:
            log.exception("reys: зупинка застосунку")


def ready() -> bool:
    return bool(url() and STATE["runner"])
