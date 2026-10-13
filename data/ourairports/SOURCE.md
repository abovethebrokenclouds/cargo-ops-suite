# OurAirports snapshot

- Fetched: 2026-10-13
- Source: https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv, https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv
- Project: https://github.com/davidmegginson/ourairports-data (data documentation: https://ourairports.com/data/)
- License: public domain (the repository's LICENSE is the Unlicense). Credit to OurAirports is appreciated and given here and in the app.

The CSVs in this folder are ignored by git. `scripts/refresh-airports.mjs` regenerates
`src/assets/data/airports-major.json` (committed): `large_airport` and `medium_airport` rows
only (5280 airports), with the longest open runway and its surface
joined from `runways.csv`. Coordinates are rounded to 4 decimals (about 11 m).
