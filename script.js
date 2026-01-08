// --- CONFIGURATION ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c';
const REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html'; 
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// --- AUTH HELPERS ---
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

// --- APP LOGIC ---
let accessToken = window.sessionStorage.getItem('access_token');
let fullLibrary = {};
let activeGameData = [];
let currentTrack = null;
let isSpinning = false;

window.addEventListener('load', async () => {
    if (window.location.search.includes('code=')) {
        if (await handleRedirect()) {
            accessToken = window.sessionStorage.getItem('access_token');
            showApp();
        }
    } else if (accessToken) {
        showApp();
    }

    // Listeners
    document.getElementById('login-btn').addEventListener('click', initiateLogin);
    
    // DJ Controls
    document.getElementById('shuffle-play-btn').addEventListener('click', playRandomTrack);
    document.getElementById('prev-btn').addEventListener('click', () => sendSpotifyCommand('previous', 'POST'));
    document.getElementById('next-btn').addEventListener('click', () => sendSpotifyCommand('next', 'POST'));
    document.getElementById('pause-btn').addEventListener('click', () => sendSpotifyCommand('pause', 'PUT'));
    
    // Reveal & Timer
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);

    // CLICK ON WHEEL TO SPIN
    document.getElementById('wheel-click-area').addEventListener('click', spinWheel);
});

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

async function loadLibrary() {
    try {
        const response = await fetch('data.json'); 
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        
        Object.keys(fullLibrary).forEach((name, index) => {
            select.add(new Option(`${name} (${fullLibrary[name].length} tracks)`, name));
            if (index === 0) activeGameData = fullLibrary[name];
        });

        select.addEventListener('change', (e) => {
            activeGameData = fullLibrary[e.target.value];
            resetTrackInfo();
        });

    } catch (error) {
        console.error("Error loading data:", error);
    }
}

// --- SPOTIFY ---
async function fetchWebApi(endpoint, method, body) {
    const res = await fetch(`https://api.spotify.com/${endpoint}`, {
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

async function playRandomTrack() {
    if (!activeGameData || activeGameData.length === 0) return;
    
    const randomIndex = Math.floor(Math.random() * activeGameData.length);
    currentTrack = activeGameData[randomIndex];
    
    resetTrackInfo();

    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    const devicesData = await devicesRes.json();
    if (!devicesData.devices.length) return alert("Open Spotify on a device first!");
    
    const deviceId = devicesData.devices[0].id;
    await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
}

async function sendSpotifyCommand(command, method) {
    await fetchWebApi(`v1/me/player/${command}`, method);
}

// --- UI ---
function resetTrackInfo() {
    document.getElementById('track-info').classList.remove('visible');
}

function revealAnswer() {
    if (!currentTrack) return;
    document.getElementById('track-name').textContent = currentTrack.title;
    document.getElementById('track-artist').textContent = currentTrack.artist;
    document.getElementById('track-year').textContent = currentTrack.year;
    document.getElementById('track-info').classList.add('visible');
}

// --- WHEEL LOGIC (LEGEND BASED) ---

// Mapping: wheel segment index -> HTML ID of the legend item
const legendIds = [
    'leg-green',  // 0
    'leg-pink',   // 1
    'leg-yellow', // 2
    'leg-purple', // 3
    'leg-blue'    // 4
];

function spinWheel() {
    if (isSpinning) return; // Prevent double click
    isSpinning = true;

    const wheel = document.getElementById('wheel');
    
    // Reset Legend styles
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('active'));

    const extraSpins = 1080 + Math.floor(Math.random() * 1080); 
    const randomDegree = Math.floor(Math.random() * 360);
    const totalDegrees = extraSpins + randomDegree;
    
    wheel.style.transform = `rotate(${totalDegrees}deg)`;
    
    setTimeout(() => {
        const realRotation = totalDegrees % 360;
        // Calculation to map rotation to 5 segments
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        
        // Highlight the legend item
        const winningId = legendIds[index];
        const winningEl = document.getElementById(winningId);
        
        if (winningEl) {
            winningEl.classList.add('active');
        }
        
        isSpinning = false;
    }, 4000);
}

// --- TIMER ---
let timerInterval;
function startTimer() {
    clearInterval(timerInterval);
    const display = document.getElementById('timer-display');
    let timeLeft = 25;
    
    display.textContent = timeLeft;
    display.style.color = 'inherit';
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.textContent = timeLeft;
        
        if (timeLeft <= 5) display.style.color = '#e74c3c';
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.textContent = "0";
        }
    }, 1000);
}
