// Amazon Location Service API key (Places V2) used for address search.
// Set VITE_AWS_LOCATION_API_KEY in app/.env (see .env.example). Vite inlines it into the
// build, so restrict the key to your site's referrer and to geo-places:SearchText.
export const AWS_LOCATION_API_KEY = (import.meta.env.VITE_AWS_LOCATION_API_KEY as string | undefined) || '';

// Basemap. Amazon Location Service tiles when a map-enabled key is provided
// (VITE_AWS_LOCATION_MAP_KEY, allowed for geo-maps:GetTile);
// otherwise the free CARTO Positron style.
const MAP_KEY = import.meta.env.VITE_AWS_LOCATION_MAP_KEY as string | undefined;
export const USING_AWS_BASEMAP = Boolean(MAP_KEY);
export const MAP_STYLE_URL = MAP_KEY
  ? `https://maps.geo.us-east-1.amazonaws.com/v2/styles/Monochrome/descriptor?color-scheme=Light&key=${encodeURIComponent(MAP_KEY)}`
  : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
