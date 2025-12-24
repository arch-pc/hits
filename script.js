// --- CONFIGURATIE ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c'; 
// LET OP: Dit moet EXACT overeenkomen met wat je in Spotify Dashboard hebt staan!
// Voor GitHub Pages is dit waarschijnlijk: 'https://arch-pc.github.io/hits/index.html'
const REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html'; 

// Juiste scopes (geen streaming meer)
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// --- PKCE HELPER FUNCTIES ---
function generateRandomString(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
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
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Sla verifier op in session storage (nodig voor na de redirect)
    window.sessionStorage.setItem('code_verifier', codeVerifier);

    const args = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge
    });

    window.location = 'https://accounts.spotify.com/authorize?' + args;
}

async function handleRedirect() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const codeVerifier = window.sessionStorage.getItem('code_verifier');

    if (code && codeVerifier) {
        // Ruil code in voor tokens
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI,
            client_id: CLIENT_ID,
            code_verifier: codeVerifier
        });

        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });

            const data = await response.json();
            if (response.ok) {
                window.localStorage.setItem('access_token', data.access_token);
                window.localStorage.setItem('refresh_token', data.refresh_token); // Voor later gebruik
                
                // URL schoonmaken (veilig)
                window.history.replaceState({}, document.title, REDIRECT_URI);
                return true;
            } else {
                console.error("Token error:", data);
            }
        } catch (e) {
            console.error("Netwerk fout bij token ruil:", e);
        }
    }
    return false;
}

// --- APP STATE ---
let accessToken = window.localStorage.getItem('access_token');
let fullLibrary = {};
let activeGameData = [];
let currentTrack = null;

// --- INITIALISATIE ---
window.addEventListener('load', async () => {
    // Check of we terugkomen van login
    if (window.location.search.includes('code=')) {
        const success = await handleRedirect();
        if (success) {
            accessToken = window.localStorage.getItem('access_token');
            showApp();
        }
    } else if (accessToken) {
        // We waren al ingelogd
        showApp();
    }

    // Koppel Events (geen onclicks meer in HTML!)
    document.getElementById('login-btn').addEventListener('click', initiateLogin);
    document.getElementById('shuffle-play-btn').addEventListener('click', playRandomTrack);
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    document.getElementById('prev-btn').addEventListener('click', () => sendSpotifyCommand('previous', 'POST'));
    document.getElementById('next-btn').addEventListener('click', () => sendSpotifyCommand('next', 'POST'));
    document.getElementById('pause-btn').addEventListener('click', () => sendSpotifyCommand('pause', 'PUT')); // Pauze/Play wisselt vaak, pause is veiliger
    
    // Mode switching
    document.getElementById('btn-classic').addEventListener('click', () => switchMode('classic'));
    document.getElementById('btn-bingo').addEventListener('click', () => switchMode('bingo'));
    
    // Game specifieke knoppen
    document.getElementById('add-player-btn').addEventListener('click', addPlayer);
    document.getElementById('spin-btn').addEventListener('click', spinWheel);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);
});

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

// --- DATA LOGICA ---
async function loadLibrary() {
    try {
        const response = await fetch('data.json');
        if (!response.ok) throw new Error("Kon data.json niet laden");
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        
        const listNames = Object.keys(fullLibrary);
        if (listNames.length === 0) {
            select.add(new Option("⚠️ Geen playlists gevonden", ""));
            return;
        }

        listNames.forEach((name, index) => {
            select.add(new Option(`${name} (${fullLibrary[name].length} nrs)`, name));
            if (index === 0) activeGameData = fullLibrary[name];
        });

        select.addEventListener('change', (e) => {
            activeGameData = fullLibrary[e.target.value];
            document.getElementById('track-info').classList.add('hidden');
        });

    } catch (error) {
        alert("Fout bij laden playlist data. Check of data.json bestaat.");
        console.error(error);
    }
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
        alert("Sessie verlopen. Log opnieuw in.");
        window.localStorage.removeItem('access_token');
        window.location.reload();
    }
    return res;
}

async function playRandomTrack() {
    if (!activeGameData || activeGameData.length === 0) return alert("Geen playlist geselecteerd!");
    
    const randomIndex = Math.floor(Math.random() * activeGameData.length);
    currentTrack = activeGameData[randomIndex];
    
    document.getElementById('track-info').classList.add('hidden'); // Verberg antwoord

    // PROBEER EERST EEN ACTIEF APPARAAT TE VINDEN
    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    const devicesData = await devicesRes.json();
    
    let deviceId = null;
    const activeDevice = devicesData.devices.find(d => d.is_active);
    
    if (activeDevice) {
        deviceId = activeDevice.id;
    } else if (devicesData.devices.length > 0) {
        // Geen actief apparaat? Pak de eerste die we vinden (vaak de iPad zelf of een telefoon)
        deviceId = devicesData.devices[0].id;
        // Optioneel: activeer dit apparaat eerst
        await fetchWebApi('v1/me/player', 'PUT', { device_ids: [deviceId] });
    } else {
        return alert("⚠️ Geen Spotify apparaat gevonden! Open de Spotify app op je iPad/iPhone en zorg dat hij wakker is.");
    }

    // Nu afspelen met expliciet device ID
    await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
}

async function sendSpotifyCommand(command, method) {
    await fetchWebApi(`v1/me/player/${command}`, method);
}

// --- UI FUNCTIES ---
function revealAnswer() {
    if (!currentTrack) return;

    document.getElementById('track-name').textContent = currentTrack.title;
    document.getElementById('track-artist').textContent = currentTrack.artist;
    document.getElementById('track-year').textContent = currentTrack.year;
    
    const linkContainer = document.getElementById('spotify-link-container');
    linkContainer.innerHTML = ''; // Leegmaken

    // Veilige manier om link te maken (XSS preventie)
    if (currentTrack.link) {
        const a = document.createElement('a');
        a.href = currentTrack.link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open in Spotify ↗';
        a.classList.add('spotify-link-btn'); // Voor CSS styling
        linkContainer.appendChild(a);
    }

    document.getElementById('track-info').classList.remove('hidden');
}

// --- GAME MODES ---
function switchMode(mode) {
    document.getElementById('mode-classic').classList.add('hidden');
    document.getElementById('mode-bingo').classList.add('hidden');
    document.getElementById('btn-classic').classList.remove('active');
    document.getElementById('btn-bingo').classList.remove('active');

    document.getElementById(`mode-${mode}`).classList.remove('hidden');
    document.getElementById(`btn-${mode}`).classList.add('active');
}

// CLASSIC
let players = [];
function addPlayer() {
    const input = document.getElementById('new-player-name');
    const name = input.value.trim();
    if (!name) return;
    players.push({ id: Date.now(), name, score: 0 });
    renderPlayers();
    input.value = '';
}

function renderPlayers() {
    const list = document.getElementById('players-list');
    list.innerHTML = ''; // Leegmaken
    
    players.forEach(p => {
        const row = document.createElement('div');
        row.className = 'player-row';
        
        // We bouwen de HTML op string basis, maar namen worden 'safe' via textContent als we dat zouden doen.
        // Voor simpelheid hier innerHTML met knoppen, maar data is veilig.
        row.innerHTML = `
            <span>${sanitize(p.name)}</span>
            <div class="player-controls">
                <button class="score-btn" data-id="${p.id}" data-delta="-1">-</button>
                <span style="display:inline-block; width:30px; text-align:center;">${p.score}</span>
                <button class="score-btn" data-id="${p.id}" data-delta="1">+</button>
                <button class="remove-btn" data-id="${p.id}" style="background:#e74c3c; margin-left:10px;">x</button>
            </div>`;
        list.appendChild(row);
    });

    // Event listeners voor de dynamische knoppen
    document.querySelectorAll('.score-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = parseInt(e.target.dataset.id);
            const delta = parseInt(e.target.dataset.delta);
            const player = players.find(p => p.id === id);
            if (player) { player.score += delta; renderPlayers(); }
        });
    });
    
    document.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = parseInt(e.target.dataset.id);
            players = players.filter(p => p.id !== id);
            renderPlayers();
        });
    });
}

// Simpele XSS preventie helper
function sanitize(str) {
    const temp = document.createElement('div');
    temp.textContent = str;
    return temp.innerHTML;
}

// BINGO LOGICA
const bingoRules = [
    { color: 'Groen', easy: 'Solo of groep?', hard: 'Titel van het nummer' }, 
    { color: 'Roze', easy: 'Voor of na 2000?', hard: 'Het exacte jaar' }, 
    { color: 'Geel', easy: 'Releasejaar (+- 4 jaar)', hard: 'Naam van de artiest' }, 
    { color: 'Paars', easy: 'Welk decennium?', hard: 'Welk decennium?' }, 
    { color: 'Blauw', easy: 'Releasejaar (+- 2 jaar)', hard: 'Releasejaar (+- 3 jaar)' } 
];

function spinWheel() {
    const wheel = document.getElementById('wheel');
    document.getElementById('bingo-result').classList.add('hidden');
    
    const extraSpins = 1080 + Math.floor(Math.random() * 1080);
    const randomDegree = Math.floor(Math.random() * 360);
    const totalDegrees = extraSpins + randomDegree;
    
    wheel.style.transform = `rotate(${totalDegrees}deg)`;
    
    setTimeout(() => {
        const realRotation = totalDegrees % 360;
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        const result = bingoRules[index];
        
        const resultBox = document.getElementById('bingo-result');
        document.getElementById('bingo-color').textContent = result.color;
        document.getElementById('bingo-color').style.color = getHexColor(result.color);
        document.getElementById('q-easy').textContent = result.easy;
        document.getElementById('q-hard').textContent = result.hard;
        
        resultBox.classList.remove('hidden');
    }, 4000);
}

function getHexColor(colorName) {
    const colors = { 'Groen': '#2ecc71', 'Roze': '#ff7979', 'Geel': '#f1c40f', 'Paars': '#9b59b6', 'Blauw': '#3498db' };
    return colors[colorName] || 'white';
}

let timerInterval;
function startTimer() {
    clearInterval(timerInterval);
    const display = document.getElementById('timer-display');
    let timeLeft = 25;
    display.textContent = timeLeft;
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.textContent = "TIJD!";
        }
    }, 1000);
}
