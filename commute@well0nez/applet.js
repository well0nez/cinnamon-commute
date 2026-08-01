const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;

const UUID = "commute@well0nez";

// Der Panel-Text soll kurz bleiben: ein voller Bahnhofsname frisst sonst das
// halbe Panel. Gesucht ist der Teil, der den Ort benennt -- bei
// "Koeln Hbf" also "Koeln" und nicht "Hbf", bei "Frankfurt(Main)Hbf"
// entsprechend "Frankfurt". Klammerzusaetze wie "(Bus)" fallen ganz weg.
function shortName(name) {
    // Klammer wird zu einem Leerzeichen, nicht geloescht: "Frankfurt(Main)Hbf"
    // ergibt sonst "FrankfurtHbf" und das Hbf laesst sich nicht mehr abtrennen.
    // trim() muss VOR den Suffix-Abgleich: der endet auf $, und ein aus der
    // Klammer stehengebliebenes Leerzeichen verhindert sonst den Treffer.
    let n = name.replace(/\s*\([^)]*\)\s*/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .replace(/\s+(Bf|Bahnhof|Hauptbahnhof|S-Bahn)\.?$/i, "")
                .replace(/[,\s]+$/, "");
    let parts = n.split(/[\s-]+/).filter((p) => p.length);
    if (!parts.length) return name;

    let last = parts[parts.length - 1];
    if (/^Hbf\.?$/i.test(last) && parts.length > 1) return parts[parts.length - 2];
    return last;
}

function pad(n) {
    return (n < 10 ? "0" : "") + n;
}


class DbPendler extends Applet.TextIconApplet {

    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_name("network-transmit-receive");
        this.hide_applet_icon();

        // Pfad aus den Metadaten statt fest verdrahtet: so laeuft das Applet
        // auch aus einem Git-Checkout heraus, der per Symlink eingebunden ist.
        this._helper = GLib.build_filenamev([metadata.path, "bahn-fetch.py"]);

        this._data = null;
        this._error = null;
        this._lastFetch = 0;
        this._proc = null;
        this._timer = null;

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        for (let key of ["station-a", "station-b", "reversed", "count",
                         "panel-mode", "warn-minutes", "refresh"]) {
            this.settings.bind(key, key.replace(/-/g, "_"), () => this._onSettingsChanged());
        }

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        // Inhalt beim Aufklappen aufbauen, nicht im Klick-Handler: so stimmt
        // das Menue auch, wenn es per Tastatur oder von aussen geoeffnet wird.
        this.menu.connect("open-state-changed", (menu, open) => {
            if (open) this._renderMenu();
        });

        this.set_applet_label("Bahn …");
        this._buildMenu();
        this._fetch();
        this._scheduleTick();
    }

    on_applet_clicked() {
        // Bewusst kein Neuladen beim Oeffnen -- der Tick haelt die Daten
        // frisch, und jeder Klick eine Abfrage waere unnoetiger Traffic.
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        if (this._timer) {
            Mainloop.source_remove(this._timer);
            this._timer = null;
        }
        if (this._proc && this._proc.cancellable) {
            this._proc.cancellable.cancel();
            this._proc = null;
        }
        this.settings.finalize();
    }

    _onSettingsChanged() {
        this._lastFetch = 0;
        this._fetch();
    }

    _from() { return this.reversed ? this.station_b : this.station_a; }
    _to()   { return this.reversed ? this.station_a : this.station_b; }

    _scheduleTick() {
        // Kurzer Takt fuer den Countdown, Netzabfrage nur wenn faellig.
        this._timer = Mainloop.timeout_add_seconds(20, () => {
            let now = Date.now() / 1000;
            if (now - this._lastFetch >= this.refresh) {
                this._fetch();
            } else {
                this._render();
            }
            return true;
        });
    }

    _fetch() {
        if (this._proc && this._proc.cancellable) {
            this._proc.cancellable.cancel();
        }
        this._lastFetch = Date.now() / 1000;

        let argv = ["python3", this._helper, this._from(), this._to(),
                    String(this.count)];

        this._proc = Util.spawnCommandLineAsyncIO("", (stdout, stderr, exit) => {
            this._proc = null;
            let parsed = null;
            try {
                parsed = JSON.parse(stdout);
            } catch (e) {
                this._error = "Helper lieferte kein JSON";
                this._data = null;
                this._render();
                return;
            }
            if (parsed.ok) {
                this._data = parsed;
                this._error = null;
            } else {
                this._error = parsed.error || "unbekannter Fehler";
            }
            this._render();
        }, { argv: argv });
    }

    // Rollierend: abgefahrene Verbindungen fallen raus, ohne dass dafuer
    // neu geladen werden muss.
    _upcoming() {
        if (!this._data) return [];
        let now = Date.now() / 1000;
        return this._data.connections.filter(
            (c) => (c.dep_ts + c.dep_delay * 60) >= now - 30
        );
    }

    _delayStyle(minutes) {
        if (minutes >= this.warn_minutes) return "db-delay-bad";
        if (minutes > 0) return "db-delay-mild";
        return "db-delay-none";
    }

    _render() {
        this._renderPanel();
        if (this.menu.isOpen) this._renderMenu();
    }

    _renderPanel() {
        let list = this._upcoming();

        if (this._error && !this._data) {
            this.set_applet_label("Bahn ⚠");
            this._applet_label.set_style("color: #e08a5b;");
            this.set_applet_tooltip("Fehler: " + this._error);
            return;
        }
        if (!list.length) {
            this.set_applet_label("Bahn –");
            this._applet_label.set_style(null);
            this.set_applet_tooltip(this._data
                ? "Keine weiteren Verbindungen"
                : "Lade …");
            return;
        }

        let c = list[0];
        let mins = Math.round((c.dep_ts + c.dep_delay * 60 - Date.now() / 1000) / 60);
        let time = c.dep;
        let text;

        // Die Uhrzeit ist immer die ABFAHRT am STARTbahnhof. Frueher stand
        // hier der ZIELbahnhof vor der Zeit -- das liest sich, als passiere
        // dort etwas zu dieser Uhrzeit, obwohl der Zug dann am Startbahnhof
        // abfaehrt. Deshalb faengt jede Variante mit "ab" an, und wo ein
        // Bahnhof genannt wird, ist es der, zu dem die Zeit gehoert.
        switch (this.panel_mode) {
            case "line":
                text = c.lines.join("+") + " ab " + time;
                break;
            case "time":
                text = "ab " + time;
                break;
            case "countdown":
                text = "ab " + time +
                    (mins >= 0 ? " · in " + mins + " min" : " · jetzt");
                break;
            default:
                text = "ab " + shortName(this._data.from_name) + " " + time;
        }

        if (c.cancelled) {
            text += " ⚠";
            this._applet_label.set_style("color: #d05c5c; font-weight: bold;");
        } else if (c.dep_delay > 0) {
            text += " +" + c.dep_delay;
            this._applet_label.set_style(
                c.dep_delay >= this.warn_minutes
                    ? "color: #d05c5c; font-weight: bold;"
                    : "color: #d3a04a;"
            );
        } else {
            this._applet_label.set_style(null);
        }

        this.set_applet_label(text);

        // Im Tooltip steht an jeder Zeit der Bahnhof, zu dem sie gehoert --
        // sonst bleibt dieselbe Verwechslung wie vorher im Panel.
        let tip = c.lines.join(" + ") + "\n" +
            "ab " + (c.dep_delay > 0
                ? c.dep_real + " statt " + c.dep + " (+" + c.dep_delay + ")"
                : c.dep) +
            "  " + this._data.from_name +
            (c.platform ? ", Gleis " + c.platform : "") + "\n" +
            "an " + (c.arr_delay > 0
                ? (c.arr_estimated ? "ca. " : "") + c.arr_real +
                  " statt " + c.arr + " (+" + c.arr_delay + ")"
                : c.arr) +
            "  " + this._data.to_name + "\n" +
            c.duration + " min" +
            (c.transfers ? ", " + c.transfers + "× umsteigen" : ", direkt");
        if (c.arr_estimated) {
            tip += "\nAnkunft aus der Abfahrtsverspätung gerechnet";
        }
        if (c.cancelled) tip += "\nFÄLLT AUS";
        this.set_applet_tooltip(tip);
    }

    _buildMenu() {
        this.menu.removeAll();

        // Kopf- und Statuszeile werden bei jedem Rendern neu erzeugt statt
        // per set_text aktualisiert. Grund: Cinnamon berechnet die
        // Spaltenbreiten beim Oeffnen einmal und cacht sie -- ein spaeter
        // befuelltes Label behaelt die Breite, die es beim Messen hatte
        // (leer = 1 px) und bleibt unsichtbar. Neu eingehaengte Items werden
        // dagegen frisch vermessen.
        this._headerSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._headerSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rowSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._rowSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let swap = new PopupMenu.PopupIconMenuItem(
            "Richtung wechseln", "object-flip-horizontal", St.IconType.SYMBOLIC);
        swap.connect("activate", () => {
            this._data = null;
            this._error = null;
            this.set_applet_label("Bahn …");
            // setValue schreibt nur den Wert und speichert -- die an bind()
            // uebergebenen Callbacks laufen dabei NICHT. Das Neuladen muss
            // hier also von Hand angestossen werden.
            this.reversed = !this.reversed;
            this.settings.setValue("reversed", this.reversed);
            this._lastFetch = 0;
            this._fetch();
            this._renderMenu();
        });
        this.menu.addMenuItem(swap);

        let reload = new PopupMenu.PopupIconMenuItem(
            "Jetzt aktualisieren", "view-refresh", St.IconType.SYMBOLIC);
        reload.connect("activate", () => {
            this._lastFetch = 0;
            this._fetch();
        });
        this.menu.addMenuItem(reload);

        this._statusSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._statusSection);
    }

    _textItem(text, styleClass) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        item.addActor(new St.Label({ text: text, style_class: styleClass }),
                      { span: -1 });
        return item;
    }

    _renderMenu() {
        this._rowSection.removeAll();
        this._headerSection.removeAll();
        this._statusSection.removeAll();

        let route = this._data
            ? this._data.from_name + "  →  " + this._data.to_name
            : this._from() + "  →  " + this._to();
        this._headerSection.addMenuItem(this._textItem(route, "db-header"));

        let list = this._upcoming();

        if (!list.length) {
            this._rowSection.addMenuItem(this._textItem(
                this._error ? "Fehler: " + this._error : "Keine Verbindungen",
                this._error ? "db-alert" : "db-sub"));
        }

        // Spaltenbreiten zur Laufzeit aus den echten Texten messen und auf
        // allen Zeilen gleich setzen. Feste px im Stylesheet haengen an
        // Schriftart und -groesse und liefen bei "RE4+S1+RB48" ohnehin aus
        // der Flucht.
        let rows = list.map((c) => this._buildRow(c));
        for (let r of rows) this._rowSection.addMenuItem(r.item);

        // Die beiden Verspaetungsspalten werden fuer "+99" vermessen, nicht
        // fuer den aktuellen Inhalt: sonst sind sie bei puenktlichen Zuegen
        // schmal, und das ganze Raster rutscht, sobald irgendwo ein "+3"
        // erscheint. Gemessen wird an den bereits eingehaengten Labels, damit
        // Theme und Schrift wirklich anliegen.
        const RESERVED = { 1: "00:00", 4: "≈00:00" };
        let saved = rows.map((r) =>
            Object.keys(RESERVED).map((i) => r.cells[i].get_text()));
        rows.forEach((r) =>
            Object.keys(RESERVED).forEach((i) => r.cells[i].set_text(RESERVED[i])));

        let widths = [];
        for (let r of rows) {
            r.cells.forEach((cell, i) => {
                let [min, nat] = cell.get_preferred_width(-1);
                if (!widths[i] || nat > widths[i]) widths[i] = nat;
            });
        }

        rows.forEach((r, n) =>
            Object.keys(RESERVED).forEach((i, k) => r.cells[i].set_text(saved[n][k])));
        for (let r of rows) {
            r.cells.forEach((cell, i) => cell.set_width(widths[i]));
        }

        // Erst jetzt, mit den fertigen Breiten, und vorn eingehaengt.
        if (rows.length) {
            this._rowSection.addMenuItem(this._buildHeaderRow(widths), 0);
        }

        let d = new Date(this._lastFetch * 1000);
        let src = this._data && this._data.iris
            ? "Transitous + IRIS"
            : "Transitous";
        this._statusSection.addMenuItem(this._textItem(
            "Stand " + pad(d.getHours()) + ":" + pad(d.getMinutes()) +
            ":" + pad(d.getSeconds()) + " · " + src +
            (this._error && this._data ? " · letzte Abfrage fehlerhaft" : ""),
            "db-status"));
    }

    // Die Ueberschrift laeuft NICHT durch die Spaltenvermessung mit. Sonst
    // blaeht "an Duesseldorf" die Ankunftsspalte auf, und zwischen Soll- und
    // Ist-Zeit steht eine Luecke von der halben Menuebreite. Stattdessen
    // bekommt sie die schon berechneten Breiten und fasst je zwei Spalten
    // zusammen: eine Beschriftung ueber Soll und Ist, denn beide gehoeren
    // zum selben Bahnhof.
    _buildHeaderRow(widths) {
        const SPACING = 8;   // entspricht .db-row-top im Stylesheet
        let pair = (a, b) => widths[a] + SPACING + widths[b];
        let short = (n) => shortName(n);

        let spans = [
            ["ab " + (this._data ? short(this._data.from_name) : ""), pair(0, 1)],
            ["Linie", widths[2]],
            ["an " + (this._data ? short(this._data.to_name) : ""), pair(3, 4)]
        ];

        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let top = new St.BoxLayout({ style_class: "db-row-top" });
        for (let [text, w] of spans) {
            let label = new St.Label({ text: text, style_class: "db-colhead" });
            label.set_width(w);
            top.add_child(label);
        }
        item.addActor(top, { span: -1 });
        return item;
    }

    _buildRow(c) {
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        let box = new St.BoxLayout({ vertical: true, style_class: "db-row" });

        // Feste Spaltenbreiten kommen aus dem Stylesheet. Nur die Linienspalte
        // ist elastisch (x_expand) und kuerzt notfalls -- sonst schiebt ein
        // langes "RE4 + S1 + RB48" die Ankunftszeit aus der Flucht.
        let top = new St.BoxLayout({ style_class: "db-row-top" });

        let cells = [
            new St.Label({
                text: c.dep,
                style_class: c.cancelled ? "db-time db-cancelled" : "db-time"
            }),
            // Statt "+19" die Zeit, zu der es wirklich losgeht. Die Farbe
            // traegt die Dringlichkeit, die Planzeit steht links daneben --
            // das ist die Schreibweise der Bahnsteiganzeigen, und es erspart
            // das Kopfrechnen.
            new St.Label({
                text: c.dep_delay > 0 ? c.dep_real : "",
                style_class: "db-delay " + this._delayStyle(c.dep_delay)
            }),
            // Bei drei Abschnitten wird der Trenner knapper -- "RE4+S1+RB48"
            // laesst die Linienspalte sonst unnoetig breit werden.
            new St.Label({
                text: c.lines.join(c.lines.length > 2 ? "+" : " + "),
                style_class: "db-line"
            }),
            new St.Label({ text: c.arr, style_class: "db-arrive" }),
            // "≈" nur, wenn die Ankunft aus der Abfahrtsverspaetung
            // hochgerechnet ist statt gemeldet.
            new St.Label({
                text: c.arr_delay > 0
                    ? (c.arr_estimated ? "≈" : "") + c.arr_real
                    : "",
                style_class: "db-arrive-delay " + this._delayStyle(c.arr_delay)
            })
        ];
        for (let cell of cells) {
            cell.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            top.add_child(cell);
        }

        box.add_child(top);

        let bits = [];
        if (c.platform) {
            bits.push((c.track_changed ? "Gleiswechsel → " : "Gleis ") + c.platform);
        }
        bits.push(c.duration + " min");
        bits.push(c.transfers ? c.transfers + "× umsteigen" : "direkt");

        let mins = Math.round((c.dep_ts + c.dep_delay * 60 - Date.now() / 1000) / 60);
        if (mins >= 0 && mins < 90) bits.push("in " + mins + " min");

        box.add_child(new St.Label({
            text: bits.join("  ·  "),
            style_class: c.track_changed ? "db-sub db-sub-warn" : "db-sub"
        }));

        if (c.cancelled) {
            box.add_child(new St.Label({ text: "Fällt aus", style_class: "db-alert" }));
        }
        for (let m of c.messages) {
            box.add_child(new St.Label({ text: m, style_class: "db-alert" }));
        }

        item.addActor(box, { span: -1 });
        return { item: item, cells: cells };
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new DbPendler(metadata, orientation, panelHeight, instanceId);
}
