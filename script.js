// Spotify application configuration.
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c';
const PRODUCTION_REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html';
const REDIRECT_URI = window.location.hostname === 'arch-pc.github.io'
    ? PRODUCTION_REDIRECT_URI
    : `${window.location.origin}${window.location.pathname}`;
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

const STORAGE_KEYS = {
    accessToken: 'spotify_access_token',
    refreshToken: 'spotify_refresh_token',
    expiresAt: 'spotify_expires_at',
    verifier: 'spotify_code_verifier',
    state: 'spotify_auth_state'
};

const MAX_TIME = 30;
const legendIds = ['leg-color1', 'leg-color2', 'leg-color3', 'leg-color4', 'leg-color5'];
const taskLabels = [
    'Name the artist',
    'Name the title',
    'Guess the exact year',
    'Guess the decade',
    'Exact year, within 3 years'
];

let accessToken = sessionStorage.getItem(STORAGE_KEYS.accessToken);
let fullLibrary = {};
let shuffledQueue = [];
let queueIndex = 0;
let currentTrack = null;
let isSpinning = false;
let currentRotation = 0;
let timerInterval = null;
let toastTimeout = null;

window.addEventListener('DOMContentLoaded', initialiseApp);

async function initialiseApp() {
    bindControls();

    const params = new URLSearchParams(window.location.search);
    const hasAuthResponse = params.has('code') || params.has('error');

    try {
        if (hasAuthResponse) {
            await handleRedirect();
            await showApp();
            return;
        }

        if (await ensureAccessToken()) {
            await showApp();
        }
    } catch (error) {
        console.error('Initialisation error:', error);
        clearAuth();
        showLoginMessage(error.message || 'Spotify login failed. Please try again.');
    }
}

function bindControls() {
    document.getElementById('login-btn').addEventListener('click', initiateLogin);
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('btn-next').addEventListener('click', playNextInQueue);
    document.getElementById('btn-pause').addEventListener('click', togglePlayback);
    document.getElementById('btn-restart').addEventListener('click', restartCurrentTrack);
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);
    document.getElementById('wheel-click-area').addEventListener('click', spinWheel);
}

// Authentication helpers (Authorization Code with PKCE).
function generateRandomString(length) {
    const values = new Uint8Array(length);
    window.crypto.getRandomValues(values);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from(values, value => alphabet[value % alphabet.length]).join('');
}

async function generateCodeChallenge(codeVerifier) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    const bytes = String.fromCharCode(...new Uint8Array(digest));

    return btoa(bytes)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

async function initiateLogin() {
    const loginButton = document.getElementById('login-btn');
    setButtonBusy(loginButton, true, 'Opening Spotify…');
    showLoginMessage('');

    try {
        const codeVerifier = generateRandomString(96);
        const state = generateRandomString(24);
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        sessionStorage.setItem(STORAGE_KEYS.verifier, codeVerifier);
        sessionStorage.setItem(STORAGE_KEYS.state, state);

        const args = new URLSearchParams({
            response_type: 'code',
            client_id: CLIENT_ID,
            scope: SCOPES,
            redirect_uri: REDIRECT_URI,
            state,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge
        });

        window.location.assign(`https://accounts.spotify.com/authorize?${args.toString()}`);
    } catch (error) {
        console.error('Login error:', error);
        showLoginMessage('Could not start Spotify login. Please reload and try again.');
        setButtonBusy(loginButton, false);
    }
}

async function handleRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const returnedState = params.get('state');
    const authError = params.get('error');
    const storedVerifier = sessionStorage.getItem(STORAGE_KEYS.verifier);
    const storedState = sessionStorage.getItem(STORAGE_KEYS.state);

    cleanAuthQuery();

    if (authError) {
        throw new Error(authError === 'access_denied'
            ? 'Spotify login was cancelled.'
            : `Spotify login failed: ${authError}`);
    }

    if (!code || !storedVerifier) {
        throw new Error('Spotify returned an incomplete login response. Please try again.');
    }

    if (!returnedState || returnedState !== storedState) {
        throw new Error('The Spotify login could not be verified. Please try again.');
    }

    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: storedVerifier
    });

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    const data = await readJsonResponse(response);
    sessionStorage.removeItem(STORAGE_KEYS.verifier);
    sessionStorage.removeItem(STORAGE_KEYS.state);

    if (!response.ok || !data.access_token) {
        throw new Error(data.error_description || 'Spotify did not return an access token.');
    }

    storeTokens(data);
}

function cleanAuthQuery() {
    const cleanUrl = `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState({}, document.title, cleanUrl);
}

function storeTokens(data) {
    if (data.access_token) {
        accessToken = data.access_token;
        sessionStorage.setItem(STORAGE_KEYS.accessToken, data.access_token);
    }

    if (data.refresh_token) {
        sessionStorage.setItem(STORAGE_KEYS.refreshToken, data.refresh_token);
    }

    if (data.expires_in) {
        const expiresAt = Date.now() + (Number(data.expires_in) * 1000) - 60_000;
        sessionStorage.setItem(STORAGE_KEYS.expiresAt, String(expiresAt));
    }
}

async function ensureAccessToken() {
    accessToken = sessionStorage.getItem(STORAGE_KEYS.accessToken);
    const expiresAt = Number(sessionStorage.getItem(STORAGE_KEYS.expiresAt) || 0);

    if (accessToken && (!expiresAt || Date.now() < expiresAt)) {
        return true;
    }

    if (sessionStorage.getItem(STORAGE_KEYS.refreshToken)) {
        await refreshAccessToken();
        return true;
    }

    clearAuth();
    return false;
}

async function refreshAccessToken() {
    const refreshToken = sessionStorage.getItem(STORAGE_KEYS.refreshToken);
    if (!refreshToken) {
        throw new Error('Your Spotify session has expired. Please log in again.');
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLIENT_ID
        })
    });

    const data = await readJsonResponse(response);
    if (!response.ok || !data.access_token) {
        clearAuth();
        throw new Error('Your Spotify session has expired. Please log in again.');
    }

    storeTokens(data);
    return accessToken;
}

function clearAuth() {
    Object.values(STORAGE_KEYS).forEach(key => sessionStorage.removeItem(key));
    accessToken = null;
}

function logout() {
    clearAuth();
    clearInterval(timerInterval);
    document.getElementById('app-section').classList.add('hidden');
    document.getElementById('login-section').classList.remove('hidden');
    showLoginMessage('You have been logged out.');
}

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

function showLoginMessage(message) {
    document.getElementById('login-message').textContent = message;
}

// data.json loading and validation.
async function loadLibrary() {
    const status = document.getElementById('library-status');
    status.textContent = 'Loading data.json…';

    try {
        const response = await fetch('data.json', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`data.json could not be loaded (HTTP ${response.status}).`);
        }

        const rawText = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch (error) {
            throw new Error(`data.json is not valid JSON: ${error.message}`);
        }

        const normalised = normaliseLibrary(parsed);
        fullLibrary = normalised.library;
        const playlistNames = Object.keys(fullLibrary);

        if (playlistNames.length === 0) {
            throw new Error('data.json contains no valid playlists or songs.');
        }

        const select = document.getElementById('playlist-select');
        select.replaceChildren();

        playlistNames.forEach(name => {
            const songCount = fullLibrary[name].length;
            select.add(new Option(`${name} (${songCount} ${songCount === 1 ? 'song' : 'songs'})`, name));
        });

        select.onchange = event => setupQueue(event.target.value);
        setupQueue(playlistNames[0]);

        const skippedText = normalised.skipped > 0
            ? ` ${normalised.skipped} invalid ${normalised.skipped === 1 ? 'entry was' : 'entries were'} skipped.`
            : '';
        status.textContent = `${playlistNames.length} ${playlistNames.length === 1 ? 'playlist' : 'playlists'} loaded.${skippedText}`;
    } catch (error) {
        console.error('Data error:', error);
        fullLibrary = {};
        shuffledQueue = [];
        document.getElementById('queue-status').textContent = 'No songs loaded';
        status.textContent = error.message;
        showToast(error.message, true);
    }
}

function normaliseLibrary(rawData) {
    const source = Array.isArray(rawData) ? { 'Music Bingo': rawData } : rawData;

    if (!source || typeof source !== 'object') {
        throw new Error('The root of data.json must be an object containing playlist arrays.');
    }

    const library = {};
    let skipped = 0;

    for (const [playlistName, tracks] of Object.entries(source)) {
        if (!Array.isArray(tracks)) {
            skipped += 1;
            continue;
        }

        const validTracks = [];
        for (const track of tracks) {
            const normalisedTrack = normaliseTrack(track);
            if (normalisedTrack) {
                validTracks.push(normalisedTrack);
            } else {
                skipped += 1;
            }
        }

        if (validTracks.length > 0) {
            library[String(playlistName).trim() || 'Untitled playlist'] = validTracks;
        }
    }

    return { library, skipped };
}

function normaliseTrack(track) {
    if (!track || typeof track !== 'object') {
        return null;
    }

    const artist = String(track.artist ?? '').trim();
    const title = String(track.title ?? track.name ?? '').trim();
    const year = String(track.year ?? track.release_year ?? '').trim();
    const link = String(track.link ?? '').trim();
    let uri = String(track.uri ?? '').trim();

    if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) {
        const trackId = extractSpotifyTrackId(link);
        uri = trackId ? `spotify:track:${trackId}` : '';
    }

    if (!uri || !artist || !title || !year) {
        return null;
    }

    return {
        ...track,
        uri,
        artist,
        title,
        year,
        link
    };
}

function extractSpotifyTrackId(link) {
    if (!link) return '';

    try {
        const url = new URL(link);
        const match = url.pathname.match(/\/track\/([A-Za-z0-9]+)/);
        return match ? match[1] : '';
    } catch {
        const match = link.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
        return match ? match[1] : '';
    }
}

function shuffleArray(array) {
    for (let index = array.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
    }
    return array;
}

function setupQueue(playlistName) {
    const tracks = fullLibrary[playlistName];
    if (!Array.isArray(tracks) || tracks.length === 0) {
        shuffledQueue = [];
        updateQueueStatus();
        return;
    }

    shuffledQueue = shuffleArray([...tracks]);
    queueIndex = 0;
    currentTrack = null;
    resetTrackInfo();
    updateQueueStatus();
}

function updateQueueStatus() {
    const remaining = Math.max(0, shuffledQueue.length - queueIndex);
    const total = shuffledQueue.length;
    document.getElementById('queue-status').textContent = total > 0
        ? `${remaining} of ${total} remaining`
        : 'No songs loaded';
}

// Spotify Web API.
async function fetchWebApi(endpoint, method = 'GET', body, allowRetry = true) {
    await ensureAccessToken();
    if (!accessToken) {
        throw new Error('You are not logged in to Spotify.');
    }

    const response = await fetch(`https://api.spotify.com/${endpoint}`, {
        method,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 401 && allowRetry && sessionStorage.getItem(STORAGE_KEYS.refreshToken)) {
        await refreshAccessToken();
        return fetchWebApi(endpoint, method, body, false);
    }

    if (response.status === 401) {
        clearAuth();
        throw new Error('Your Spotify session has expired. Please log in again.');
    }

    return response;
}

async function playNextInQueue() {
    const button = document.getElementById('btn-next');

    if (shuffledQueue.length === 0) {
        showToast('No songs are loaded. Check data.json.', true);
        return;
    }

    if (queueIndex >= shuffledQueue.length) {
        const restart = window.confirm('The playlist is finished. Shuffle it and start again?');
        if (!restart) return;
        shuffledQueue = shuffleArray([...shuffledQueue]);
        queueIndex = 0;
    }

    setButtonBusy(button, true, 'Connecting…');
    const nextTrack = shuffledQueue[queueIndex];

    try {
        const devicesResponse = await fetchWebApi('v1/me/player/devices');
        const devicesData = await readJsonResponse(devicesResponse);

        if (!devicesResponse.ok) {
            throw new Error(getSpotifyError(devicesData, 'Could not retrieve Spotify devices.'));
        }

        const availableDevices = Array.isArray(devicesData.devices)
            ? devicesData.devices.filter(device => !device.is_restricted)
            : [];
        const device = availableDevices.find(item => item.is_active) || availableDevices[0];

        if (!device) {
            throw new Error('No available Spotify device found. Open Spotify and play something once, then try again.');
        }

        const playResponse = await fetchWebApi(
            `v1/me/player/play?device_id=${encodeURIComponent(device.id)}`,
            'PUT',
            { uris: [nextTrack.uri] }
        );

        if (!playResponse.ok) {
            const playError = await readJsonResponse(playResponse);
            throw new Error(getSpotifyError(playError, 'Spotify could not start this song.'));
        }

        currentTrack = nextTrack;
        queueIndex += 1;
        resetTrackInfo();
        updateQueueStatus();
        showToast(`Now playing on ${device.name || 'your Spotify device'}.`);
    } catch (error) {
        console.error('Playback error:', error);
        showToast(error.message, true);
    } finally {
        setButtonBusy(button, false);
    }
}

async function togglePlayback() {
    const button = document.getElementById('btn-pause');
    setButtonBusy(button, true, 'Checking…');

    try {
        const stateResponse = await fetchWebApi('v1/me/player');

        if (stateResponse.status === 204) {
            throw new Error('Nothing is active in Spotify yet. Start a song first.');
        }

        if (!stateResponse.ok) {
            const data = await readJsonResponse(stateResponse);
            throw new Error(getSpotifyError(data, 'Could not read the Spotify playback state.'));
        }

        const state = await stateResponse.json();
        const endpoint = state.is_playing ? 'v1/me/player/pause' : 'v1/me/player/play';
        const response = await fetchWebApi(endpoint, 'PUT');

        if (!response.ok) {
            const data = await readJsonResponse(response);
            throw new Error(getSpotifyError(data, 'Could not change playback.'));
        }

        showToast(state.is_playing ? 'Playback paused.' : 'Playback resumed.');
    } catch (error) {
        console.error('Pause/play error:', error);
        showToast(error.message, true);
    } finally {
        setButtonBusy(button, false);
    }
}

async function restartCurrentTrack() {
    const button = document.getElementById('btn-restart');
    setButtonBusy(button, true, 'Restarting…');

    try {
        if (!currentTrack) {
            throw new Error('Start a song before using restart.');
        }

        const response = await fetchWebApi('v1/me/player/seek?position_ms=0', 'PUT');
        if (!response.ok) {
            const data = await readJsonResponse(response);
            throw new Error(getSpotifyError(data, 'Could not restart the song.'));
        }

        showToast('Song restarted.');
    } catch (error) {
        console.error('Restart error:', error);
        showToast(error.message, true);
    } finally {
        setButtonBusy(button, false);
    }
}

function getSpotifyError(payload, fallback) {
    const error = payload?.error;
    if (error?.reason === 'PREMIUM_REQUIRED') {
        return 'Spotify Premium is required for direct playback.';
    }
    return error?.message || payload?.error_description || fallback;
}

async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

// Game UI.
function resetTrackInfo() {
    ['val-artist', 'val-title', 'val-year'].forEach(id => {
        const element = document.getElementById(id);
        element.textContent = '???';
        element.classList.remove('visible');
    });

    resetTimer();
}

function revealAnswer() {
    if (!currentTrack) {
        showToast('Start a song before revealing the answer.', true);
        return;
    }

    const values = {
        'val-artist': currentTrack.artist,
        'val-title': currentTrack.title,
        'val-year': currentTrack.year
    };

    Object.entries(values).forEach(([id, value]) => {
        const element = document.getElementById(id);
        element.textContent = value;
        element.classList.add('visible');
    });
}

function spinWheel() {
    if (isSpinning) return;

    const wheelButton = document.getElementById('wheel-click-area');
    const wheel = document.getElementById('wheel');
    const result = document.getElementById('wheel-result');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const spinDuration = reduceMotion ? 50 : 4000;

    isSpinning = true;
    wheelButton.disabled = true;
    result.textContent = 'Spinning…';
    document.querySelectorAll('.legend-item').forEach(item => item.classList.remove('active'));

    const extraSpins = (4 * 360) + Math.floor(Math.random() * 720) + 1;
    currentRotation += extraSpins;
    wheel.style.transform = `rotate(${currentRotation}deg)`;

    window.setTimeout(() => {
        const realRotation = ((currentRotation % 360) + 360) % 360;
        const winnerIndex = Math.floor(((360 - realRotation) % 360) / 72);
        const winningElement = document.getElementById(legendIds[winnerIndex]);

        winningElement?.classList.add('active');
        result.textContent = taskLabels[winnerIndex];
        isSpinning = false;
        wheelButton.disabled = false;
    }, spinDuration);
}

function startTimer() {
    clearInterval(timerInterval);

    const display = document.getElementById('timer-display');
    const bar = document.getElementById('timer-bar');
    const button = document.getElementById('start-timer-btn');
    const endsAt = Date.now() + (MAX_TIME * 1000);

    button.textContent = '↻ Restart timer';
    updateTimerVisual(MAX_TIME, display, bar);

    timerInterval = window.setInterval(() => {
        const timeLeft = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        updateTimerVisual(timeLeft, display, bar);

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            button.textContent = '▶ Start 30 seconds';
            showToast('Time is up!');
        }
    }, 250);
}

function resetTimer() {
    clearInterval(timerInterval);
    timerInterval = null;

    const display = document.getElementById('timer-display');
    const bar = document.getElementById('timer-bar');
    const button = document.getElementById('start-timer-btn');

    updateTimerVisual(MAX_TIME, display, bar);
    button.textContent = '▶ Start 30 seconds';
}

function updateTimerVisual(timeLeft, display, bar) {
    display.textContent = String(timeLeft);
    bar.style.width = `${(timeLeft / MAX_TIME) * 100}%`;

    if (timeLeft <= 5) {
        display.style.color = 'var(--c-pink)';
        bar.style.backgroundColor = 'var(--c-pink)';
    } else if (timeLeft <= 10) {
        display.style.color = 'var(--c-gold)';
        bar.style.backgroundColor = 'var(--c-gold)';
    } else {
        display.style.color = 'var(--text)';
        bar.style.backgroundColor = 'var(--spotify-green)';
    }
}

function setButtonBusy(button, busy, busyText = 'Loading…') {
    if (!button) return;

    if (busy) {
        button.dataset.originalHtml = button.innerHTML;
        button.textContent = busyText;
        button.disabled = true;
    } else {
        if (button.dataset.originalHtml) {
            button.innerHTML = button.dataset.originalHtml;
        }
        button.disabled = false;
        delete button.dataset.originalHtml;
    }
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    window.clearTimeout(toastTimeout);

    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('visible');

    toastTimeout = window.setTimeout(() => {
        toast.classList.remove('visible');
    }, 4500);
}
