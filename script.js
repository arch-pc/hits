// --- CONFIGURATIE ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c'; // Check of dit klopt!
const REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html'; // Check of dit klopt!
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// --- AUTH HELPER FUNCTIES (PKCE) ---
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

    // LET OP: Dit is de officiële Spotify link
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
    
    if (error) { alert("Login Fout: " + error); return false; }
    if (!returnedState || returnedState !== storedState) { alert("Beveiligingsfout: State mismatch"); return false; }

    if (code && storedVerifier) {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: storedVerifier
        });

        try {
            // LET OP: Officiële Token URL
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await response.json();
            if (response.ok) {
                window.sessionStorage.setItem('access_token', data.access_token);
                return true;
            } else {
                console.error("Token Error:", data);
                alert("Kon geen token krijgen van Spotify.");
            }
        } catch (e) { console.error("Netwerk Fout:", e); }
    }
    return false;
}

// --- APP STATES ---
let accessToken = window.sessionStorage.getItem('access_token');
let fullLibrary = {};
let shuffledQueue = [];
let queueIndex = 0;
let currentTrack = null;
let isSpinning = false;
let currentRotation = 0; // Voor het wiel

// --- INIT ---
window.addEventListener('load', async () => {
    // 1. Check Login Redirect
    if (window.location.search.includes('code=')) {
        if (await handleRedirect()) {
            accessToken = window.sessionStorage.getItem('access_token');
            showApp();
        }
    } else if (accessToken) {
        // 2. Al ingelogd
        showApp();
    }

    // Buttons koppelen
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

// --- DATA ---
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
        if (!response.ok) throw new Error("Kan data.json niet vinden!");
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        const playlistNames = Object.keys(fullLibrary);

        if (playlistNames.length === 0) {
            alert("Je data.json bestand is leeg!");
            return;
        }

        playlistNames.forEach((name) => {
            select.add(new Option(`${name} (${fullLibrary[name].length} songs)`, name));
        });

        // Eerste laden
        setupQueue(playlistNames[0]);

        select.addEventListener('change', (e) => {
            setupQueue(e.target.value);
        });

    } catch (error) {
        console.error("Data Error:", error);
        alert("Fout bij laden data.json. Check de console.");
    }
}

function setupQueue(playlistName) {
    const rawData = fullLibrary[playlistName];
    if (!rawData) return;
    shuffledQueue = shuffleArray([...rawData]);
    queueIndex = 0;
    resetTrackInfo();
}

// --- SPOTIFY API (CRUCIAAL) ---

async function fetchWebApi(endpoint, method, body) {
    // LET OP: Dit moet https://api.spotify.com/ zijn!
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
        alert("Je sessie is verlopen. De pagina wordt herladen.");
        window.location.reload();
    }
    return res;
}

// --- DJ FUNCTIES (MET FOUTMELDINGEN) ---

async function playNextInQueue() {
    if (!shuffledQueue || shuffledQueue.length === 0) {
        alert("Wacht even, de playlist is nog niet geladen of is leeg.");
        return;
    }
    
    // Check einde lijst
    if (queueIndex >= shuffledQueue.length) {
        if(confirm("Playlist is klaar! Opnieuw husselen?")) {
            shuffledQueue = shuffleArray([...shuffledQueue]);
            queueIndex = 0;
        } else {
            return;
        }
    }

    currentTrack = shuffledQueue[queueIndex];
    queueIndex++;
    resetTrackInfo(); 

    // 1. Zoek actieve apparaten
    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    const devicesData = await devicesRes.json();
    
    // DEBUG HULP
    console.log("Gevonden apparaten:", devicesData);

    if (!devicesData.devices || devicesData.devices.length === 0) {
        alert("⚠️ GEEN APPARAAT GEVONDEN!\n\nOpen Spotify op je telefoon of laptop en speel iets af zodat hij 'wakker' is.");
        return;
    }
    
    // Zoek het 'actieve' apparaat, anders pak de eerste
    let deviceId = devicesData.devices[0].id;
    const activeDevice = devicesData.devices.find(d => d.is_active);
    if (activeDevice) deviceId = activeDevice.id;

    console.log("Spelen op device:", deviceId);
    console.log("Track URI:", currentTrack.uri);

    // 2. Start afspelen
    const playRes = await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
    
    if (!playRes.ok) {
        const err = await playRes.json();
        console.error("Play Error:", err);
        // Specifieke foutmelding voor premium
        if (err.error && err.error.reason === "PREMIUM_REQUIRED") {
            alert("Fout: Je hebt Spotify Premium nodig om specifieke nummers te kiezen.");
        } else {
            alert("Spotify Fout: Kon nummer niet starten. Check console.");
        }
    }
}

async function togglePlayback() {
    // Eerst status ophalen
    const stateRes = await fetchWebApi('v1/me/player', 'GET');
    
    // Status 204 betekent: Er is wel een sessie, maar er speelt niks actiefs en er staat niks op pauze.
    if (stateRes.status === 204) {
        alert("Spotify slaapt. Klik eerst op 'Next Song' om de verbinding te activeren.");
        return;
    }

    if (stateRes.ok) {
        const state = await stateRes.json();
        if (state.is_playing) {
            await fetchWebApi('v1/me/player/pause', 'PUT');
        } else {
            await fetchWebApi('v1/me/player/play', 'PUT');
        }
    } else {
        alert("Kon status niet ophalen. Is Spotify open?");
    }
}

async function restartCurrentTrack() {
    const res = await fetchWebApi('v1/me/player/seek?position_ms=0', 'PUT');
    if (!res.ok) alert("Kon niet terugspoelen. Speelt er iets?");
}

// --- UI FUNCTIES ---
function resetTrackInfo() {
    ['val-artist', 'val-title', 'val-year'].forEach(id => {
        const el = document.getElementById(id);
        if(el) { el.textContent = '???'; el.classList.remove('visible'); }
    });
    // Timer reset
    clearInterval(timerInterval);
    const bar = document.getElementById('timer-bar');
    const disp = document.getElementById('timer-display');
    if(bar) bar.style.width = '100%';
    if(disp) { disp.textContent = '30'; disp.style.color = '#fff'; }
}

function revealAnswer() {
    if (!currentTrack) return;
    const ids = { 'val-artist': currentTrack.artist, 'val-title': currentTrack.title, 'val-year': currentTrack.year };
    
    for (const [id, val] of Object.entries(ids)) {
        const el = document.getElementById(id);
        if(el) {
            el.textContent = val;
            el.classList.add('visible');
        }
    }
}

// --- WIEL LOGICA ---
const legendIds = ['leg-color1', 'leg-color2', 'leg-color3', 'leg-color4', 'leg-color5'];

function spinWheel() {
    if (isSpinning) return; 
    isSpinning = true;

    const wheel = document.getElementById('wheel');
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('active'));

    // OPTELLENDE ROTATIE (Cruciaal voor meerdere keren draaien)
    const extraSpins = 1080 + Math.floor(Math.random() * 1080); 
    currentRotation += extraSpins;
    
    wheel.style.transform = `rotate(${currentRotation}deg)`;
    
    setTimeout(() => {
        const realRotation = currentRotation % 360;
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        
        const winningEl = document.getElementById(legendIds[index]);
        if (winningEl) winningEl.classList.add('active');
        
        isSpinning = false;
    }, 4000);
}

// --- TIMER ---
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
        bar.style.width = `${(timeLeft / MAX_TIME) * 100}%`;

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
