# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-02

### Added

- A compact form for the panel. A middle-click removes the text and leaves a
  train icon, and a second middle-click brings the text back. The applet keeps
  the choice, also after a restart. The width goes from 143 pixels to 28.

  The icon still reports a delay, because it takes the colour that the text
  would have. A departure that is 20 minutes away is not news at 14:00, but a
  cancellation is news at any hour. The tooltip continues to give the full
  departure, and the menu is unchanged.

- A symbolic train icon in the applet. No icon theme on the test system has
  one: Papirus offers only a coloured map marker, which looks foreign in a
  panel. The icon ships with the applet and takes the colour of the panel
  text.

## [1.0.2] - 2026-08-02

### Added

- The menu now shows the real time next to the scheduled time. A delayed
  train gives two times, and the second one is red. Before this the applet
  showed `00:35 +19`, and the reader had to do the addition. The column
  header names the station once and covers both times, so the table needs no
  extra column.

### Fixed

- An arrival can no longer be on time when the departure is late and the
  journey is too short to recover the delay. The departure delay comes from
  IRIS, but the arrival prognosis comes from MOTIS, and the two contradicted
  each other. One ICE left 19 minutes late on a 21-minute run and still
  claimed a punctual arrival.

  A train can recover time, because the timetable holds a buffer. The applet
  therefore replaces the arrival only when the recovery is not possible: more
  than 20 percent of the journey time, and at least two minutes. A calculated
  arrival gets the prefix `≈`, and the tooltip says where the value comes
  from.

## [1.0.1] - 2026-08-02

### Fixed

- The applet now finds long-distance trains and S-Bahn trains on the IRIS
  board. It read the train number from the brackets in the MOTIS line name,
  for example `RB48 (17381)`. An ICE has no brackets, because its number is
  its name, and an S-Bahn sends no number at all. Both groups therefore got
  no platform and no delay from IRIS. The applet now also matches on the
  scheduled departure time together with the line name.

  The effect is large. On the route Köln Hbf to Düsseldorf Hbf the platform
  count went from five of eight connections to eight of eight. One ICE showed
  two minutes early from the open feed, while IRIS reported a delay of 19
  minutes with two reasons.

- The geocoder returned the wrong station for a name that ends in `Hbf`. A
  general preference for the DELFI feed overruled the relevance order of the
  service, so `Köln Hbf` became `Stolberg, Hauptbahnhof (Bus)`. The feed now
  decides only between stations with the same name.

- The short name in the panel took the last word of the station name. `Köln
  Hbf` became `Hbf`. The applet now removes the brackets and the station
  suffix first, and it keeps the word that names the place.

## [1.0.0] - 2026-08-02

The first release.

### Added

- A panel applet that shows the next departure between two stations. The text
  names the start station, so that the time cannot read as an arrival.
- A menu with the next connections. Each row gives the departure, the delay,
  the line, the arrival, the platform, the travel time and the transfers.
- Column headers that name the station for each time column.
- A menu entry that swaps the two stations and keeps the new direction.
- Journey planning through Transitous, with transfers.
- Delay and platform data from db-infoscreen, which reads IRIS. The applet
  falls back to the Transitous values when db-infoscreen does not answer.
- A rolling list. Departed trains leave the list every 20 seconds, without a
  request to the servers.
- Colour for the delay: amber below the threshold, red above it, and a warning
  sign for a cancelled train.
- Four formats for the panel text, in the settings.
- Column widths that the applet measures at runtime, so that the table stays
  aligned with any font and any line name.
- A reserved width for the two delay columns, so that the table does not move
  when a delay appears.

### Notes on the data

- Times from MOTIS arrive in UTC. The helper converts them to `Europe/Berlin`.
- The platform comes from IRIS only. MOTIS gives internal DELFI codes at some
  stations, and these codes appear on no platform sign.
- IRIS keeps two boards for some stations. The helper compares train numbers to
  find the board that holds your trains, and it stores the result.

### Request limits

- The minimum interval is 60 seconds.
- A cache per station permits one request per station per minute, also when you
  switch the direction quickly.
- The search for the station name stops at the first board that matches.
