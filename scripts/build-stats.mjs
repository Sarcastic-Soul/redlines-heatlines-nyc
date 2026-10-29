// Area-weighted overlap of 1930s HOLC zones with 2020s heat vulnerability (ZCTA) zones.
// Reads public/data/holc_nyc.json and public/data/zcta_hvi.json, writes public/data/stats.json.
// Run: node scripts/build-stats.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { area, bbox, featureCollection, intersect } from '@turf/turf';

const read = (f) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url)));
const holc = read('holc_nyc.json').features;
const zcta = read('zcta_hvi.json').features;

const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const zBoxes = zcta.map((z) => bbox(z));

const grades = ['A', 'B', 'C', 'D'];
const out = Object.fromEntries(grades.map((g) => [g, { zones: 0, areaKm2: 0, highAreaKm2: 0 }]));
const hviSplit = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

for (const f of holc) {
  const g = f.properties.grade;
  if (!out[g]) continue;
  out[g].zones += 1;
  const fb = bbox(f);
  zcta.forEach((z, i) => {
    if (!overlaps(fb, zBoxes[i])) return;
    let part;
    try {
      part = intersect(featureCollection([f, z]));
    } catch {
      return;
    }
    if (!part) return;
    const km2 = area(part) / 1e6;
    out[g].areaKm2 += km2;
    hviSplit[z.properties.hvi] += km2;
    if (z.properties.hvi >= 4) out[g].highAreaKm2 += km2;
  });
}

const totalArea = grades.reduce((n, g) => n + out[g].areaKm2, 0);
const totalHigh = grades.reduce((n, g) => n + out[g].highAreaKm2, 0);
const result = {
  method: 'Share of each HOLC grade\'s land area (km2) that falls inside ZIP zones scored 4 or 5 on the heat vulnerability index.',
  grades: Object.fromEntries(
    grades.map((g) => [
      g,
      {
        zones: out[g].zones,
        areaKm2: +out[g].areaKm2.toFixed(2),
        pctHigh: out[g].areaKm2 ? +((out[g].highAreaKm2 / out[g].areaKm2) * 100).toFixed(1) : 0,
      },
    ])
  ),
  allGradedPctHigh: +((totalHigh / totalArea) * 100).toFixed(1),
  zipsTotal: zcta.length,
  zipsHigh: zcta.filter((z) => z.properties.hvi >= 4).length,
};
writeFileSync(new URL('../public/data/stats.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
