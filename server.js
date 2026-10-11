const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
);
const io = new Server(server, {
    maxHttpBufferSize: 256 * 1024,
    cors: allowedOrigins.size ? { origin: [...allowedOrigins], methods: ['GET', 'POST'] } : undefined
});

const userSockets = new Map();
const socketUsers = new Map();
const calls = new Map();
const usernamePattern = /^[a-zA-Z0-9_.-]{3,32}$/;
const callIdPattern = /^[a-zA-Z0-9_-]{8,80}$/;

app.disable('x-powered-by');
app.get('/healthz', (request, response) => response.status(200).json({ status: 'ok' }));
app.get('/', (request, response) => response.sendFile(path.join(__dirname, 'index.html')));
['index.html', 'app.js', 'style.css', 'logo.png'].forEach(asset => {
    app.get(`/${asset}`, (request, response) => {
        response.sendFile(path.join(__dirname, asset), {
            headers: { 'Cache-Control': process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache' }
        });
    });
});

io.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    const requestHost = socket.handshake.headers['x-forwarded-host'] || socket.handshake.headers.host;
    if (origin) {
        let allowed = allowedOrigins.has(origin);
        if (!allowedOrigins.size) {
            try {
                const forwardedProtocol = socket.handshake.headers['x-forwarded-proto'];
                const requestProtocol = forwardedProtocol
                    ? forwardedProtocol.split(',')[0].trim()
                    : (socket.conn.request.socket.encrypted ? 'https' : 'http');
                const parsedOrigin = new URL(origin);
                allowed = parsedOrigin.host === requestHost && `${parsedOrigin.protocol.slice(0, -1)}` === requestProtocol;
            } catch (error) {
                allowed = false;
            }
        }
        if (!allowed) return next(new Error('Origin not allowed'));
    }
    next();
});

function addUserSocket(userId, socketId) {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socketId);
    socketUsers.set(socketId, userId);
}

function removeUserSocket(socketId) {
    const userId = socketUsers.get(socketId);
    if (!userId) return null;
    socketUsers.delete(socketId);
    const sockets = userSockets.get(userId);
    sockets?.delete(socketId);
    if (sockets?.size === 0) userSockets.delete(userId);
    return userId;
}

function emitToUser(userId, event, payload) {
    const sockets = userSockets.get(userId);
    if (!sockets) return false;
    sockets.forEach(socketId => io.to(socketId).emit(event, payload));
    return true;
}

function acknowledge(ack, result) {
    if (typeof ack === 'function') ack(result);
}

io.on('connection', socket => {
    socket.data.eventWindow = { start: Date.now(), count: 0 };
    socket.use((packet, next) => {
        const windowState = socket.data.eventWindow;
        const now = Date.now();
        if (now - windowState.start >= 1000) {
            windowState.start = now;
            windowState.count = 0;
        }
        windowState.count += 1;
        if (windowState.count > 80) return next(new Error('Rate limit exceeded'));
        next();
    });

    socket.on('register-user', (payload, ack) => {
        // Replace this client-asserted ID with a verified session claim before public deployment.
        const userId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
        if (!usernamePattern.test(userId)) {
            acknowledge(ack, { ok: false, error: 'Invalid user ID' });
            return;
        }
        removeUserSocket(socket.id);
        addUserSocket(userId, socket.id);
        socket.data.userId = userId;
        acknowledge(ack, { ok: true, userId });
    });

    socket.on('call-user', (payload, ack) => {
        const caller = socket.data.userId;
        const recipient = typeof payload?.to === 'string' ? payload.to.trim() : '';
        const callId = typeof payload?.callId === 'string' ? payload.callId : '';
        const offer = payload?.offer;
        if (!caller || !usernamePattern.test(recipient) || recipient === caller ||
            !callIdPattern.test(callId) || offer?.type !== 'offer' || typeof offer.sdp !== 'string' ||
            offer.sdp.length > 200000) {
            acknowledge(ack, { ok: false, error: 'Invalid call request' });
            return;
        }
        if (calls.has(callId)) {
            acknowledge(ack, { ok: false, error: 'Call ID already exists' });
            return;
        }
        const busy = [...calls.values()].some(call =>
            ['ringing', 'active'].includes(call.status) && [call.caller, call.recipient].some(userId =>
                userId === caller || userId === recipient
            )
        );
        if (busy) {
            acknowledge(ack, { ok: false, error: 'One of these users is already in a call' });
            return;
        }
        if (!userSockets.has(recipient)) {
            acknowledge(ack, { ok: false, error: 'User is unavailable' });
            socket.emit('call-unavailable', { callId, userId: recipient });
            return;
        }

        calls.set(callId, { caller, recipient, callerSocket: socket.id, status: 'ringing' });
        emitToUser(recipient, 'incoming-call', { callId, caller, offer });
        acknowledge(ack, { ok: true, callId });
    });

    socket.on('accept-call', (payload, ack) => {
        const userId = socket.data.userId;
        const callId = typeof payload?.callId === 'string' ? payload.callId : '';
        const call = calls.get(callId);
        const answer = payload?.answer;
        if (!call || call.recipient !== userId || call.status !== 'ringing' ||
            answer?.type !== 'answer' || typeof answer.sdp !== 'string' || answer.sdp.length > 200000) {
            acknowledge(ack, { ok: false, error: 'Call cannot be accepted' });
            return;
        }
        call.status = 'active';
        call.recipientSocket = socket.id;
        emitToUser(call.caller, 'call-accepted', { callId, recipient: userId, answer });
        acknowledge(ack, { ok: true, callId });
    });

    socket.on('decline-call', (payload, ack) => {
        const userId = socket.data.userId;
        const callId = typeof payload?.callId === 'string' ? payload.callId : '';
        const call = calls.get(callId);
        if (!call || call.recipient !== userId || call.status !== 'ringing') {
            acknowledge(ack, { ok: false, error: 'Call cannot be declined' });
            return;
        }
        calls.delete(callId);
        emitToUser(call.caller, 'call-declined', { callId, recipient: userId });
        acknowledge(ack, { ok: true, callId });
    });

    socket.on('end-call', (payload, ack) => {
        const userId = socket.data.userId;
        const callId = typeof payload?.callId === 'string' ? payload.callId : '';
        const call = calls.get(callId);
        if (!call || ![call.caller, call.recipient].includes(userId)) {
            acknowledge(ack, { ok: false, error: 'Call not found' });
            return;
        }
        calls.delete(callId);
        const peer = call.caller === userId ? call.recipient : call.caller;
        emitToUser(peer, 'call-ended', { callId, userId });
        acknowledge(ack, { ok: true, callId });
    });

    socket.on('ice-candidate', (payload, ack) => {
        const userId = socket.data.userId;
        const callId = typeof payload?.callId === 'string' ? payload.callId : '';
        const call = calls.get(callId);
        const candidate = payload?.candidate;
        if (!call || ![call.caller, call.recipient].includes(userId) || !candidate ||
            typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) {
            acknowledge(ack, { ok: false, error: 'Invalid ICE candidate' });
            return;
        }
        const peer = call.caller === userId ? call.recipient : call.caller;
        emitToUser(peer, 'ice-candidate', { callId, candidate });
        acknowledge(ack, { ok: true });
    });

    socket.on('disconnect', () => {
        const userId = removeUserSocket(socket.id);
        if (!userId) return;
        calls.forEach((call, callId) => {
            if (call.callerSocket !== socket.id && call.recipientSocket !== socket.id) return;
            calls.delete(callId);
            const peer = call.caller === userId ? call.recipient : call.caller;
            emitToUser(peer, 'call-ended', { callId, userId });
        });
    });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => {
    console.log(`BlockTalk signaling server listening on port ${port}`);
});