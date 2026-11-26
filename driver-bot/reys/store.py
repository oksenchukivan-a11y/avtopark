"""Збереження рейсу в базі бота (ті самі reports.db, окремі таблиці з префіксом reys_)."""
import json
import os
import sqlite3
from datetime import datetime

from . import engine

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
        CREATE TABLE IF NOT EXISTS reys_crew(sheet_ref TEXT NOT NULL, tg_id INTEGER NOT NULL, by_id INTEGER, ts TEXT,
            PRIMARY KEY(sheet_ref, tg_id));
        CREATE TABLE IF NOT EXISTS reys_people(tg_id INTEGER PRIMARY KEY, name TEXT, seen TEXT);
        CREATE TABLE IF NOT EXISTS reys_titles(sheet_ref TEXT PRIMARY KEY, title TEXT, points INTEGER, ts TEXT);
        CREATE TABLE IF NOT EXISTS reys_screen(tg_id INTEGER PRIMARY KEY, chat_id INTEGER, msg_id INTEGER);
        """)
        if "ver" not in {r["name"] for r in c.execute("PRAGMA table_info(reys_runs)")}:
            c.execute("ALTER TABLE reys_runs ADD COLUMN ver INTEGER DEFAULT 0")
        if "fixed" not in {r["name"] for r in c.execute("PRAGMA table_info(reys_people)")}:
            c.execute("ALTER TABLE reys_people ADD COLUMN fixed INTEGER DEFAULT 0")
        # було «одна путівка — один водій»; тепер екіпаж з одного-двох. Старі закріплення переносимо один раз.
        c.execute("INSERT OR IGNORE INTO reys_crew(sheet_ref, tg_id, by_id, ts) SELECT sheet_ref, tg_id, by_id, ts FROM reys_assign")
        c.execute("DELETE FROM reys_assign")
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


class Stale(Exception):
    """Рейс змінили, поки ми тримали стару копію (напарник відмітив точку). Запис відхилено, щоб не затерти його відмітку."""


def _load(r):
    """Рейс із рядка бази. Номер версії їде разом з рейсом — за ним save() бачить, що копія застаріла."""
    run = json.loads(r["data"])
    run["_ver"] = r["ver"] or 0
    return run


def _dump(run):
    return json.dumps({k: v for k, v in run.items() if k != "_ver"}, ensure_ascii=False)


def get(run_id):
    """Свіжа копія відкритого рейсу за номером."""
    with db() as c:
        r = c.execute("SELECT data, ver FROM reys_runs WHERE id=? AND status='open'", (run_id,)).fetchone()
    return _load(r) if r else None


def open_run(tg_id):
    """Рейс, у якому людина зараз працює. Екіпаж їде одним рейсом: його відкрив один, а бачать і відмічають обидва.
    Свій рейс із відмітками важливіший (у ньому гроші, які ще не здано), далі свій справжній,
    далі рейс, який відкрив напарник, або свій навчальний — той, що відкрито пізніше."""
    with db() as c:
        rows = c.execute(
            "SELECT id, tg_id, sheet_ref, data, ver FROM reys_runs WHERE status='open' AND (tg_id=?1 OR sheet_ref IN "
            "(SELECT sheet_ref FROM reys_crew WHERE tg_id=?1)) ORDER BY id DESC", (tg_id,)).fetchall()
        mates = {r["sheet_ref"]: {x["tg_id"] for x in c.execute(
            "SELECT tg_id FROM reys_crew WHERE sheet_ref=?", (r["sheet_ref"],))} for r in rows if r["tg_id"] != tg_id}
    own = [r for r in rows if r["tg_id"] == tg_id]
    # чужий рейс — тільки якщо його відкрив напарник з того самого екіпажу (пробний рейс власника сюди не потрапляє)
    shared = [r for r in rows if r["tg_id"] != tg_id and r["tg_id"] in mates[r["sheet_ref"]]]
    mine = [(r["id"], _load(r)) for r in own]
    idle = lambda run: bool(run.get("demo") or run.get("snap"))          # noqa: E731
    rest = sorted([(r["id"], _load(r)) for r in shared] + [x for x in mine if idle(x[1])], key=lambda x: -x[0])
    for pick in ([x for x in mine if engine.has_marks(x[1])], [x for x in mine if not idle(x[1])], rest):
        if pick:
            return pick[0]                                   # серед рейсу напарника і свого навчального — той, що новіший
    return None, None


def owner(run_id):
    """Хто відкрив рейс."""
    with db() as c:
        r = c.execute("SELECT tg_id FROM reys_runs WHERE id=?", (run_id,)).fetchone()
    return r["tg_id"] if r else None


def sheet_run(sheet_ref):
    """Відкритий рейс екіпажу по цій путівці: (номер, хто відкрив, рейс) або (None, None, None)."""
    with db() as c:
        r = c.execute("SELECT id, tg_id, data, ver FROM reys_runs WHERE sheet_ref=? AND status='open' AND tg_id IN "
                      "(SELECT tg_id FROM reys_crew WHERE sheet_ref=?) ORDER BY id DESC LIMIT 1",
                      (sheet_ref, sheet_ref)).fetchone()
    return (r["id"], r["tg_id"], _load(r)) if r else (None, None, None)


def drop_idle(tg_id):
    """Прибирає власні відкриті рейси без відміток (навчальний, щойно відкритий) — коли людина заходить у рейс екіпажу."""
    with db() as c:
        rows = c.execute("SELECT id, data, ver FROM reys_runs WHERE tg_id=? AND status='open'", (tg_id,)).fetchall()
    for r in rows:
        if not engine.has_marks(_load(r)):
            drop(r["id"])


def drop(run_id):
    """Покинутий рейс: у списках його більше немає, у журналі лишається."""
    with db() as c:
        c.execute("UPDATE reys_runs SET status='dropped', closed_at=? WHERE id=? AND status='open'", (now(), run_id))


def create(tg_id, run):
    with db() as c:
        c.execute("UPDATE reys_runs SET status='dropped', closed_at=? WHERE tg_id=? AND status='open'", (now(), tg_id))
        cur = c.execute("INSERT INTO reys_runs(tg_id, sheet_ref, day, data, created_at) VALUES(?,?,?,?,?)",
                        (tg_id, run["sheet_ref"], run["day"], _dump(run), now()))
        run["_ver"] = 0
        return cur.lastrowid


def save(run_id, run):
    """Записує рейс. Якщо його тим часом змінив напарник — Stale: відмітку не затираємо, людина повторить."""
    ver = run.get("_ver", 0)
    with db() as c:
        cur = c.execute("UPDATE reys_runs SET data=?, ver=? WHERE id=? AND status='open' AND COALESCE(ver, 0)=?",
                        (_dump(run), ver + 1, run_id, ver))
    if not cur.rowcount:
        raise Stale(run_id)
    run["_ver"] = ver + 1


def close(run_id, run):
    ver = run.get("_ver", 0)
    with db() as c:
        cur = c.execute("UPDATE reys_runs SET status='closed', closed_at=?, data=?, ver=? WHERE id=? AND status='open' "
                        "AND COALESCE(ver, 0)=?", (now(), _dump(run), ver + 1, run_id, ver))
    if not cur.rowcount:
        raise Stale(run_id)


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

def crew_add(sheet_ref, tg_id, by_id):
    with db() as c:
        c.execute("INSERT OR IGNORE INTO reys_crew(sheet_ref, tg_id, by_id, ts) VALUES(?,?,?,?)",
                  (sheet_ref, int(tg_id), by_id, now()))


def crew_del(sheet_ref, tg_id=None):
    """Знімає людину з путівки (без tg_id — увесь екіпаж)."""
    with db() as c:
        if tg_id is None:
            c.execute("DELETE FROM reys_crew WHERE sheet_ref=?", (sheet_ref,))
        else:
            c.execute("DELETE FROM reys_crew WHERE sheet_ref=? AND tg_id=?", (sheet_ref, int(tg_id)))


def crew(sheet_ref):
    """Екіпаж путівки в порядку закріплення."""
    with db() as c:
        return [r["tg_id"] for r in c.execute("SELECT tg_id FROM reys_crew WHERE sheet_ref=? ORDER BY ts, rowid",
                                              (sheet_ref,))]


def crews():
    out = {}
    with db() as c:
        for r in c.execute("SELECT sheet_ref, tg_id FROM reys_crew ORDER BY ts, rowid"):
            out.setdefault(r["sheet_ref"], []).append(r["tg_id"])
    return out


def taken_by(sheet_ref, ok_ids):
    """Хто сторонній уже відкрив або здав цю путівку (покинуті рейси не рахуються).
    ok_ids — кого не рахуємо: сам екіпаж і пробні рейси власника."""
    with db() as c:
        for r in c.execute("SELECT tg_id FROM reys_runs WHERE sheet_ref=? AND status IN ('open','closed') "
                           "ORDER BY id DESC", (sheet_ref,)):
            if r["tg_id"] not in ok_ids:
                return r["tg_id"]
    return None


def shares(day):
    """Хто з ким їхав цього дня: {tg_id: [(путівка, частка, [напарники])]}. Частка 1.0 — сам, 0.5 — удвох.
    Рахуємо по рейсах дня (відкритих і зданих), а не по закріпленнях: закріпити можна й те, що не поїхало."""
    out = {}
    with db() as c:
        refs = [r["sheet_ref"] for r in c.execute(
            "SELECT DISTINCT sheet_ref FROM reys_runs WHERE day=? AND status IN ('open','closed') AND sheet_ref IN "
            "(SELECT sheet_ref FROM reys_crew) AND tg_id IN (SELECT tg_id FROM reys_crew WHERE sheet_ref=reys_runs.sheet_ref)",
            (str(day),))]
    for ref in refs:
        team = crew(ref)
        for t in team:
            out.setdefault(t, []).append((ref, round(1 / len(team), 2), [x for x in team if x != t]))
    return out


def saw(tg_id, name):
    """Запам'ятовує ім'я людини з Telegram — щоб власник закріплював путівку за іменем, а не за номером."""
    with db() as c:
        c.execute("INSERT INTO reys_people(tg_id, name, seen) VALUES(?,?,?) ON CONFLICT(tg_id) DO UPDATE SET "
                  "name=CASE WHEN reys_people.fixed=1 THEN reys_people.name ELSE excluded.name END, seen=excluded.seen",
                  (tg_id, name or str(tg_id), now()))


def set_name(tg_id, name):
    """Ім'я водія, як його знає бот. Воно важливіше за те, як людина назвала себе в Telegram."""
    with db() as c:
        c.execute("INSERT INTO reys_people(tg_id, name, fixed) VALUES(?,?,1) ON CONFLICT(tg_id) "
                  "DO UPDATE SET name=excluded.name, fixed=1", (int(tg_id), str(name)))


def known_people():
    with db() as c:
        return {r["tg_id"]: r["name"] for r in c.execute("SELECT tg_id, name FROM reys_people")}


# ---------- назва путівки ----------

def title(sheet_ref, max_age_min=20):
    """(напрямок, скільки точок) з кешу, поки свіжий: щоб меню не ходило в 1С на кожне відкриття."""
    with db() as c:
        r = c.execute("SELECT title, points, ts FROM reys_titles WHERE sheet_ref=?", (sheet_ref,)).fetchone()
    if not r or (datetime.now() - datetime.fromisoformat(r["ts"])).total_seconds() > max_age_min * 60:
        return None
    return r["title"], r["points"]


def set_title(sheet_ref, name, points):
    with db() as c:
        c.execute("INSERT INTO reys_titles(sheet_ref, title, points, ts) VALUES(?,?,?,?) ON CONFLICT(sheet_ref) "
                  "DO UPDATE SET title=excluded.title, points=excluded.points, ts=excluded.ts",
                  (sheet_ref, name, int(points), now()))


def closed_refs(ignore=()):
    """Путівки, по яких касу вже здано. ignore — чиї рейси не рахуємо (пробні рейси власника)."""
    with db() as c:
        return {r["sheet_ref"] for r in c.execute("SELECT sheet_ref, tg_id FROM reys_runs WHERE status='closed'")
                if r["tg_id"] not in ignore}
