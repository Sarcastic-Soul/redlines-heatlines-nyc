import React, { useCallback, useEffect, useRef, useState } from 'react';
import Map, { type MapRef, type MapLayerMouseEvent, Marker, Source, Layer, Popup, NavigationControl, ScaleControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { MagnifyingGlass, X, WarningCircle, Crosshair, LinkSimple, ArrowRight } from '@phosphor-icons/react';
import { AWS_LOCATION_API_KEY, MAP_STYLE_URL, USING_AWS_BASEMAP } from './config';
import './App.css';

const NYC_CENTER = { longitude: -73.95, latitude: 40.72, zoom: 9.5 };
const NYC_BOUNDS = { minLng: -74.3, maxLng: -73.65, minLat: 40.45, maxLat: 40.95 };
const DATA_BASE = import.meta.env.BASE_URL + 'data';
const PLACES_URL = 'https://places.geo.us-east-1.amazonaws.com/v2';
const MOBILE_MAX = 860;

const HOLC_FILL_COLORS: Record<string, string> = {
  A: '#76a865',
  B: '#7cb5bd',
  C: '#ffff00',
  D: '#d9838d',
  E: '#cccccc',
};
const UNGRADED = '#cccccc';

// index 0 unused. Sepia ramp so heat reads apart from the HOLC green/blue/yellow/pink.
const HVI_COLORS = ['#f7f7f7', '#efe7d8', '#d3c19d', '#a98f66', '#715a3d', '#3a2b1c'];
const GRADES = ['A', 'B', 'C', 'D'] as const;

const gradeLabel: Record<string, string> = {
  A: 'A — Best',
  B: 'B — Still Desirable',
  C: 'C — Definitely Declining',
  D: 'D — Hazardous',
};

const hviLabel = (v: number) => ['Lowest', 'Low', 'Moderate', 'High', 'Highest'][v - 1] || String(v);

type Mode = 'holc' | 'hvi' | 'both';
const MODES: { id: Mode; label: string }[] = [
  { id: 'holc', label: 'Redlining' },
  { id: 'hvi', label: 'Heat' },
  { id: 'both', label: 'Both' },
];

interface TourStop {
  label: string;
  lng: number;
  lat: number;
  title: string;
  note: string;
}

// Each stop is a polygon centre taken from the data; the notes only state what the two layers show.
const TOUR: TourStop[] = [
  {
    label: 'East New York',
    lng: -73.8854,
    lat: 40.6683,
    title: 'East New York, Brooklyn',
    note: 'Graded D in the 1930s, and ZIP 11207 scores 5 of 5 for heat vulnerability today.',
  },
  {
    label: 'South Bronx',
    lng: -73.9105,
    lat: 40.8144,
    title: 'South Bronx (Morrisania)',
    note: 'Another grade D zone sitting in a 5 of 5 ZIP (10455). All grade D land in the Bronx is in high heat ZIPs.',
  },
  {
    label: 'Central Harlem',
    lng: -73.9462,
    lat: 40.8151,
    title: 'Central Harlem, Manhattan',
    note: 'Grade D, heat 5 of 5 (ZIP 10030). The pattern is weaker in Manhattan than in the Bronx or Brooklyn, but this zone follows it.',
  },
  {
    label: 'Riverdale',
    lng: -73.9132,
    lat: 40.8962,
    title: 'Riverdale, Bronx',
    note: 'The best grade, A, and the lowest heat score, 1 of 5 (ZIP 10471). Few places got that grade.',
  },
  {
    label: 'Park Slope',
    lng: -73.993,
    lat: 40.6645,
    title: 'Park Slope, Brooklyn (a counterexample)',
    note: 'Graded D in the 1930s, yet ZIP 11215 scores 1 of 5 today. The link is a tendency, not a rule: ZIP scores are coarse and neighbourhoods change.',
  },
];

interface HolcFeature {
  properties: { area_id: number; city: string; grade: string | null; label: string; category: string; fill: string };
  geometry: any;
}

interface ZctaFeature {
  properties: { zcta5: string; hvi: number };
  geometry: any;
}

interface Stats {
  grades: Record<string, { zones: number; areaKm2: number; pctHigh: number }>;
  byBorough: Record<string, Record<string, { zones: number; pctHigh: number | null }>>;
  allGradedPctHigh: number;
  zipsTotal: number;
  zipsHigh: number;
}

interface ClickInfo {
  lngLat: [number, number];
  holc?: HolcFeature | null;
  zcta?: ZctaFeature | null;
  tour?: number | null;
}

interface Hover {
  holcId: number | null;
  grade: string | null;
  label: string | null;
  zip: string | null;
  hvi: number | null;
}

const BOROUGHS = ['Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island'];

const isMobile = () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX;

export default function App() {
  const [holcData, setHolcData] = useState<any>(null);
  const [zctaData, setZctaData] = useState<any>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>('both');
  const [holcOpacity, setHolcOpacity] = useState(0.25);
  const [hviOpacity, setHviOpacity] = useState(0.6);
  const [address, setAddress] = useState('');
  const [marker, setMarker] = useState<{ lng: number; lat: number; label: string } | null>(null);
  const [placeName, setPlaceName] = useState<string | null>(null);
  const [clickInfo, setClickInfo] = useState<ClickInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [copied, setCopied] = useState(false);
  const [legendOpen] = useState(() => !isMobile());
  const mapRef = useRef<MapRef>(null);
  const panelRef = useRef<HTMLElement>(null);
  const lookupToken = useRef(0);

  const showHOLC = mode !== 'hvi';
  const showHVI = mode !== 'holc';

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    setHolcOpacity(m === 'both' ? 0.25 : 0.55);
    setHviOpacity(m === 'both' ? 0.6 : 0.75);
  }, []);

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
      const holc = (holcData?.features as HolcFeature[] | undefined)?.find((f) => booleanPointInPolygon(pt, f as any));
      const zcta = (zctaData?.features as ZctaFeature[] | undefined)?.find((z) => booleanPointInPolygon(pt, z as any));
      return { holc: holc ?? null, zcta: zcta ?? null };
    },
    [holcData, zctaData]
  );

  // Amazon Location Service reverse geocode: turns the selected point into a street address.
  const lookupAddress = useCallback(async (lng: number, lat: number) => {
    if (!AWS_LOCATION_API_KEY) return;
    const token = ++lookupToken.current;
    try {
      const res = await fetch(`${PLACES_URL}/reverse-geocode?key=${encodeURIComponent(AWS_LOCATION_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ QueryPosition: [lng, lat], MaxResults: 1 }),
      });
      if (!res.ok) return;
      const json = await res.json();
      const title = json.ResultItems?.[0]?.Title;
      if (title && token === lookupToken.current) setPlaceName(title);
    } catch {
      /* the address line is a bonus; the zone info does not depend on it */
    }
  }, []);

  const select = useCallback(
    (lng: number, lat: number, opts: { label?: string | null; fly?: boolean; zoom?: number; tour?: number | null } = {}) => {
      const { label = null, fly = true, zoom = 13.5, tour = null } = opts;
      lookupToken.current += 1;
      setMarker(label ? { lng, lat, label } : null);
      setPlaceName(label);
      setCopied(false);
      const { holc, zcta } = findContaining(lng, lat);
      setClickInfo({ lngLat: [lng, lat], holc, zcta, tour });
      if (!label) lookupAddress(lng, lat);
      if (fly) {
        const map = mapRef.current;
        map?.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), zoom), duration: 1400 });
      }
      if (isMobile()) panelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('lat', lat.toFixed(5));
        u.searchParams.set('lng', lng.toFixed(5));
        if (label) u.searchParams.set('name', label.slice(0, 120));
        else u.searchParams.delete('name');
        window.history.replaceState(null, '', u);
      } catch {
        /* history can be blocked in sandboxed frames */
      }
    },
    [findContaining, lookupAddress]
  );

  const clearSelection = () => {
    lookupToken.current += 1;
    setClickInfo(null);
    setMarker(null);
    setPlaceName(null);
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('lat');
      u.searchParams.delete('lng');
      u.searchParams.delete('name');
      window.history.replaceState(null, '', u);
    } catch {
      /* ignore */
    }
  };

  // restore a shared point (?lat=&lng=) once the polygons are loaded
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !holcData || !zctaData) return;
    restored.current = true;
    const q = new URLSearchParams(window.location.search);
    const lat = parseFloat(q.get('lat') || '');
    const lng = parseFloat(q.get('lng') || '');
    if (Number.isFinite(lat) && Number.isFinite(lng)) select(lng, lat, { label: q.get('name') });
  }, [holcData, zctaData, select]);

  const goToStop = (i: number) => {
    const stop = TOUR[i];
    setMode('both');
    select(stop.lng, stop.lat, { fly: true, zoom: 12.8, tour: i });
  };

  const runSearch = async (query: string) => {
    if (!query.trim()) return;
    if (!AWS_LOCATION_API_KEY) {
      setSearchError('Address search is not configured (missing VITE_AWS_LOCATION_API_KEY)');
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`${PLACES_URL}/search-text?key=${encodeURIComponent(AWS_LOCATION_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          QueryText: query,
          BiasPosition: [-73.95, 40.72],
          Filter: { IncludeCountries: ['USA'] },
          MaxResults: 1,
        }),
      });
      if (!res.ok) throw new Error(`Address search is unavailable right now (HTTP ${res.status})`);
      const json = await res.json();
      const item = json.ResultItems?.[0];
      if (!item) throw new Error('No match for that address');
      const pos = item.Position || item.Geometry?.Point;
      if (!pos) throw new Error('That match has no location');
      const [lng, lat] = pos;
      const region = item.Address?.Region?.Code;
      const outside =
        lng < NYC_BOUNDS.minLng || lng > NYC_BOUNDS.maxLng || lat < NYC_BOUNDS.minLat || lat > NYC_BOUNDS.maxLat || (region && region !== 'NY');
      if (outside) throw new Error('That address is outside New York City');
      select(lng, lat, { label: item.Title || item.Address?.Label || query });
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
    (e: MapLayerMouseEvent) => {
      if (!e.lngLat) return;
      select(e.lngLat.lng, e.lngLat.lat, { fly: false });
    },
    [select]
  );

  const inspectCentre = () => {
    const c = mapRef.current?.getCenter();
    if (c) select(c.lng, c.lat, { fly: false });
  };

  const handleMove = (e: MapLayerMouseEvent) => {
    const holcF = e.features?.find((x) => x.layer.id === 'holc-fill');
    const hviF = e.features?.find((x) => x.layer.id === 'hvi-fill');
    const next: Hover | null =
      holcF || hviF
        ? {
            holcId: holcF ? (holcF.properties?.area_id as number) : null,
            grade: holcF ? ((holcF.properties?.grade as string) || null) : null,
            label: holcF ? ((holcF.properties?.label as string) || null) : null,
            zip: hviF ? (hviF.properties?.zcta5 as string) : null,
            hvi: hviF ? (hviF.properties?.hvi as number) : null,
          }
        : null;
    setHover((prev) =>
      prev && next && prev.holcId === next.holcId && prev.zip === next.zip ? prev : prev === null && next === null ? prev : next
    );
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setSearchError('Could not copy the link. Copy it from the address bar instead');
    }
  };

  const pctHigh = (g: string) => stats?.grades[g]?.pctHigh ?? 0;
  const loading = !loadError && (!holcData || !zctaData || !stats);

  // boroughs where grade D does not have the highest heat share
  const exceptions = stats
    ? BOROUGHS.filter((b) => {
        const row = stats.byBorough[b];
        if (!row) return false;
        const d = row.D?.pctHigh ?? 0;
        return GRADES.some((g) => g !== 'D' && row[g]?.zones && (row[g].pctHigh ?? 0) > d);
      })
    : [];

  const interactiveIds = [...(showHOLC ? ['holc-fill'] : []), ...(showHVI ? ['hvi-fill'] : [])];
  const tourStop = clickInfo?.tour != null ? TOUR[clickInfo.tour] : null;
  const holcProps = clickInfo?.holc?.properties;

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
          <input id="addr" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Search an NYC address" autoComplete="off" />
          <button type="submit" disabled={searching}>{searching ? 'Searching' : 'Find'}</button>
        </form>
        <nav className="examples" aria-label="Guided tour">
          <span>Tour</span>
          {TOUR.map((s, i) => (
            <button key={s.label} type="button" aria-pressed={clickInfo?.tour === i} onClick={() => goToStop(i)}>{s.label}</button>
          ))}
        </nav>
      </header>

      <div className="main">
        <aside className="panel" ref={panelRef} aria-label="Findings and controls">
          {searchError && (
            <p className="alert" role="alert">
              <WarningCircle size={18} aria-hidden="true" /> {searchError}.
            </p>
          )}

          {clickInfo && (
            <section className="here" aria-live="polite" aria-labelledby="h-here">
              <div className="here-head">
                <h2 id="h-here">{tourStop ? tourStop.title : 'At this point'}</h2>
                <div className="here-actions">
                  <button className="text-btn" onClick={copyLink}>
                    <LinkSimple size={16} aria-hidden="true" /> {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <button className="icon-btn" onClick={clearSelection} aria-label="Clear selected point">
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {tourStop && <p className="tour-note">{tourStop.note}</p>}
              <p className="coords">{clickInfo.lngLat[1].toFixed(4)}, {clickInfo.lngLat[0].toFixed(4)}</p>
              {placeName && <p className="found">{placeName}</p>}
              {holcProps ? (
                holcProps.grade && gradeLabel[holcProps.grade] ? (
                  <p>
                    <span className="chip" style={{ background: HOLC_FILL_COLORS[holcProps.grade] }} />
                    <strong>Grade {holcProps.grade}</strong>, {gradeLabel[holcProps.grade].split(' — ')[1]} ({holcProps.label}) in {holcProps.city}
                  </p>
                ) : (
                  <p>
                    <span className="chip" style={{ background: UNGRADED }} />
                    <strong>Ungraded zone</strong>{holcProps.category ? `, ${holcProps.category.trim().toLowerCase()}` : ''} in {holcProps.city}
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
              {clickInfo.tour != null && (
                <button className="next-btn" onClick={() => goToStop(((clickInfo.tour as number) + 1) % TOUR.length)}>
                  Next stop <ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
            </section>
          )}

          <section aria-labelledby="h-layers">
            <h2 id="h-layers">Layers</h2>
            <p className="muted small">Choose what to show with the buttons on the map.</p>
            <label className="slider">
              <span className="slider-name">Redlining</span>
              <input type="range" min={0} max={1} step={0.01} value={holcOpacity} disabled={!showHOLC} onChange={(e) => setHolcOpacity(+e.target.value)} aria-label="Redlining opacity" />
              <output>{Math.round(holcOpacity * 100)}%</output>
            </label>
            <label className="slider">
              <span className="slider-name">Heat</span>
              <input type="range" min={0} max={1} step={0.01} value={hviOpacity} disabled={!showHVI} onChange={(e) => setHviOpacity(+e.target.value)} aria-label="Heat opacity" />
              <output>{Math.round(hviOpacity * 100)}%</output>
            </label>
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
                  Bars show the share of each grade's land inside ZIPs scored 4 or 5 (the tick marks the {stats.allGradedPctHigh}% average). Heat scores are ranks, so {stats.zipsHigh} of {stats.zipsTotal} ZIPs ({Math.round((stats.zipsHigh / stats.zipsTotal) * 100)}%) score 4 or 5 by design. Grade A is only {stats.grades.A.zones} small zones. ZIP scores are coarser than the 1930s zones, and the link is a correlation, not proof of cause.
                </p>

                <details className="boroughs">
                  <summary>By borough</summary>
                  <table>
                    <caption className="sr">Share of each grade's land in high heat vulnerability ZIPs, by borough</caption>
                    <thead>
                      <tr><th scope="col">Borough</th>{GRADES.map((g) => <th key={g} scope="col">{g}</th>)}</tr>
                    </thead>
                    <tbody>
                      {BOROUGHS.map((b) => (
                        <tr key={b}>
                          <th scope="row">{b}</th>
                          {GRADES.map((g) => {
                            const c = stats.byBorough[b]?.[g];
                            return (
                              <td key={g} className={c?.zones ? '' : 'none'}>
                                {c?.zones ? `${Math.round(c.pctHigh ?? 0)}%` : '–'}
                                {c?.zones ? <small>{c.zones}</small> : null}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="note">
                    Small numbers are zone counts. {exceptions.length ? `Grade D has the highest share in ${BOROUGHS.length - exceptions.length} of ${BOROUGHS.length} boroughs; ${exceptions.join(' and ')} ${exceptions.length === 1 ? 'is the exception' : 'are the exceptions'}.` : 'Grade D has the highest share in every borough.'} Grade A is nearly absent from Brooklyn and Queens, so its 0% is partly geography.
                  </p>
                </details>
              </>
            ) : (
              <div className="skeleton" aria-hidden="true"><i /><i /><i /><i /></div>
            )}
          </section>

          <footer className="sources">
            <p>
              <strong>Redlining:</strong> Mapping Inequality, Univ. of Richmond and partners (HOLC maps, 1930s), CC BY-NC-SA 4.0. {holcData ? holcData.features.length : ''} polygons across the five boroughs.
            </p>
            <p>
              <strong>Heat:</strong> NYC Health Department Heat Vulnerability Index, 2024 release, 1 (lowest) to 5 (highest), by ZIP code tabulation area ({zctaData ? zctaData.features.length : ''} areas), via NYC Open Data.
            </p>
            <p>
              <strong>AWS:</strong> address search and street-address lookup run on Amazon Location Service{USING_AWS_BASEMAP ? ', as does the basemap' : ''}. Data files are served from Amazon S3 through CloudFront.
            </p>
          </footer>
        </aside>

        <main id="map" className="map" aria-label="Map of New York City redlining grades and heat vulnerability" tabIndex={-1}>
          {loading && <div className="status" role="status">Loading map data</div>}
          {loadError && <div className="status err" role="alert">Could not load the map data ({loadError}). Reload the page to try again.</div>}

          <div className="map-tools">
            <div className="seg" role="group" aria-label="Layers shown">
              {MODES.map((m) => (
                <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>
              ))}
            </div>
            <button type="button" className="tool-btn" onClick={inspectCentre}>
              <Crosshair size={18} aria-hidden="true" /> <span>Inspect map centre</span>
            </button>
          </div>

          <details className="legend-box" open={legendOpen}>
            <summary>Legend</summary>
            <h3>HOLC grade, 1930s</h3>
            <ul>
              {GRADES.map((g) => (
                <li key={g}><span className="chip" style={{ background: HOLC_FILL_COLORS[g] }} />{gradeLabel[g].replace(' — ', ', ')}</li>
              ))}
              <li><span className="chip" style={{ background: UNGRADED }} />Ungraded (industrial, commercial)</li>
            </ul>
            <h3>Heat vulnerability by ZIP</h3>
            <div className="ramp" role="img" aria-label="Five step scale from 1, lowest, to 5, highest">
              {[1, 2, 3, 4, 5].map((v) => (<span key={v} style={{ background: HVI_COLORS[v] }}>{v}</span>))}
            </div>
            <div className="ramp-ends"><span>Lowest</span><span>Highest</span></div>
            <p className="credit">Redlining: Mapping Inequality, CC BY-NC-SA 4.0. Heat: NYC Health Department.</p>
          </details>

          {hover && (
            <div className="readout" aria-hidden="true">
              {hover.zip && <span>ZIP {hover.zip}, heat <strong>{hover.hvi}</strong></span>}
              {hover.holcId !== null && <span>{hover.grade ? <>HOLC <strong>{hover.label}</strong></> : 'Ungraded zone'}</span>}
            </div>
          )}

          <p className="sr">Use the arrow keys to pan and plus or minus to zoom. The Inspect map centre button reads the zone at the middle of the map.</p>

          <Map
            ref={mapRef}
            initialViewState={NYC_CENTER}
            scrollZoom
            style={{ width: '100%', height: '100%' }}
            mapStyle={MAP_STYLE_URL}
            onClick={handleMapClick}
            onMouseMove={handleMove}
            onMouseLeave={() => setHover(null)}
            cursor={hover ? 'pointer' : ''}
            interactiveLayerIds={interactiveIds}
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
                    'fill-color': ['interpolate', ['linear'], ['get', 'hvi'], 1, HVI_COLORS[1], 2, HVI_COLORS[2], 3, HVI_COLORS[3], 4, HVI_COLORS[4], 5, HVI_COLORS[5]],
                    'fill-opacity': hviOpacity,
                  }}
                />
                <Layer id="hvi-outline" type="line" paint={{ 'line-color': '#555', 'line-width': 0.5, 'line-opacity': 0.6 }} />
                <Layer
                  id="hvi-hover"
                  type="line"
                  filter={['==', ['get', 'zcta5'], hover?.zip ?? '']}
                  paint={{ 'line-color': '#26211c', 'line-width': 2.5, 'line-dasharray': [2, 1.5] }}
                />
              </Source>
            )}

            {holcData && showHOLC && (
              <Source id="holc" type="geojson" data={holcData}>
                <Layer id="holc-fill" type="fill" paint={{ 'fill-color': ['get', 'fill'], 'fill-opacity': holcOpacity }} />
                <Layer
                  id="holc-outline"
                  type="line"
                  paint={{
                    'line-color': ['match', ['get', 'grade'], 'A', '#3f7a31', 'B', '#2f7f8c', 'C', '#a89500', 'D', '#b0394c', '#777'],
                    'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 14, 2.2],
                    'line-opacity': 0.95,
                  }}
                />
                <Layer
                  id="holc-hover"
                  type="line"
                  filter={['==', ['get', 'area_id'], hover?.holcId ?? -1]}
                  paint={{ 'line-color': '#26211c', 'line-width': 3 }}
                />
              </Source>
            )}

            {marker && <Marker longitude={marker.lng} latitude={marker.lat} color="#a8412c" />}

            {clickInfo && (
              <Popup longitude={clickInfo.lngLat[0]} latitude={clickInfo.lngLat[1]} onClose={clearSelection} closeOnClick={false}>
                <div className="pop" aria-hidden="true">
                  {holcProps && <div>{holcProps.grade ? <>HOLC grade <strong>{holcProps.grade}</strong> · {holcProps.label}</> : <>Ungraded HOLC zone</>}</div>}
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
