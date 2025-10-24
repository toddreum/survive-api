// server.js - Survive.com Backend Logic
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Requires key from Render

const app = express();
const server = http.createServer(app);
// Configure CORS to allow your frontend (survive.com) to connect
const io = new Server(server, {
    cors: {
        origin: "*", // IMPORTANT: For testing, use "*". Change to "https://survive.com" for production.
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;

// --- ROOM STATE MANAGEMENT (Simplified Structure) ---
const rooms = {};

// Function to reset player state for a new game
const createNewPlayer = (id, nickname) => ({
    id,
    nickname,
    health: 20,
    animalName: null,
    isBot: false,
    isConnected: true,
    lastActionTime: Date.now()
});

// Full game logic (room creation, joins, start, call, fail, damage, etc.) goes here
// This logic will manage the 'rooms' object, handle the timer, and emit 'state' updates.
// (This large section is what was generated in the canvas.)

// --- SOCKET.IO CONNECTION HANDLER ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // [Game logic functions like socket.on('join'), socket.on('call'), etc. would be here]
    // The server handles all state changes (health, swap, timer) and emits the new state.

    socket.on('joinRoom', ({ code, nickname }) => {
        // Find or create room, add player, enforce MAX_PLAYERS, and emit state
        socket.join(code);
        // ... (room logic)
        io.to(code).emit('state', { /* new game state */ });
    });
    
    // Disconnect handler
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // ... (handle player leaving room)
    });
});


// --- MONETIZATION API (Stripe Placeholder) ---
app.use(express.json()); // Middleware for parsing JSON bodies

app.post('/api/buy_health', async (req, res) => {
    // 1. Get the player ID and game room from the request body.
    const { playerId, roomId } = req.body; 
    
    try {
        // **STEP 2: ADD REAL STRIPE LOGIC HERE**
        
        // Example: Create a Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: process.env.STRIPE_HEALTH_BOOST_PRICE_ID, // Use the ID from your Render env var
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `https://survive.com/success?session_id={CHECKOUT_SESSION_ID}&player=${playerId}`,
            cancel_url: `https://survive.com/cancel`,
            // Store player data so the webhook knows who to give health to
            metadata: { playerId: playerId, roomId: roomId } 
        });

        // 3. Redirect the client to the Stripe checkout page
        res.json({ url: session.url });

    } catch (e) {
        console.error("Stripe Checkout Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- STRIPE WEBHOOK (Critical for Health Granting) ---
app.post('/webhook', express.raw({type: 'application/json'}), (request, response) => {
    // This is where Stripe confirms payment. You must implement signature verification
    // and then grant the +2 health to the player in your 'rooms' state.
    // ... (logic to verify signature and update health)
    response.send();
});


// --- START SERVER ---
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access endpoint: http://localhost:${PORT}`);
});
