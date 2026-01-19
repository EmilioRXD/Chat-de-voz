const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity in this demo
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// State
let users = {};

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

app.get('/', (req, res) => {
    res.send('Proximity Voice Chat Backend Running');
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
