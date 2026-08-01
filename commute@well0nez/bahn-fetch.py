#!/usr/bin/env python3
"""Holt Verbindungen fuer das db-pendler-Applet.

Primaerquelle: Transitous/MOTIS (Routing A->B inkl. Umstiege, Realtime).
Anreicherung:  db-infoscreen/IRIS (DB-eigene Verspaetung + Gleis am Startbahnhof).

Gibt genau eine JSON-Zeile auf stdout aus. Faellt nie mit Traceback aus --
Fehler landen als {"ok": false, "error": ...} im JSON, damit das Applet
etwas Sinnvolles anzeigen kann.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Berlin")
UA = "db-pendler-applet/1.0 (Cinnamon; persoenliche Pendleranzeige)"

MOTIS = "https://api.transitous.org/api/v1"
DBF = "https://dbf.finalrewind.org"

CACHE_DIR = os.path.join(
    os.environ.get("XDG_CACHE_HOME", os.path.expanduser("~/.cache")),
    "cinnamon-commute",
)
GEO_CACHE = os.path.join(CACHE_DIR, "stations.json")
RESULT_CACHE = os.path.join(CACHE_DIR, "last.json")
BOARD_CACHE = os.path.join(CACHE_DIR, "boards.json")

# Transitous ist ein ehrenamtlich betriebener Dienst -- nicht haemmern.
MIN_REFRESH = 45

# db-infoscreen sagt ausdruecklich: "maximal 10 Anfragen pro Minute und
# insbesondere nur eine Anfrage pro Station und Minute". Der Streckencache
# oben reicht dafuer nicht -- beim Umschalten der Richtung wechselt der
# Streckenschluessel, und die Station wuerde erneut abgefragt. Deshalb ein
# zweiter Cache pro Bahnhof, der diese Grenze hart einhaelt.
IRIS_TTL = 60


def get_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def load_cache(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(path, data):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except Exception:
        pass


def resolve_station(name):
    """Bahnhofsname -> MOTIS-Stop-ID. Ergebnis wird dauerhaft gecacht."""
    cache = load_cache(GEO_CACHE)
    key = name.strip().lower()
    if key in cache:
        return cache[key]["id"], cache[key]["name"]

    url = f"{MOTIS}/geocode?text={urllib.parse.quote(name)}"
    hits = get_json(url)
    stops = [h for h in hits if h.get("type") == "STOP"]
    if not stops:
        raise ValueError(f"Bahnhof nicht gefunden: {name}")

    # Die Reihenfolge der Geocoder-Antwort IST das Relevanz-Ranking -- nicht
    # umsortieren. Eine pauschale DELFI-Bevorzugung schob sonst bei "Koeln Hbf"
    # ein "Stolberg, Hauptbahnhof (Bus)" nach vorn, nur weil dessen ID aus dem
    # DELFI-Feed stammt.
    best = stops[0]

    # Nur bei gleichem Namen zaehlt die Herkunft: der DELFI-Eintrag traegt die
    # deutschen Realtime-Daten, ein gleichnamiger aus einem anderen Feed nicht
    # unbedingt.
    for s in stops:
        if s["name"] == best["name"] and s["id"].startswith("de-DELFI"):
            best = s
            break
    cache[key] = {"id": best["id"], "name": best["name"]}
    save_cache(GEO_CACHE, cache)
    return best["id"], best["name"]


def to_local(iso):
    """MOTIS liefert UTC mit 'Z'. Ohne diese Umrechnung zeigt das Applet
    im Sommer zwei Stunden zu frueh an."""
    if not iso:
        return None
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(TZ)


def hhmm(dt):
    return dt.strftime("%H:%M") if dt else "--:--"


def delay_min(real, sched):
    if not real or not sched:
        return 0
    return int(round((real - sched).total_seconds() / 60.0))


def iris_candidates(motis_name, user_input):
    """IRIS kennt andere Schreibweisen als MOTIS.

    Meist trifft der MOTIS-Name ohne das angehaengte ' Bf'. Bei Opladen liegt
    es schlimmer: IRIS fuehrt zwei getrennte Boards -- 'Opladen' (RB48, RE7)
    und 'Leverkusen Opladen' (RE1, RE5, S6) -- fuer denselben Bahnhof. Deshalb
    werden alle Kandidaten geholt und zusammengefuehrt, statt beim ersten
    Treffer aufzuhoeren.
    """
    name = motis_name
    for suffix in (" Bf", " Bahnhof", " S-Bahn"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    out = []
    for c in (name, motis_name, name.split()[-1] if name.split() else "", user_input):
        if c and c not in out:
            out.append(c)
    return out


def fetch_board(name):
    # Harte Obergrenze von einer Abfrage pro Station und Minute, unabhaengig
    # davon wie oft das Applet den Helper aufruft.
    cache = load_cache(BOARD_CACHE)
    hit = cache.get(name)
    if hit and time.time() - hit.get("at", 0) < IRIS_TTL:
        return hit.get("board", {})

    try:
        url = f"{DBF}/{urllib.parse.quote(name)}.json?version=3"
        got = get_json(url, timeout=10)
    except Exception:
        return {}
    # Mehrdeutige oder unbekannte Namen liefern 200 mit "error"-Feld.
    if got.get("error") or "departures" not in got:
        # Auch Fehlschlaege merken, sonst probiert jeder Aufruf die
        # untauglichen Namensvarianten erneut durch.
        cache[name] = {"at": time.time(), "board": {}}
        save_cache(BOARD_CACHE, cache)
        return {}

    board = {}
    for dep in got.get("departures", []):
        num = (dep.get("trainNumber") or "").strip()
        sched = dep.get("scheduledDeparture")
        if not num or not sched:
            continue
        board[num] = {
            "delay": dep.get("delayDeparture") or 0,
            "platform": dep.get("platform"),
            "scheduled_platform": dep.get("scheduledPlatform"),
            "cancelled": bool(dep.get("isCancelled")),
            "messages": [
                m.get("text")
                for m in (dep.get("messages", {}).get("delay", []) or [])
                if m.get("text")
            ],
            "scheduled": sched,
        }

    cache[name] = {"at": time.time(), "board": board}
    save_cache(BOARD_CACHE, cache)
    return board


def iris_board(motis_name, user_input, wanted_nums):
    """Abfahrtstafel des Startbahnhofs aus IRIS (DB-intern).

    Liefert genauere und schnellere Verspaetungen als der DELFI-GTFS-RT-Feed,
    und vor allem echte Bahnsteignummern -- MOTIS gibt am Opladener Board
    DELFI-Interncodes wie '77' aus, die kein Reisender je auf der Anzeige
    sieht. Best effort: faellt das aus, laeuft das Applet mit MOTIS weiter.

    Gecacht wird, welche Kandidatennamen ueberhaupt Treffer geliefert haben,
    damit spaetere Aufrufe nicht jedes Mal alle Varianten abklappern.
    """
    cache = load_cache(GEO_CACHE)
    ckey = "iris:" + motis_name.lower()
    known = cache.get(ckey) or []
    if isinstance(known, str):  # Altformat aus frueherem Cache
        known = [known]

    # Bewaehrte Namen zuerst, der Rest nur als Rueckfallebene. Damit kostet
    # der Normalfall genau eine Abfrage; die uebrigen Varianten werden nur
    # angefasst, wenn wirklich noch Zuege fehlen.
    cands = known + [c for c in iris_candidates(motis_name, user_input)
                     if c not in known]

    # Das erste Board, das ueberhaupt einen unserer Zuege kennt, gewinnt --
    # und danach wird abgebrochen. Auf volle Abdeckung zu warten waere falsch:
    # IRIS reicht nur rund zwei Stunden voraus, eine Verbindung in vier
    # Stunden kann kein Board kennen, und die Schleife liefe jedes Mal durch
    # alle Namensvarianten desselben Bahnhofs.
    merged, winner = {}, None
    for cand in cands:
        board = fetch_board(cand)
        if not board:
            continue
        if wanted_nums and not (set(board) & wanted_nums):
            continue  # kennt keinen unserer Zuege -- falscher Bahnhof
        merged = board
        winner = cand
        break

    if winner and cache.get(ckey) != [winner]:
        cache[ckey] = [winner]
        save_cache(GEO_CACHE, cache)
    return merged


def train_number(leg):
    """MOTIS haengt die Zugnummer als 'RB48 (17381)' an den Liniennamen."""
    raw = leg.get("routeShortName") or ""
    if "(" in raw and ")" in raw:
        return raw[raw.rfind("(") + 1 : raw.rfind(")")].strip()
    return ""


def first_transit_leg(itin):
    for l in itin.get("legs", []):
        if l.get("mode") != "WALK":
            return l
    return None


def build_connection(itin, iris):
    legs = [l for l in itin.get("legs", []) if l.get("mode") != "WALK"]
    if not legs:
        return None

    first, last = legs[0], legs[-1]
    dep_sched = to_local(first["from"].get("scheduledDeparture"))
    dep_real = to_local(first["from"].get("departure")) or dep_sched
    arr_sched = to_local(last["to"].get("scheduledArrival"))
    arr_real = to_local(last["to"].get("arrival")) or arr_sched

    lines = []
    for l in legs:
        name = (l.get("routeShortName") or l.get("mode") or "?").split(" (")[0]
        lines.append(name)

    dep_delay = delay_min(dep_real, dep_sched)
    cancelled = any(l.get("cancelled") for l in legs)
    messages = []

    # Gleis kommt bewusst NUR aus IRIS. MOTIS liefert an manchen Bahnhoefen
    # (Opladen: "77", "78") DELFI-Interncodes statt Bahnsteignummern -- lieber
    # kein Gleis anzeigen als eines, das am Bahnhof nirgends steht.
    platform = ""
    track_changed = False

    hit = iris.get(train_number(first))
    if hit and dep_sched and hit.get("scheduled") == dep_sched.strftime("%H:%M"):
        dep_delay = hit["delay"]
        if hit.get("platform"):
            track_changed = bool(
                hit.get("scheduled_platform")
                and hit["platform"] != hit["scheduled_platform"]
            )
            platform = hit["platform"]
        cancelled = cancelled or hit["cancelled"]
        messages = hit["messages"]

    return {
        "dep": hhmm(dep_sched),
        "arr": hhmm(arr_sched),
        "dep_ts": int(dep_sched.timestamp()) if dep_sched else 0,
        "dep_delay": dep_delay,
        "arr_delay": delay_min(arr_real, arr_sched),
        "duration": int(itin.get("duration", 0) // 60),
        "transfers": itin.get("transfers", 0),
        "lines": lines,
        "platform": platform or "",
        "track_changed": track_changed,
        "cancelled": cancelled,
        "messages": messages,
    }


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: bahn-fetch.py VON NACH [anzahl]"}))
        return

    src, dst = sys.argv[1], sys.argv[2]
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 5

    # Rate-Limit gegen den ehrenamtlichen Dienst: bei zu schnellen Aufrufen
    # das letzte Ergebnis wiederverwenden (gleiche Richtung vorausgesetzt).
    cached = load_cache(RESULT_CACHE)
    if (
        cached.get("route") == f"{src}|{dst}"
        and time.time() - cached.get("fetched_at", 0) < MIN_REFRESH
    ):
        cached["from_cache"] = True
        print(json.dumps(cached))
        return

    try:
        from_id, from_name = resolve_station(src)
        to_id, to_name = resolve_station(dst)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Bahnhof unbekannt: {e}"}))
        return

    url = (
        f"{MOTIS}/plan"
        f"?fromPlace={urllib.parse.quote(from_id, safe='')}"
        f"&toPlace={urllib.parse.quote(to_id, safe='')}"
        f"&numItineraries={max(count, 3)}"
        f"&transitModes=RAIL"
    )

    try:
        plan = get_json(url, timeout=25)
    except urllib.error.HTTPError as e:
        print(json.dumps({"ok": False, "error": f"Transitous HTTP {e.code}"}))
        return
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Netzwerk: {e}"}))
        return

    wanted = set()
    for itin in plan.get("itineraries", []):
        leg = first_transit_leg(itin)
        if leg:
            wanted.add(train_number(leg))
    wanted.discard("")

    iris = iris_board(from_name, src, wanted)

    conns = []
    for itin in plan.get("itineraries", []):
        c = build_connection(itin, iris)
        if c:
            conns.append(c)
    conns.sort(key=lambda c: c["dep_ts"])

    out = {
        "ok": True,
        "route": f"{src}|{dst}",
        "from_name": from_name,
        "to_name": to_name,
        "fetched_at": int(time.time()),
        "iris": bool(iris),
        "connections": conns[:count],
    }
    save_cache(RESULT_CACHE, out)
    print(json.dumps(out))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # letzte Reissleine -- nie ohne JSON zurueckkommen
        print(json.dumps({"ok": False, "error": str(e)}))
