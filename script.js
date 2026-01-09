// --- CONFIGURATIE ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c'; // Jouw Client ID
const REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html'; // Jouw Github URL
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// --- AUTH HELPER FUNCTIES (PKCE Security) ---
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

// --- AUTHENTICATIE FLOW ---
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

    // Correcte Spotify Authorize URL
    window.location = 'https://accounts.spotify.com/authorize?' + args;
}

async function handleRedirect() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const returnedState = urlParams.get('state');
    const error = urlParams.get('error');

    const storedVerifier = window.sessionStorage.getItem('code_verifier');
    const storedState = window.sessionStorage.getItem('spotify_auth_state');

    // URL opschonen
    window.history.replaceState({}, document.title, REDIRECT_URI);
    
    if (error) { console.error("Spotify Auth Error:", error); return false; }
    if (!returnedState || returnedState !== storedState) { alert("Security Error: State mismatch."); return false; }

    if (code && storedVerifier) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: storedVerifier
        });

        try {
            // Correcte Spotify Token URL
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await response.json();
            if (response.ok) {
                window.sessionStorage.setItem('access_token', data.access_token);
                // Ook refresh token opslaan voor later gebruik zou netter zijn, 
                // maar voor nu is dit voldoende voor een sessie van 1 uur.
                return true;
            } else {
                console.error("Token error:", data);
            }
        } catch (e) { console.error("Netwerk fout:", e); }
    }
    return false;
}

// --- APP STATES ---
let accessToken = window.sessionStorage.getItem('access_token');
let fullLibrary = {};     // Alle playlists uit data.json
let shuffledQueue = [];   // De huidige gehusselde afspeellijst
let queueIndex = 0;       // Welk nummer zijn we?
let currentTrack = null;  // Het huidige track object
let isSpinning = false;   // Voorkomt dubbel klikken op het wiel

// --- INITIALISATIE ---
window.addEventListener('load', async () => {
    // 1. Check of we terugkomen van login
    if (window.location.search.includes('code=')) {
        if (await handleRedirect()) {
            accessToken = window.sessionStorage.getItem('access_token');
            showApp();
        }
    } else if (accessToken) {
        // 2. We zijn al ingelogd
        showApp();
    }

    // 3. Event Listeners koppelen
    document.getElementById('login-btn').addEventListener('click', initiateLogin);
    
    // DJ Knoppen
    document.getElementById('btn-next').addEventListener('click', playNextInQueue);
    document.getElementById('btn-pause').addEventListener('click', togglePlayback);
    document.getElementById('btn-restart').addEventListener('click', restartCurrentTrack);
    
    // Info & Timer
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);

    // Wiel
    document.getElementById('wheel-click-area').addEventListener('click', spinWheel);
});

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

// --- DATA & QUEUE LOGICA ---

// Fisher-Yates Shuffle: Zorgt voor een perfecte, random volgorde zonder dubbelen
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
        if (!response.ok) throw new Error("Kon data.json niet vinden");
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        
        const playlistNames = Object.keys(fullLibrary);
        
        if (playlistNames.length === 0) {
            alert("data.json is leeg!");
            return;
        }

        // Dropdown vullen
        playlistNames.forEach((name) => {
            select.add(new Option(`${name} (${fullLibrary[name].length} songs)`, name));
        });

        // Eerste playlist direct laden en shufflen
        setupQueue(playlistNames[0]);

        // Luister naar verandering van playlist
        select.addEventListener('change', (e) => {
            setupQueue(e.target.value);
        });

    } catch (error) {
        console.error("Fout bij laden data:", error);
    }
}

function setupQueue(playlistName) {
    const rawData = fullLibrary[playlistName];
    if (!rawData) return;

    // Maak kopie en shuffle
    shuffledQueue = shuffleArray([...rawData]);
    queueIndex = 0;
    
    console.log(`Queue geladen voor ${playlistName}: ${shuffledQueue.length} nummers.`);
    resetTrackInfo(); // Reset het scherm
}

// --- SPOTIFY API FUNCTIES ---

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
        // Token verlopen
        window.sessionStorage.removeItem('access_token');
        alert("Sessie verlopen. Log opnieuw in.");
        window.location.reload();
    }
    return res;
}

// Speelt het volgende nummer in de gehusselde lijst
async function playNextInQueue() {
    if (!shuffledQueue || shuffledQueue.length === 0) return;
    
    // Check of we aan het einde zijn
    if (queueIndex >= shuffledQueue.length) {
        const restart = confirm("Playlist is afgelopen! Wil je opnieuw beginnen (reshuffle)?");
        if (restart) {
            shuffledQueue = shuffleArray([...shuffledQueue]);
            queueIndex = 0;
        } else {
            return;
        }
    }

    // Pak huidige track en hoog index op
    currentTrack = shuffledQueue[queueIndex];
    queueIndex++;

    resetTrackInfo(); // UI leegmaken

    // Haal actieve apparaten op
    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    const devicesData = await devicesRes.json();
    
    if (!devicesData.devices || !devicesData.devices.length) {
        return alert("⚠️ Geen Spotify apparaat gevonden! Open Spotify op je device.");
    }
    
    // Gebruik het eerste actieve apparaat, of gewoon het eerste in de lijst
    let deviceId = devicesData.devices[0].id;
    const activeDevice = devicesData.devices.find(d => d.is_active);
    if (activeDevice) deviceId = activeDevice.id;

    // Start afspelen
    await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
}

// Toggle Play/Pause
async function togglePlayback() {
    const stateRes = await fetchWebApi('v1/me/player', 'GET');
    if (!stateRes.ok) return; // Geen actieve speler
    
    // Soms geeft Spotify 204 No Content als er niks speelt
    if (stateRes.status === 204) return alert("Start eerst een nummer.");

    const state = await stateRes.json();
    if (state.is_playing) {
        await fetchWebApi('v1/me/player/pause', 'PUT');
    } else {
        await fetchWebApi('v1/me/player/play', 'PUT');
    }
}

// Start nummer opnieuw (Seek to 0)
async function restartCurrentTrack() {
    await fetchWebApi('v1/me/player/seek?position_ms=0', 'PUT');
}

// --- UI FUNCTIES ---

function resetTrackInfo() {
    // Info velden resetten
    const fields = ['val-artist', 'val-title', 'val-year'];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = '???';
            el.classList.remove('visible');
        }
    });

    // Timer resetten
    clearInterval(timerInterval);
    const timerBar = document.getElementById('timer-bar');
    const timerDisplay = document.getElementById('timer-display');
    if (timerBar) {
        timerBar.style.width = '100%';
        timerBar.style.backgroundColor = 'var(--spotify-green)';
    }
    if (timerDisplay) {
        timerDisplay.textContent = '30';
        timerDisplay.style.color = '#fff';
    }
}

function revealAnswer() {
    if (!currentTrack) return;
    
    const artistEl = document.getElementById('val-artist');
    const titleEl = document.getElementById('val-title');
    const yearEl = document.getElementById('val-year');

    artistEl.textContent = currentTrack.artist;
    titleEl.textContent = currentTrack.title;
    yearEl.textContent = currentTrack.year;

    // Animatie triggeren
    artistEl.classList.add('visible');
    titleEl.classList.add('visible');
    yearEl.classList.add('visible');
}

// --- BINGO WIEL FUNCTIES ---

// ID's van de legenda items (volgorde moet matchen met CSS Conic Gradient segments)
// Volgorde in CSS was: Blue (0-20%), Purple (20-40%), Pink (40-60%), Orange (60-80%), Gold (80-100%)
const legendIds = [
    'leg-color1', // Blue
    'leg-color2', // Purple
    'leg-color3', // Pink
    'leg-color4', // Orange
    'leg-color5'  // Gold
];

function spinWheel() {
    if (isSpinning) return; 
    isSpinning = true;

    const wheel = document.getElementById('wheel');
    
    // Reset vorige highlights
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('active'));

    // Bereken rotatie
    const extraSpins = 1080 + Math.floor(Math.random() * 1080); // Minimaal 3 rondjes
    const randomDegree = Math.floor(Math.random() * 360);
    const totalDegrees = extraSpins + randomDegree;
    
    wheel.style.transform = `rotate(${totalDegrees}deg)`;
    
    // Wacht 4 seconden (duur van CSS transition)
    setTimeout(() => {
        const realRotation = totalDegrees % 360;
        
        // Bereken welk segment bovenaan staat (0 graden)
        // Elk segment is 72 graden (360 / 5)
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        
        const winningId = legendIds[index];
        const winningEl = document.getElementById(winningId);
        
        if (winningEl) {
            winningEl.classList.add('active');
        }
        
        isSpinning = false;
    }, 4000);
}

// --- TIMER FUNCTIES ---
let timerInterval;
const MAX_TIME = 30;

function startTimer() {
    clearInterval(timerInterval);
    const display = document.getElementById('timer-display');
    const bar = document.getElementById('timer-bar');
    
    let timeLeft = MAX_TIME;
    
    // Reset startstaat
    display.textContent = timeLeft;
    display.style.color = '#fff';
    bar.style.width = '100%';
    bar.style.backgroundColor = 'var(--spotify-green)';
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.textContent = timeLeft;
        
        // Update breedte van de balk
        const percentage = (timeLeft / MAX_TIME) * 100;
        bar.style.width = `${percentage}%`;

        // Kleuren veranderen als de tijd bijna op is
        if (timeLeft <= 10) {
            display.style.color = 'var(--c-gold)'; // Geel/Goud
            bar.style.backgroundColor = 'var(--c-gold)';
        }
        if (timeLeft <= 5) {
            display.style.color = 'var(--c-pink)'; // Rood/Roze
            bar.style.backgroundColor = 'var(--c-pink)';
        }

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.textContent = "0";
            bar.style.width = '0%';
        }
    }, 1000);
}
