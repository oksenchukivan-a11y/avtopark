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
        CREATE TABLE IF NOT EXISTS reys_screen(tg_id INTEGER PRIMARY KEY, chat_id INTEGER, msg_id INTEGER);
        """)


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
        r = c.execute("SELECT phone FROM reys_phones WHERE name=?", (name,)).fetchone()
    return r["phone"] if r else None


def set_phone(name, phone_no):
    with db() as c:
        c.execute("INSERT INTO reys_phones(name, phone) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET phone=excluded.phone",
                  (name, phone_no))


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
