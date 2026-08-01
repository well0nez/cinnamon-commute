# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
