// server.js - Survive.com Backend Logic
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); 

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
const STARTING_HEALTH = 20;
const MATCH_DURATION_MS = 120000; // 2 minutes

// IMPORTANT: Set CORS origin to allow your frontend domain and the Render domain
const io = new Server(server, {
    cors: {
        origin: [
            process.env.FRONTEND_URL || 'https://www.survive.com',
            process.env.PUBLIC_BASE || 'https://survive.com',
            'https://your-render-static-site.onrender.com' // Replace with your actual Render Static Site URL
        ],
        methods: ["GET", "POST"]
    }
});

// --- ROOM STATE MANAGEMENT ---
const rooms = {};
const availableAnimals = ['Aardvark', 'Bear', 'Cat', 'Dog', 'Elephant', 'Fox', 'Giraffe', 'Hedgehog', 'Iguana', 'Jaguar', 'Kangaroo', 'Lion', 'Monkey', 'Newt', 'Owl', 'Panda', 'Quail', 'Rabbit', 'Snake', 'Tiger'];

const createNewPlayer = (id, nickname, isBot = false) => ({
    id,
    nickname,
    health: STARTING_HEALTH,
    animalName: null,
    isBot,
    score: 0,
    isConnected: true
});

const getRoomState = (code) => rooms[code];

const assignNames = (room) => {
    let animals = [...availableAnimals];
    room.players.forEach(p => {
        if (!p.animalName) {
            const randomIndex = Math.floor(Math.random() * animals.length);
            p.animalName = animals.splice(randomIndex, 1)[0];
        }
    });
    room.callerId = room.players.find(p => p.animalName === 'Aardvark')?.id || room.players[0].id;
    room.currentResponderId = null;
    room.matchStartTime = null;
    room.isGameActive = false;
};

const broadcastState = (code) => {
    const room = getRoomState(code);
    if (room) {
        // Send a clean, current state
        io.to(code).emit('state', {
            players: room.players.filter(p => p.health > 0 || p.isBot), // Filter out eliminated humans
            callerId: room.callerId,
            currentResponderId: room.currentResponderId,
            matchTimeRemaining: room.matchTimeRemaining,
            isGameActive: room.isGameActive,
            gameStatus: room.gameStatus,
            timer: room.timer
        });
    }
};

const handleFail = (room, failedPlayerId, reason = 'timer') => {
    const caller = room.players.find(p => p.id === room.callerId);
    const failedPlayer = room.players.find(p => p.id === failedPlayerId);
    
    // 1. Damage Logic
    if (failedPlayer) {
        failedPlayer.health -= 2;
        console.log(`${failedPlayer.nickname} failed. Health: ${failedPlayer.health}`);
    }
    
    // 2. Name/Role Swap (only if failed player is not eliminated)
    if (failedPlayer && failedPlayer.health > 0) {
        if (caller) {
            // Swap names
            const tempName = caller.animalName;
            caller.animalName = failedPlayer.animalName;
            failedPlayer.animalName = tempName;

            // Swap roles (Caller goes to the failed player's spot, failed player becomes new caller)
            room.callerId = failedPlayerId; 
        }
    } else if (failedPlayer && failedPlayer.health <= 0) {
        // Player eliminated. Caller stays, and a new random responder is selected to continue the chain.
        room.players = room.players.filter(p => p.id !== failedPlayerId);
        room.currentResponderId = null; 
    }
    
    // 3. Continue the chain
    room.timer = 0; // Stop the countdown
    room.currentResponderId = null; // Reset responder
    startNewCall(room);
};

const startNewCall = (room) => {
    // Logic for the new Aardvark (the new callerId) to pick a target.
    room.currentResponderId = null; // The caller must choose a new target
    
    const activePlayers = room.players.filter(p => p.health > 0);
    if (activePlayers.length <= 1) {
        room.gameStatus = 'ENDED';
        room.isGameActive = false;
        clearInterval(room.matchInterval);
        console.log(`Game over for room ${room.code}. Winner: ${activePlayers[0]?.nickname || 'No one'}`);
    } else {
        // Find the new caller (the one whose ID is room.callerId)
        const caller = activePlayers.find(p => p.id === room.callerId);
        if (caller && caller.isBot) {
             // Bot logic to pick a random target and "call" them after a delay
             setTimeout(() => {
                const target = activePlayers.filter(p => p.id !== caller.id)[0]; // Simplified bot pick
                if (target) {
                    handleCall(room, caller.id, target.animalName);
                }
             }, 1000); // 1 second delay for bot "call"
        }
    }
    broadcastState(room.code);
};

const startCountdown = (room) => {
    if (room.timerInterval) clearInterval(room.timerInterval);
    
    room.timer = 10;
    room.timerInterval = setInterval(() => {
        if (!room.isGameActive || !room.currentResponderId) {
            clearInterval(room.timerInterval);
            return;
        }
        
        room.timer--;
        if (room.timer <= 0) {
            clearInterval(room.timerInterval);
            // Damage the failed player
            handleFail(room, room.currentResponderId, 'timer'); 
        }
        broadcastState(room.code);
    }, 1000);
};


const handleCall = (room, callerId, calledAnimalName) => {
    // 1. Check if the call is valid
    const calledPlayer = room.players.find(p => p.animalName === calledAnimalName && p.health > 0);
    if (!calledPlayer) return; 

    // 2. If no one was the responder (Aardvark/caller is picking the first target)
    if (!room.currentResponderId) {
        room.currentResponderId = calledPlayer.id;
        startCountdown(room); // Start 10s countdown for the new responder
    } 
    // 3. If the correct person is responding (the current responder is trying to pass the chain)
    else if (callerId === room.currentResponderId) {
        room.currentResponderId = calledPlayer.id; // Pass the chain to the new person
        room.players.find(p => p.id === callerId).score += 1; // Reward the successful caller
        startCountdown(room); // Restart the 10s countdown
    }
    
    broadcastState(room.code);
};

// --- MATCH TIMER LOOP ---
const startMatchTimer = (room) => {
    room.matchStartTime = Date.now();
    room.matchTimeRemaining = MATCH_DURATION_MS;
    room.isGameActive = true;
    
    room.matchInterval = setInterval(() => {
        const elapsed = Date.now() - room.matchStartTime;
        room.matchTimeRemaining = Math.max(0, MATCH_DURATION_MS - elapsed);
        
        if (room.matchTimeRemaining <= 0) {
            clearInterval(room.matchInterval);
            clearInterval(room.timerInterval);
            room.isGameActive = false;
            room.gameStatus = 'ENDED';
            
            // Determine winner based on health/score
            const winner = room.players.sort((a, b) => b.health - a.health)[0];
            console.log(`Match finished. Winner by health: ${winner.nickname}`);
        }
        broadcastState(room.code);
    }, 1000);
    
    // Start the first call after names are assigned
    startNewCall(room); 
};


// --- SOCKET.IO CONNECTION HANDLER ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('joinRoom', ({ code, nickname }) => {
        if (!rooms[code]) {
            rooms[code] = { 
                code, 
                players: [], 
                callerId: null, 
                currentResponderId: null, 
                isGameActive: false,
                gameStatus: 'LOBBY',
                matchTimeRemaining: MATCH_DURATION_MS,
                timer: 0
            };
        }
        const room = rooms[code];
        if (room.players.length >= MAX_PLAYERS || room.isGameActive) {
            socket.emit('error', 'Room is full or game in progress.');
            return;
        }

        socket.join(code);
        const player = createNewPlayer(socket.id, nickname);
        room.players.push(player);
        broadcastState(code);
    });
    
    socket.on('addBot', ({ code }) => {
        const room = getRoomState(code);
        if (room && room.players.length < MAX_PLAYERS && !room.isGameActive) {
            const botId = `bot-${Date.now()}`;
            const botName = `Bot${room.players.length + 1}`;
            room.players.push(createNewPlayer(botId, botName, true));
            broadcastState(code);
        }
    });

    socket.on('startGame', ({ code }) => {
        const room = getRoomState(code);
        if (room && room.players.length >= 2 && !room.isGameActive) {
            assignNames(room);
            startMatchTimer(room);
            broadcastState(code);
        }
    });
    
    socket.on('playerCall', ({ code, calledAnimalName }) => {
        const room = getRoomState(code);
        if (room && room.isGameActive && room.currentResponderId === socket.id) {
            // Player is responding to the chain by calling another animal name
            handleCall(room, socket.id, calledAnimalName);
        } else if (room && room.isGameActive && room.callerId === socket.id && !room.currentResponderId) {
             // Aardvark (the center caller) is initiating the first call
             handleCall(room, socket.id, calledAnimalName);
        }
    });
    
    // Placeholder for when a player fails to call in time (useful for debugging/testing)
    socket.on('forceFail', ({ code }) => {
        const room = getRoomState(code);
        if (room && room.currentResponderId) {
            clearInterval(room.timerInterval);
            handleFail(room, room.currentResponderId, 'debug');
        }
    });

    socket.on('disconnect', () => {
        // Logic to remove player from room or mark as disconnected
        for (const code in rooms) {
            const room = rooms[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players[playerIndex].isConnected = false;
                // If the game is not active, remove them entirely
                if (!room.isGameActive) {
                    room.players.splice(playerIndex, 1);
                }
                broadcastState(code);
                break;
            }
        }
    });
});


// --- MONETIZATION API (Stripe Implementation) ---
app.use(express.json()); // Middleware for parsing JSON bodies

// Route to buy a Health Boost
app.post('/api/buy_health', async (req, res) => {
    const { playerId, roomId } = req.body; 
    
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: process.env.STRIPE_PRICE_HEALTH_BOOST, // $0.99
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}&player=${playerId}`,
            cancel_url: `${process.env.FRONTEND_URL}/cancel`,
            metadata: { playerId: playerId, roomId: roomId, type: 'HEALTH_BOOST' } // Critical for webhook
        });

        res.json({ url: session.url });

    } catch (e) {
        console.error("Stripe Checkout Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// Route to buy the Survivor Pass
app.post('/api/buy_pass', async (req, res) => {
    const { playerId } = req.body; 
    
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: process.env.STRIPE_PRICE_SURVIVOR_PASS, // $7.99
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}&player=${playerId}`,
            cancel_url: `${process.env.FRONTEND_URL}/cancel`,
            metadata: { playerId: playerId, type: 'SURVIVOR_PASS' } // Critical for webhook
        });

        res.json({ url: session.url });

    } catch (e) {
        console.error("Stripe Pass Checkout Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});


// --- STRIPE WEBHOOK (Critical for Granting Entitlements) ---
app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
    const sig = request.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.log(`Webhook Error: ${err.message}`);
        return response.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { playerId, roomId, type } = session.metadata;

        if (type === 'HEALTH_BOOST') {
            const room = getRoomState(roomId);
            const player = room?.players.find(p => p.id === playerId);
            
            if (player) {
                player.health = Math.min(STARTING_HEALTH, player.health + 2); // Cap at starting health
                console.log(`Health Boost granted to ${player.nickname}. New Health: ${player.health}`);
                broadcastState(roomId);
            }
        } else if (type === 'SURVIVOR_PASS') {
            // Update your database (REDIS/Postgres) here to mark playerId as having the pass
            console.log(`Survivor Pass granted to Player ID: ${playerId}.`);
        }
    }

    response.send();
});


// --- START SERVER ---
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
