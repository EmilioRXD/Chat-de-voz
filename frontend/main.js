import { io } from "socket.io-client";

// Configuration
const BACKEND_URL = undefined; // Undefined lets Socket.IO connect to the same host/port as the page
const MAX_DISTANCE = 50; // Distancia máxima de audición (50 metros)
const MIN_DISTANCE = 5;  // Distancia donde el volumen empieza a bajar (rolloff)
const ROLLOFF_FACTOR = 1.5; // Qué tan rápido baja el volumen (mayor = más rápido)
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:voice.scape.nexus:3478',
            username: 'uservideo',
            credential: 'videopassword'
        }
    ]
};

// State
let socket;
let myStream;
let myPos = { x: 0, y: 0, z: 0 };
let peers = {}; // { socketId: { connection, gainNode, position } }
let audioContext;
let isMuted = false;
let isDeafened = false;
let mutedPeers = new Set();

// Elements
const loginOverlay = document.getElementById('login-overlay');
const mainInterface = document.getElementById('main-interface');
const loginForm = document.getElementById('login-form');
const radarCanvas = document.getElementById('radar-canvas');
const usersUl = document.getElementById('users-ul');
const currentPosSpan = document.getElementById('current-pos');
const disconnectBtn = document.getElementById('disconnect-btn');

// --- Initialization ---

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const x = parseFloat(document.getElementById('pos-x').value);
    const y = parseFloat(document.getElementById('pos-y').value);
    const z = parseFloat(document.getElementById('pos-z').value);

    try {
        await initAudio();
        connectSocket(username, x, y, z);
        myPos = { x, y, z };
        updateMyPositionUI();

        loginOverlay.classList.add('hidden');
        mainInterface.classList.remove('hidden');
    } catch (err) {
        console.error("Failed to init:", err);
        alert("Error accediendo al micrófono. Asegúrate de dar permisos.");
    }
});

disconnectBtn.addEventListener('click', () => {
    location.reload();
});

document.getElementById('test-audio-btn').addEventListener('click', () => {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().then(() => console.log("Resumed by button"));
    }
    // Also try to play all audio elements
    document.querySelectorAll('audio').forEach(el => el.play());
});

const muteBtn = document.getElementById('toggle-mute-btn');
const deafenBtn = document.getElementById('toggle-deafen-btn');

muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    if (myStream) {
        myStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    }
    muteBtn.classList.toggle('active', isMuted);
    muteBtn.innerText = isMuted ? '🔇' : '🎤';
});

deafenBtn.addEventListener('click', () => {
    isDeafened = !isDeafened;
    deafenBtn.classList.toggle('active', isDeafened);
    deafenBtn.innerText = isDeafened ? '🔇' : '🎧';
    updateAllVolumes();
});

// Movement Controls
document.querySelectorAll('.move-controls button').forEach(btn => {
    btn.addEventListener('click', () => {
        const axis = btn.dataset.axis;
        const dir = parseInt(btn.dataset.dir);
        const step = 5;

        if (axis === 'x') myPos.x += dir * step;
        if (axis === 'z') myPos.z += dir * step; // Using Z mostly for 2D radar visual, but logic supports 3D

        updateMyPositionUI();
        socket.emit('move', myPos);
        updateAllVolumes();
    });
});

// --- Audio & WebRTC ---

async function initAudio() {
    try {
        myStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("Microphone access granted");
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log("AudioContext state:", audioContext.state);
    } catch (e) {
        console.error("Error getting user media:", e);
    }
}

function connectSocket(username, x, y, z) {
    socket = io(BACKEND_URL);

    socket.on('connect', () => {
        console.log('Connected to signaling server');
        socket.emit('join', { username, x, y, z });
    });

    socket.on('all-users', (users) => {
        // Connect to existing users
        Object.values(users).forEach(user => {
            if (user.id !== socket.id) {
                createPeer(user.id, user.username, user, true); // Initiator
            }
        });
        updateRadar(users);
    });

    socket.on('user-joined', (user) => {
        console.log('User joined:', user.username);
        createPeer(user.id, user.username, user, false); // Not initiator
        peers[user.id].position = { x: user.x, y: user.y, z: user.z };
        updateList();
    });

    socket.on('user-moved', (data) => {
        if (peers[data.id]) {
            peers[data.id].position = { x: data.x, y: data.y, z: data.z };
            updateVolume(data.id);
            updateList();
            // In a real app we'd update radar more efficiently than full redraw
            // For simple demo, we rely on local state updates if we tracked all users specifically
        }
    });

    socket.on('user-left', (id) => {
        if (peers[id]) {
            peers[id].connection.close();
            delete peers[id];
            updateList();
            const dot = document.getElementById(`dot-${id}`);
            if (dot) dot.remove();
        }
    });

    socket.on('signal', async (data) => {
        const peer = peers[data.sender];
        if (peer) {
            try {
                if (data.signal.sdp) {
                    await peer.connection.setRemoteDescription(new RTCSessionDescription(data.signal));
                    if (data.signal.type === 'offer') {
                        const answer = await peer.connection.createAnswer();
                        await peer.connection.setLocalDescription(answer);
                        socket.emit('signal', { target: data.sender, signal: answer });
                    }
                } else if (data.signal.candidate) {
                    await peer.connection.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
                }
            } catch (e) {
                console.error("Signal error", e);
            }
        }
    });
}

function createPeer(targetId, username, initialData, initiator) {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Add my stream
    myStream.getTracks().forEach(track => pc.addTrack(track, myStream));

    // Handle ICE
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log("Sending ICE candidate to", targetId);
            socket.emit('signal', { target: targetId, signal: { candidate: event.candidate } });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log("ICE Connection State with " + targetId + ":", pc.iceConnectionState);
    };

    pc.ontrack = (event) => {
        console.log("Received remote stream/track from", targetId);
        const remoteStream = event.streams[0];

        // 1. Setup Web Audio Graph for proximity control (GainNode)
        setupAudioGraph(targetId, remoteStream);

        // 2. Attach to hidden muted element to satisfy browser playback policies
        attachAudioStream(targetId, remoteStream);

        // Debug info
        const track = remoteStream.getAudioTracks()[0];
        if (track) {
            track.onunmute = () => console.log("Track UNMUTED for", targetId);
        }
    };

    if (initiator) {
        pc.onnegotiationneeded = async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('signal', { target: targetId, signal: offer });
            } catch (err) {
                console.error("Negotiation error", err);
            }
        };
    }

    peers[targetId] = {
        connection: pc,
        username: username,
        position: { x: initialData.x, y: initialData.y, z: initialData.z }
    };

    updateList();
}

// Signal handling moved inside connectSocket


// --- Audio Graph (Proximity Logic) ---

function setupAudioGraph(id, stream) {
    if (peers[id].gainNode) return; // Already setup

    const source = audioContext.createMediaStreamSource(stream);
    const gainNode = audioContext.createGain();

    // Connect: Source -> Gain -> Destination
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);

    peers[id].gainNode = gainNode;
    updateVolume(id);

    // Ensure AudioContext is running (mobile requires user interaction)
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => console.log("AudioContext resumed"));
    }

    // Debug output
    const analyser = audioContext.createAnalyser();
    gainNode.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const checkAudio = () => {
        analyser.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        if (sum > 0) console.log(`Audio detecting from ${id}: level ${sum}`);
        if (peers[id]) requestAnimationFrame(checkAudio);
    };
    // Uncomment to debug raw audio levels if needed
    // checkAudio();
}

function updateVolume(id) {
    const peer = peers[id];
    if (!peer || !peer.gainNode) return;

    let volume = 0;

    // Solo calcular volumen si NO estamos esordecidos y NO hemos muteado a este par específico
    if (!isDeafened && !mutedPeers.has(id)) {
        const dist = calculateDistance(myPos, peer.position);

        if (dist <= MIN_DISTANCE) {
            volume = 1.0;
        } else if (dist >= MAX_DISTANCE) {
            volume = 0;
        } else {
            const normalizedDist = (dist - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE);
            volume = Math.pow(1 - normalizedDist, ROLLOFF_FACTOR);
        }
    }

    volume = Math.max(0, Math.min(1, volume));
    peer.gainNode.gain.setTargetAtTime(volume, audioContext.currentTime, 0.1);

    updateRadarVisuals();
}

function updateAllVolumes() {
    Object.keys(peers).forEach(id => updateVolume(id));
}

function calculateDistance(p1, p2) {
    return Math.sqrt(
        Math.pow(p2.x - p1.x, 2) +
        Math.pow(p2.y - p1.y, 2) +
        Math.pow(p2.z - p1.z, 2)
    );
}


// --- UI Helpers ---

function updateMyPositionUI() {
    currentPosSpan.innerText = `${myPos.x}, ${myPos.y}, ${myPos.z}`;
}

function updateList() {
    usersUl.innerHTML = '';
    Object.keys(peers).forEach(id => {
        const peer = peers[id];
        const li = document.createElement('li');
        const dist = calculateDistance(myPos, peer.position).toFixed(1);

        const isMutedPeer = mutedPeers.has(id);

        li.innerHTML = `
            <div class="peer-item-info">
                <strong>${peer.username}</strong>
                <span class="peer-dist">(${dist}m)</span>
            </div>
            <button class="btn-mute-peer ${isMutedPeer ? 'active' : ''}" data-id="${id}">
                ${isMutedPeer ? 'Unmute' : 'Mute'}
            </button>
        `;

        li.querySelector('button').addEventListener('click', (e) => {
            const peerId = e.target.dataset.id;
            if (mutedPeers.has(peerId)) {
                mutedPeers.delete(peerId);
            } else {
                mutedPeers.add(peerId);
            }
            updateList();
            updateVolume(peerId);
        });

        usersUl.appendChild(li);
    });
}

function updateRadar(allUsers) {
    // Basic initial render (only capable of simple updates in this demo structure)
    // Real implementation would reactively update all dots
}

function updateRadarVisuals() {
    // Clear old external dots
    document.querySelectorAll('.other-dot').forEach(el => el.remove());

    const centerX = radarCanvas.clientWidth / 2;
    const centerY = radarCanvas.clientHeight / 2;
    const scale = 2; // Pixels per meter

    Object.keys(peers).forEach(id => {
        const peer = peers[id];
        const dx = peer.position.x - myPos.x;
        const dz = peer.position.z - myPos.z; // Map Z to Y-axis on 2D screen

        // Only show if within visual range of radar box (approx)
        if (Math.abs(dx) * scale < centerX && Math.abs(dz) * scale < centerY) {
            const dot = document.createElement('div');
            dot.className = 'dot other-dot';
            dot.id = `dot-${id}`;
            dot.style.left = `${centerX + (dx * scale)}px`;
            dot.style.top = `${centerY + (dz * scale)}px`;
            radarCanvas.appendChild(dot);
        }
    });
}

// --- Audio Playback Helpers ---
// Create a hidden audio element for each peer to ensure playback policy is satisfied
// Web Audio API alone sometimes gets suspended or tracks stay muted unless attached to an element
function attachAudioStream(id, stream) {
    let audioEl = document.getElementById(`audio-${id}`);
    if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `audio-${id}`;
        audioEl.autoplay = true;
        audioEl.muted = true; // IMPORTANT: Mute it so we don't hear double audio
        audioEl.playsInline = true; // Important for iOS
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;

    // Attempt play
    audioEl.play().catch(e => console.log("Autoplay blocked for", id, e));
}
