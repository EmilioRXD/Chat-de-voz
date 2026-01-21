const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); // Para parsear JSON en POST requests

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity in this demo
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 4010;

// State
let users = {};
let minecraftData = null; // Datos del addon de Minecraft
const voiceStates = new Map(); // { gamertag: { isTalking, volume } }

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // User joins with initial position
    socket.on('join', (userData) => {
        users[socket.id] = {
            id: socket.id,
            username: userData.username,
            x: userData.x || 0,
            y: userData.y || 0,
            z: userData.z || 0
        };

        // Broadcast list of existing users to the new user
        socket.emit('all-users', users);

        // Notify others of the new user
        socket.broadcast.emit('user-joined', users[socket.id]);

        console.log(`User ${userData.username} joined at [${userData.x}, ${userData.y}, ${userData.z}]`);
    });

    // User updates position
    socket.on('move', (position) => {
        if (users[socket.id]) {
            users[socket.id].x = position.x;
            users[socket.id].y = position.y;
            users[socket.id].z = position.z;

            // Broadcast position update to everyone (could be optimized to only neighbors)
            io.emit('user-moved', {
                id: socket.id,
                x: position.x,
                y: position.y,
                z: position.z
            });
        }
    });

    // Voice Detection (VAD)
    socket.on('voice-detection', (data) => {
        // data: { gamertag, isTalking, volume }
        voiceStates.set(data.gamertag, {
            isTalking: data.isTalking,
            volume: data.volume
        });

        console.log(`🎤 ${data.gamertag}: ${data.isTalking ? `TALKING (${data.volume.toFixed(1)}dB)` : 'SILENT'}`);
    });

    // WebRTC Signaling
    socket.on('signal', (data) => {
        // data: { target: targetSocketId, signal: signalData }
        io.to(data.target).emit('signal', {
            sender: socket.id,
            signal: data.signal
        });
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            console.log(`User ${users[socket.id].username} disconnected`);
            delete users[socket.id];
            io.emit('user-left', socket.id);
        }
    });
});

// Endpoint para recibir datos del addon de Minecraft
app.post('/minecraft-data', (req, res) => {
    minecraftData = req.body;
    console.log('📦 Minecraft data received:', minecraftData.players?.length || 0, 'players');

    // Broadcast a todos los clientes conectados vía Socket.IO
    io.emit('minecraft-update', {
        players: minecraftData.players,
        config: minecraftData.config
    });

    // Preparar respuesta para el addon con estados de voz
    const voiceStatesArray = Array.from(voiceStates.entries()).map(([gamertag, state]) => ({
        gamertag,
        isTalking: state.isTalking,
        volume: state.volume
    }));

    // Determinar estados de conexión (quién está conectado al chat de voz)
    const connectionStates = minecraftData.players?.map(player => {
        // Buscar si el jugador está conectado al sistema de voz (Socket.IO)
        const isConnected = Object.values(users).some(u => u.username === player.name);
        return {
            gamertag: player.name,
            isConnected,
            inMinecraftWorld: true
        };
    }) || [];

    // Responder al addon de Minecraft
    res.json({
        success: true,
        voiceStates: voiceStatesArray,
        connectionStates
    });
});

app.get('/', (req, res) => {
    res.send('Proximity Voice Chat Backend Running');
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
