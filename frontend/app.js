"use strict";

const config = window.WISECALLS_CONFIG || {};
const keys = {
  verifier: "wisecalls.oauth.verifier",
  state: "wisecalls.oauth.state",
  returnQuery: "wisecalls.oauth.return_query",
  idToken: "wisecalls.oauth.id_token",
  expiresAt: "wisecalls.oauth.expires_at"
};

const elements = {
  authState: document.querySelector("#auth-state"),
  signIn: document.querySelector("#sign-in"),
  signOut: document.querySelector("#sign-out"),
  locationCard: document.querySelector("#location-card"),
  consent: document.querySelector("#consent"),
  share: document.querySelector("#share-location"),
  locationState: document.querySelector("#location-state"),
  result: document.querySelector("#location-result"),
  latitude: document.querySelector("#latitude"),
  longitude: document.querySelector("#longitude"),
  altitude: document.querySelector("#altitude"),
  accuracy: document.querySelector("#accuracy"),
  observedAt: document.querySelector("#observed-at"),
  phoneOptions: document.querySelector("#service-phone-options")
};

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomValue(length = 48) {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function redirectUri() {
  return `${window.location.origin}/`;
}

function configured() {
  const phoneNumbers = validServicePhoneNumbers();
  return typeof config.clientId === "string" && config.clientId.length > 5
    && phoneNumbers.length > 0
    && [config.cognitoDomain, config.locationApiUrl, config.currentLocationApiUrl]
      .every((value) => typeof value === "string" && value.startsWith("https://"));
}

function decodeClaims(token) {
  try {
    const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
  } catch {
    return {};
  }
}

function currentToken() {
  const token = sessionStorage.getItem(keys.idToken);
  const expiresAt = Number(sessionStorage.getItem(keys.expiresAt));
  if (!token || !expiresAt || Date.now() >= expiresAt - 30000) {
    sessionStorage.removeItem(keys.idToken);
    sessionStorage.removeItem(keys.expiresAt);
    return undefined;
  }
  return token;
}

async function signIn() {
  const verifier = randomValue();
  const state = randomValue(24);
  sessionStorage.setItem(keys.verifier, verifier);
  sessionStorage.setItem(keys.state, state);
  sessionStorage.setItem(keys.returnQuery, window.location.search);
  const challenge = base64Url(await sha256(verifier));
  const query = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state
  });
  window.location.assign(`${config.cognitoDomain}/oauth2/authorize?${query}`);
}

async function completeCallback() {
  const query = new URLSearchParams(window.location.search);
  const code = query.get("code");
  if (!code) return;
  const expectedState = sessionStorage.getItem(keys.state);
  const verifier = sessionStorage.getItem(keys.verifier);
  if (!expectedState || query.get("state") !== expectedState || !verifier) throw new Error("The sign-in response could not be verified. Please sign in again.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier
  });
  const response = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error("Sign-in could not be completed. Please try again.");
  const tokens = await response.json();
  if (!tokens.id_token) throw new Error("The identity token was not returned.");
  sessionStorage.setItem(keys.idToken, tokens.id_token);
  sessionStorage.setItem(keys.expiresAt, String(Date.now() + Number(tokens.expires_in || 900) * 1000));
  sessionStorage.removeItem(keys.verifier);
  sessionStorage.removeItem(keys.state);
  const returnQuery = sessionStorage.getItem(keys.returnQuery) || "";
  sessionStorage.removeItem(keys.returnQuery);
  history.replaceState({}, document.title, `${window.location.pathname}${returnQuery}`);
}

function renderAuthentication() {
  const token = currentToken();
  elements.signIn.hidden = Boolean(token);
  elements.signOut.hidden = !token;
  elements.locationCard.hidden = !token;
  if (!token) {
    elements.authState.textContent = "You are not signed in.";
    elements.authState.className = "state";
    return;
  }
  const claims = decodeClaims(token);
  const customerId = String(claims["custom:customer_id"] || "");
  const masked = customerId.length > 2 ? `••••${customerId.slice(-2)}` : "verified customer";
  elements.authState.textContent = `Signed in as ${masked}.`;
  elements.authState.className = "state success";
}

function signOut() {
  sessionStorage.clear();
  const query = new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() });
  window.location.assign(`${config.cognitoDomain}/logout?${query}`);
}

function validServicePhoneNumbers() {
  if (!Array.isArray(config.servicePhoneNumbers)) return [];
  return config.servicePhoneNumbers.filter((phone) => phone
    && typeof phone.id === "string"
    && typeof phone.label === "string"
    && typeof phone.display === "string"
    && /^\+[1-9][0-9]{7,14}$/.test(phone.e164 || ""));
}

function selectedServicePhone() {
  const selectedId = document.querySelector('input[name="service-phone"]:checked')?.value;
  return validServicePhoneNumbers().find((phone) => phone.id === selectedId);
}

function phoneUrl(phone) {
  return `tel:${phone.e164}`;
}

function updateCallButton() {
  const selected = selectedServicePhone();
  if (selected && !elements.consent.disabled) {
    elements.share.textContent = `☎ Share location and call ${selected.display}`;
  }
}

function renderServicePhones() {
  const phoneNumbers = validServicePhoneNumbers();
  elements.phoneOptions.replaceChildren();
  if (phoneNumbers.length === 0) {
    elements.phoneOptions.textContent = "Service numbers are not configured.";
    return;
  }
  phoneNumbers.forEach((phone, index) => {
    const row = document.createElement("div");
    row.className = "phone-option";

    const choice = document.createElement("label");
    choice.className = "phone-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "service-phone";
    radio.value = phone.id;
    radio.checked = index === 0;
    radio.addEventListener("change", updateCallButton);

    const copy = document.createElement("span");
    copy.className = "phone-copy";
    const label = document.createElement("small");
    label.textContent = phone.label;
    const number = document.createElement("strong");
    number.textContent = phone.display;
    copy.append(label, number);
    choice.append(radio, copy);

    const directCall = document.createElement("a");
    directCall.className = "direct-number-call";
    directCall.href = phoneUrl(phone);
    directCall.textContent = "Call without location";
    directCall.setAttribute("aria-label", `Call WiseCalls on ${phone.display} without sharing location`);
    row.append(choice, directCall);
    elements.phoneOptions.append(row);
  });
  updateCallButton();
}

function getPosition() {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0
  }));
}

function friendlyLocationError(error) {
  if (error?.code === 1) return "Location permission was not granted. You can continue receiving service without sharing it.";
  if (error?.code === 2) return "Your device could not determine its current location. Move to an open area and try again.";
  if (error?.code === 3) return "The location request timed out. Please try again.";
  return error?.message || "The location could not be sent. Please try again.";
}

async function shareLocation() {
  if (!elements.consent.checked) return;
  const token = currentToken();
  const callNumber = selectedServicePhone();
  if (!callNumber) {
    elements.locationState.textContent = "Choose a WiseCalls service line first.";
    elements.locationState.className = "state error";
    return;
  }
  if (!token) {
    renderAuthentication();
    return;
  }
  if (!navigator.geolocation) {
    elements.locationState.textContent = "This browser does not support location sharing.";
    elements.locationState.className = "state error";
    return;
  }

  elements.share.disabled = true;
  elements.locationState.textContent = "Requesting a fresh position from your device…";
  elements.locationState.className = "state";
  try {
    const position = await getPosition();
    const observedAt = new Date(position.timestamp).toISOString();
    const payload = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy,
      observedAt
    };
    if (Number.isFinite(position.coords.altitude)) payload.altitudeMeters = position.coords.altitude;
    if (Number.isFinite(position.coords.altitudeAccuracy)) payload.verticalAccuracyMeters = position.coords.altitudeAccuracy;

    const sessionId = new URLSearchParams(window.location.search).get("session");
    const endpoint = sessionId ? config.locationApiUrl : config.currentLocationApiUrl;
    if (sessionId) {
      payload.sessionId = sessionId;
      payload.consentAt = new Date().toISOString();
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      if (response.status === 401 || response.status === 403) sessionStorage.removeItem(keys.idToken);
      throw new Error(result.code === "EXPIRED_OR_USED" ? "This location request has expired or was already completed." : "The secure service did not accept the update. Please sign in again or contact your agent.");
    }

    elements.latitude.textContent = position.coords.latitude.toFixed(6);
    elements.longitude.textContent = position.coords.longitude.toFixed(6);
    elements.altitude.textContent = Number.isFinite(position.coords.altitude) ? `${position.coords.altitude.toFixed(1)} metres` : "Not supplied by device";
    elements.accuracy.textContent = `Approximately ${Math.round(position.coords.accuracy)} metres`;
    elements.observedAt.textContent = new Date(position.timestamp).toLocaleString("en-AU");
    elements.result.hidden = false;
    elements.locationState.textContent = "Your current location was sent securely. Opening your phone app now.";
    elements.locationState.className = "state success";
    elements.share.textContent = "Opening your phone app…";
    elements.consent.disabled = true;
    window.setTimeout(() => window.location.assign(phoneUrl(callNumber)), 300);
  } catch (error) {
    elements.locationState.textContent = friendlyLocationError(error);
    elements.locationState.className = "state error";
    elements.share.disabled = !elements.consent.checked;
  }
}

async function initialise() {
  renderServicePhones();
  if (!configured()) {
    elements.authState.textContent = "This page has not been configured. Contact the service administrator.";
    elements.authState.className = "state error";
    return;
  }
  elements.signIn.addEventListener("click", signIn);
  elements.signOut.addEventListener("click", signOut);
  elements.consent.addEventListener("change", () => { elements.share.disabled = !elements.consent.checked; });
  elements.share.addEventListener("click", shareLocation);
  try {
    await completeCallback();
  } catch (error) {
    elements.authState.textContent = error.message;
    elements.authState.className = "state error";
  }
  renderAuthentication();
}

initialise();
