// --- CONFIGURATION ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c';
const REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html'; 
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// --- AUTH HELPERS (PKCE Security) ---
function generateRandomString(length) {
    const array = new Uint8Array(length);
    window.crypto.getRandomValues(array);
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(array[i] % possible.length);
    }
    return text;
}

async function generateCodeChallenge(codeVerifier) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)]))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// --- LOGIN FLOW ---
async function initiateLogin() {
    const codeVerifier = generateRandomString(128);
    const state = generateRandomString(16);
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    window.sessionStorage.setItem('code_verifier', codeVerifier);
    window.sessionStorage.setItem('spotify_auth_state', state);

    const args = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        state: state,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge
    });

    // Proxy endpoint for Authorize
    window.location = 'https://accounts.spotify.com/authorize?' + args;
}

async function handleRedirect() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const returnedState = urlParams.get('state');
    const error = urlParams.get('error');

    const storedVerifier = window.sessionStorage.getItem('code_verifier');
    const storedState = window.sessionStorage.getItem('spotify_auth_state');

    window.history.replaceState({}, document.title, REDIRECT_URI);
    
    if (error) { console.error("Auth Error:", error); return false; }
    if (!returnedState || returnedState !== storedState) { alert("State mismatch!"); return false; }

    if (code && storedVerifier) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: storedVerifier
        });

        try {
            // Proxy endpoint for Token
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await response.json();
            if (response.ok) {
                window.sessionStorage.setItem('access_token', data.access_token);
                return true;
            }
        } catch (e) { console.error("Token error:", e); }
    }
    return false;
}

// --- APP STATE ---
let accessToken = window.sessionStorage.getItem('access_token');
let fullLibrary = {};
let shuffledQueue = [];
let queueIndex = 0;
let currentTrack = null;
let isSpinning = false;

// GLOBAL ROTATION VARIABLE (Crucial for the fix)
let currentRotation = 0; 

// --- INITIALIZATION ---
window.addEventListener('load', async () => {
    if (window.location.search.includes('code=')) {
        if (await handleRedirect()) {
            accessToken = window.sessionStorage.getItem('access_token');
            showApp();
        }
    } else if (accessToken) {
        showApp();
    }

    // Event Listeners
    document.getElementById('login-btn').addEventListener('click', initiateLogin);
    
    // DJ Controls
    document.getElementById('btn-next').addEventListener('click', playNextInQueue);
    document.getElementById('btn-pause').addEventListener('click', togglePlayback);
    document.getElementById('btn-restart').addEventListener('click', restartCurrentTrack);
    
    // UI Controls
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);

    // Wheel Interaction
    document.getElementById('wheel-click-area').addEventListener('click', spinWheel);
});

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

// --- DATA & SHUFFLE LOGIC ---
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function loadLibrary() {
    try {
        const response = await fetch('data.json'); 
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        
        const names = Object.keys(fullLibrary);
        names.forEach((name) => {
            select.add(new Option(`${name} (${fullLibrary[name].length} tracks)`, name));
        });

        if (names.length > 0) {
            setupQueue(names[0]);
        }

        select.addEventListener('change', (e) => {
            setupQueue(e.target.value);
        });

    } catch (error) {
        console.error("Error loading data:", error);
    }
}

function setupQueue(playlistName) {
    const rawData = fullLibrary[playlistName];
    // Create a new shuffled queue
    shuffledQueue = shuffleArray([...rawData]);
    queueIndex = 0;
    
    console.log(`Loaded and shuffled: ${playlistName}`);
    resetTrackInfo();
}

// --- SPOTIFY API ---
async function fetchWebApi(endpoint, method, body) {
    // Proxy endpoint for API calls
    const res = await fetch(`https://api.spotify.com/$${endpoint}`, {
        headers: { 
            Authorization: `Bearer ${accessToken}`, 
            'Content-Type': 'application/json' 
        },
        method,
        body: body ? JSON.stringify(body) : undefined
    });
    
    if (res.status === 401) {
        window.sessionStorage.removeItem('access_token');
        location.reload();
    }
    return res;
}

async function playNextInQueue() {
    if (!shuffledQueue || shuffledQueue.length === 0) return;
    
    // Check if queue is finished
    if (queueIndex >= shuffledQueue.length) {
        if(confirm("Playlist finished! Reshuffle?")) {
            shuffledQueue = shuffleArray([...shuffledQueue]);
            queueIndex = 0;
        } else {
            return;
        }
    }

    currentTrack = shuffledQueue[queueIndex];
    queueIndex++;
    
    resetTrackInfo();

    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    const devicesData = await devicesRes.json();
    
    if (!devicesData.devices || !devicesData.devices.length) {
        return alert("Please open Spotify on a device first.");
    }
    
    // Pick active device or first available
    let deviceId = devicesData.devices[0].id;
    const active = devicesData.devices.find(d => d.is_active);
    if (active) deviceId = active.id;

    await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
}

async function togglePlayback() {
    const stateRes = await fetchWebApi('v1/me/player', 'GET');
    if (stateRes.status === 204) return; // No content
    
    const state = await stateRes.json();
    if (state.is_playing) {
        await fetchWebApi('v1/me/player/pause', 'PUT');
    } else {
        await fetchWebApi('v1/me/player/play', 'PUT');
    }
}

async function restartCurrentTrack() {
    await fetchWebApi('v1/me/player/seek?position_ms=0', 'PUT');
}

// --- UI HELPERS ---
function resetTrackInfo() {
    const ids = ['val-artist', 'val-title', 'val-year'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        el.textContent = '???';
        el.classList.remove('visible');
    });

    // Reset Timer UI
    clearInterval(timerInterval);
    const bar = document.getElementById('timer-bar');
    const disp = document.getElementById('timer-display');
    if(bar) {
        bar.style.width = '100%'; 
        bar.style.backgroundColor = 'var(--spotify-green)';
    }
    if(disp) {
        disp.textContent = '30';
        disp.style.color = '#fff';
    }
}

function revealAnswer() {
    if (!currentTrack) return;
    
    const artist = document.getElementById('val-artist');
    const title = document.getElementById('val-title');
    const year = document.getElementById('val-year');
    
    artist.textContent = currentTrack.artist;
    title.textContent = currentTrack.title;
    year.textContent = currentTrack.year;
    
    artist.classList.add('visible');
    title.classList.add('visible');
    year.classList.add('visible');
}

// --- WHEEL LOGIC (FIXED) ---

const legendIds = [
    'leg-color1', // Blue (0deg top)
    'leg-color2', // Purple
    'leg-color3', // Pink
    'leg-color4', // Orange
    'leg-color5'  // Gold
];

function spinWheel() {
    if (isSpinning) return;
    isSpinning = true;

    const wheel = document.getElementById('wheel');
    
    // Remove active class from all items
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('active'));

    // 1. Calculate new random rotation
    // We add at least 3 full spins (1080) + random part
    const extraSpins = 1080 + Math.floor(Math.random() * 1080);
    
    // 2. IMPORTANT: Add to the GLOBAL currentRotation
    currentRotation += extraSpins;
    
    // 3. Apply the new total rotation
    wheel.style.transform = `rotate(${currentRotation}deg)`;
    
    // 4. Wait for animation (4s)
    setTimeout(() => {
        // Calculate where we stopped (0-360 range)
        const realRotation = currentRotation % 360;
        
        // Map degrees to 5 segments of 72 degrees
        // Because CSS conic-gradient starts at top (0) and goes clockwise,
        // and rotation moves clockwise, we interpret the "Top" arrow by inverting.
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        
        const winningId = legendIds[index];
        const winningEl = document.getElementById(winningId);
        
        if (winningEl) {
            winningEl.classList.add('active');
        }
        
        isSpinning = false;
    }, 4000);
}

// --- TIMER LOGIC ---
let timerInterval;
const MAX_TIME = 30;

function startTimer() {
    clearInterval(timerInterval);
    const display = document.getElementById('timer-display');
    const bar = document.getElementById('timer-bar');
    
    let timeLeft = MAX_TIME;
    
    display.textContent = timeLeft;
    display.style.color = '#fff';
    bar.style.width = '100%';
    bar.style.backgroundColor = 'var(--spotify-green)';
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.textContent = timeLeft;
        
        // Update Bar Width
        const pct = (timeLeft / MAX_TIME) * 100;
        bar.style.width = `${pct}%`;

        // Panic Colors
        if (timeLeft <= 10) {
            display.style.color = 'var(--c-gold)';
            bar.style.backgroundColor = 'var(--c-gold)';
        }
        if (timeLeft <= 5) {
            display.style.color = 'var(--c-pink)';
            bar.style.backgroundColor = 'var(--c-pink)';
        }

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.textContent = "0";
            bar.style.width = '0%';
        }
    }, 1000);
}
