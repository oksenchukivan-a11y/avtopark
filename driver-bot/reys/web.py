"""Застосунок рейсу всередині Telegram: маленький веб-сервер у тому самому процесі, що й бот.

Сторінка сама даних не містить. Кожен запит несе підпис Telegram (initData); сервер перевіряє його
ключем бота і пускає тільки тестувальників. Слухає лише локальну адресу — назовні його віддає Caddy.
"""
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

from . import build, engine, onec, store, ui, view
from . import handlers as hd

log = logging.getLogger("reys.web")
MAX_AGE = 36 * 3600          # застосунок можуть тримати відкритим увесь рейс
STATE = {"bot": None, "runner": None, "secret": b""}
PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.html")


HITS: dict = {}              # хто скільки запитів зробив за останню хвилину
RATE = 90                    # запитів на людину за хвилину; рейс стільки не потребує


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
    return own or common or (9, 18)


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


async def menu(day=None):
    """Що можна відкрити: путівки з 1С за день, знімки, демо."""
    day = day or hd.today()
    sheets, note = [], ""
    if onec.configured():
        try:
            sheets = [{"id": "1c:" + s["Ref_Key"], "title": f"Путівка {s['Date'][11:16]} · № {s['Number'].lstrip('0')}"}
                      for s in await hd.list_sheets(day)]
            if not sheets:
                note = f"За {day:%d.%m} путівок у 1С ще немає."
        except onec.OneCError as e:
            note = f"1С не відповідає: {e}"
    sheets += [{"id": "sn:" + stem, "title": title} for stem, title in hd.snapshots()]
    return {"sheets": sheets, "note": note}


async def a_state(uid, a):
    run_id, run = store.open_run(uid)
    return {} if run else {"menu": await menu()}


async def a_menu(uid, a):
    return {"menu": await menu()}


async def a_start(uid, a):
    what = str(a.get("id", ""))
    if what == "demo":
        run = build.demo_run(hd.today())
    elif what.startswith("sn:"):
        run = hd.load_snapshot(what[3:])
    elif what.startswith("1c:") and re.fullmatch(r"[0-9a-f-]{36}", what[3:]):
        run = await hd.load_run(what[3:])
    else:
        raise Bad("Не знаю такої путівки")
    run_id = store.create(uid, run)
    store.log(run_id, uid, "start", sheet=run["sheet_no"], stops=len(engine.route(run)), via="app")
    return {}


async def a_open(uid, a):
    run_id, run = _run(uid)
    st = _stop(run, a)
    if st["debts"] is None:
        await hd.load_debts(st)
        store.save(run_id, run)
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
    debtor = reason == "nomoney" and engine.debt_due(st) > 0.5 and bool(engine.riding(st))
    if debtor:
        if not isinstance(left, bool):
            raise Bad("У клієнта борг: спершу набери менеджера")
        engine.mark_none(st, uid, reason, left=left)
        st["status"]["text"] = "нема грошей · " + ("менеджер дозволив залишити" if left else "товар не залишив")
        store.log(run_id, uid, "debtor", stop=st["name"], manager=st["manager"], left=left)
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
    items = await hd.load_items(st)
    store.save(run_id, run)
    return {"items": [{"ii": x[0], "li": x[1], "name": x[2], "qty": x[3], "price": x[4]} for x in items]}


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
    picked = [_one_problem(st, kind, r) for r in rows]
    if len({(it[0], it[1]) for it, _ in picked}) != len(picked):
        raise Bad("Позиція позначена двічі")
    for it, qty in picked:
        hd.apply_one(uid, run_id, st, kind, it, qty)
    st.pop("psel", None)
    store.save(run_id, run)
    return {"n": len(picked)}


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


async def a_close(uid, a, who=""):
    run_id, run = _run(uid)
    if engine.open_stops(run):
        raise Bad("Ще є точки без відмітки")
    run["closed"] = True
    t = engine.totals(run)
    store.log(run_id, uid, "close", **{k: v for k, v in t.items() if k != "why"})
    store.close(run_id, run)
    await after_close(uid, run, who)
    return {"done": {"hand": t["hand"], "cash": t["cash"], "spent": t["spent"], "unpaid": t["unpaid"],
                     "title": view.run_view(run)["title"]}, "run": None}


async def after_close(uid, run, who):
    """Чат чиститься: кнопку рейсу прибираємо. Підсумок іде касиру, а не водієві."""
    bot = STATE["bot"]
    if not bot:
        return
    chat_id, msg_id = store.screen(uid)
    if msg_id:
        try:
            await bot.delete_message(chat_id, msg_id)
        except Exception as e:                      # повідомлення могли стерти руками — це не біда
            log.info("reys: кнопку рейсу не прибрано: %s", e)
        store.set_screen(uid, None, None)
    for cid in hd.ids_from_env("REYS_CASHIER"):
        try:
            await bot.send_message(cid, ui.report(run, who), parse_mode="HTML")
        except Exception as e:
            log.warning("reys: підсумок касиру %s не надіслано: %s", cid, e)


ACTIONS = {"state": a_state, "menu": a_menu, "start": a_start, "open": a_open,
           "all": _quick(engine.pay_all, "all"), "today": _quick(engine.pay_today, "tod"),
           "given": _quick(engine.mark_given, "gv"), "pick": a_pick, "amount": a_amount, "none": a_none,
           "fix": a_fix, "items": a_items, "problem": a_problem, "expense": a_expense,
           "expense_del": a_expense_del, "close": a_close}


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
        return _json({"ok": False, "msg": "Відкрий рейс кнопкою в боті"}, 401)
    uid, name = who
    if uid not in hd.TESTERS:
        return _json({"ok": False, "msg": "Рейс для тебе ще не ввімкнено"}, 403)
    if too_fast(uid):
        log.warning("reys: забагато запитів від %s", uid)
        return _json({"ok": False, "msg": "Забагато запитів. Зачекай хвилину."}, 429)
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
    except onec.OneCError as e:
        out = {"ok": False, "msg": f"1С: {e}"}
    except Exception:
        log.exception("reys: дія %s", act)
        out = {"ok": False, "msg": "Щось пішло не так. Спробуй ще раз."}
    out.setdefault("ok", True)
    if "run" not in out:
        run_id, run = store.open_run(uid)
        out["run"] = view.run_view(run) if run else None
    out["cfg"] = {"call": os.environ.get("REYS_CALL", "link")}
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
        log.info("reys: застосунок слухає %s:%s (%s)", host, port, datetime.now().isoformat(timespec="seconds"))
    except Exception:
        log.exception("reys: застосунок не запустився — рейс працює кнопками в чаті")
        if runner:
            try:
                await runner.cleanup()
            except Exception:
                pass


async def stop():
    runner, STATE["runner"] = STATE["runner"], None
    if runner:
        try:
            await runner.cleanup()
        except Exception:
            log.exception("reys: зупинка застосунку")


def ready() -> bool:
    return bool(url() and STATE["runner"])
