import React, { useCallback, useEffect, useRef, useState } from 'react';
import Map, { type MapRef, Marker, Source, Layer, Popup, NavigationControl, ScaleControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { MagnifyingGlass, X, WarningCircle } from '@phosphor-icons/react';
import { AWS_LOCATION_API_KEY, MAP_STYLE_URL, USING_AWS_BASEMAP } from './config';
import './App.css';

const NYC_CENTER = { longitude: -73.95, latitude: 40.72, zoom: 9.5 };
const NYC_BOUNDS = { minLng: -74.3, maxLng: -73.65, minLat: 40.45, maxLat: 40.95 };
const EXAMPLES = [
  { label: 'Harlem', q: 'Harlem, New York' },
  { label: 'South Bronx', q: 'Mott Haven, Bronx, New York' },
  { label: 'Bed-Stuy', q: 'Bedford-Stuyvesant, Brooklyn, New York' },
  { label: 'Park Slope', q: 'Park Slope, Brooklyn, New York' },
];
const DATA_BASE = import.meta.env.BASE_URL + 'data';

const HOLC_FILL_COLORS: Record<string, string> = {
  A: '#76a865',
  B: '#7cb5bd',
  C: '#ffff00',
  D: '#d9838d',
  E: '#cccccc',
};

// index 0 unused. Sepia ramp so heat reads apart from the HOLC green/blue/yellow/pink.
const HVI_COLORS = ['#f7f7f7', '#efe7d8', '#d3c19d', '#a98f66', '#715a3d', '#3a2b1c'];
const GRADES = ['A', 'B', 'C', 'D'] as const;
// index 0 unused; hvi 1..5

const gradeLabel: Record<string, string> = {
  A: 'A — Best',
  B: 'B — Still Desirable',
  C: 'C — Definitely Declining',
  D: 'D — Hazardous',
};

const hviLabel = (v: number) =>
  ['Lowest', 'Low', 'Moderate', 'High', 'Highest'][v - 1] || String(v);

interface HolcFeature {
  properties: { area_id: number; city: string; grade: string; label: string; category: string; fill: string };
  geometry: any;
}

interface ZctaFeature {
  properties: { zcta5: string; hvi: number };
  geometry: any;
}

interface Stats {
  grades: Record<string, { zones: number; areaKm2: number; pctHigh: number }>;
  allGradedPctHigh: number;
  zipsTotal: number;
  zipsHigh: number;
}

interface ClickInfo {
  lngLat: [number, number];
  holc?: HolcFeature | null;
  zcta?: ZctaFeature | null;
}

export default function App() {
  const [holcData, setHolcData] = useState<any>(null);
  const [zctaData, setZctaData] = useState<any>(null);
  const [showHOLC, setShowHOLC] = useState(true);
  const [showHVI, setShowHVI] = useState(true);
  const [holcOpacity, setHolcOpacity] = useState(0.35);
  const [hviOpacity, setHviOpacity] = useState(0.55);
  const [address, setAddress] = useState('');
  const [marker, setMarker] = useState<{ lng: number; lat: number; label: string } | null>(null);
  const [clickInfo, setClickInfo] = useState<ClickInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const mapRef = useRef<MapRef>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const load = (file: string, set: (d: any) => void) =>
      fetch(`${DATA_BASE}/${file}`)
        .then((r) => {
          if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
          return r.json();
        })
        .then(set)
        .catch((err) => setLoadError(err.message || 'Could not load map data'));
    load('holc_nyc.json', setHolcData);
    load('zcta_hvi.json', setZctaData);
    load('stats.json', setStats);
  }, []);

  const findContaining = useCallback(
    (lng: number, lat: number) => {
      const pt = point([lng, lat]);
      const holc = (holcData?.features as HolcFeature[] | undefined)?.find((f) =>
        booleanPointInPolygon(pt, f as any)
      );
      const zcta = (zctaData?.features as ZctaFeature[] | undefined)?.find((z) =>
        booleanPointInPolygon(pt, z as any)
      );
      return { holc: holc ?? null, zcta: zcta ?? null };
    },
    [holcData, zctaData]
  );

  const select = useCallback(
    (lng: number, lat: number, label: string | null, fly = true) => {
      setMarker(label ? { lng, lat, label } : null);
      const { holc, zcta } = findContaining(lng, lat);
      setClickInfo({ lngLat: [lng, lat], holc, zcta });
      if (fly) mapRef.current?.flyTo({ center: [lng, lat], zoom: Math.max(mapRef.current.getZoom(), 13.5), duration: 1400 });
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('lat', lat.toFixed(5));
        u.searchParams.set('lng', lng.toFixed(5));
        window.history.replaceState(null, '', u);
      } catch {
        /* history can be blocked in sandboxed frames */
      }
    },
    [findContaining]
  );

  // restore a shared point (?lat=&lng=) once the polygons are loaded
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !holcData || !zctaData) return;
    restored.current = true;
    const q = new URLSearchParams(window.location.search);
    const lat = parseFloat(q.get('lat') || '');
    const lng = parseFloat(q.get('lng') || '');
    if (Number.isFinite(lat) && Number.isFinite(lng)) select(lng, lat, null);
  }, [holcData, zctaData, select]);

  const runSearch = async (query: string) => {
    if (!query.trim()) return;
    if (!AWS_LOCATION_API_KEY) {
      setSearchError('Address search is not configured (missing VITE_AWS_LOCATION_API_KEY)');
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(
        'https://places.geo.us-east-1.amazonaws.com/v2/search-text?key=' + encodeURIComponent(AWS_LOCATION_API_KEY),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            QueryText: query,
            BiasPosition: [-73.95, 40.72],
            Filter: { IncludeCountries: ['USA'] },
            MaxResults: 1,
          }),
        }
      );
      if (!res.ok) throw new Error(`Address search is unavailable right now (HTTP ${res.status})`);
      const json = await res.json();
      const item = json.ResultItems?.[0];
      if (!item) throw new Error('No match for that address');
      const pos = item.Position || item.Geometry?.Point;
      if (!pos) throw new Error('That match has no location');
      const [lng, lat] = pos;
      if (lng < NYC_BOUNDS.minLng || lng > NYC_BOUNDS.maxLng || lat < NYC_BOUNDS.minLat || lat > NYC_BOUNDS.maxLat) {
        throw new Error('That address is outside New York City');
      }
      select(lng, lat, item.Title || item.Address?.Label || query);
    } catch (err: any) {
      setSearchError(err.message || 'Address search failed');
    } finally {
      setSearching(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    runSearch(address);
  };

  const handleMapClick = useCallback(
    (e: any) => {
      if (!e.lngLat) return;
      setMarker(null);
      select(e.lngLat.lng, e.lngLat.lat, null, false);
    },
    [select]
  );

  const pctHigh = (g: string) => stats?.grades[g]?.pctHigh ?? 0;

  const loading = !loadError && (!holcData || !zctaData);

  return (
    <div className="app">
      <a className="skip" href="#map">Skip to map</a>
      <header className="top">
        <div className="title">
          <h1>Redlines <span aria-hidden="true">&rarr;</span><span className="sr"> to </span> Heatlines</h1>
          <p>1930s HOLC redlining grades against today's Heat Vulnerability Index, New York City</p>
        </div>
        <form className="search" onSubmit={handleSearch} role="search">
          <label htmlFor="addr" className="sr">Search a New York City address</label>
          <MagnifyingGlass size={18} aria-hidden="true" className="search-icon" />
          <input
            id="addr"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Search an NYC address"
            autoComplete="off"
          />
          <button type="submit" disabled={searching}>{searching ? 'Searching' : 'Find'}</button>
        </form>
        <div className="examples">
          <span>Try</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.label} type="button" disabled={searching} onClick={() => { setAddress(ex.q); runSearch(ex.q); }}>{ex.label}</button>
          ))}
        </div>
      </header>

      <div className="main">
        <aside className="panel" aria-label="Map controls and findings">
          {searchError && (
            <p className="alert" role="alert">
              <WarningCircle size={18} aria-hidden="true" /> {searchError}.
            </p>
          )}

          {clickInfo && (
            <section className="here" aria-live="polite">
              <div className="here-head">
                <h2>At this point</h2>
                <button className="icon-btn" onClick={() => setClickInfo(null)} aria-label="Clear selected point">
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
              <p className="coords">{clickInfo.lngLat[1].toFixed(4)}, {clickInfo.lngLat[0].toFixed(4)}</p>
              {marker && <p className="found">{marker.label}</p>}
              {clickInfo.holc ? (
                clickInfo.holc.properties.grade && gradeLabel[clickInfo.holc.properties.grade] ? (
                  <p>
                    <span className="chip" style={{ background: HOLC_FILL_COLORS[clickInfo.holc.properties.grade] }} />
                    <strong>Grade {clickInfo.holc.properties.grade}</strong>, {gradeLabel[clickInfo.holc.properties.grade].split(' — ')[1]} ({clickInfo.holc.properties.label}) in {clickInfo.holc.properties.city}
                  </p>
                ) : (
                  <p>
                    <span className="chip" style={{ background: HOLC_FILL_COLORS.E }} />
                    <strong>Ungraded zone</strong>{clickInfo.holc.properties.category ? `, ${clickInfo.holc.properties.category.trim().toLowerCase()}` : ''} in {clickInfo.holc.properties.city}
                  </p>
                )
              ) : (
                <p className="muted">Outside any mapped 1930s HOLC zone.</p>
              )}
              {clickInfo.zcta ? (
                <p>
                  <span className="chip" style={{ background: HVI_COLORS[clickInfo.zcta.properties.hvi] }} />
                  <strong>Heat vulnerability {clickInfo.zcta.properties.hvi} of 5</strong> ({hviLabel(clickInfo.zcta.properties.hvi).toLowerCase()}), ZIP {clickInfo.zcta.properties.zcta5}
                </p>
              ) : (
                <p className="muted">No heat vulnerability zone here.</p>
              )}
            </section>
          )}

          <section aria-labelledby="h-layers">
            <h2 id="h-layers">Layers</h2>
            <div className="layer">
              <label className="check">
                <input type="checkbox" checked={showHOLC} onChange={(e) => setShowHOLC(e.target.checked)} />
                <span>HOLC redlining, 1930s</span>
              </label>
              <label className="slider">
                <span className="sr">HOLC opacity</span>
                <input type="range" min={0} max={1} step={0.01} value={holcOpacity} disabled={!showHOLC} onChange={(e) => setHolcOpacity(+e.target.value)} />
                <output>{Math.round(holcOpacity * 100)}%</output>
              </label>
            </div>
            <div className="layer">
              <label className="check">
                <input type="checkbox" checked={showHVI} onChange={(e) => setShowHVI(e.target.checked)} />
                <span>Heat Vulnerability Index, today</span>
              </label>
              <label className="slider">
                <span className="sr">Heat vulnerability opacity</span>
                <input type="range" min={0} max={1} step={0.01} value={hviOpacity} disabled={!showHVI} onChange={(e) => setHviOpacity(+e.target.value)} />
                <output>{Math.round(hviOpacity * 100)}%</output>
              </label>
            </div>
          </section>

          <section aria-labelledby="h-story">
            <h2 id="h-story">What the overlap shows</h2>
            {stats ? (
              <>
                <p className="lede">
                  <strong>{pctHigh('D')}%</strong> of the land the 1930s map graded D (hazardous) is in a high heat vulnerability ZIP today, against <strong>{pctHigh('A')}%</strong> of the land graded A. Across all graded land it is {stats.allGradedPctHigh}%.
                </p>
                <ul className="bars">
                  {GRADES.map((g) => (
                    <li key={g}>
                      <span className="chip" style={{ background: HOLC_FILL_COLORS[g] }} />
                      <span className="bar-label">{g}<small>{stats.grades[g].zones} zones</small></span>
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${pctHigh(g)}%` }} />
                        <span className="bar-base" style={{ left: `${stats.allGradedPctHigh}%` }} title="All graded land" />
                      </span>
                      <span className="bar-num">{pctHigh(g)}%</span>
                    </li>
                  ))}
                </ul>
                <p className="note">
                  Bars show the share of each grade's land area inside ZIPs scored 4 or 5 (the tick marks the {stats.allGradedPctHigh}% average). {stats.zipsHigh} of {stats.zipsTotal} ZIPs score 4 or 5, so a grade has to beat that to say much. Grade A is only 16 small zones. ZIP scores are coarser than the 1930s zones, and the link is a correlation, not proof of cause.
                </p>
              </>
            ) : (
              <div className="skeleton" aria-hidden="true"><i /><i /><i /><i /></div>
            )}
          </section>

          <section aria-labelledby="h-legend">
            <h2 id="h-legend">Legend</h2>
            <h3>HOLC grade, 1930s</h3>
            <ul className="legend">
              {GRADES.map((g) => (
                <li key={g}><span className="chip" style={{ background: HOLC_FILL_COLORS[g] }} />{gradeLabel[g].replace(' — ', ', ')}</li>
              ))}
            </ul>
            <h3>Heat vulnerability by ZIP, 1 to 5</h3>
            <div className="ramp" role="img" aria-label="Five step scale from 1, lowest, to 5, highest">
              {[1, 2, 3, 4, 5].map((v) => (<span key={v} style={{ background: HVI_COLORS[v] }}>{v}</span>))}
            </div>
            <div className="ramp-ends"><span>Lowest</span><span>Highest</span></div>
          </section>

          <footer className="sources">
            <p>
              <strong>Redlining:</strong> Mapping Inequality, Univ. of Richmond and partners (HOLC maps, 1930s), CC BY-NC-SA 4.0. {holcData ? holcData.features.length : ''} polygons across the five boroughs.
            </p>
            <p>
              <strong>Heat:</strong> NYC Health Department Heat Vulnerability Index, 1 (lowest) to 5 (highest), by ZIP code tabulation area ({zctaData ? zctaData.features.length : ''} areas).
            </p>
            <p>
              <strong>AWS:</strong> address search runs on Amazon Location Service{USING_AWS_BASEMAP ? ', as does the basemap' : ''}. Data files are served from Amazon S3 through CloudFront.
            </p>
          </footer>
        </aside>

        <main id="map" className="map" tabIndex={-1}>
          {loading && <div className="status" role="status">Loading map data</div>}
          {loadError && <div className="status err" role="alert">Could not load the map data ({loadError}). Reload the page to try again.</div>}
          <Map
            ref={mapRef}
            initialViewState={NYC_CENTER}
            scrollZoom
            style={{ width: '100%', height: '100%' }}
            mapStyle={MAP_STYLE_URL}
            onClick={handleMapClick}
            onMouseMove={(e) => {
              const f = e.features?.find((x) => x.layer.id === 'holc-fill');
              setHoverId(f ? (f.properties?.area_id as number) : null);
            }}
            onMouseLeave={() => setHoverId(null)}
            cursor={hoverId !== null ? 'pointer' : ''}
            interactiveLayerIds={['holc-fill', 'hvi-fill']}
            minZoom={8}
            maxZoom={17}
          >
            <NavigationControl position="top-right" showCompass={false} />
            <ScaleControl position="bottom-right" unit="imperial" />
            {zctaData && showHVI && (
              <Source id="hvi" type="geojson" data={zctaData}>
                <Layer
                  id="hvi-fill"
                  type="fill"
                  paint={{
                    'fill-color': [
                      'interpolate', ['linear'], ['get', 'hvi'],
                      1, HVI_COLORS[1], 2, HVI_COLORS[2], 3, HVI_COLORS[3], 4, HVI_COLORS[4], 5, HVI_COLORS[5],
                    ],
                    'fill-opacity': hviOpacity,
                  }}
                />
                <Layer id="hvi-outline" type="line" paint={{ 'line-color': '#555', 'line-width': 0.5, 'line-opacity': 0.6 }} />
              </Source>
            )}

            {holcData && showHOLC && (
              <Source id="holc" type="geojson" data={holcData}>
                <Layer id="holc-fill" type="fill" paint={{ 'fill-color': ['get', 'fill'], 'fill-opacity': holcOpacity }} />
                <Layer
                  id="holc-outline"
                  type="line"
                  paint={{ 'line-color': ['match', ['get', 'grade'], 'A', '#3f7a31', 'B', '#2f7f8c', 'C', '#a89500', 'D', '#b0394c', '#777'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 14, 2.2], 'line-opacity': 0.95 }}
                />
                <Layer
                  id="holc-hover"
                  type="line"
                  filter={['==', ['get', 'area_id'], hoverId ?? -1]}
                  paint={{ 'line-color': '#26211c', 'line-width': 3 }}
                />
              </Source>
            )}

            {marker && <Marker longitude={marker.lng} latitude={marker.lat} color="#a8412c" />}

            {clickInfo && (
              <Popup
                longitude={clickInfo.lngLat[0]}
                latitude={clickInfo.lngLat[1]}
                onClose={() => setClickInfo(null)}
                closeOnClick={false}
              >
                <div className="pop">
                  {clickInfo.holc && <div>{clickInfo.holc.properties.grade ? <>HOLC grade <strong>{clickInfo.holc.properties.grade}</strong> · {clickInfo.holc.properties.label}</> : <>Ungraded HOLC zone</>}</div>}
                  {clickInfo.zcta && <div>Heat vulnerability <strong>{clickInfo.zcta.properties.hvi}</strong> · {hviLabel(clickInfo.zcta.properties.hvi)}</div>}
                  {!clickInfo.holc && !clickInfo.zcta && <div>No data at this point</div>}
                </div>
              </Popup>
            )}
          </Map>
        </main>
      </div>
    </div>
  );
}
