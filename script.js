// --- CONFIGURATIE ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c';
const REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html'; 
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// --- CRYPTO HELPER FUNCTIES (PKCE) ---
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

// --- AUTHENTICATIE LOGICA ---
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
        } catch (e) { console.error("Token fout:", e); }
    }
    return false;
}

// --- APP VARIABELEN ---
let accessToken = window.sessionStorage.getItem('access_token');
let fullLibrary = {};
let activeGameData = [];
let currentTrack = null;

// --- INIT ---
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
    document.getElementById('shuffle-play-btn').addEventListener('click', playRandomTrack);
    document.getElementById('prev-btn').addEventListener('click', () => sendSpotifyCommand('previous', 'POST'));
    document.getElementById('next-btn').addEventListener('click', () => sendSpotifyCommand('next', 'POST'));
    document.getElementById('pause-btn').addEventListener('click', () => sendSpotifyCommand('pause', 'PUT'));
    
    // Reveal & Wheel
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('spin-btn').addEventListener('click', spinWheel);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);
});

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

// --- DATA LADEN ---
async function loadLibrary() {
    try {
        const response = await fetch('data.json'); // Zorg dat dit bestand bestaat!
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        
        Object.keys(fullLibrary).forEach((name, index) => {
            select.add(new Option(`${name} (${fullLibrary[name].length} nrs)`, name));
            if (index === 0) activeGameData = fullLibrary[name];
        });

        select.addEventListener('change', (e) => {
            activeGameData = fullLibrary[e.target.value];
            resetTrackInfo();
        });

    } catch (error) {
        console.error("Fout bij laden data:", error);
    }
}

// --- SPOTIFY FUNCTIES ---
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
    
    resetTrackInfo(); // Verberg vorig antwoord

    // Zoek device en speel af
    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    const devicesData = await devicesRes.json();
    if (!devicesData.devices.length) return alert("Open Spotify op een apparaat!");
    
    const deviceId = devicesData.devices[0].id;
    await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
}

async function sendSpotifyCommand(command, method) {
    await fetchWebApi(`v1/me/player/${command}`, method);
}

// --- UI FUNCTIES ---

function resetTrackInfo() {
    // Verbergt de info weer (opacity 0)
    document.getElementById('track-info').classList.remove('visible');
}

function revealAnswer() {
    if (!currentTrack) return;

    document.getElementById('track-name').textContent = currentTrack.title;
    document.getElementById('track-artist').textContent = currentTrack.artist;
    document.getElementById('track-year').textContent = currentTrack.year;
    
    // Zorgt voor de fade-in (CSS opacity transitie)
    document.getElementById('track-info').classList.add('visible');
}

// --- BINGO WIEL LOGICA ---

// Alleen de MOEILIJKE opdrachten, gemapt op de kleuren van de CSS Conic Gradient
// Volgorde in CSS: Green, Pink, Yellow, Purple, Blue
const wheelRules = [
    { color: 'Groen', task: 'Zing het refrein mee!', hex: '#4CAF50' },
    { color: 'Roze',  task: 'Doe een bijpassend dansje', hex: '#E91E63' },
    { color: 'Geel',  task: 'Raad het exacte jaartal', hex: '#FFEB3B' },
    { color: 'Paars', task: 'Noem 3 andere nrs van deze artiest', hex: '#9C27B0' },
    { color: 'Blauw', task: 'Doe een Air-Guitar solo', hex: '#2196F3' }
];

function spinWheel() {
    const wheel = document.getElementById('wheel');
    const spinBtn = document.getElementById('spin-btn');
    
    // Reset tekst
    document.getElementById('bingo-color').textContent = "...";
    document.getElementById('bingo-color').style.color = "#555";
    document.getElementById('q-hard').textContent = "Draaien maar...";

    // Disable knop tijdens draaien
    spinBtn.disabled = true;

    // Bereken rotatie
    const extraSpins = 1080 + Math.floor(Math.random() * 1080); 
    const randomDegree = Math.floor(Math.random() * 360);
    const totalDegrees = extraSpins + randomDegree;
    
    wheel.style.transform = `rotate(${totalDegrees}deg)`;
    
    // Wacht 4 seconden (de tijd van de CSS transitie)
    setTimeout(() => {
        const realRotation = totalDegrees % 360;
        // Elk vlak is 72 graden (360 / 5)
        // Omdat de pijl bovenaan staat, rekenen we terug
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        
        const result = wheelRules[index];
        
        // Update UI
        const colorTitle = document.getElementById('bingo-color');
        colorTitle.textContent = result.color.toUpperCase();
        colorTitle.style.color = result.hex;
        
        document.getElementById('q-hard').textContent = result.task;
        
        spinBtn.disabled = false;
    }, 4000);
}

// --- TIMER ---
let timerInterval;
function startTimer() {
    clearInterval(timerInterval);
    const display = document.getElementById('timer-display');
    let timeLeft = 25;
    
    display.textContent = timeLeft;
    display.style.color = '#fff'; // Reset kleur
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.textContent = timeLeft;
        
        if (timeLeft <= 5) {
            display.style.color = '#e74c3c'; // Rood bij laatste 5 sec
        }

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.textContent = "0";
        }
    }, 1000);
}
