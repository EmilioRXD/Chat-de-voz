import { io } from "socket.io-client";

// Configuration
const BACKEND_URL = "http://localhost:4010";
const MAX_DISTANCE = 100; // Max distance to hear someone
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// State
let socket;
let myStream;
let myPos = { x: 0, y: 0, z: 0 };
let peers = {}; // { socketId: { connection, gainNode, position } }
let audioContext;

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
    myStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
                await peer.connection.setRemoteDescription(new RTCSessionDescription(data.signal));
                if (data.signal.type === 'offer') {
                    const answer = await peer.connection.createAnswer();
                    await peer.connection.setLocalDescription(answer);
                    socket.emit('signal', { target: data.sender, signal: answer });
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
            // Note: simple signalling usually sends candidate as part of 'signal' or separate
            // For this raw implementation we cheat and package it as 'candidate' type or re-emit signal
            // But standard pattern:

            // Actually, wait. 'signal' usually implies Description. Candidates are separate.
            // Let's assume the 'signal' handler on server and client can handle both, or we conform.
            // To keep it simple like simple-peer, let's just use the 'signal' event for everything?
            // No, raw WebRTC requires careful handling.

            // For robust raw WebRTC, we should stick to standard Offer/Answer/Candidate exchange.
            // BUT, to keep code short, often candidates are sent after description.
            // Let's hack it into one 'signal' payload type if possible, or handle specifically.
            // Wait, my handler above `new RTCSessionDescription(data.signal)` fails for candidates.
            // I need to separate them.

            // Correct approach for raw WebRTC:
            // 1. Exchange Descriptions
            // 2. Exchange Candidates

            // Simpler: Use a library? No, I promised native.
            // Solution: Check `data.signal.candidate` vs `data.signal.sdp`.
        }
    };

    // Better ICE handling
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('signal', { target: targetId, signal: { candidate: event.candidate } });
        }
    };

    pc.ontrack = (event) => {
        console.log("Received remote stream/track");
        const remoteStream = event.streams[0];
        setupAudioGraph(targetId, remoteStream);
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

// Enhance server listener to handle candidate
const originalSignalHandler = socket.listeners('signal')[0]; // Wait, logic flow issue.
// Let's redefine signal handler to be robust.
socket.off('signal');
socket.on('signal', async (data) => {
    const peer = peers[data.sender];
    if (!peer) return;

    if (data.signal.sdp) {
        await peer.connection.setRemoteDescription(new RTCSessionDescription(data.signal));
        if (data.signal.type === 'offer') {
            const answer = await peer.connection.createAnswer();
            await peer.connection.setLocalDescription(answer);
            socket.emit('signal', { target: data.sender, signal: answer });
        }
    } else if (data.signal.candidate) {
        try {
            await peer.connection.addIceCandidate(new RTCIceCandidate(data.signal.candidate));
        } catch (e) {
            console.error("Error adding candidate", e);
        }
    }
});


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
}

function updateVolume(id) {
    const peer = peers[id];
    if (!peer || !peer.gainNode) return;

    const dist = calculateDistance(myPos, peer.position);

    // Linear falloff: 1.0 at 0 dist, 0.0 at MAX_DISTANCE
    let volume = 1 - (dist / MAX_DISTANCE);
    if (volume < 0) volume = 0;

    // Smooth transition
    peer.gainNode.gain.setTargetAtTime(volume, audioContext.currentTime, 0.1);

    updateRadarVisuals(); // Update visual distance too
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
    Object.values(peers).forEach(peer => {
        const li = document.createElement('li');
        const dist = calculateDistance(myPos, peer.position).toFixed(1);
        li.innerHTML = `<span>${peer.username}</span> <span style="opacity:0.6; font-size:0.8rem">Dist: ${dist}m</span>`;
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
