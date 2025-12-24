// --- CONFIGURATIE ---
const CLIENT_ID = 'a7f4c18653c549a99780219bf348a83c'; 
const REDIRECT_URI = window.location.href.split('?')[0]; // Huidige URL (zonder ? parameters)
const SCOPES = 'user-modify-playback-state user-read-currently-playing user-read-playback-state streaming';

// --- VARIABELEN ---
let accessToken = null;
let fullLibrary = {};    // Hier komen ALLE lijsten uit data.json in
let activeGameData = []; // Dit is de lijst die je NU aan het spelen bent
let currentTrack = null; // Het nummer dat nu geselecteerd is (het antwoord)

// 1. INITIALISATIE & LOGIN LOGICA
window.onload = async () => {
    // Check of we terugkomen van Spotify login (token zit in de URL hash)
    const hash = window.location.hash;
    if (hash) {
        const params = new URLSearchParams(hash.substring(1));
        accessToken = params.get('access_token');
        
        // Als we een token hebben, start de app
        if (accessToken) {
            document.getElementById('login-section').classList.add('hidden');
            document.getElementById('app-section').classList.remove('hidden');
            
            // URL opschonen (ziet er netter uit)
            window.history.replaceState(null, null, ' '); 
            
            // Bibliotheek laden
            await loadLibrary();
        }
    }
};

// Login knop actie
document.getElementById('login-btn').addEventListener('click', () => {
    let url = `https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=token&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`;
    window.location.href = url;
});

// 2. DATA FUNCTIES
// Laad data.json en vul het dropdown menu
async function loadLibrary() {
    try {
        const response = await fetch('data.json');
        if (!response.ok) throw new Error("Bestand niet gevonden");
        
        fullLibrary = await response.json();
        
        const select = document.getElementById('playlist-select');
        select.innerHTML = ''; // Reset menu
        
        const listNames = Object.keys(fullLibrary);
        
        if (listNames.length === 0) {
            const opt = document.createElement('option');
            opt.text = "⚠️ Geen playlists in data.json";
            select.add(opt);
            return;
        }

        // Vul menu opties
        listNames.forEach((name, index) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.text = `${name} (${fullLibrary[name].length} nrs)`;
            select.add(opt);
            
            // Selecteer automatisch de eerste lijst
            if (index === 0) {
                activeGameData = fullLibrary[name];
            }
        });

        // Luister naar wisselen van lijst
        select.addEventListener('change', (e) => {
            const chosen = e.target.value;
            if (chosen && fullLibrary[chosen]) {
                activeGameData = fullLibrary[chosen];
                // Reset huidige track info als je wisselt
                document.getElementById('track-info').classList.add('hidden');
            }
        });

    } catch (error) {
        alert("Kon 'data.json' niet laden! Heb je het Python script gedraaid en geüpload?");
        console.error(error);
    }
}

// Helper functie om met Spotify te praten
async function fetchWebApi(endpoint, method, body) {
    const res = await fetch(`https://api.spotify.com/${endpoint}`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        method,
        body: body ? JSON.stringify(body) : undefined
    });
    return res;
}

// 3. SPEL LOGICA (SHUFFLE & PLAY)
document.getElementById('shuffle-play-btn').addEventListener('click', async () => {
    if (!activeGameData || activeGameData.length === 0) {
        return alert("Selecteer eerst een geldige playlist!");
    }
    
    // 1. Kies een willekeurig nummer uit de JSON
    const randomIndex = Math.floor(Math.random() * activeGameData.length);
    currentTrack = activeGameData[randomIndex];
    
    // 2. Verberg het vorige antwoord DIRECT
    document.getElementById('track-info').classList.add('hidden');

    // 3. Stuur commando naar Spotify
    // We gebruiken 'uris' (meervoud) array, zelfs voor 1 nummer
    try {
        const res = await fetchWebApi(`v1/me/player/play`, 'PUT', { uris: [currentTrack.uri] });
        
        if (res.status === 404) {
            alert("⚠️ Geen actief Spotify apparaat gevonden! Open Spotify op je iPad/iPhone en start een willekeurig nummer, probeer het dan opnieuw.");
        } else if (res.status === 403) {
            alert("⚠️ Spotify Premium nodig of account beperking.");
        }
    } catch (e) {
        console.error("Fout bij afspelen:", e);
    }
});

// Toon Antwoord Knop
document.getElementById('reveal-btn').addEventListener('click', () => {
    if (!currentTrack) return;

    // Vul de gegevens in vanuit de JSON (niet van Spotify live data, want we willen JOUW jaartallen)
    document.getElementById('track-name').innerText = currentTrack.title;
    document.getElementById('track-artist').innerText = currentTrack.artist;
    document.getElementById('track-year').innerText = currentTrack.year;
    
    // De link knop maken
    const linkContainer = document.getElementById('spotify-link-container');
    if (currentTrack.link) {
        linkContainer.innerHTML = `<a href="${currentTrack.link}" target="_blank">Open in Spotify ↗</a>`;
    } else {
        linkContainer.innerHTML = "";
    }

    // Toon de box
    document.getElementById('track-info').classList.remove('hidden');
});

// Controls (Pause, Next, Prev)
document.getElementById('pause-btn').addEventListener('click', () => fetchWebApi('v1/me/player/pause', 'PUT'));
document.getElementById('next-btn').addEventListener('click', () => fetchWebApi('v1/me/player/next', 'POST')); 
document.getElementById('prev-btn').addEventListener('click', () => fetchWebApi('v1/me/player/previous', 'POST'));


// 4. GAME MODES (Bingo & Classic)
window.switchMode = (mode) => {
    document.getElementById('mode-classic').classList.add('hidden');
    document.getElementById('mode-bingo').classList.add('hidden');
    document.getElementById('btn-classic').classList.remove('active');
    document.getElementById('btn-bingo').classList.remove('active');

    document.getElementById(`mode-${mode}`).classList.remove('hidden');
    document.getElementById(`btn-${mode}`).classList.add('active');
};

// --- CLASSIC MODE (Spelers) ---
let players = [];

window.addPlayer = () => {
    const input = document.getElementById('new-player-name');
    const name = input.value.trim();
    if (!name) return;
    
    players.push({ id: Date.now(), name, score: 0 });
    renderPlayers();
    input.value = '';
};

function renderPlayers() {
    const list = document.getElementById('players-list');
    list.innerHTML = '';
    players.forEach(p => {
        list.innerHTML += `
            <div class="player-row">
                <span>${p.name}</span>
                <div class="player-controls">
                    <button onclick="updateScore(${p.id}, -1)">-</button>
                    <span style="display:inline-block; width:30px; text-align:center;">${p.score}</span>
                    <button onclick="updateScore(${p.id}, 1)">+</button>
                    <button onclick="removePlayer(${p.id})" style="background:#e74c3c; font-size:0.8em; margin-left:10px;">x</button>
                </div>
            </div>`;
    });
}

window.updateScore = (id, delta) => {
    const p = players.find(x => x.id === id);
    if (p) {
        p.score += delta;
        renderPlayers();
    }
};

window.removePlayer = (id) => {
    players = players.filter(p => p.id !== id);
    renderPlayers();
};

// --- BINGO MODE (Rad) ---
const bingoRules = [
    { color: 'Groen', easy: 'Solo of groep?', hard: 'Titel van het nummer' }, 
    { color: 'Roze', easy: 'Voor of na 2000?', hard: 'Het exacte jaar' }, 
    { color: 'Geel', easy: 'Releasejaar (+- 4 jaar)', hard: 'Naam van de artiest' }, 
    { color: 'Paars', easy: 'Welk decennium?', hard: 'Welk decennium?' }, 
    { color: 'Blauw', easy: 'Releasejaar (+- 2 jaar)', hard: 'Releasejaar (+- 3 jaar)' } 
];

window.spinWheel = () => {
    const wheel = document.getElementById('wheel');
    
    // Reset vorige draai
    document.getElementById('bingo-result').classList.add('hidden');
    
    // Willekeurige draai tussen 3 en 6 rondjes extra (1080 - 2160 graden)
    const extraSpins = 1080 + Math.floor(Math.random() * 1080);
    const randomDegree = Math.floor(Math.random() * 360);
    const totalDegrees = extraSpins + randomDegree;
    
    wheel.style.transform = `rotate(${totalDegrees}deg)`;
    
    // Wacht op einde animatie (4 seconden in CSS)
    setTimeout(() => {
        // Bereken welk vakje bovenaan staat
        // Omdat de pijl bovenaan staat, moeten we kijken wat er op 0 graden uitkomt.
        // Conic gradient begint bovenaan en gaat met de klok mee.
        // De rotatie draait het hele wiel met de klok mee.
        // De 'werkelijke' rotatie is totalDegrees % 360.
        // Als rotatie 20 graden is, staat het segment dat oorspronkelijk op 340 graden zat nu bovenaan.
        // Index formule: 
        const realRotation = totalDegrees % 360;
        const segmentSize = 360 / 5; // 72 graden per vakje
        
        // We moeten terugrekenen: (360 - rotatie) / 72
        let index = Math.floor(((360 - realRotation) % 360) / segmentSize);
        
        const result = bingoRules[index];
        
        // Toon resultaat
        const resultBox = document.getElementById('bingo-result');
        document.getElementById('bingo-color').innerText = result.color;
        document.getElementById('bingo-color').style.color = getHexColor(result.color);
        document.getElementById('q-easy').innerText = result.easy;
        document.getElementById('q-hard').innerText = result.hard;
        
        resultBox.classList.remove('hidden');
        
    }, 4000); // Zelfde tijd als CSS transition
};

function getHexColor(colorName) {
    switch(colorName) {
        case 'Groen': return '#2ecc71';
        case 'Roze': return '#ff7979';
        case 'Geel': return '#f1c40f';
        case 'Paars': return '#9b59b6';
        case 'Blauw': return '#3498db';
        default: return 'white';
    }
}

// Timer Logica
let timerInterval;
window.startTimer = () => {
    clearInterval(timerInterval);
    const display = document.getElementById('timer-display');
    let timeLeft = 25;
    
    display.innerText = timeLeft;
    display.style.color = '#e74c3c'; // Rood begin
    
    timerInterval = setInterval(() => {
        timeLeft--;
        display.innerText = timeLeft;
        
        if (timeLeft <= 5) {
             // Knipperen ofzo
             display.style.color = (timeLeft % 2 === 0) ? 'red' : 'white';
        }

        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            display.innerText = "TIJD!";
        }
    }, 1000);
};
