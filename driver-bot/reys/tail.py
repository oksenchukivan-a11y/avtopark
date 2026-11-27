"""«Хвіст дня»: накладні міста, яких немає в сьогоднішній путівці, але везти їх треба сьогодні.

Путівку міста друкують близько 13:00, і кожна накладна буває лише в одній путівці. Тому повз рейс проходять:
  а) відкладені («на середу», «доставка 27.11») — вони лежать у путівці дня, коли їх виписали;
  б) виписані після друку путівки — їх немає в жодній;
  в) ті, які водій привіз назад («товар не залишив»), — їх треба везти знову.
Модуль додає їх до точок рейсу з позначкою, звідки вони, стежить за дозамовленнями, поки рейс відкритий,
і після здачі каси каже власникові, що лишилось на складі. Тільки місто; обласні рейси не чіпає.
Вмикається прапорцем REYS_TAIL=1. У 1С нічого не пише."""
import asyncio
import json
import logging
import os
from datetime import date, datetime, timedelta
from html import escape as h

from . import build, engine, onec, store
from .tags import delivery_date, short_comment, tags_of

log = logging.getLogger("reys")
REAL = "Document_РеализацияТоваровУслуг"
SHEET = "Document_ПутевойЛист"
CITY = "Суми"
LOOKBACK = 14                # днів назад шукаємо відкладене й недоставлене
EVERY = 600                  # секунд між перевірками дозамовлень, поки рейс відкритий
DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"]


def enabled() -> bool:
    return os.environ.get("REYS_TAIL") == "1"


def is_city(where) -> bool:
    return (where or "").startswith(CITY)


def own_shop(name) -> bool:
    """Свої магазини возять окремо. Список — у налаштуваннях сервера (REYS_OWN_SHOPS, частини назв через кому)."""
    t = (name or "").casefold()
    return any(x and x in t for x in (p.strip().casefold() for p in os.environ.get("REYS_OWN_SHOPS", "").split(",")))


def init():
    with store.db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS reys_wait(
            inv_ref TEXT PRIMARY KEY, deliver_day TEXT NOT NULL, from_day TEXT, item TEXT NOT NULL, ts TEXT)""")


def _d(day) -> str:
    try:
        d = date.fromisoformat(str(day)[:10])
        return f"{DAYS[d.weekday()]} {d:%d.%m}"
    except ValueError:
        return str(day)


def label(inv) -> str:
    """Підпис для водія: звідки ця накладна взялась у рейсі."""
    kind, frm = inv.get("tail"), inv.get("tail_from", "")
    return {"moved": f"📌 перенесено з {_d(frm)}", "new": "🆕 після путівки",
            "back": f"↩️ не доставлено {_d(frm)}", "urgent": "🆕 терміново"}.get(kind, "")


def _item(st, inv, kind, frm):
    return {"ref": inv["ref"], "no": inv["no"], "sum": engine.orig_sum(st, inv), "date": inv.get("date", ""),
            "key": st["key"], "name": st["name"], "addr": st.get("addr", ""), "manager": inv.get("manager", ""),
            "comment": inv.get("comment", ""), "tags": [t for t in inv.get("tags", []) if t != "DATE"],
            "tail": kind, "tail_from": frm}


# ---------- а) відкладені ----------

def wait(item, deliver_day, from_day):
    with store.db() as c:
        c.execute("INSERT INTO reys_wait(inv_ref, deliver_day, from_day, item, ts) VALUES(?,?,?,?,?) "
                  "ON CONFLICT(inv_ref) DO UPDATE SET deliver_day=excluded.deliver_day, item=excluded.item",
                  (item["ref"], str(deliver_day), str(from_day), json.dumps(item, ensure_ascii=False), store.now()))


def remember(run):
    """Відкладені накладні з путівки записуємо собі: у день доставки їх у путівці вже не буде."""
    for st in run["stops"]:
        for inv in st["inv"]:
            if inv.get("deliver") and not {"SV", "NP"} & set(inv["tags"]):
                wait(_item(st, inv, "moved", run["day"]), inv["deliver"], run["day"])


def waits_for(day, strict=False):
    """Відкладені на цей день. Не strict — ще й прострочені за останні дні (того дня міського рейсу могло не бути)."""
    day = str(day)
    since = day if strict else (date.fromisoformat(day) - timedelta(days=LOOKBACK)).isoformat()
    with store.db() as c:
        rows = c.execute("SELECT item FROM reys_wait WHERE deliver_day>=? AND deliver_day<=? ORDER BY deliver_day, inv_ref",
                         (since, day)).fetchall()
    return [json.loads(r["item"]) for r in rows]


# ---------- в) що вже возили ----------

def past(ignore=(), days=LOOKBACK + 7):
    """З уже зданих рейсів: (доставлені накладні, {накладна: позиція} — привезені назад і досі не доставлені).
    ignore — чиї рейси не рахуємо (пробні рейси власника)."""
    since = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    done, back = set(), {}
    with store.db() as c:
        rows = c.execute("SELECT tg_id, data FROM reys_runs WHERE status='closed' AND closed_at>=? ORDER BY id",
                         (since,)).fetchall()
    for r in rows:
        run = json.loads(r["data"])
        if r["tg_id"] in ignore or run.get("demo") or run.get("snap"):
            continue
        for st in run["stops"]:
            s = st.get("status")
            if not s:
                continue
            for inv in engine.riding(st):
                if s.get("kind") == "back":
                    if run.get("tailable"):                     # назад у чергу — тільки міські
                        back[inv["ref"]] = _item(st, inv, "back", run.get("day", ""))
                else:
                    done.add(inv["ref"])
                    back.pop(inv["ref"], None)
    return done, {k: v for k, v in back.items() if k not in done}


# ---------- б) виписані після друку путівки ----------

async def prev_city_print(printed: datetime) -> datetime:
    """Коли надрукували попередню міську путівку: з цього моменту рахуємо «після путівки»."""
    from . import handlers as hd
    rows = await hd.read_sheets((printed - timedelta(days=5)).isoformat(timespec="seconds"),
                                (printed - timedelta(seconds=1)).isoformat(timespec="seconds"))
    for s in sorted(rows, key=lambda x: x["Date"], reverse=True):
        got = store.title(s["Ref_Key"], max_age_min=10 ** 6)
        if got is None:
            cities, points = await hd.sheet_cities(s["Ref_Key"])
            got = (build.direction(cities), points)
            store.set_title(s["Ref_Key"], *got)
        if is_city(got[0]):
            return datetime.fromisoformat(s["Date"][:19])
    return printed - timedelta(days=1)


async def fresh(a: datetime, b: datetime, ride: date, known, kind="new", on_wait=wait, blank=None):
    """Проведені накладні клієнтів міста за проміжок (a, b], яких немає в жодній путівці й серед known.
    Без самовивозу, пошти й своїх магазинів. Відкладені на пізніше не віддає, а записує через on_wait.
    blank — список, куди скласти накладні клієнтів, у яких у 1С не вказано місто: у рейс їх не беремо
    (невідомо, чи це місто), але власник має про них знати. Якщо нових накладних немає — це один запит до 1С."""
    from . import handlers as hd
    docs = await onec.call(
        "query", object=REAL, select="Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,Агент_Key", orderby="Date", top=500,
        filter=f"Date gt datetime'{a.isoformat(timespec='seconds')}' and Date le datetime'{b.isoformat(timespec='seconds')}' "
               f"and Posted eq true")
    docs = [d for d in docs if d["Ref_Key"] not in known and not d.get("DeletionMark")]
    if not docs:
        return []
    # чи є накладна в якійсь путівці — питаємо самі рядки путівок за ключем накладної: відповідь крихітна.
    # (Путівки цілком читати не можна: п'ять путівок — це вже 150 тисяч знаків, 1С таку відповідь обрізає.)
    rows = await onec.by_keys(SHEET + "_Контрагенты", {d["Ref_Key"] for d in docs}, "Ref_Key,Документ_Key",
                              field="Документ_Key")
    dead = {s["Ref_Key"] for s in await onec.by_keys(SHEET, {r["Ref_Key"] for r in rows}, "Ref_Key,DeletionMark")
            if s.get("DeletionMark")} if rows else set()
    in_sheet = {r["Документ_Key"] for r in rows if r["Ref_Key"] not in dead}
    docs = [d for d in docs if d["Ref_Key"] not in in_sheet]
    if not docs:
        return []
    cards = {c["Ref_Key"]: c for c in await onec.by_keys(
        "Catalog_Контрагенты", {d["Контрагент_Key"] for d in docs}, "Ref_Key,Description,ДополнительноеОписание")}
    town = {k: build.city_name(c.get("ДополнительноеОписание", "")) for k, c in cards.items()}
    docs = [d for d in docs if d["Контрагент_Key"] in cards
            and (town[d["Контрагент_Key"]] == CITY or (blank is not None and not town[d["Контрагент_Key"]]))
            and not own_shop(cards[d["Контрагент_Key"]].get("Description", ""))]
    if not docs:
        return []
    orders = await onec.by_keys(
        "Document_ЗаказПокупателя", {d["Контрагент_Key"] for d in docs}, "Date,Комментарий,СуммаДокумента,Контрагент_Key",
        field="Контрагент_Key",
        extra=f"Date ge datetime'{(a - timedelta(days=10)).date().isoformat()}T00:00:00' "
              f"and Date le datetime'{b.isoformat(timespec='seconds')}' and Posted eq true")
    order_of = build.match_orders(docs, orders)
    agents = await hd.agent_names({d.get("Агент_Key") for d in docs})
    out = []
    for d in docs:
        order = order_of.get(d["Ref_Key"])
        comment = (order or {}).get("Комментарий", "")
        tg = tags_of(comment)
        if {"SV", "NP"} & tg:
            continue
        name, addr = build.split_name(cards[d["Контрагент_Key"]].get("Description", "Клієнт без назви"))
        item = {"ref": d["Ref_Key"], "no": build.short_no(d["Number"]), "sum": round(d["СуммаДокумента"], 2),
                "date": d["Date"][:10], "key": d["Контрагент_Key"], "name": name, "addr": addr,
                "manager": agents.get(d.get("Агент_Key"), ""), "comment": short_comment(comment), "tags": sorted(tg),
                "tail": kind, "tail_from": d["Date"][:10]}
        when = delivery_date(comment, datetime.fromisoformat(order["Date"][:19]).date()) if order else None
        if not town[d["Контрагент_Key"]]:
            blank.append(item)                                             # місто не вказано — тільки власникові
            continue
        if when and when > ride:
            on_wait(dict(item, tail="moved"), when, d["Date"][:10])       # приїде у свій день
            continue
        out.append(item)
    return out


# ---------- додати до рейсу ----------

def add(run, items):
    """Дописує накладні в рейс. Клієнт уже є — накладна лягає до його точки, точка не дублюється.
    Якщо його точку вже відмічено (дозамовлення посеред рейсу) — це нова точка. Повертає додане."""
    have = {i["ref"] for s in run["stops"] for i in s["inv"]}
    added = []
    for it in items:
        if it["ref"] in have:
            continue
        have.add(it["ref"])
        st = next((s for s in run["stops"] if s["key"] == it["key"] and not s.get("status")), None)
        if st is None:
            st = {"key": it["key"], "name": it["name"], "addr": it.get("addr", ""), "sheet_debt": 0.0, "inv": [],
                  "debts": None, "manager": it.get("manager", ""), "status": None, "probs": []}
            run["stops"].append(st)
        st["inv"].append({"ref": it["ref"], "no": it["no"], "sum": it["sum"], "date": it.get("date", ""),
                          "tags": sorted(set(it.get("tags") or []) - {"DATE"}), "comment": it.get("comment", ""),
                          "deliver": "", "manager": it.get("manager", ""), "tail": it["tail"],
                          "tail_from": it.get("tail_from", "")})
        st["manager"] = st["manager"] or it.get("manager", "")
        build.classify(st)
        added.append(it)
    return added


async def extend(run, printed: datetime, ride: date, ignore=()):
    """Під час відкриття міської путівки: дописати хвіст. Збій 1С тут рейс не зупиняє — їде те, що в путівці."""
    run["tailable"] = True
    remember(run)
    done, back = past(ignore)
    have = {i["ref"] for s in run["stops"] for i in s["inv"]}
    items = [it for it in waits_for(ride) + list(back.values()) if it["ref"] not in done and it["ref"] not in have]
    try:
        prev = await prev_city_print(printed)
        items += await fresh(prev, printed, ride, have | done | {it["ref"] for it in items})
        run["tail_since"] = prev.isoformat(timespec="seconds")     # звідси ввечері рахуємо «що не поїхало»
    except onec.OneCError as e:
        log.warning("reys: хвіст дня — нові накладні не прочитано: %s", e)
    run["tail_checked"] = printed.isoformat(timespec="seconds")
    return add(run, items)


# ---------- дозамовлення, поки рейс відкритий ----------

def _open_city_run():
    with store.db() as c:
        rows = c.execute("SELECT id FROM reys_runs WHERE status='open' ORDER BY id DESC").fetchall()
    for r in rows:
        run = store.get(r["id"])
        if run and run.get("tailable") and not run.get("demo"):
            return r["id"], run
    return None, None


async def tick(bot=None, now=None, ignore=()):
    """Одна перевірка дозамовлень: нові накладні міста після останньої перевірки → точка «терміново» і одне
    повідомлення екіпажу. Нічого нового — один запит до 1С. Повертає додане."""
    now = now or datetime.now()
    if not enabled() or not 9 <= now.hour < 18:
        return []
    run_id, run = _open_city_run()
    if not run:
        return []
    done, _ = past(ignore)
    since = datetime.fromisoformat(run.get("tail_checked") or f"{run['day']}T00:00:00")
    known = {i["ref"] for s in run["stops"] for i in s["inv"]} | done
    items = await fresh(since, now, date.fromisoformat(run["day"]), known, kind="urgent")
    added = []
    for _ in range(3):                                   # водій міг щось відмітити, поки ми питали 1С
        run = store.get(run_id)
        if not run:
            return []
        added = add(run, items)
        run["tail_checked"] = now.isoformat(timespec="seconds")
        try:
            store.save(run_id, run)
            break
        except store.Stale:
            added = []
    if added:
        store.log(run_id, 0, "tail", kind="urgent", n=len(added), invoices=[x["no"] for x in added])
        if bot:
            from . import handlers as hd
            team = store.crew(run.get("sheet_ref", "")) or [store.owner(run_id)]
            names = ", ".join(sorted({x["name"] for x in added}))
            for t in team:
                try:
                    hd.sent(await bot.send_message(t, f"🆕 <b>Терміново додалось у рейс: {len(added)}</b>\n{h(names)}",
                                                   parse_mode="HTML"))
                except Exception as e:
                    log.warning("reys: про дозамовлення не повідомлено %s: %s", t, e)
    return added


async def watch(bot):
    """Працює весь час, поки живе бот: раз на EVERY секунд дивиться, чи не дозамовили щось у місто."""
    from . import handlers as hd
    while True:
        await asyncio.sleep(EVERY)
        try:
            await tick(bot, ignore=hd.trial_ids())
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("reys: перевірка дозамовлень: %s", e)


# ---------- після здачі каси: що лишилось на складі ----------

async def left_behind(run, now=None, ignore=()):
    """Текст для власника: накладні міста за день, які не поїхали або повернулись, і окремо — накладні клієнтів,
    у яких у 1С не вказано місто (у рейс вони не потрапляють). None — усе розвезли."""
    now = now or datetime.now()
    rows, blank = [], []
    for st in run["stops"]:
        s = st.get("status") or {}
        if s.get("kind") == "back":
            rows += [(inv["no"], st["name"], inv.get("manager", ""), s.get("text", "товар не залишив")) for inv in engine.riding(st)]
    try:
        done, _ = past(ignore)
        since = datetime.fromisoformat(run.get("tail_since") or run.get("tail_checked") or f"{run['day']}T00:00:00")
        known = {i["ref"] for s in run["stops"] for i in s["inv"]} | done
        late = await fresh(since, now, date.fromisoformat(run["day"]), known, blank=blank)
        rows += [(x["no"], x["name"], x["manager"], "у рейс не потрапила") for x in late]
    except (onec.OneCError, ValueError) as e:
        log.warning("reys: звірка складу після рейсу: %s", e)
    if not rows and not blank:
        return None

    def block(items, top=20):
        body = "\n\n".join(f"№ {h(no)} · <b>{h(name)}</b>\n{h(engine.clean(mgr)) or 'менеджер не вказаний'}"
                             + (f" · {h(why)}" if why else "") for no, name, mgr, why in items[:top])
        return f"<blockquote>{body}" + (f"\n\n… і ще {len(items) - top}" if len(items) > top else "") + "</blockquote>"
    out = []
    if rows:
        out.append(f"📦 <b>Стоїть на складі, не поїхала: {len(rows)}</b>\n" + block(rows))
    if blank:
        out.append(f"❓ <b>Місто клієнта не вказано в 1С: {len(blank)}</b>\nУ рейс такі не потрапляють — перевір, чи їх не треба було везти.\n"
                   + block([(x["no"], x["name"], x["manager"], "") for x in blank]))
    return "\n\n".join(out)


# ---------- перевірка на історії (запускається на сервері руками) ----------

async def history(d1: date, d2: date, out=print):
    """Скільки накладних додав би хвіст по днях, якби працював тоді. Тільки читає 1С, у базу бота не пише."""
    from . import handlers as hd
    waits, total = {}, {"a": [0, 0.0], "b": [0, 0.0]}

    def keep(item, when, frm):
        waits[item["ref"]] = (str(when), item)
    day = d1 - timedelta(days=LOOKBACK)
    out("день       путівка  у путівці   а) відкладені        б) після друку")
    while day <= d2:
        sheets = [s for s in await hd.read_sheets(f"{day.isoformat()}T00:00:00", f"{day.isoformat()}T23:59:59")]
        for s in sheets:
            cities, points = await hd.sheet_cities(s["Ref_Key"])
            if not is_city(build.direction(cities)):
                continue
            run, printed, ride = await hd.load_sheet(s["Ref_Key"], light=True)
            for st in run["stops"]:
                for inv in st["inv"]:
                    if inv.get("deliver") and not {"SV", "NP"} & set(inv["tags"]):
                        waits[inv["ref"]] = (inv["deliver"], _item(st, inv, "moved", run["day"]))
            have = {i["ref"] for st in run["stops"] for i in st["inv"]}
            if day >= d1:
                a = [it for when, it in waits.values() if when == ride.isoformat() and it["ref"] not in have]
                prev = await prev_city_print(printed)
                b = await fresh(prev, printed, ride, have | {it["ref"] for it in a}, on_wait=keep)
                n = sum(len(engine.riding(st)) for st in run["stops"])
                out(f"{ride:%d.%m} {DAYS[ride.weekday()]}  № {run['sheet_no']:>6}  {n:>4}      "
                    f"{len(a):>3} · {sum(x['sum'] for x in a):>10.2f}    {len(b):>3} · {sum(x['sum'] for x in b):>10.2f}")
                for k, part in (("a", a), ("b", b)):
                    total[k][0] += len(part)
                    total[k][1] += sum(x["sum"] for x in part)
            else:
                prev = await prev_city_print(printed)                      # до початку періоду — лише збираємо відкладені
                await fresh(prev, printed, ride, have, on_wait=keep)
        day += timedelta(days=1)
    out(f"РАЗОМ      а) {total['a'][0]} · {total['a'][1]:.2f} ₴     б) {total['b'][0]} · {total['b'][1]:.2f} ₴")
    return total
