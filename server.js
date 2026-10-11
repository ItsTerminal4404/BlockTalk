const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const dataFile = process.env.BLOCKTALK_DATA_FILE || path.join(__dirname, 'data', 'blocktalk.json');
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
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const emptyStore = { users: {}, sessions: {} };

function loadStore() {
    try {
        const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
        if (!parsed || typeof parsed.users !== 'object' || typeof parsed.sessions !== 'object') {
            throw new Error('Invalid BlockTalk data file format');
        }
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT') return emptyStore;
        throw error;
    }
}

let store = loadStore();

function saveStore() {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const temporaryFile = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(temporaryFile, dataFile);
}

function createProfile() {
    return {
        profilePictureUrl: '',
        theme: 'terminal',
        blockedUsers: [],
        friends: [],
        messages: {},
        pendingFriendRequests: { incoming: [], outgoing: [] }
    };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function tokenUser(token) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = store.sessions[tokenHash];
    if (!session || session.expiresAt <= Date.now() || !store.users[session.username]) return null;
    return session.username;
}

function publicProfile(profile, includeMessages = false) {
    return {
        profilePictureUrl: profile.profilePictureUrl,
        theme: profile.theme,
        blockedUsers: profile.blockedUsers,
        friends: profile.friends,
        messages: includeMessages ? profile.messages : {},
        pendingFriendRequests: profile.pendingFriendRequests,
        onlineUsers: profile.onlineUsers || []
    };
}

function clientData(username) {
    const user = store.users[username];
    const profile = user.profile;
    const relatedUsernames = new Set([
        username,
        ...profile.friends.map(friend => friend.username),
        ...profile.pendingFriendRequests.incoming,
        ...profile.pendingFriendRequests.outgoing
    ]);
    const profiles = {};
    relatedUsernames.forEach(relatedUsername => {
        const relatedUser = store.users[relatedUsername];
        if (!relatedUser) return;
        profiles[relatedUsername] = publicProfile(relatedUser.profile, relatedUsername === username);
    });
    profile.onlineUsers = profile.friends
        .filter(friend => userSockets.has(friend.username))
        .map(friend => friend.username);
    profiles[username] = publicProfile(profile, true);
    return {
        currentUser: { username, email: user.email },
        database: { profiles, calls: {} }
    };
}

function emitDataUpdated(username) {
    emitToUser(username, 'data-updated', {});
}

function requireAuth(request, response, next) {
    const authorization = request.get('authorization') || '';
    const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
    const username = tokenUser(match?.[1]);
    if (!username) {
        response.status(401).json({ error: 'Please sign in again.' });
        return;
    }
    request.userId = username;
    next();
}

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.get('/healthz', (request, response) => response.status(200).json({ status: 'ok' }));
app.get('/', (request, response) => response.sendFile(path.join(__dirname, 'index.html')));
['index.html', 'app.js', 'style.css', 'logo.png'].forEach(asset => {
    app.get(`/${asset}`, (request, response) => {
        response.sendFile(path.join(__dirname, asset), {
            headers: { 'Cache-Control': process.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-cache' }
        });
    });
});

app.post('/api/auth/signup', (request, response) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const email = typeof request.body?.email === 'string' ? request.body.email.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!usernamePattern.test(username) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6) {
        response.status(400).json({ error: 'Enter a valid username, email, and password (at least 6 characters).' });
        return;
    }
    if (store.users[username]) {
        response.status(409).json({ error: 'Username already taken.' });
        return;
    }
    const normalizedEmail = email.toLowerCase();
    if (Object.values(store.users).some(user => user.email.toLowerCase() === normalizedEmail)) {
        response.status(409).json({ error: 'This email is already linked to an account.' });
        return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    store.users[username] = { email, salt, passwordHash, profile: createProfile() };
    const token = crypto.randomBytes(32).toString('hex');
    store.sessions[hashToken(token)] = { username, expiresAt: Date.now() + sessionLifetimeMs };
    saveStore();
    response.status(201).json({ token, ...clientData(username) });
});

app.post('/api/auth/signin', (request, response) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const user = store.users[username];
    if (!user || password.length < 1) {
        response.status(401).json({ error: 'Invalid username or password.' });
        return;
    }
    const suppliedHash = crypto.scryptSync(password, user.salt, 64);
    const storedHash = Buffer.from(user.passwordHash, 'hex');
    if (suppliedHash.length !== storedHash.length || !crypto.timingSafeEqual(suppliedHash, storedHash)) {
        response.status(401).json({ error: 'Invalid username or password.' });
        return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    store.sessions[hashToken(token)] = { username, expiresAt: Date.now() + sessionLifetimeMs };
    saveStore();
    response.json({ token, ...clientData(username) });
});

app.get('/api/data', requireAuth, (request, response) => {
    response.json(clientData(request.userId));
});

app.post('/api/auth/logout', requireAuth, (request, response) => {
    const authorization = request.get('authorization');
    const token = authorization.slice('Bearer '.length);
    delete store.sessions[hashToken(token)];
    saveStore();
    response.status(204).end();
});

app.patch('/api/profile', requireAuth, (request, response) => {
    const { profilePictureUrl, theme } = request.body || {};
    if (typeof profilePictureUrl !== 'string' || profilePictureUrl.length > 2048 ||
        !['terminal', 'cyberpunk', 'light'].includes(theme)) {
        response.status(400).json({ error: 'Invalid profile settings.' });
        return;
    }
    if (profilePictureUrl) {
        try {
            const url = new URL(profilePictureUrl);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL scheme');
        } catch (error) {
            response.status(400).json({ error: 'Enter a valid HTTP or HTTPS image URL.' });
            return;
        }
    }
    const profile = store.users[request.userId].profile;
    profile.profilePictureUrl = profilePictureUrl;
    profile.theme = theme;
    saveStore();
    profile.friends.forEach(friend => emitDataUpdated(friend.username));
    response.json({ ok: true });
});

app.post('/api/friends/:action', requireAuth, (request, response) => {
    const username = request.userId;
    const targetUsername = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const user = store.users[username];
    const target = store.users[targetUsername];
    const action = request.params.action;
    if (!usernamePattern.test(targetUsername) || !target || targetUsername === username) {
        response.status(404).json({ error: 'No account found for that username.' });
        return;
    }
    const profile = user.profile;
    const targetProfile = target.profile;
    if (action === 'request') {
        if (profile.blockedUsers.includes(targetUsername) || targetProfile.blockedUsers.includes(username)) {
            response.status(403).json({ error: 'This user cannot be reached.' });
            return;
        }
        if (targetProfile.pendingFriendRequests.outgoing.includes(username)) {
            response.status(409).json({ error: 'This user has already sent you a friend request.' });
            return;
        }
        if (profile.friends.some(friend => friend.username === targetUsername) ||
            profile.pendingFriendRequests.outgoing.includes(targetUsername)) {
            response.status(409).json({ error: 'Already friends or a request is already pending.' });
            return;
        }
        profile.pendingFriendRequests.outgoing.push(targetUsername);
        targetProfile.pendingFriendRequests.incoming.push(username);
    } else if (action === 'accept') {
        if (!profile.pendingFriendRequests.incoming.includes(targetUsername) ||
            profile.blockedUsers.includes(targetUsername) || targetProfile.blockedUsers.includes(username)) {
            response.status(409).json({ error: 'That friend request cannot be accepted.' });
            return;
        }
        profile.pendingFriendRequests.incoming = profile.pendingFriendRequests.incoming.filter(name => name !== targetUsername);
        targetProfile.pendingFriendRequests.outgoing = targetProfile.pendingFriendRequests.outgoing.filter(name => name !== username);
        profile.friends.push({ username: targetUsername, status: 'offline', addedAt: Date.now() });
        targetProfile.friends.push({ username, status: 'offline', addedAt: Date.now() });
    } else if (action === 'decline') {
        profile.pendingFriendRequests.incoming = profile.pendingFriendRequests.incoming.filter(name => name !== targetUsername);
        targetProfile.pendingFriendRequests.outgoing = targetProfile.pendingFriendRequests.outgoing.filter(name => name !== username);
    } else if (action === 'cancel') {
        profile.pendingFriendRequests.outgoing = profile.pendingFriendRequests.outgoing.filter(name => name !== targetUsername);
        targetProfile.pendingFriendRequests.incoming = targetProfile.pendingFriendRequests.incoming.filter(name => name !== username);
    } else if (action === 'unfriend') {
        profile.friends = profile.friends.filter(friend => friend.username !== targetUsername);
        targetProfile.friends = targetProfile.friends.filter(friend => friend.username !== username);
    } else if (action === 'block') {
        if (!profile.blockedUsers.includes(targetUsername)) profile.blockedUsers.push(targetUsername);
        profile.friends = profile.friends.filter(friend => friend.username !== targetUsername);
        targetProfile.friends = targetProfile.friends.filter(friend => friend.username !== username);
        profile.pendingFriendRequests.incoming = profile.pendingFriendRequests.incoming.filter(name => name !== targetUsername);
        profile.pendingFriendRequests.outgoing = profile.pendingFriendRequests.outgoing.filter(name => name !== targetUsername);
        targetProfile.pendingFriendRequests.incoming = targetProfile.pendingFriendRequests.incoming.filter(name => name !== username);
        targetProfile.pendingFriendRequests.outgoing = targetProfile.pendingFriendRequests.outgoing.filter(name => name !== username);
        calls.forEach((call, callId) => {
            if (![call.caller, call.recipient].includes(username) ||
                ![call.caller, call.recipient].includes(targetUsername)) return;
            calls.delete(callId);
            emitToUser(call.caller, 'call-ended', { callId, userId: username });
            emitToUser(call.recipient, 'call-ended', { callId, userId: username });
        });
    } else {
        response.status(404).json({ error: 'Unknown friend action.' });
        return;
    }
    saveStore();
    emitDataUpdated(username);
    emitDataUpdated(targetUsername);
    response.json({ ok: true });
});

app.post('/api/messages', requireAuth, (request, response) => {
    const senderUsername = request.userId;
    const recipientUsername = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
    const sender = store.users[senderUsername];
    const recipient = store.users[recipientUsername];
    if (!recipient || recipientUsername === senderUsername || !content || content.length > 2000) {
        response.status(400).json({ error: 'Enter a message of 1 to 2000 characters.' });
        return;
    }
    if (!sender.profile.friends.some(friend => friend.username === recipientUsername) ||
        sender.profile.blockedUsers.includes(recipientUsername) ||
        recipient.profile.blockedUsers.includes(senderUsername)) {
        response.status(403).json({ error: 'This contact cannot receive a message.' });
        return;
    }
    const message = {
        id: crypto.randomUUID(),
        sender: senderUsername,
        content,
        timestamp: Date.now(),
        status: 'sent'
    };
    sender.profile.messages[recipientUsername] ||= [];
    recipient.profile.messages[senderUsername] ||= [];
    sender.profile.messages[recipientUsername].push(message);
    recipient.profile.messages[senderUsername].push({ ...message });
    saveStore();
    emitDataUpdated(senderUsername);
    emitDataUpdated(recipientUsername);
    response.status(201).json({ message });
});

app.post('/api/messages/read', requireAuth, (request, response) => {
    const readerUsername = request.userId;
    const senderUsername = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const reader = store.users[readerUsername];
    const sender = store.users[senderUsername];
    if (!sender || !reader.profile.friends.some(friend => friend.username === senderUsername)) {
        response.status(403).json({ error: 'This conversation is unavailable.' });
        return;
    }
    const messages = reader.profile.messages[senderUsername] || [];
    const unreadIds = new Set(messages
        .filter(message => message.sender === senderUsername && message.status !== 'read')
        .map(message => message.id));
    if (unreadIds.size) {
        messages.forEach(message => {
            if (unreadIds.has(message.id)) message.status = 'read';
        });
        (sender.profile.messages[readerUsername] || []).forEach(message => {
            if (unreadIds.has(message.id)) message.status = 'read';
        });
        saveStore();
        emitDataUpdated(senderUsername);
    }
    response.json({ ok: true });
});

app.use((error, request, response, next) => {
    console.error('BlockTalk request failed:', error);
    if (response.headersSent) return next(error);
    response.status(500).json({ error: 'The server could not complete the request.' });
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
        const userId = tokenUser(typeof payload?.token === 'string' ? payload.token : '');
        if (!userId) {
            acknowledge(ack, { ok: false, error: 'Sign-in required' });
            return;
        }
        removeUserSocket(socket.id);
        addUserSocket(userId, socket.id);
        socket.data.userId = userId;
        store.users[userId].profile.friends.forEach(friend => emitDataUpdated(friend.username));
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
        const callerProfile = store.users[caller]?.profile;
        const recipientProfile = store.users[recipient]?.profile;
        if (!callerProfile?.friends.some(friend => friend.username === recipient) ||
            !recipientProfile || callerProfile.blockedUsers.includes(recipient) ||
            recipientProfile.blockedUsers.includes(caller)) {
            acknowledge(ack, { ok: false, error: 'This contact cannot receive a call' });
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
        const callerProfile = store.users[call.caller]?.profile;
        const recipientProfile = store.users[call.recipient]?.profile;
        if (!callerProfile?.friends.some(friend => friend.username === call.recipient) ||
            !recipientProfile || callerProfile.blockedUsers.includes(call.recipient) ||
            recipientProfile.blockedUsers.includes(call.caller)) {
            calls.delete(callId);
            acknowledge(ack, { ok: false, error: 'This call is no longer allowed' });
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
        store.users[userId]?.profile.friends.forEach(friend => emitDataUpdated(friend.username));
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