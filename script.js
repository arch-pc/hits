// --- CONFIGURATIE ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c';
const REDIRECT_URI = 'https://arch-pc.github.io/hits/index.html'; 
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';

// --- CRYPTO HELPER FUNCTIES (Veilig) ---
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

// --- AUTHENTICATIE LOGICA (PKCE + STATE) ---
async function initiateLogin() {
    const codeVerifier = generateRandomString(128);
    const state = generateRandomString(16); // Anti-CSRF token
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Opslaan voor validatie na redirect
    window.sessionStorage.setItem('code_verifier', codeVerifier);
    window.sessionStorage.setItem('spotify_auth_state', state);

    const args = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
        state: state, // Veiligheid: stuur state mee
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

    // Opruimen URL (veiligheid)
    window.history.replaceState({}, document.title, REDIRECT_URI);
    
    // Validaties
    if (error) {
        console.error("Spotify Auth Error:", error);
        return false;
    }

    if (!returnedState || returnedState !== storedState) {
        alert("Beveiligingsfout: State mismatch. Log opnieuw in.");
        return false;
    }

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
                // Schoon de storage op
                window.sessionStorage.removeItem('code_verifier');
                window.sessionStorage.removeItem('spotify_auth_state');
                return true;
            } else {
                console.error("Token error:", data);
            }
        } catch (e) {
            console.error("Netwerk fout:", e);
        }
    }
    return false;
}

// --- APP LOGICA ---
let accessToken = window.sessionStorage.getItem('access_token');
let fullLibrary = {};
let activeGameData = [];
let currentTrack = null;

window.addEventListener('load', async () => {
    // Check redirect
    if (window.location.search.includes('code=')) {
        const success = await handleRedirect();
        if (success) {
            accessToken = window.sessionStorage.getItem('access_token');
            showApp();
        }
    } else if (accessToken) {
        showApp();
    }

    // Event Listeners (DOM)
    document.getElementById('login-btn').addEventListener('click', initiateLogin);
    document.getElementById('shuffle-play-btn').addEventListener('click', playRandomTrack);
    document.getElementById('reveal-btn').addEventListener('click', revealAnswer);
    
    document.getElementById('prev-btn').addEventListener('click', () => sendSpotifyCommand('previous', 'POST'));
    document.getElementById('next-btn').addEventListener('click', () => sendSpotifyCommand('next', 'POST'));
    document.getElementById('pause-btn').addEventListener('click', () => sendSpotifyCommand('pause', 'PUT'));
    
    document.getElementById('btn-classic').addEventListener('click', () => switchMode('classic'));
    document.getElementById('btn-bingo').addEventListener('click', () => switchMode('bingo'));
    document.getElementById('add-player-btn').addEventListener('click', addPlayer);
    document.getElementById('spin-btn').addEventListener('click', spinWheel);
    document.getElementById('start-timer-btn').addEventListener('click', startTimer);
});

async function showApp() {
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('app-section').classList.remove('hidden');
    await loadLibrary();
}

// --- DATA ---
async function loadLibrary() {
    try {
        const response = await fetch('data.json');
        if (!response.ok) throw new Error("Fout bij laden data.json");
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';
        
        const listNames = Object.keys(fullLibrary);
        if (listNames.length === 0) {
            select.add(new Option("⚠️ Geen playlists", ""));
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
        console.error(error);
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
        alert("Sessie verlopen. Log opnieuw in.");
        window.location.reload();
    }
    return res;
}

async function playRandomTrack() {
    if (!activeGameData || activeGameData.length === 0) return alert("Geen playlist geselecteerd!");
    
    const randomIndex = Math.floor(Math.random() * activeGameData.length);
    currentTrack = activeGameData[randomIndex];
    
    document.getElementById('track-info').classList.add('hidden'); 

    const devicesRes = await fetchWebApi('v1/me/player/devices', 'GET');
    if (!devicesRes.ok) return;

    const devicesData = await devicesRes.json();
    let deviceId = null;
    const activeDevice = devicesData.devices.find(d => d.is_active);
    
    if (activeDevice) deviceId = activeDevice.id;
    else if (devicesData.devices.length > 0) deviceId = devicesData.devices[0].id;
    else return alert("⚠️ Geen Spotify apparaat gevonden! Open de app.");

    await fetchWebApi(`v1/me/player/play?device_id=${deviceId}`, 'PUT', { uris: [currentTrack.uri] });
}

async function sendSpotifyCommand(command, method) {
    await fetchWebApi(`v1/me/player/${command}`, method);
}

// --- UI / VEILIGHEID ---
function revealAnswer() {
    if (!currentTrack) return;

    // textContent is veilig (geen HTML parsing)
    document.getElementById('track-name').textContent = currentTrack.title;
    document.getElementById('track-artist').textContent = currentTrack.artist;
    document.getElementById('track-year').textContent = currentTrack.year;
    
    const linkContainer = document.getElementById('spotify-link-container');
    linkContainer.innerHTML = ''; 

    // STRICT LINK VALIDATION
    // We checken of het een geldige URL is én of het domain klopt.
    if (currentTrack.link) {
        try {
            const url = new URL(currentTrack.link);
            if (url.protocol === 'https:' && url.hostname === 'open.spotify.com') {
                const a = document.createElement('a');
                a.href = currentTrack.link;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = 'Open in Spotify ↗';
                a.style.color = '#1DB954';
                a.style.textDecoration = 'none';
                a.style.border = '1px solid #1DB954';
                a.style.padding = '8px 15px';
                a.style.borderRadius = '20px';
                a.style.display = 'inline-block';
                linkContainer.appendChild(a);
            }
        } catch (e) {
            console.warn("Ongeldige link genegeerd:", currentTrack.link);
        }
    }
    document.getElementById('track-info').classList.remove('hidden');
}

// --- MODES ---
function switchMode(mode) {
    document.getElementById('mode-classic').classList.add('hidden');
    document.getElementById('mode-bingo').classList.add('hidden');
    document.getElementById('btn-classic').classList.remove('active');
    document.getElementById('btn-bingo').classList.remove('active');

    document.getElementById(`mode-${mode}`).classList.remove('hidden');
    document.getElementById(`btn-${mode}`).classList.add('active');
}

// SCOREBORD - VEILIGE DOM MANIPULATIE (Geen innerHTML)
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
    list.innerHTML = ''; // Container leegmaken mag wel
    
    players.forEach(p => {
        // We bouwen de elementen op met JS functies, niet met tekst
        const row = document.createElement('div');
        row.className = 'player-row';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = p.name; // Veilig!

        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'player-controls';

        // Min knop
        const minBtn = createButton('-', () => updateScore(p.id, -1));
        minBtn.style.backgroundColor = '#555';

        // Score
        const scoreSpan = document.createElement('span');
        scoreSpan.style.display = 'inline-block';
        scoreSpan.style.width = '30px';
        scoreSpan.style.textAlign = 'center';
        scoreSpan.textContent = p.score;

        // Plus knop
        const plusBtn = createButton('+', () => updateScore(p.id, 1));
        plusBtn.style.backgroundColor = '#555';

        // Verwijder knop
        const removeBtn = createButton('x', () => removePlayer(p.id));
        removeBtn.style.backgroundColor = '#e74c3c';
        removeBtn.style.marginLeft = '10px';

        // Alles in elkaar zetten
        controlsDiv.append(minBtn, scoreSpan, plusBtn, removeBtn);
        row.append(nameSpan, controlsDiv);
        list.appendChild(row);
    });
}

// Helper voor knoppen
function createButton(text, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.padding = '5px 12px';
    btn.style.margin = '0 2px';
    btn.style.color = 'white';
    btn.style.border = 'none';
    btn.style.borderRadius = '20px';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', onClick);
    return btn;
}

function updateScore(id, delta) {
    const p = players.find(x => x.id === id);
    if (p) { p.score += delta; renderPlayers(); }
}

function removePlayer(id) {
    players = players.filter(p => p.id !== id);
    renderPlayers();
}

// BINGO & TIMER
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
    
    const extraSpins = 1080 + Math.floor(Math.random() * 1080); // Animatie random mag wel Math.random zijn
    const randomDegree = Math.floor(Math.random() * 360);
    const totalDegrees = extraSpins + randomDegree;
    
    wheel.style.transform = `rotate(${totalDegrees}deg)`;
    
    setTimeout(() => {
        const realRotation = totalDegrees % 360;
        const index = Math.floor(((360 - realRotation) % 360) / 72);
        const result = bingoRules[index];
        
        const resultBox = document.getElementById('bingo-result');
        // textContent = veilig
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
    display.style.color = '#e74c3c';
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.textContent = "TIJD!";
            display.style.color = 'white';
        }
    }, 1000);
}
