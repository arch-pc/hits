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
let shuffledQueue = []; // Hier slaan we de gehusselde lijst op
let queueIndex = 0;     // Waar zijn we in de lijst?
let currentTrack = null;

window.addEventListener('load', async () => {
    // (Login check code hierboven laten staan zoals die was...)
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
    
    // NIEUWE DJ CONTROLS
    document.getElementById('btn-next').addEventListener('click', playNextInQueue);
    document.getElementById('btn-pause').addEventListener('click', () => sendSpotifyCommand('pause', 'PUT')); // Werkt als toggle vaak
    document.getElementById('btn-restart').addEventListener('click', restartCurrentTrack);
    
    // Reveal & Timer
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);

    // Wheel
    document.getElementById('wheel-click-area').addEventListener('click', spinWheel);
});

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

// Fisher-Yates Shuffle Algorithm (Echt random zonder dubbele)
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
        
        Object.keys(fullLibrary).forEach((name, index) => {
            select.add(new Option(`${name} (${fullLibrary[name].length} tracks)`, name));
        });

        // Initialize first playlist
        if (Object.keys(fullLibrary).length > 0) {
            setupQueue(Object.keys(fullLibrary)[0]);
        }

        select.addEventListener('change', (e) => {
            setupQueue(e.target.value);
        });

    } catch (error) {
        console.error("Error loading data:", error);
    }
}

function setupQueue(playlistName) {
    // 1. Maak kopie van originele data
    const rawData = fullLibrary[playlistName];
    // 2. Shuffle de data
    shuffledQueue = shuffleArray([...rawData]);
    // 3. Reset index
    queueIndex = 0;
    
    console.log(`Queue loaded for ${playlistName}: ${shuffledQueue.length} songs.`);
    resetTrackInfo();
}

// --- SPOTIFY ---
async function fetchWebApi(endpoint, method, body) {
    const res = await fetch(`https://api.spotify.com/${endpoint}`, { // Let op: officiële URL
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
    
    // Check of we aan het einde zijn
    if (queueIndex >= shuffledQueue.length) {
        alert("Playlist is finished! Reshuffling...");
        shuffledQueue = shuffleArray([...shuffledQueue]);
        queueIndex = 0;
    }

    // Pak volgend nummer
    currentTrack = shuffledQueue[queueIndex];
    queueIndex++; // Verhoog teller voor volgende keer
    
    resetTrackInfo(); // Maak velden leeg/onzichtbaar

    // Start afspelen
    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    const devicesData = await devicesRes.json();
    if (!devicesData.devices || !devicesData.devices.length) return alert("Open Spotify on a device first!");
    
    const deviceId = devicesData.devices[0].id;
    await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
}

async function restartCurrentTrack() {
    // seek to 0 position
    await fetchWebApi('v1/me/player/seek?position_ms=0', 'PUT');
    // Ensure it's playing
    await fetchWebApi('v1/me/player/play', 'PUT');
}

async function sendSpotifyCommand(command, method) {
    // Voor pause/play button. Als command 'pause' is, checken we vaak de status, 
    // maar voor simpele toggle kunnen we proberen 'play' te sturen als hij gepauzeerd is en andersom.
    // Voor nu simpel: als command 'pause' is, stuur pause request.
    // Eigenlijk heeft de button label 'Pause / Play', dus we gebruiken de player status.
    
    const stateRes = await fetchWebApi('v1/me/player', 'GET');
    if(stateRes.ok) {
        const state = await stateRes.json();
        if(state.is_playing) {
            await fetchWebApi('v1/me/player/pause', 'PUT');
        } else {
            await fetchWebApi('v1/me/player/play', 'PUT');
        }
    }
}

// --- UI ---
function resetTrackInfo() {
    // Maak waarden leeg en verberg ze
    const fields = ['val-artist', 'val-title', 'val-year'];
    fields.forEach(id => {
        const el = document.getElementById(id);
        el.textContent = '???';
        el.classList.remove('visible');
    });
    
    // Reset timer UI ook voor de netheid
    document.getElementById('timer-bar').style.width = '100%';
    document.getElementById('timer-display').textContent = '30';
    clearInterval(timerInterval);
}

function revealAnswer() {
    if (!currentTrack) return;
    
    // Vul waarden in
    document.getElementById('val-artist').textContent = currentTrack.artist;
    document.getElementById('val-title').textContent = currentTrack.title;
    document.getElementById('val-year').textContent = currentTrack.year;
    
    // Maak zichtbaar (fade in via CSS class)
    document.getElementById('val-artist').classList.add('visible');
    document.getElementById('val-title').classList.add('visible');
    document.getElementById('val-year').classList.add('visible');
}
// --- WHEEL LOGIC (EXACT TASK MATCH) ---

// Mapping: wheel segment index -> HTML ID of the legend item
const legendIds = [
    'leg-color1', // Blue   - Name Artist
    'leg-color2', // Purple - Name Title
    'leg-color3', // Pink   - Exact Year
    'leg-color4', // Orange - Decade
    'leg-color5'  // Gold   - Year +- 3
];

function spinWheel() {
    if (isSpinning) return; 
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
        // Calculation to map rotation to 5 segments (72 degrees each)
        // With current CSS Conic Gradient, 0deg is top (Blue).
        // Arrow points to top.
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        
        const winningId = legendIds[index];
        const winningEl = document.getElementById(winningId);
        
        if (winningEl) {
            winningEl.classList.add('active');
        }
        
        isSpinning = false;
    }, 4000);
}

// --- TIMER (VISUAL BAR) ---
let timerInterval;
const MAX_TIME = 30; // Seconds

function startTimer() {
    clearInterval(timerInterval);
    const display = document.getElementById('timer-display');
    const bar = document.getElementById('timer-bar');
    
    let timeLeft = MAX_TIME;
    
    // Reset UI
    display.textContent = timeLeft;
    display.style.color = '#fff';
    bar.style.width = '100%';
    bar.style.backgroundColor = 'var(--spotify-green)';
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.textContent = timeLeft;
        
        // Update Bar Width
        const percentage = (timeLeft / MAX_TIME) * 100;
        bar.style.width = `${percentage}%`;

        // Change colors based on urgency
        if (timeLeft <= 10) {
            display.style.color = 'var(--c-gold)';
            bar.style.backgroundColor = 'var(--c-gold)';
        }
        if (timeLeft <= 5) {
            display.style.color = 'var(--c-pink)'; // Alarm color
            bar.style.backgroundColor = 'var(--c-pink)';
        }

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.textContent = "0";
            bar.style.width = '0%';
        }
    }, 1000);
}
