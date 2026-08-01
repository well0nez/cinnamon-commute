# How to contribute

## Languages in this project

The documentation is English, and it follows the writing rules of ASD-STE100
Simplified Technical English. Write in the active voice, use the present
tense, and keep a descriptive sentence below 25 words. A procedural sentence
stays below 20 words and gives one instruction. Short sentences are not a goal
in themselves; a sentence that carries no information is not an improvement
over a longer one that does.

The approved dictionary of ASD-STE100 is Part 2 of the specification, and this
project does not apply it. That dictionary comes from aircraft maintenance
manuals, where every word has one narrow meaning. Some of its substitutions
are wrong here: it replaces "delay" with "interval", which is a waiting time
and not the lateness of a train. Domain words such as station, platform, feed
and applet therefore stay as they are. Rule 1.6 of the specification permits
this, because they are technical nouns.

The user interface is German, because the applet serves German railway data.
The code comments are German as well. Keep this split: if you add a string that
the user reads, write it in German.

## Structure

The applet has two parts, and the split is deliberate.

`bahn-fetch.py` does the network work, the time zone conversion, and the merge
of the two data sources. It writes one line of JSON to standard output, and it
never exits with a traceback. An error becomes `{"ok": false, "error": "..."}`,
so that the applet can show something useful. You can run the helper alone:

```bash
./commute@well0nez/bahn-fetch.py "Köln Hbf" "Düsseldorf Hbf" 5
```

`applet.js` builds the panel text and the menu. It starts the helper through
`Util.spawnCommandLineAsyncIO` and reads the JSON. Keep the network logic out
of this file.

## Before you send a change

Check the syntax of both files:

```bash
cjs -c 'const G=imports.gi.GLib;let [o,b]=G.file_get_contents("commute@well0nez/applet.js");new Function(imports.byteArray.toString(b));print("ok")'
python3 -m py_compile commute@well0nez/bahn-fetch.py
```

Load the applet again and read the log:

```bash
gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
  --method org.Cinnamon.Eval 'imports.ui.extension.reloadExtension("commute@well0nez", imports.ui.extension.Type.APPLET)'
grep -i "JS ERROR" ~/.xsession-errors | tail
```

## Rules for the request limits

db-infoscreen permits one request per station per minute, and 10 requests per
minute in total. Any change that touches the fetch path must hold this limit.
The applet enforces it in three places: the minimum interval of 60 seconds in
`settings-schema.json`, the per-station cache in `fetch_board`, and the early
stop in `iris_board` after the first board that matches.

Do not lower the minimum interval, and do not remove a cache to make a test
easier. Both services are free, and volunteers pay for them.

## Two traps in the data

MOTIS returns times in UTC with a `Z` suffix. Convert them to `Europe/Berlin`.
Without the conversion the applet shows times that are two hours early in
summer.

MOTIS returns internal DELFI codes instead of platform numbers at some
stations. Take the platform from IRIS only.

## Two traps in Cinnamon

Cinnamon measures the column widths of a popup menu once, when the menu opens,
and then keeps the result. A label that you fill later with `set_text()` holds
the width from the measurement, which is one pixel for an empty label. Build
the menu items again on each render instead.

`settings.setValue()` writes the value and saves the file, but it does not call
the callbacks that you passed to `bind()`. After a change from your own code,
start the follow-up work yourself.
