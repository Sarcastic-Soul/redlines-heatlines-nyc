// Rebuilds / checks the two data files from their public sources.
//   node scripts/prepare-data.mjs          check only, prints differences
//   node scripts/prepare-data.mjs --write  overwrite public/data/holc_nyc.json and refresh HVI scores
// Then run: node scripts/build-stats.mjs
//
// Sources
//   HOLC polygons : Mapping Inequality, https://dsl.richmond.edu/panorama/redlining/ (CC BY-NC-SA 4.0)
//   Heat scores   : NYC Open Data "Heat Vulnerability Index Rankings" (NYC Health Department), dataset 4mhf-duep
//   ZIP polygons  : 2020 ZIP code tabulation area boundaries already in public/data/zcta_hvi.json
import { readFileSync, writeFileSync } from 'node:fs';

const write = process.argv.includes('--write');
const file = (f) => new URL(`../public/data/${f}`, import.meta.url);
const BOROUGHS = new Set(['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island']);

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

// 1. HOLC polygons: the five boroughs, with the fields the app uses.
const source = await getJson('https://dsl.richmond.edu/panorama/redlining/static/mappinginequality.json');
const holc = {
  type: 'FeatureCollection',
  features: source.features
    .filter((f) => f.properties.state === 'NY' && BOROUGHS.has(f.properties.city))
    .map((f) => ({
      type: 'Feature',
      properties: {
        area_id: Number(f.properties.area_id),
        city: f.properties.city,
        grade: f.properties.grade,
        label: f.properties.label,
        category: f.properties.category,
        fill: f.properties.fill,
      },
      geometry: f.geometry,
    })),
};
const current = JSON.parse(readFileSync(file('holc_nyc.json')));
console.log(`HOLC: source gives ${holc.features.length} NYC polygons, repo has ${current.features.length}`);
if (write) writeFileSync(file('holc_nyc.json'), JSON.stringify(holc));

// 2. Heat scores by ZIP.
const rows = await getJson('https://data.cityofnewyork.us/resource/4mhf-duep.json?$limit=1000');
const hviByZip = new Map(rows.map((r) => [String(r.zcta20), Number(r.hvi)]));
const zcta = JSON.parse(readFileSync(file('zcta_hvi.json')));
let diff = 0;
let missing = 0;
for (const z of zcta.features) {
  const v = hviByZip.get(z.properties.zcta5);
  if (v === undefined) missing += 1;
  else if (v !== z.properties.hvi) {
    diff += 1;
    if (write) z.properties.hvi = v;
  }
}
console.log(`HVI: ${rows.length} scores from the API, ${zcta.features.length} ZIP polygons, ${diff} score differences, ${missing} ZIPs without a score`);
if (write) writeFileSync(file('zcta_hvi.json'), JSON.stringify(zcta));
