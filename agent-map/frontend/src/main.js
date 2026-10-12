import { AmazonConnectApp } from "@amazon-connect/app";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

const config = window.WISECALLS_AGENT_MAP_CONFIG || {};
const elements = Object.fromEntries([
  "status-card", "status-spinner", "status-title", "status-message", "auth-card", "sign-in",
  "location-panel", "approximate-label", "observed-at", "freshness", "refresh", "accuracy",
  "altitude", "confidence", "map"
].map((id) => [id, document.getElementById(id)]));

let activeContactId;
let map;
let marker;
let refreshTimer;

function setStatus(title, message, spinning = false) {
  elements["status-card"].classList.remove("hidden", "error");
  elements["status-title"].textContent = title;
  elements["status-message"].textContent = message;
  elements["status-spinner"].classList.toggle("hidden", !spinning);
}

function setError(message) {
  setStatus("Location unavailable", message, false);
  elements["status-card"].classList.add("error");
  elements["location-panel"].classList.add("hidden");
}

function validateConfig() {
  const required = [config.apiBaseUrl, config.awsRegion, config.mapApiKey,
    config.oidc?.authorizationEndpoint, config.oidc?.tokenEndpoint,
    config.oidc?.clientId, config.oidc?.redirectUri];
  if (required.some((value) => !value || String(value).includes("REPLACE"))) {
    throw new Error("Agent map configuration has not been generated yet.");
  }
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function randomValue() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function tokenIsUsable(token) {
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")));
    return Number(payload.exp || 0) > Math.floor(Date.now() / 1000) + 30;
  } catch {
    return false;
  }
}

async function beginSignIn() {
  const verifier = randomValue();
  const state = randomValue();
  sessionStorage.setItem("wc_agent_pkce", verifier);
  sessionStorage.setItem("wc_agent_state", state);
  const challenge = base64Url(await sha256(verifier));
  const url = new URL(config.oidc.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: (config.oidc.scopes || ["openid", "profile"]).join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });
  window.location.assign(url.toString());
}

async function processSignInCallback() {
  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  if (!code) return;
  if (query.get("state") !== sessionStorage.getItem("wc_agent_state")) {
    throw new Error("Agent sign-in response could not be verified.");
  }
  const verifier = sessionStorage.getItem("wc_agent_pkce");
  const response = await fetch(config.oidc.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.oidc.clientId,
      redirect_uri: config.oidc.redirectUri,
      code_verifier: verifier || "",
      code
    })
  });
  if (!response.ok) throw new Error("Agent sign-in could not be completed.");
  const tokens = await response.json();
  sessionStorage.setItem("wc_agent_access_token", tokens.access_token);
  sessionStorage.removeItem("wc_agent_pkce");
  sessionStorage.removeItem("wc_agent_state");
  history.replaceState({}, document.title, new URL(config.oidc.redirectUri).pathname || "/");
}

function accuracyPolygon(longitude, latitude, radiusMeters) {
  const points = [];
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.max(Math.cos(latitude * Math.PI / 180), 0.01);
  for (let angle = 0; angle <= 360; angle += 6) {
    const radians = angle * Math.PI / 180;
    points.push([
      longitude + (Math.cos(radians) * radiusMeters) / longitudeScale,
      latitude + (Math.sin(radians) * radiusMeters) / latitudeScale
    ]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [points] } };
}

function renderMap(location) {
  const center = [location.longitude, location.latitude];
  const circle = accuracyPolygon(location.longitude, location.latitude, location.accuracyRadiusMeters);
  if (!map) {
    const styleUrl = `https://maps.geo.${encodeURIComponent(config.awsRegion)}.amazonaws.com/v2/styles/${encodeURIComponent(config.mapStyle || "Standard")}/descriptor?key=${encodeURIComponent(config.mapApiKey)}`;
    map = new maplibregl.Map({ container: "map", style: styleUrl, center, zoom: 15, validateStyle: false });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    marker = new maplibregl.Marker({ color: "#007eb9" }).setLngLat(center).addTo(map);
    map.on("load", () => {
      map.addSource("accuracy", { type: "geojson", data: circle });
      map.addLayer({ id: "accuracy-fill", type: "fill", source: "accuracy", paint: { "fill-color": "#00a7e1", "fill-opacity": 0.18 } });
      map.addLayer({ id: "accuracy-line", type: "line", source: "accuracy", paint: { "line-color": "#007eb9", "line-width": 2 } });
    });
  } else {
    marker.setLngLat(center);
    map.getSource("accuracy")?.setData(circle);
    map.easeTo({ center, zoom: 15 });
  }
}

async function loadLocation() {
  if (!activeContactId) return;
  const token = sessionStorage.getItem("wc_agent_access_token");
  if (!tokenIsUsable(token)) {
    elements["auth-card"].classList.remove("hidden");
    setStatus("Agent authentication required", "Sign in to view location for this active contact.");
    return;
  }
  elements["auth-card"].classList.add("hidden");
  setStatus("Loading current location…", "Authorising this contact and checking location freshness.", true);
  const url = new URL("agent/location", `${config.apiBaseUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("contactId", activeContactId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    sessionStorage.removeItem("wc_agent_access_token");
    return loadLocation();
  }
  if (!response.ok || !body.ok) throw new Error(body.message || "No current location is available.");

  const location = body.location;
  elements["approximate-label"].textContent = location.approximateLabel;
  const observed = new Date(location.observedAt);
  const ageSeconds = Math.max(0, Math.round((Date.now() - observed.getTime()) / 1000));
  elements["observed-at"].textContent = `Observed ${ageSeconds < 60 ? `${ageSeconds} seconds` : `${Math.round(ageSeconds / 60)} minutes`} ago`;
  elements.freshness.textContent = ageSeconds <= 300 ? "Current" : "Older location";
  elements.freshness.classList.toggle("warning", ageSeconds > 300);
  elements.accuracy.textContent = `Approximately ${Math.round(location.accuracyRadiusMeters)} m`;
  elements.altitude.textContent = location.altitudeMeters == null
    ? "Not supplied"
    : `${Math.round(location.altitudeMeters)} m (vertical accuracy ${location.verticalAccuracyMeters == null ? "unknown" : `${Math.round(location.verticalAccuracyMeters)} m`})`;
  elements.confidence.textContent = String(location.confidence || "APPROXIMATE").replaceAll("_", " ").toLowerCase();
  elements["location-panel"].classList.remove("hidden");
  elements["status-card"].classList.add("hidden");
  renderMap(location);
}

async function initialise() {
  try {
    validateConfig();
    await processSignInCallback();
    AmazonConnectApp.init({
      onCreate: async (event) => {
        activeContactId = event?.context?.contactScope?.contactId || event?.contactScope?.contactId;
        if (!activeContactId) {
          setError("Open Customer Location while an active call or chat is selected.");
          return;
        }
        await loadLocation().catch((error) => setError(error.message));
        refreshTimer = window.setInterval(() => loadLocation().catch((error) => setError(error.message)), 60000);
      },
      onDestroy: async () => {
        window.clearInterval(refreshTimer);
        map?.remove();
        map = undefined;
        marker = undefined;
        activeContactId = undefined;
        sessionStorage.removeItem("wc_agent_access_token");
      }
    });
  } catch (error) {
    setError(error.message || "The map application could not start.");
  }
}

elements["sign-in"].addEventListener("click", () => beginSignIn().catch((error) => setError(error.message)));
elements.refresh.addEventListener("click", () => loadLocation().catch((error) => setError(error.message)));
initialise();
