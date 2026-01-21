import { io } from "socket.io-client";
import { VoiceDetector } from "./VoiceDetector.js";

// Configuration
const BACKEND_URL = undefined; // Undefined lets Socket.IO connect to the same host/port as the page
let MAX_DISTANCE = 50; // Distancia máxima de audición (50 metros) - ahora controlado por Minecraft
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
let peers = {}; // { socketId: { connection, gainNode, position, username, customVolume } }
let audioContext;

// Minecraft integration
let minecraftData = null;
let voiceDetector = null;
let myUsername = '';
let isConnectedToMinecraft = false;

// Elements
const loginOverlay = document.getElementById('login-overlay');
const mainInterface = document.getElementById('main-interface');
const loginForm = document.getElementById('login-form');

const usersUl = document.getElementById('users-ul');
const currentPosSpan = document.getElementById('current-pos');
const disconnectBtn = document.getElementById('disconnect-btn');
const minecraftStatusEl = document.getElementById('minecraft-status');
const voiceIndicatorEl = document.getElementById('voice-indicator');
const voiceDbSpan = document.getElementById('voice-db');
const micSelector = document.getElementById('mic-selector');

// --- Initialization ---

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    // Coordinates controlled by Minecraft now
    const x = 0;
    const y = 0;
    const z = 0;

    myUsername = username;

    try {
        await initAudio();
        await loadMicrophones();
        await initAudio();
        await loadMicrophones();
        connectSocket(username);
        // myPos will wait for Minecraft data


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

// Movement Controls Removed (Controlled by Minecraft)

// --- Audio & WebRTC ---

async function initAudio() {
    try {
        myStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });

        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Inicializar VoiceDetector
        voiceDetector = new VoiceDetector(myStream, (isTalking, volumeDb) => {
            // Enviar al servidor
            if (socket && myUsername) {
                socket.emit('voice-detection', {
                    gamertag: myUsername,
                    isTalking,
                    volume: volumeDb
                });
            }

            // Actualizar UI local
            updateVoiceIndicator(isTalking, volumeDb);
        });

        console.log("✓ Audio initialized with voice detection");
    } catch (e) {
        console.error("Error getting user media:", e);
        throw e;
    }
}

function connectSocket(username) {
    socket = io(BACKEND_URL);

    socket.on('connect', () => {
        console.log('Connected to signaling server');
        socket.emit('join', { username });
    });


    socket.on('all-users', (users) => {
        // Connect to existing users
        Object.values(users).forEach(user => {
            if (user.id !== socket.id) {
                createPeer(user.id, user.username, user, true); // Initiator
            }
        });

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
    // Escuchar actualizaciones de Minecraft
    socket.on('minecraft-update', (data) => {
        minecraftData = data;
        console.log('📦 Minecraft update:', data.players?.length || 0, 'players');

        const myPlayer = data.players?.find(p => p.name === myUsername);

        if (myPlayer) {
            isConnectedToMinecraft = true;

            // Sync Position
            if (myPlayer.location) {
                myPos = myPlayer.location;
                updateMyPositionUI();
                // No emit 'move', backend knows.
            }


            applyMinecraftSettings(myPlayer.data);
            updateMinecraftStatus(true);
        } else {
            isConnectedToMinecraft = false;
            muteAllAudio();
            updateMinecraftStatus(false);
        }

        // Sync Peer Positions
        if (data.players) {
            data.players.forEach(p => {
                if (p.name !== myUsername) {
                    // Find peer by username (since socket ID mapping is separate)
                    // We need to match username -> socketID
                    const peerId = Object.keys(peers).find(id => peers[id].username === p.name);
                    if (peerId && p.location) {
                        peers[peerId].position = p.location;
                        updateVolume(peerId);
                    }
                }
            });
        }


        if (data.config?.maxDistance) {
            MAX_DISTANCE = data.config.maxDistance;
            updateAllVolumes();
        }

        updateList();
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

    // Solo calcular volumen si estamos conectados a Minecraft
    if (isConnectedToMinecraft) {
        const dist = calculateDistance(myPos, peer.position);

        if (dist <= MIN_DISTANCE) {
            volume = 1.0;
        } else if (dist >= MAX_DISTANCE) {
            volume = 0;
        } else {
            const normalizedDist = (dist - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE);
            volume = Math.pow(1 - normalizedDist, ROLLOFF_FACTOR);
        }

        // Aplicar volumen personalizado desde Minecraft
        const customVolume = peer.customVolume ?? 1.0;
        volume *= customVolume;
    }

    volume = Math.max(0, Math.min(1, volume));
    peer.gainNode.gain.setTargetAtTime(volume, audioContext.currentTime, 0.1);


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
        const dist = calculateDistance(myPos, peer.position).toFixed(1);

        // Generar URL de skin de Minecraft
        const skinUrl = `https://mc-api.io/render/face/${encodeURIComponent(peer.username)}/bedrock`;

        const li = document.createElement('li');
        li.className = 'peer-item';

        li.innerHTML = `
            <div class="peer-avatar">
                <img src="${skinUrl}" alt="${peer.username}" 
                     onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2232%22 height=%2232%22%3E%3Crect fill=%22%23888%22 width=%2232%22 height=%2232%22/%3E%3C/svg%3E'">
            </div>
            <div class="peer-info">
                <strong>${peer.username}</strong>
                <div class="peer-stats">
                    <span class="peer-dist">📍 ${dist}m</span>
                </div>
            </div>
            <div class="peer-indicators">
                ${isConnectedToMinecraft ? '🎮' : ''}
            </div>
        `;

        usersUl.appendChild(li);
    });
}

// Radar functions removed


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
function applyMinecraftSettings(playerData) {
    if (myStream) {
        myStream.getAudioTracks().forEach(track => {
            track.enabled = !playerData.isMuted;
        });
    }

    if (playerData.isDeafened) {
        muteAllAudio();
    } else {
        Object.keys(peers).forEach(id => {
            const peer = peers[id];
            const customVol = playerData.customVolumes?.[peer.username] ?? 1.0;
            peer.customVolume = customVol;
            updateVolume(id);
        });
    }
}

function muteAllAudio() {
    Object.keys(peers).forEach(id => {
        if (peers[id].gainNode) {
            peers[id].gainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.1);
        }
    });
}

function updateMinecraftStatus(connected) {
    if (minecraftStatusEl) {
        const disconnectedSpan = minecraftStatusEl.querySelector('.status-disconnected');
        const connectedSpan = minecraftStatusEl.querySelector('.status-connected');

        if (connected) {
            disconnectedSpan?.classList.add('hidden');
            connectedSpan?.classList.remove('hidden');
            minecraftStatusEl.classList.add('connected');
        } else {
            disconnectedSpan?.classList.remove('hidden');
            connectedSpan?.classList.add('hidden');
            minecraftStatusEl.classList.remove('connected');
        }
    }
}

function updateVoiceIndicator(isTalking, volumeDb) {
    if (voiceIndicatorEl && voiceDbSpan) {
        if (isTalking) {
            voiceIndicatorEl.classList.remove('hidden');
            voiceDbSpan.innerText = volumeDb.toFixed(1);
        } else {
            voiceIndicatorEl.classList.add('hidden');
        }
    }
}

async function loadMicrophones() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');

        if (micSelector) {
            micSelector.innerHTML = '';
            audioInputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${micSelector.length + 1}`;
                micSelector.appendChild(option);
            });

            micSelector.removeEventListener('change', onMicChange);
            micSelector.addEventListener('change', onMicChange);
        }
    } catch (e) {
        console.error("Error loading microphones:", e);
    }
}

async function onMicChange(e) {
    await changeMicrophone(e.target.value);
}

async function changeMicrophone(deviceId) {
    console.log('🎤 Changing microphone context to:', deviceId);

    if (myStream) {
        myStream.getTracks().forEach(t => t.stop());
    }

    try {
        myStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        if (voiceDetector) voiceDetector.dispose();

        voiceDetector = new VoiceDetector(myStream, (isTalking, volumeDb) => {
            if (socket && myUsername) {
                socket.emit('voice-detection', {
                    gamertag: myUsername,
                    isTalking,
                    volume: volumeDb
                });
            }
            updateVoiceIndicator(isTalking, volumeDb);
        });

        Object.values(peers).forEach(peer => {
            const senders = peer.connection.getSenders();
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            if (audioSender) {
                audioSender.replaceTrack(myStream.getAudioTracks()[0]);
            }
        });

        console.log('✓ Microphone updated successfully');
    } catch (e) {
        console.error("Error changing microphone:", e);
        alert("Error al cambiar de micrófono.");
    }
}

// Ensure AudioContext starts correctly
document.addEventListener('click', () => {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
}, { once: true });
