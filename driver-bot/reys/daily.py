"""«Звіт за день» усередині рейсу (рішення власника 27.11): те, що водій щовечора вводив окремою анкетою,
збирається під час здачі каси. Авто вибирає на старті; ящики, пошту й стан авто — перед здачею;
точки, штуки й кілометри рахуються самі. Екіпаж із двох ділить ящики, точки й штуки навпіл.

Поки йде звірка зі старим звітом, усе пишеться в окрему таблицю reys_daily і зарплату не зачіпає.
У таблицю старого звіту рядок піде лише з прапорцем REYS_TO_REPORTS=1 — функцією, яку дає сам бот."""
import asyncio
import inspect
import json
import logging
import os
from datetime import datetime

from . import engine, onec, store

log = logging.getLogger("reys")
VEHICLES: dict = {}          # {код авто: назва} — дає бот у setup(); без цього звіту за день у рейсі немає
KM_FOR = None                # функція бота: (коди авто, день) → (км, деталі) або None
TO_REPORTS = None            # функція бота: (рядок-словник) — запис у таблицю старого звіту
ON_PHOTO = None              # функція бота: (bot, tg_id, file_id, авто, опис) — фото пошкодження
PARCELS = None               # функція бота: (день) → [{supplier, ttn, places}] — посилки, які мають прийти поштою
TASKS: set = set()
REAL = "Document_РеализацияТоваровУслуг"
FIELDS = ("run_id", "tg_id", "day", "sheet_ref", "route", "vehicle", "boxes", "points", "pieces", "boxes_received",
          "boxes_sent", "vehicle_ok", "damage_vehicle", "damage_desc", "damage_photo", "hours_fact", "km", "km_detail",
          "share", "km_owner", "full_boxes", "full_points", "full_pieces", "started_at", "closed_at", "test", "src",
          "sent", "sent_mode", "ts")


def enabled() -> bool:
    return bool(VEHICLES) and os.environ.get("REYS_DAILY", "1") != "0"


def init():
    with store.db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS reys_daily(
            run_id INTEGER NOT NULL, tg_id INTEGER NOT NULL, day TEXT, sheet_ref TEXT, route TEXT, vehicle TEXT,
            boxes REAL, points REAL, pieces REAL, boxes_received REAL, boxes_sent REAL DEFAULT 0,
            vehicle_ok INTEGER, damage_vehicle TEXT, damage_desc TEXT, damage_photo TEXT,
            hours_fact REAL, km REAL, km_detail TEXT, share REAL, km_owner INTEGER,
            full_boxes REAL, full_points REAL, full_pieces REAL, started_at TEXT, closed_at TEXT,
            test INTEGER DEFAULT 0, src TEXT DEFAULT 'reys', sent INTEGER DEFAULT 0, sent_mode TEXT, ts TEXT,
            UNIQUE(run_id, tg_id));
        CREATE TABLE IF NOT EXISTS reys_photo_wait(tg_id INTEGER PRIMARY KEY, run_id INTEGER, ts TEXT);
        """)
        if "sent_mode" not in {r["name"] for r in c.execute("PRAGMA table_info(reys_daily)")}:
            c.execute("ALTER TABLE reys_daily ADD COLUMN sent_mode TEXT")


def vehicles_view():
    return [{"code": k, "name": v} for k, v in VEHICLES.items()]


def set_vehicles(run, codes):
    """Авто рейсу: усі, на яких їздив за день, у порядку вибору (пересів — додав). Міняти можна будь-коли до здачі каси.
    Повертає список або кидає ValueError з текстом для водія."""
    if not isinstance(codes, list):
        raise ValueError("Вибери авто")
    picked = [c for c in codes if isinstance(c, str) and c in VEHICLES]
    if not picked or len(picked) != len(codes) or len(set(picked)) != len(picked):   # чуже авто чи те саме двічі
        raise ValueError("Вибери авто зі списку")
    if len(picked) > 4:
        raise ValueError("Забагато авто на один день")
    run["vehicles"] = picked
    return picked


def set_post(run, sent, received):
    """Пошта за день: скільки ящиків відправив і скільки отримав. Вводиться будь-коли в рейсі, останнє число — чинне."""
    run["post"] = {"sent": _count(sent or 0, "Відправив", 3000), "received": _count(received or 0, "Отримав", 3000)}
    return run["post"]


async def expected(day):
    """Посилки, які сьогодні мають прийти (з бланків замовлень постачальникам) — якщо бот уміє їх дати."""
    if not PARCELS:
        return []
    try:
        got = await asyncio.wait_for(_call(PARCELS, day), 6)
        return [{"supplier": str(p.get("supplier", ""))[:60], "ttn": str(p.get("ttn", ""))[:30],
                 "places": int(p.get("places") or 0)} for p in (got or []) if isinstance(p, dict)][:30]
    except Exception as e:                                         # джерело мовчить — пошта вводиться як завжди
        log.warning("reys: очікувані посилки не взято: %s", e)
        return []


def _count(v, name, top):
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        raise ValueError(f"{name}: потрібне число") from None
    if not 0 <= n <= top:
        raise ValueError(f"{name}: число від 0 до {top}")
    return n


def check(run, d):
    """Перевіряє «Звіт за день» перед здачею каси. Повертає чистий словник або кидає ValueError з текстом для водія."""
    cars = run.get("vehicles") or []
    if not cars:
        raise ValueError("Спершу вибери авто")
    if not isinstance(d, dict) or d.get("boxes") in (None, ""):
        raise ValueError("Скільки ящиків розвіз?")
    was = run.get("post") or {}                                    # пошту могли ввести ще в дорозі — на закритті підтверджують
    pick = lambda k: d.get(k) if d.get(k) not in (None, "") else was.get(k, 0)      # noqa: E731
    out = {"boxes": _count(d.get("boxes"), "Ящики", 3000), "sent": _count(pick("sent"), "Відправив", 3000),
           "received": _count(pick("received"), "Отримав", 3000)}
    if d.get("ok") is True:
        return dict(out, ok=True, damage_vehicle="", damage_desc="")
    if d.get("ok") is not False:
        raise ValueError("Авто в порядку чи є пошкодження?")
    desc = " ".join(str(d.get("desc") or "").split())[:500]
    car = d.get("car") if d.get("car") in cars else (cars[0] if len(cars) == 1 else "")
    if not car:
        raise ValueError("Яке авто пошкоджено?")
    if len(desc) < 3:
        raise ValueError("Опиши пошкодження кількома словами")
    return dict(out, ok=False, damage_vehicle=car, damage_desc=desc)


def write(run_id, run, team, test):
    """Рядок на кожного з екіпажу. Швидко й без мережі — штуки та кілометри дописуються слідом (enrich)."""
    d, share = run["daily"], round(1 / len(team), 4)
    started, closed = store.run_times(run_id)
    try:
        hours = round((datetime.fromisoformat(closed) - datetime.fromisoformat(started)).total_seconds() / 3600, 1)
    except (TypeError, ValueError):
        hours = None
    points = sum(1 for s in run["stops"] if s.get("status"))       # усі точки з відміткою, і борги поруч теж
    route = "Навчальний рейс" if run.get("demo") else (run.get("title") or f"Путівка {run.get('sheet_no', '')}".strip())
    rows = []
    for n, t in enumerate(team):
        rows.append(dict(
            run_id=run_id, tg_id=t, day=run.get("day", ""), sheet_ref=run.get("sheet_ref", ""), route=route,
            vehicle=",".join(run.get("vehicles") or []), boxes=round(d["boxes"] * share, 2),
            points=round(points * share, 2), pieces=None, boxes_received=round(d["received"] * share, 2),
            boxes_sent=round(d["sent"] * share, 2),
            vehicle_ok=1 if d["ok"] else 0, damage_vehicle=d["damage_vehicle"], damage_desc=d["damage_desc"],
            damage_photo=None, hours_fact=hours, km=None, km_detail=None, share=share, km_owner=1 if n == 0 else 0,
            full_boxes=d["boxes"], full_points=points, full_pieces=None, started_at=started, closed_at=closed,
            test=1 if test else 0, src="reys", sent=0, sent_mode=None, ts=store.now()))
    with store.db() as c:
        c.executemany(f"INSERT OR REPLACE INTO reys_daily({', '.join(FIELDS)}) VALUES({', '.join('?' * len(FIELDS))})",
                      [tuple(r[f] for f in FIELDS) for r in rows])
    return rows


def rows(day=None, run_id=None):
    """Рядки звіту: за день (для вечірньої звірки зі старим звітом) або за рейс."""
    with store.db() as c:
        if run_id is not None:
            got = c.execute("SELECT * FROM reys_daily WHERE run_id=? ORDER BY km_owner DESC, tg_id", (run_id,))
        else:
            got = c.execute("SELECT * FROM reys_daily WHERE day=? ORDER BY run_id, km_owner DESC", (str(day),))
        return [dict(r) for r in got]


async def pieces(run):
    """Скільки штук товару доставлено: кількість із накладних, що їхали й лишились у клієнта,
    мінус те, чого не вистачило або від чого клієнт відмовився. None — 1С не відповіла."""
    refs, minus = set(), 0.0
    for s in run["stops"]:
        st = s.get("status")
        if not st or st.get("kind") == "back" or s["key"].startswith("demo"):
            continue
        refs |= {i["ref"] for i in engine.riding(s)}
        minus += sum(p.get("qty") or 0 for p in s.get("probs", []) if p["kind"] in ("miss", "refuse"))
    if not refs or not onec.configured():
        return None
    docs = await onec.by_keys(REAL, refs, "Ref_Key,Товары", n=8)   # накладні з рядками важкі: по 30 1С обрізає відповідь
    total = sum(x.get("Количество") or 0 for d in docs for x in d.get("Товары") or [])
    return max(0.0, round(total - minus, 2))


async def _call(fn, *a):
    out = fn(*a)
    return await out if inspect.isawaitable(out) else out


async def enrich(run_id, run):
    """Після здачі каси, вже без водія: штуки з 1С, кілометри з GPS, і — якщо ввімкнено — запис у старий звіт."""
    try:
        n = await pieces(run)
    except Exception as e:                                         # 1С мовчить — звіт лишається без штук
        log.warning("reys: штуки з 1С не взято: %s", e)
        n = None
    km = None
    if KM_FOR and run.get("vehicles"):
        try:
            km = await _call(KM_FOR, list(run["vehicles"]), run.get("day", ""))
        except Exception as e:
            log.warning("reys: кілометри не взято: %s", e)
    with store.db() as c:
        if n is not None:
            c.execute("UPDATE reys_daily SET full_pieces=?, pieces=ROUND(? * share, 2) WHERE run_id=?", (n, n, run_id))
        if km:
            detail = km[1] if isinstance(km[1], str) else json.dumps(km[1], ensure_ascii=False)
            c.execute("UPDATE reys_daily SET km=?, km_detail=? WHERE run_id=?", (km[0], detail, run_id))
    if os.environ.get("REYS_TO_REPORTS") == "1" and TO_REPORTS:
        for r in rows(run_id=run_id):
            if r["test"] or r["sent"]:
                continue                                           # навчальні й пробні рейси в зарплату не йдуть ніколи
            try:
                # бот відповідає: 'written' — записав у старий звіт; 'checked' — водій уже заповнив його сам, лише звірено;
                # нічого — не надіслано, рядок лишається з sent=0
                how = await _call(TO_REPORTS, dict(r))
                if how:
                    with store.db() as c:
                        c.execute("UPDATE reys_daily SET sent=1, sent_mode=? WHERE run_id=? AND tg_id=?",
                                  (str(how)[:20], run_id, r["tg_id"]))
                else:
                    log.warning("reys: старий звіт рядок не прийняв (рейс %s, водій %s)", run_id, r["tg_id"])
            except Exception:
                log.exception("reys: рядок звіту за день не записано (рейс %s, водій %s)", run_id, r["tg_id"])


def start_enrich(run_id, run):
    task = asyncio.get_running_loop().create_task(enrich(run_id, run))
    TASKS.add(task)
    task.add_done_callback(TASKS.discard)
    return task


async def drain():
    """Дочекатись фонових дописів (для перевірок)."""
    while TASKS:
        await asyncio.gather(*list(TASKS), return_exceptions=True)


# ---------- фото пошкодження ----------

def wait_photo(tg_id, run_id):
    with store.db() as c:
        c.execute("INSERT OR REPLACE INTO reys_photo_wait(tg_id, run_id, ts) VALUES(?,?,?)", (tg_id, run_id, store.now()))


def photo_wait(tg_id, max_hours=12):
    """Рейс, для якого від цієї людини чекаємо фото пошкодження (None — не чекаємо)."""
    with store.db() as c:
        r = c.execute("SELECT run_id, ts FROM reys_photo_wait WHERE tg_id=?", (tg_id,)).fetchone()
    if not r or (datetime.now() - datetime.fromisoformat(r["ts"])).total_seconds() > max_hours * 3600:
        return None
    return r["run_id"]


def set_photo(tg_id, run_id, file_id):
    with store.db() as c:
        c.execute("UPDATE reys_daily SET damage_photo=? WHERE run_id=?", (file_id, run_id))
        c.execute("DELETE FROM reys_photo_wait WHERE tg_id=? OR run_id=?", (tg_id, run_id))
