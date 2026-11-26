"""Збереження рейсу в базі бота (ті самі reports.db, окремі таблиці з префіксом reys_)."""
import json
import os
import sqlite3
from datetime import datetime

DB_PATH = os.environ.get("DB_PATH", "reports.db")   # справжній шлях передає setup()


def db():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS reys_runs(
            id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id INTEGER NOT NULL, sheet_ref TEXT, day TEXT,
            status TEXT DEFAULT 'open', data TEXT NOT NULL, created_at TEXT, closed_at TEXT);
        CREATE TABLE IF NOT EXISTS reys_events(
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, ts TEXT, tg_id INTEGER,
            action TEXT, payload TEXT);
        CREATE TABLE IF NOT EXISTS reys_phones(name TEXT PRIMARY KEY, phone TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reys_dirs(name TEXT PRIMARY KEY, dir TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reys_assign(sheet_ref TEXT PRIMARY KEY, tg_id INTEGER NOT NULL, by_id INTEGER, ts TEXT);
        CREATE TABLE IF NOT EXISTS reys_people(tg_id INTEGER PRIMARY KEY, name TEXT, seen TEXT);
        CREATE TABLE IF NOT EXISTS reys_screen(tg_id INTEGER PRIMARY KEY, chat_id INTEGER, msg_id INTEGER);
        """)
        _rekey(c, "reys_phones", "phone")
        _rekey(c, "reys_dirs", "dir")


def key(name: str) -> str:
    """Ім'я менеджера як ключ: без зайвих пробілів і без різниці великих-малих літер.
    У 1С імена пишуть по-різному («Прізвище  Ім'я », з подвійним пробілом чи пробілом у кінці)."""
    return " ".join((name or "").split()).casefold()


def _rekey(c, table, col):
    """Старі записи під «сирими» іменами переводимо під нормалізований ключ."""
    for r in c.execute(f"SELECT name, {col} FROM {table}").fetchall():
        k = key(r["name"])
        if k != r["name"]:
            c.execute(f"DELETE FROM {table} WHERE name=?", (r["name"],))
            if k:
                c.execute(f"INSERT OR IGNORE INTO {table}(name, {col}) VALUES(?,?)", (k, r[col]))


def now():
    return datetime.now().isoformat(timespec="seconds")


def open_run(tg_id):
    with db() as c:
        r = c.execute("SELECT id, data FROM reys_runs WHERE tg_id=? AND status='open' ORDER BY id DESC LIMIT 1",
                      (tg_id,)).fetchone()
    return (r["id"], json.loads(r["data"])) if r else (None, None)


def create(tg_id, run):
    with db() as c:
        c.execute("UPDATE reys_runs SET status='dropped', closed_at=? WHERE tg_id=? AND status='open'", (now(), tg_id))
        cur = c.execute("INSERT INTO reys_runs(tg_id, sheet_ref, day, data, created_at) VALUES(?,?,?,?,?)",
                        (tg_id, run["sheet_ref"], run["day"], json.dumps(run, ensure_ascii=False), now()))
        return cur.lastrowid


def save(run_id, run):
    with db() as c:
        c.execute("UPDATE reys_runs SET data=? WHERE id=?", (json.dumps(run, ensure_ascii=False), run_id))


def close(run_id, run):
    with db() as c:
        c.execute("UPDATE reys_runs SET status='closed', closed_at=?, data=? WHERE id=?",
                  (now(), json.dumps(run, ensure_ascii=False), run_id))


def log(run_id, tg_id, action, **payload):
    """Журнал: хто, коли і що натиснув. Нічого не стирається, навіть після «Виправити»."""
    with db() as c:
        c.execute("INSERT INTO reys_events(run_id, ts, tg_id, action, payload) VALUES(?,?,?,?,?)",
                  (run_id, now(), tg_id, action, json.dumps(payload, ensure_ascii=False)))


def phone(name):
    with db() as c:
        r = c.execute("SELECT phone FROM reys_phones WHERE name=?", (key(name),)).fetchone()
    return r["phone"] if r else None


def set_phone(name, phone_no):
    with db() as c:
        c.execute("INSERT INTO reys_phones(name, phone) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET phone=excluded.phone",
                  (key(name), phone_no))


def screen(tg_id):
    """Повідомлення з кнопкою «Відкрити рейс» — єдине, що модуль тримає в чаті."""
    with db() as c:
        r = c.execute("SELECT chat_id, msg_id FROM reys_screen WHERE tg_id=?", (tg_id,)).fetchone()
    return (r["chat_id"], r["msg_id"]) if r else (None, None)


def set_screen(tg_id, chat_id, msg_id):
    with db() as c:
        if msg_id is None:
            c.execute("DELETE FROM reys_screen WHERE tg_id=?", (tg_id,))
        else:
            c.execute("INSERT INTO reys_screen(tg_id, chat_id, msg_id) VALUES(?,?,?) ON CONFLICT(tg_id) "
                      "DO UPDATE SET chat_id=excluded.chat_id, msg_id=excluded.msg_id", (tg_id, chat_id, msg_id))


def direction(name):
    """Напрямок менеджера («манікюр», «волосся») — налаштування в базі, не в коді."""
    with db() as c:
        r = c.execute("SELECT dir FROM reys_dirs WHERE name=?", (key(name),)).fetchone()
    return r["dir"] if r else ""


def set_direction(name, value):
    with db() as c:
        if value:
            c.execute("INSERT INTO reys_dirs(name, dir) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET dir=excluded.dir",
                      (key(name), value))
        else:
            c.execute("DELETE FROM reys_dirs WHERE name=?", (key(name),))


def people():
    """{ключ імені: (телефон, напрямок)} одним запитом — щоб екран рейсу не ходив у базу за кожною точкою."""
    out = {}
    with db() as c:
        for r in c.execute("SELECT name, phone FROM reys_phones"):
            out[r["name"]] = (r["phone"], "")
        for r in c.execute("SELECT name, dir FROM reys_dirs"):
            out[r["name"]] = (out.get(r["name"], ("", ""))[0], r["dir"])
    return out


# ---------- чия путівка ----------
# У 1С у путівці немає ні водія, ні маршруту, тому «чия вона» знає тільки той, хто її роздає.

def assign(sheet_ref, tg_id, by_id):
    """Закріплює путівку за водієм. tg_id = 0 — зняти."""
    with db() as c:
        if tg_id:
            c.execute("INSERT INTO reys_assign(sheet_ref, tg_id, by_id, ts) VALUES(?,?,?,?) ON CONFLICT(sheet_ref) "
                      "DO UPDATE SET tg_id=excluded.tg_id, by_id=excluded.by_id, ts=excluded.ts",
                      (sheet_ref, int(tg_id), by_id, now()))
        else:
            c.execute("DELETE FROM reys_assign WHERE sheet_ref=?", (sheet_ref,))


def assigned(sheet_ref):
    with db() as c:
        r = c.execute("SELECT tg_id FROM reys_assign WHERE sheet_ref=?", (sheet_ref,)).fetchone()
    return r["tg_id"] if r else None


def assignments():
    with db() as c:
        return {r["sheet_ref"]: r["tg_id"] for r in c.execute("SELECT sheet_ref, tg_id FROM reys_assign")}


def taken_by(sheet_ref, not_uid):
    """Хто інший уже відкрив або здав цю путівку (покинуті рейси не рахуються)."""
    with db() as c:
        r = c.execute("SELECT tg_id FROM reys_runs WHERE sheet_ref=? AND tg_id<>? AND status IN ('open','closed') "
                      "ORDER BY id DESC LIMIT 1", (sheet_ref, not_uid)).fetchone()
    return r["tg_id"] if r else None


def saw(tg_id, name):
    """Запам'ятовує ім'я людини з Telegram — щоб власник закріплював путівку за іменем, а не за номером."""
    with db() as c:
        c.execute("INSERT INTO reys_people(tg_id, name, seen) VALUES(?,?,?) ON CONFLICT(tg_id) "
                  "DO UPDATE SET name=excluded.name, seen=excluded.seen", (tg_id, name or str(tg_id), now()))


def known_people():
    with db() as c:
        return {r["tg_id"]: r["name"] for r in c.execute("SELECT tg_id, name FROM reys_people")}
