document.addEventListener('DOMContentLoaded', () => {
    const app = window.BlockTalk;
    const authToggle = document.getElementById('authToggleBtn');
    const callButton = document.getElementById('callButton');
    const callPanel = document.getElementById('active-call-panel');
    const callTitle = document.getElementById('callRoomTitle');
    const callStatus = document.getElementById('callStatus');
    const callAlert = document.getElementById('callAlert');
    const incomingCallList = document.getElementById('incoming-call-list');
    const localCallPfp = document.getElementById('local-call-pfp');
    const localCallInitials = document.getElementById('local-call-initials');
    const remoteCallPfp = document.getElementById('remote-call-pfp');
    const remoteCallInitials = document.getElementById('remote-call-initials');
    const localCallName = document.getElementById('local-call-name');
    const remoteCallName = document.getElementById('remote-call-name');
    const muteButton = document.getElementById('call-mute-button');
    const cameraButton = document.getElementById('call-camera-button');
    const shareButton = document.getElementById('call-share-button');
    const sharePreview = document.getElementById('screen-share-preview');
    const remoteScreenPreview = document.getElementById('remote-screen-preview');
    const remoteAudio = document.getElementById('remote-call-audio');
    const settingsModal = document.getElementById('settings-modal');
    const settingsButton = document.getElementById('settings-button');
    const settingsPfpUrl = document.getElementById('settings-pfp-url');
    const settingsTheme = document.getElementById('settings-theme');
    const settingsStatus = document.getElementById('settings-status');
    const profilePicture = document.getElementById('my-pfp');
    let localStream = null;
    let gun = null;
    let currentGunMap = null;
    let currentGunSignalingMap = null;
    let activeGunPeer = null;
    let activeGunRoom = null;
    let activeGunSignalingNode = null;
    let activeGunKey = null;
    let gunObserverGeneration = 0;
    const pendingGunMessageIds = new Set();
    const seenCallSignalIds = new Set();
    const MAX_DIRECT_PACKET_LENGTH = 900000;
    const MAX_RENDERED_SERVER_MESSAGES = 500;
    const MAX_IMAGE_DATA_URL_LENGTH = 360000;
    const MAX_VOICE_DATA_URL_LENGTH = 260000;
    const OWNER_USERNAME = 'ItsTerminal4404';
    const FOUNDER_BADGE_CUTOFF = Date.UTC(2027, 0, 1);
    const SERVER_STORAGE_PREFIX = 'blocktalk:servers-v1:';
    const ATTACHMENT_PREFIX = 'blocktalk-media-v1:';
    const commonEmojis = [
        '😀', '😄', '😂', '🥹', '😉', '😍', '😎', '😭', '🤔', '🙌', '👏', '👍',
        '👎', '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '🎉', '✨', '💯', '🙏',
        '🤝', '👋', '☕', '🚀', '🌙', '✅', '❌', '🤖', '🎮', '🎵', '🐱', '🐶'
    ];
    let activeCall = null;
    const incomingCalls = new Map();
    let peerConnection = null;
    let videoSender = null;
    let remoteStream = null;
    let callTimer = 0;
    const voiceMeters = new Set();
    let screenStream = null;
    let cameraStream = null;
    let activeServerObserver = null;
    let activeServerGeneration = 0;
    let activeServer = null;
    let activeServerKey = null;
    let recordingStream = null;
    let voiceRecorder = null;
    let voiceChunks = [];
    let voiceRecordingTimer = 0;
    let voiceRecordingTarget = null;
    let pendingProfilePictureDataUrl = '';
    let profilePictureProcessing = false;
    let profilePictureSelectionGeneration = 0;
    let profileModalGeneration = 0;
    let badgeTarget = null;
    let isMuted = false;
    const pendingIceCandidates = [];
    const pendingRemoteIceCandidates = new Map();
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const gunRelays = [
        'https://gun.rig.airfaas.com/gun',
        'https://peer.ooo/gun'
    ];
    const pendingMessageStorageKey = 'pending-messages';
    let pendingMessageFlush = null;

    function getDirectMessageRoomId(userId, peerId) {
        if (typeof userId !== 'string' || typeof peerId !== 'string' ||
            !userId || !peerId || userId === peerId) {
            throw new Error('A different friend is required to open a direct conversation.');
        }
        //notes Sort both IDs alphabetically in a locale-independent order to produce the same room ID on both clients.
        const ids = [userId, peerId].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        return `blocktalk-dm-v1:${ids.map(encodeURIComponent).join('~')}`;
    }

    function getConversationKeyStorageKey(peerId) {
        const username = app.state.currentUser?.username;
        if (!username) throw new Error('Sign in before accessing saved conversation keys.');
        return `blocktalk:dm-key-v1:${getDirectMessageRoomId(username, peerId)}`;
    }

    function readConversationPassphrase(peerId) {
        //notes Check localStorage for the shared passphrase saved for this account pair on this device.
        const passphrase = window.localStorage.getItem(getConversationKeyStorageKey(peerId));
        if (passphrase === null) return null;
        if (passphrase.length < 20 || passphrase.length > 256) {
            throw new Error('The saved conversation passphrase is invalid. Enter the shared passphrase again.');
        }
        return passphrase;
    }

    function forgetConversationPassphrase(peerId) {
        window.localStorage.removeItem(getConversationKeyStorageKey(peerId));
    }

    function bytesToBase64(bytes) {
        let binary = '';
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return window.btoa(binary);
    }

    function base64ToBytes(value) {
        const binary = window.atob(value);
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }

    async function deriveConversationKey(passphrase, roomId) {
        const material = await window.crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(passphrase),
            'PBKDF2',
            false,
            ['deriveKey']
        );
        return window.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: new TextEncoder().encode(`BlockTalk encrypted DM v1:${roomId}`),
                iterations: 310000,
                hash: 'SHA-256'
            },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    function messageMetadata(sender, timestamp) {
        return new TextEncoder().encode(JSON.stringify([sender, timestamp]));
    }

    function callSignalMetadata(packet) {
        return new TextEncoder().encode(JSON.stringify([
            packet.sender,
            packet.recipient,
            packet.callId,
            packet.type,
            packet.timestamp
        ]));
    }

    async function encryptDirectMessage(plaintext, key, sender, timestamp) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        //notes Encrypt the local plaintext with AES-GCM before any message data is written to the public Gun relays.
        const ciphertext = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: messageMetadata(sender, timestamp) },
            key,
            new TextEncoder().encode(plaintext)
        );
        return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
    }

    async function decryptDirectMessage(envelope, key, sender, timestamp) {
        const parts = envelope.split('.');
        if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unsupported encrypted message format.');
        const plaintext = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: base64ToBytes(parts[1]),
                additionalData: messageMetadata(sender, timestamp)
            },
            key,
            base64ToBytes(parts[2])
        );
        return new TextDecoder().decode(plaintext);
    }

    function validateAttachment(attachment) {
        if (!attachment || typeof attachment !== 'object' ||
            typeof attachment.dataUrl !== 'string' ||
            typeof attachment.name !== 'string' || attachment.name.length > 120) {
            throw new Error('This attachment has an invalid format.');
        }
        if (attachment.kind === 'image' &&
            /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(attachment.dataUrl) &&
            attachment.dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH &&
            dataUrlByteLength(attachment.dataUrl) <= 256 * 1024) return attachment;
        if (attachment.kind === 'voice' &&
            /^data:audio\/(webm|mp4|ogg);base64,[A-Za-z0-9+/]+=*$/.test(attachment.dataUrl) &&
            attachment.dataUrl.length <= MAX_VOICE_DATA_URL_LENGTH &&
            dataUrlByteLength(attachment.dataUrl) <= 180 * 1024) return attachment;
        throw new Error('This attachment type or size is not supported.');
    }

    function decodeMessageContent(content) {
        if (!content.startsWith(ATTACHMENT_PREFIX)) return { content, attachment: null };
        const attachment = validateAttachment(JSON.parse(content.slice(ATTACHMENT_PREFIX.length)));
        return { content: '', attachment };
    }

    function encodeMessageContent(value) {
        if (typeof value === 'string') return value.trim();
        const attachment = validateAttachment(value);
        return `${ATTACHMENT_PREFIX}${JSON.stringify(attachment)}`;
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener('load', () => {
                if (typeof reader.result !== 'string') reject(new Error('The selected file could not be read.'));
                else resolve(reader.result);
            }, { once: true });
            reader.addEventListener('error', () => reject(new Error('The selected file could not be read.')), { once: true });
            reader.readAsDataURL(file);
        });
    }

    async function compressImageFile(file, maximumBytes = 256 * 1024, maximumDimension = 1280) {
        if (!file?.type.startsWith('image/')) throw new Error('Choose an image file.');
        if (typeof window.createImageBitmap !== 'function') {
            throw new Error('This browser cannot safely resize images before sending.');
        }
        const bitmap = await window.createImageBitmap(file);
        try {
            let scale = Math.min(1, maximumDimension / Math.max(bitmap.width, bitmap.height));
            for (let attempt = 0; attempt < 12; attempt += 1) {
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                const context = canvas.getContext('2d');
                if (!context) throw new Error('The browser could not prepare this image.');
                context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', Math.max(0.4, 0.82 - attempt * 0.045)));
                if (!blob) throw new Error('The browser could not compress this image.');
                if (blob.size <= maximumBytes) {
                    const dataUrl = await readFileAsDataUrl(blob);
                    return { dataUrl, name: file.name.slice(0, 120) || 'image.webp' };
                }
                scale *= 0.82;
            }
            throw new Error(`The image is too large. Use an image that can be compressed below ${Math.round(maximumBytes / 1024)} KB.`);
        } finally {
            bitmap.close();
        }
    }

    function dataUrlByteLength(dataUrl) {
        const comma = dataUrl.indexOf(',');
        if (comma === -1) return Infinity;
        return Math.floor((dataUrl.length - comma - 1) * 3 / 4);
    }

    function setMediaStatus(message) {
        const status = document.getElementById('mediaStatus');
        if (status) status.textContent = message;
    }

    function activeConversationToken() {
        if (activeServer) return `server:${activeServer.id}`;
        if (app.state.currentConversation) return `dm:${app.state.currentConversation}`;
        return null;
    }

    async function encryptCallSignal(payload, packet, key) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: callSignalMetadata(packet) },
            key,
            new TextEncoder().encode(JSON.stringify(payload))
        );
        return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
    }

    async function decryptCallSignal(envelope, packet, key) {
        const parts = envelope.split('.');
        if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Invalid encrypted call signal.');
        const plaintext = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: base64ToBytes(parts[1]),
                additionalData: callSignalMetadata(packet)
            },
            key,
            base64ToBytes(parts[2])
        );
        return JSON.parse(new TextDecoder().decode(plaintext));
    }

    function rememberCallSignal(signalId) {
        if (seenCallSignalIds.has(signalId)) return false;
        seenCallSignalIds.add(signalId);
        if (seenCallSignalIds.size > 2048) {
            const oldestId = seenCallSignalIds.values().next().value;
            seenCallSignalIds.delete(oldestId);
        }
        return true;
    }

    async function publishCallSignal(type, callId, payload = {}, allowClosedCall = false) {
        const sender = app.state.currentUser?.username;
        const recipient = activeGunPeer;
        const signalingNode = activeGunSignalingNode;
        const key = activeGunKey;
        if (!sender || !recipient || !signalingNode || !key) {
            throw new Error('Unlock this conversation before using call signaling.');
        }
        const packet = {
            id: window.crypto.randomUUID(),
            sender,
            recipient,
            callId,
            type,
            timestamp: Date.now()
        };
        packet.ciphertext = await encryptCallSignal(payload, packet, key);
        if (!allowClosedCall &&
            (activeGunSignalingNode !== signalingNode || activeGunKey !== key)) {
            throw new Error('The selected conversation changed before signaling completed.');
        }
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('The Gun relay did not accept call signaling.')), 15000);
            signalingNode.set(packet, acknowledgement => {
                clearTimeout(timeout);
                if (acknowledgement?.err) reject(new Error('The Gun relay rejected call signaling.'));
                else resolve();
            });
        });
    }

    function validCallDescription(description, type) {
        return description && description.type === type && typeof description.sdp === 'string' &&
            description.sdp.length > 0 && description.sdp.length <= 200000;
    }

    function validIceCandidate(candidate) {
        return candidate && typeof candidate.candidate === 'string' &&
            candidate.candidate.length > 0 && candidate.candidate.length <= 4096;
    }

    async function receiveCallSignal(packet, signalId, generation, peerId, key) {
        const username = app.state.currentUser?.username;
        const acceptedTypes = new Set(['offer', 'answer', 'candidate', 'decline', 'end']);
        const maxAge = packet?.type === 'offer' ? 60000 : 5 * 60 * 1000;
        if (!username || generation !== gunObserverGeneration || activeGunPeer !== peerId ||
            !packet || typeof signalId !== 'string' || packet.id !== signalId ||
            packet.sender !== peerId || packet.recipient !== username ||
            !acceptedTypes.has(packet.type) || typeof packet.callId !== 'string' ||
            !/^call-[a-zA-Z0-9_-]{8,80}$/.test(packet.callId) ||
            !Number.isFinite(packet.timestamp) || Math.abs(Date.now() - packet.timestamp) > maxAge ||
            typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 300000 ||
            !rememberCallSignal(signalId)) return;

        let payload;
        try {
            payload = await decryptCallSignal(packet.ciphertext, packet, key);
        } catch (error) {
            return;
        }
        if (generation !== gunObserverGeneration || activeGunPeer !== peerId) return;

        if (packet.type === 'offer') {
            if (!validCallDescription(payload?.offer, 'offer') ||
                incomingCalls.has(packet.callId) || activeCall) return;
            const database = app.readDatabase();
            const profile = app.getUserProfile(database, username);
            if (isBlocked(database, peerId, username) ||
                !profile.friends.some(friend => friend.username === peerId)) return;
            incomingCalls.set(packet.callId, {
                callId: packet.callId,
                caller: peerId,
                offer: payload.offer
            });
            callAlert.textContent = '';
            syncCallView();
            return;
        }

        if (packet.type === 'decline' || packet.type === 'end') {
            if (activeCall?.callId === packet.callId && activeCall.peer === peerId) {
                if (packet.type === 'decline') {
                    callAlert.textContent = `TERMINAL: @${peerId} declined the call.`;
                } else {
                    callStatus.textContent = 'The other participant disconnected.';
                }
                finishCall(false);
            } else if (incomingCalls.delete(packet.callId)) {
                syncCallView();
            }
            return;
        }

        if (packet.type === 'candidate') {
            if (!validIceCandidate(payload?.candidate)) return;
            const isActiveCall = activeCall?.callId === packet.callId && activeCall.peer === peerId;
            if (!isActiveCall && !incomingCalls.has(packet.callId)) {
                if (!pendingRemoteIceCandidates.has(packet.callId) && pendingRemoteIceCandidates.size >= 16) return;
                const candidates = pendingRemoteIceCandidates.get(packet.callId) || [];
                if (candidates.length < 128) candidates.push(payload.candidate);
                pendingRemoteIceCandidates.set(packet.callId, candidates);
                return;
            }
            if (!peerConnection?.remoteDescription || !isActiveCall) {
                if (!pendingRemoteIceCandidates.has(packet.callId) && pendingRemoteIceCandidates.size >= 16) return;
                const candidates = pendingRemoteIceCandidates.get(packet.callId) || [];
                if (candidates.length < 128) candidates.push(payload.candidate);
                pendingRemoteIceCandidates.set(packet.callId, candidates);
                return;
            }
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
            } catch (error) {
                callAlert.textContent = 'TERMINAL: A network route candidate could not be added.';
            }
            return;
        }

        if (!activeCall || activeCall.callId !== packet.callId || activeCall.peer !== peerId) return;
        if (packet.type === 'answer' && activeCall.role === 'caller') {
            if (!validCallDescription(payload?.answer, 'answer')) return;
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
                await flushRemoteIceCandidates(packet.callId);
                if (activeCall?.callId === packet.callId && activeCall.status !== 'connected') {
                    activeCall.status = 'connecting';
                    syncCallView();
                }
            } catch (error) {
                callAlert.textContent = 'TERMINAL: Could not complete the WebRTC handshake.';
                finishCall(true);
            }
        }
    }

    function closeGunConversation() {
        gunObserverGeneration += 1;
        if (currentGunMap) currentGunMap.off();
        if (currentGunSignalingMap) currentGunSignalingMap.off();
        currentGunMap = null;
        currentGunSignalingMap = null;
        pendingGunMessageIds.clear();
        seenCallSignalIds.clear();
        activeGunPeer = null;
        activeGunRoom = null;
        activeGunSignalingNode = null;
        activeGunKey = null;
    }

    async function openGunConversation(peerId, passphrase) {
        const username = app.state.currentUser?.username;
        if (!window.crypto?.subtle || !window.crypto?.getRandomValues) {
            throw new Error('This browser does not support secure message encryption.');
        }
        if (!gun) throw new Error('GunDB did not load. Refresh the page and try again.');
        if (peerId !== app.state.currentConversation || !username) {
            throw new Error('Select a friend before opening a conversation.');
        }
        const manuallyProvidedPassphrase = typeof passphrase === 'string' && passphrase.length > 0;
        if (!manuallyProvidedPassphrase) passphrase = readConversationPassphrase(peerId);
        if (!passphrase) {
            throw new Error('Enter the shared conversation passphrase once on this device to unlock the chat.');
        }
        if (typeof passphrase !== 'string' || passphrase.length < 20) {
            throw new Error('Use the same unique passphrase of at least 20 characters on both devices.');
        }

        closeGunConversation();
        const generation = gunObserverGeneration;
        const roomId = getDirectMessageRoomId(username, peerId);
        const key = await deriveConversationKey(passphrase, roomId);
        if (generation !== gunObserverGeneration || peerId !== app.state.currentConversation) {
            throw new Error('The selected conversation changed. Enter the passphrase again.');
        }
        let savedLocally = !manuallyProvidedPassphrase;
        let saveError = null;
        if (manuallyProvidedPassphrase) {
            try {
                //notes Save the already-shared passphrase locally after the user unlocks this conversation.
                window.localStorage.setItem(getConversationKeyStorageKey(peerId), passphrase);
                savedLocally = true;
            } catch (error) {
                saveError = error;
            }
        }

        const room = gun.get(roomId).get('messages');
        const signalingNode = gun.get(roomId).get('signaling');
        activeGunPeer = peerId;
        activeGunRoom = room;
        activeGunSignalingNode = signalingNode;
        activeGunKey = key;
        app.directMessageCache[peerId] = [];
        app.state.messages[peerId] = app.directMessageCache[peerId];
        app.directMessageReady = true;
        app.renderChatArea();
        app.renderDMList();
        syncCallView();
        document.getElementById('messageInput').focus();

        const observer = room.map();
        currentGunMap = observer;
        observer.on(async (packet, messageId) => {
            if (generation !== gunObserverGeneration || activeGunPeer !== peerId ||
                !packet || typeof messageId !== 'string' ||
                (packet.sender !== username && packet.sender !== peerId) ||
                typeof packet.message !== 'string' || packet.message.length > MAX_DIRECT_PACKET_LENGTH ||
                !Number.isFinite(packet.timestamp)) return;
            const messages = app.directMessageCache[peerId];
            if (messages.some(message => message.id === messageId) || pendingGunMessageIds.has(messageId)) return;
            pendingGunMessageIds.add(messageId);
            try {
                const plaintext = await decryptDirectMessage(packet.message, key, packet.sender, packet.timestamp);
                const { content, attachment } = decodeMessageContent(plaintext);
                if (generation !== gunObserverGeneration || activeGunPeer !== peerId) return;
                messages.push({
                    id: messageId,
                    sender: packet.sender,
                    content,
                    attachment,
                    timestamp: packet.timestamp,
                    status: 'sent'
                });
                messages.sort((left, right) => left.timestamp - right.timestamp);
                app.state.messages[peerId] = messages;
                app.renderMessages();
                app.renderDMList();
            } catch (error) {
                if (generation === gunObserverGeneration) {
                    document.getElementById('direct-message-key-status').textContent =
                        'A message could not be decrypted. Confirm both people entered the same passphrase.';
                }
            } finally {
                pendingGunMessageIds.delete(messageId);
            }
        });

        const signalingObserver = signalingNode.map();
        currentGunSignalingMap = signalingObserver;
        //notes Replace the former server signaling listeners with this authenticated Gun signaling stream.
        signalingObserver.on((packet, signalId) => {
            receiveCallSignal(packet, signalId, generation, peerId, key)
                .catch(error => {
                    callAlert.textContent = `TERMINAL: Could not process call signaling. ${error.message}`;
                });
        });
        return { savedLocally, saveError };
    }

    function getPendingMessages() {
        const stored = window.localStorage.getItem(pendingMessageStorageKey);
        if (stored === null) return [];
        let queue;
        try {
            queue = JSON.parse(stored);
        } catch (error) {
            throw new Error('The saved offline message queue is unreadable. Do not clear site storage until you have recovered it.');
        }
        if (!Array.isArray(queue) || queue.some(entry =>
            !entry || typeof entry.roomId !== 'string' ||
            !(entry.roomId.startsWith('blocktalk-dm-v1:') ||
                /^blocktalk-server-v1:[a-f0-9]{64}$/.test(entry.roomId)) ||
            !entry.packet || typeof entry.packet.sender !== 'string' ||
            typeof entry.packet.message !== 'string' ||
            entry.packet.message.length > MAX_DIRECT_PACKET_LENGTH ||
            !Number.isFinite(entry.packet.timestamp)
        )) {
            throw new Error('The saved offline message queue has an invalid format and was left untouched.');
        }
        return queue;
    }

    function savePendingMessages(queue) {
        if (!queue.length) {
            window.localStorage.removeItem(pendingMessageStorageKey);
            return;
        }
        const serialized = JSON.stringify(queue);
        if (serialized.length > 3500000) {
            throw new Error('The offline queue is near this browser’s storage limit. Reconnect and send smaller attachments.');
        }
        window.localStorage.setItem(pendingMessageStorageKey, serialized);
    }

    function queueEncryptedMessage(roomId, packet) {
        const queue = getPendingMessages();
        if (queue.length >= 500) throw new Error('The offline message queue is full. Reconnect and retry before sending more.');
        queue.push({ roomId, packet });
        savePendingMessages(queue);
    }

    function publishQueuedMessage(entry) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Gun did not acknowledge the queued message.')), 15000);
            gun.get(entry.roomId).get('messages').set(entry.packet, acknowledgement => {
                clearTimeout(timeout);
                if (acknowledgement?.err) reject(new Error(String(acknowledgement.err)));
                else resolve();
            });
        });
    }

    async function flushPendingMessages() {
        if (pendingMessageFlush) return pendingMessageFlush;
        if (!gun || !window.navigator.onLine) return;
        pendingMessageFlush = (async () => {
            //notes Flush the durable offline queue in order, removing each packet only after Gun acknowledges its write.
            while (window.navigator.onLine) {
                const queue = getPendingMessages();
                if (!queue.length) {
                    savePendingMessages([]);
                    const status = document.getElementById('direct-message-key-status');
                    if (status) status.textContent = 'Offline message queue is empty.';
                    return;
                }
                const entry = queue[0];
                try {
                    await publishQueuedMessage(entry);
                } catch (error) {
                    const status = document.getElementById('direct-message-key-status');
                    if (status) status.textContent = `Could not send a queued message; it remains saved on this device. ${error.message}`;
                    return;
                }
                const latestQueue = getPendingMessages();
                const entryIndex = latestQueue.findIndex(queued =>
                    queued.roomId === entry.roomId &&
                    queued.packet.sender === entry.packet.sender &&
                    queued.packet.timestamp === entry.packet.timestamp &&
                    queued.packet.message === entry.packet.message
                );
                if (entryIndex !== -1) latestQueue.splice(entryIndex, 1);
                savePendingMessages(latestQueue);
            }
        })().catch(error => {
            const status = document.getElementById('direct-message-key-status');
            if (status) status.textContent = `Could not read or flush the saved offline queue. ${error.message}`;
            else console.error('Could not flush BlockTalk offline queue:', error);
        }).finally(() => {
            pendingMessageFlush = null;
        });
        return pendingMessageFlush;
    }

    async function sendDirectMessage(content) {
        if (activeServer) return sendServerMessage(content);
        const peerId = app.state.currentConversation;
        if (!peerId) {
            setMediaStatus('Choose a direct conversation or server before sending.');
            return;
        }
        if (activeGunPeer !== peerId || !activeGunRoom || !activeGunKey) {
            document.getElementById('direct-message-key-status').textContent =
                'Unlock this conversation with its shared passphrase before sending.';
            return;
        }
        let text;
        try {
            text = encodeMessageContent(content);
        } catch (error) {
            setMediaStatus(error.message);
            return;
        }
        if (!text || (typeof content === 'string' && text.length > 2000)) return;
        const sender = app.state.currentUser.username;
        const timestamp = Date.now();
        const room = activeGunRoom;
        const key = activeGunKey;
        const generation = gunObserverGeneration;
        try {
            const packet = {
                sender,
                message: await encryptDirectMessage(text, key, sender, timestamp),
                timestamp
            };
            if (packet.message.length > MAX_DIRECT_PACKET_LENGTH) {
                throw new Error('This encrypted attachment is too large to send through the current Gun relay.');
            }
            if (generation !== gunObserverGeneration || peerId !== app.state.currentConversation) return;
            if (!window.navigator.onLine) {
                //notes Monitor navigator connection state here and queue only the locally encrypted packet while offline.
                queueEncryptedMessage(getDirectMessageRoomId(sender, peerId), packet);
                document.getElementById('messageInput').value = '';
                setMediaStatus('');
                document.getElementById('direct-message-key-status').textContent =
                    'Encrypted message saved on this device and will send when the connection returns.';
                return;
            }
            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('The Gun relays did not confirm the message.')), 15000);
                    room.set(packet, acknowledgement => {
                        clearTimeout(timeout);
                        if (acknowledgement?.err) reject(new Error('The message could not be saved to the Gun relays.'));
                        else resolve();
                    });
                });
            } catch (error) {
                queueEncryptedMessage(getDirectMessageRoomId(sender, peerId), packet);
                document.getElementById('messageInput').value = '';
                document.getElementById('direct-message-key-status').textContent =
                    'Gun did not confirm the encrypted message. It is saved on this device and will retry when online.';
                return;
            }
            document.getElementById('messageInput').value = '';
            document.getElementById('direct-message-key-status').textContent =
                'Encrypted message submitted to Gun. Remote sync may take time; relays can see sender and timestamp, not text.';
        } catch (error) {
            document.getElementById('direct-message-key-status').textContent = error.message;
        }
    }

    function serverStorageKey() {
        const username = app.state.currentUser?.username;
        if (!username) throw new Error('Sign in before managing private servers.');
        return `${SERVER_STORAGE_PREFIX}${username}`;
    }

    function getJoinedServers() {
        const stored = window.localStorage.getItem(serverStorageKey());
        if (stored === null) return [];
        let servers;
        try {
            servers = JSON.parse(stored);
        } catch (error) {
            throw new Error('The saved server list is unreadable; it was left untouched.');
        }
        if (!Array.isArray(servers) || servers.some(server =>
            !server || typeof server.id !== 'string' || !/^blocktalk-server-v1:[a-f0-9]{64}$/.test(server.id) ||
            typeof server.code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(server.code) ||
            typeof server.name !== 'string' || !server.name
        )) {
            throw new Error('The saved server list is invalid; it was left untouched.');
        }
        return servers;
    }

    function saveJoinedServers(servers) {
        window.localStorage.setItem(serverStorageKey(), JSON.stringify(servers));
    }

    async function getServerId(inviteCode) {
        const digest = await window.crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(`BlockTalk private server v1:${inviteCode}`)
        );
        const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        return `blocktalk-server-v1:${hex}`;
    }

    function generateInviteCode() {
        const bytes = window.crypto.getRandomValues(new Uint8Array(24));
        return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function serverMessageSignaturePayload(serverId, packet) {
        return JSON.stringify([
            serverId,
            packet.sender,
            packet.senderPub,
            packet.timestamp,
            packet.message
        ]);
    }

    function closeActiveServer() {
        activeServerGeneration += 1;
        if (activeServerObserver) activeServerObserver.off();
        activeServerObserver = null;
        activeServer = null;
        activeServerKey = null;
        app.serverMessagesReady = false;
    }

    function renderServerList() {
        const list = document.getElementById('serverList');
        list.replaceChildren();
        let servers;
        try {
            servers = getJoinedServers();
        } catch (error) {
            document.getElementById('serverStatus').textContent = error.message;
            return;
        }
        if (!servers.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-list-note';
            empty.textContent = 'No servers yet. Create one or join with an invite code.';
            list.appendChild(empty);
            return;
        }
        servers.forEach(server => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'server-item';
            button.textContent = `# ${server.name}`;
            button.classList.toggle('active', app.state.currentServer?.id === server.id);
            button.addEventListener('click', () => openServerConversation(server));
            list.appendChild(button);
        });
    }

    async function addServerWithInviteCode(inviteCode, expectedName = '') {
        const normalizedCode = inviteCode.trim();
        if (!/^[A-Za-z0-9_-]{32}$/.test(normalizedCode)) {
            throw new Error('Invite codes must be 32 characters. Check that the full code was copied.');
        }
        const id = await getServerId(normalizedCode);
        const metadata = await app.readGunNode(gun.get(id).get('meta'));
        if (!metadata || typeof metadata.name !== 'string' ||
            metadata.name.length < 1 || metadata.name.length > 40) {
            throw new Error('No server was found for that invite code.');
        }
        if (expectedName && metadata.name !== expectedName) {
            throw new Error('The newly created server could not be verified on the relay.');
        }
        const servers = getJoinedServers();
        const existing = servers.find(server => server.id === id);
        if (!existing) {
            servers.push({ id, code: normalizedCode, name: metadata.name });
            saveJoinedServers(servers);
        }
        renderServerList();
        return existing || { id, code: normalizedCode, name: metadata.name };
    }

    async function createPrivateServer() {
        const nameInput = document.getElementById('serverNameInput');
        const status = document.getElementById('serverStatus');
        const name = nameInput.value.trim();
        if (name.length < 2 || name.length > 40) {
            status.textContent = 'Server names must be 2–40 characters.';
            return;
        }
        const button = document.getElementById('createServerButton');
        button.disabled = true;
        status.textContent = 'Creating a private invite-code server...';
        try {
            const code = generateInviteCode();
            const id = await getServerId(code);
            await app.writeGunNode(gun.get(id).get('meta'), {
                name,
                createdBy: app.state.currentUser.username,
                createdAt: Date.now()
            });
            const server = await addServerWithInviteCode(code, name);
            const result = document.getElementById('serverInviteResult');
            document.getElementById('serverInviteCode').textContent = server.code;
            result.classList.remove('hidden');
            status.textContent = `Created ${server.name}. Share the invite code only with people you trust.`;
            nameInput.value = '';
            await openServerConversation(server);
        } catch (error) {
            status.textContent = `Could not create the server: ${error.message}`;
        } finally {
            button.disabled = false;
        }
    }

    async function joinPrivateServer() {
        const input = document.getElementById('serverInviteInput');
        const status = document.getElementById('serverStatus');
        const button = document.getElementById('joinServerButton');
        button.disabled = true;
        status.textContent = 'Checking the invite code...';
        try {
            const server = await addServerWithInviteCode(input.value);
            input.value = '';
            status.textContent = `Joined ${server.name}. The invite code is saved only on this device.`;
            await openServerConversation(server);
        } catch (error) {
            status.textContent = error.message;
        } finally {
            button.disabled = false;
        }
    }

    async function openServerConversation(server) {
        closeGunConversation();
        closeActiveServer();
        const generation = activeServerGeneration;
        activeServer = server;
        app.state.currentConversation = null;
        app.state.currentServer = { id: server.id, name: server.name };
        app.serverMessagesReady = false;
        const messagesKey = `server:${server.id}`;
        app.state.messages[messagesKey] = [];
        window.dispatchEvent(new CustomEvent('blocktalk:conversation-selected', { detail: { peer: null } }));
        app.renderDMList();
        app.renderChatArea();
        setMediaStatus('');
        document.getElementById('serverStatus').textContent = `Connecting to ${server.name}...`;
        try {
            const key = await deriveConversationKey(server.code, server.id);
            if (generation !== activeServerGeneration || activeServer?.id !== server.id) return;
            activeServerKey = key;
            const observer = gun.get(server.id).get('messages').map();
            activeServerObserver = observer;
            const seenMessages = new Set();
            observer.on(async (packet, messageId) => {
                if (generation !== activeServerGeneration || activeServer?.id !== server.id ||
                    !packet || typeof messageId !== 'string' || seenMessages.has(messageId) ||
                    typeof packet.sender !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(packet.sender) ||
                    typeof packet.senderPub !== 'string' || typeof packet.signature !== 'string' ||
                    typeof packet.message !== 'string' || packet.message.length > MAX_DIRECT_PACKET_LENGTH ||
                    !Number.isFinite(packet.timestamp)) return;
                seenMessages.add(messageId);
                if (seenMessages.size > 10000) seenMessages.delete(seenMessages.values().next().value);
                try {
                    const expectedPub = await app.lookupUserPub(packet.sender);
                    if (expectedPub !== packet.senderPub) return;
                    const verified = await app.getGunSea().verify(packet.signature, packet.senderPub);
                    if (verified !== serverMessageSignaturePayload(server.id, packet)) return;
                    const plaintext = await decryptDirectMessage(packet.message, key, packet.sender, packet.timestamp);
                    const { content, attachment } = decodeMessageContent(plaintext);
                    if (generation !== activeServerGeneration) return;
                    const messages = app.state.messages[messagesKey];
                    messages.push({ id: messageId, sender: packet.sender, content, attachment, timestamp: packet.timestamp, status: 'sent' });
                    messages.sort((left, right) => left.timestamp - right.timestamp);
                    if (messages.length > MAX_RENDERED_SERVER_MESSAGES) {
                        messages.splice(0, messages.length - MAX_RENDERED_SERVER_MESSAGES);
                    }
                    app.renderMessages();
                } catch (error) {
                    setMediaStatus('A server message could not be decrypted. Confirm the invite code is correct.');
                }
            });
            app.serverMessagesReady = true;
            app.renderChatArea();
            document.getElementById('serverStatus').textContent = `Connected to ${server.name}.`;
        } catch (error) {
            if (generation !== activeServerGeneration) return;
            document.getElementById('serverStatus').textContent = `Could not open this server: ${error.message}`;
        }
    }

    async function sendServerMessage(content) {
        if (!activeServer || !activeServerKey || !activeServerObserver) {
            setMediaStatus('Open a private server before sending.');
            return;
        }
        let plaintext;
        try {
            plaintext = encodeMessageContent(content);
        } catch (error) {
            setMediaStatus(error.message);
            return;
        }
        if (!plaintext || (typeof content === 'string' && plaintext.length > 2000)) return;
        const server = activeServer;
        const generation = activeServerGeneration;
        const key = activeServerKey;
        const pair = app.gunUser?._?.sea;
        if (!pair?.pub) {
            setMediaStatus('Sign in again before posting to this server.');
            return;
        }
        const packet = {
            sender: app.state.currentUser.username,
            senderPub: pair.pub,
            timestamp: Date.now()
        };
        try {
            packet.message = await encryptDirectMessage(plaintext, key, packet.sender, packet.timestamp);
            if (generation !== activeServerGeneration || activeServer?.id !== server.id) return;
            if (packet.message.length > MAX_DIRECT_PACKET_LENGTH) {
                throw new Error('This encrypted attachment is too large for the current Gun relay.');
            }
            packet.signature = await app.getGunSea().sign(serverMessageSignaturePayload(server.id, packet), pair);
            if (typeof packet.signature !== 'string') throw new Error('The server message could not be signed.');
            if (generation !== activeServerGeneration || activeServer?.id !== server.id) return;
            if (!window.navigator.onLine) {
                queueEncryptedMessage(server.id, packet);
                document.getElementById('messageInput').value = '';
                setMediaStatus('Encrypted server message queued on this device; it will send when online.');
                return;
            }
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('The Gun relay did not confirm the server message.')), 15000);
                gun.get(server.id).get('messages').set(packet, acknowledgement => {
                    clearTimeout(timeout);
                    if (acknowledgement?.err) reject(new Error(String(acknowledgement.err)));
                    else resolve();
                });
            });
            if (activeServer?.id === server.id) setMediaStatus('');
            document.getElementById('messageInput').value = '';
        } catch (error) {
            if (error.message.includes('did not confirm') || error.message.includes('could not be saved')) {
                try {
                    queueEncryptedMessage(server.id, packet);
                    document.getElementById('messageInput').value = '';
                    setMediaStatus('Gun did not confirm the server message. It is queued on this device for retry.');
                    return;
                } catch (queueError) {
                    setMediaStatus(`Could not queue server message: ${queueError.message}`);
                    return;
                }
            }
            setMediaStatus(`Could not send server message: ${error.message}`);
        }
    }

    app.directMessages = { openConversation: openGunConversation, sendMessage: sendDirectMessage };
    app.closeDirectMessage = closeGunConversation;
    app.directMessageReady = false;
    try {
        if (!app.gun && typeof window.Gun !== 'function') throw new Error('GunDB client script did not load.');
        gun = app.gun || window.Gun({ peers: gunRelays, axe: false });
    } catch (error) {
        document.getElementById('direct-message-key-status').textContent = error.message;
    }
    //notes Monitor browser connectivity changes and immediately trigger the sequential cache flush on reconnection.
    window.addEventListener('online', () => {
        flushPendingMessages();
    });
    if (window.navigator.onLine) flushPendingMessages();

    window.addEventListener('blocktalk:conversation-selected', event => {
        const nextPeer = event.detail?.peer || null;
        if (activeCall && activeCall.peer !== nextPeer) {
            finishCall(true);
        }
        if (nextPeer !== activeGunPeer) incomingCalls.clear();
        closeGunConversation();
        const peerId = nextPeer;
        app.directMessageReady = false;
        if (peerId) {
            app.directMessageCache[peerId] = [];
            app.state.messages[peerId] = app.directMessageCache[peerId];
        }
        document.getElementById('direct-message-key').value = '';
        document.getElementById('direct-message-key-status').textContent = peerId
            ? 'Enter the shared passphrase once on this device. It can be remembered locally for future visits.'
            : '';
        document.getElementById('messageInput').disabled = true;
        document.getElementById('messageInput').value = '';
        document.getElementById('sendBtn').disabled = true;
        //notes Wipe the previous conversation text log immediately when switching friends.
        document.getElementById('messageLog').replaceChildren();
        if (peerId) app.renderMessages();
        else app.renderChatArea();
        if (peerId) {
            try {
                const savedPassphrase = readConversationPassphrase(peerId);
                if (savedPassphrase) {
                    document.getElementById('direct-message-key-status').textContent =
                        'Found this conversation’s saved key on this device. Unlocking...';
                    openGunConversation(peerId).then(result => {
                        if (app.state.currentConversation !== peerId) return;
                        document.getElementById('direct-message-key-status').textContent = result.saveError
                            ? `Chat unlocked, but the key could not be saved locally: ${result.saveError.message}`
                            : 'Chat unlocked with the passphrase saved on this device.';
                    }).catch(error => {
                        if (app.state.currentConversation === peerId) {
                            document.getElementById('direct-message-key-status').textContent = error.message;
                        }
                    });
                }
            } catch (error) {
                document.getElementById('direct-message-key-status').textContent = error.message;
            }
        }
    });

    document.getElementById('forget-direct-message-key').addEventListener('click', () => {
        const peerId = app.state.currentConversation;
        if (!peerId) return;
        try {
            forgetConversationPassphrase(peerId);
            document.getElementById('direct-message-key-status').textContent =
                'Saved key removed from this device. The current chat remains unlocked until you switch conversations or log out.';
        } catch (error) {
            document.getElementById('direct-message-key-status').textContent =
                `Could not remove the saved key: ${error.message}`;
        }
    });

    function updateAuthCopy() {
        const isSignUp = app.auth.isSignUpMode;
        const mode = isSignUp ? 'Sign Up' : 'Sign In';
        document.getElementById('authFormTitle').textContent = mode;
        document.getElementById('authSubmitBtn').textContent = mode;
        document.getElementById('toggleText').textContent = isSignUp
            ? 'Already have an account? '
            : "Don't have an account? ";
        authToggle.textContent = isSignUp ? 'Sign In' : 'Sign Up';
        document.getElementById('usernameLabel').textContent = `${mode} Username`;
        document.getElementById('passwordLabel').textContent = `${mode} Password`;
        document.getElementById('confirmPasswordLabel').textContent = `${mode} Confirm Password`;
        document.getElementById('authUsername').placeholder = isSignUp ? 'Choose a username' : 'Enter your username';
        document.getElementById('authPassword').placeholder = isSignUp ? 'Create a strong password' : 'Enter your password';
        document.getElementById('authConfirmPassword').placeholder = 'Confirm password';
        document.getElementById('authConfirmPassword').required = isSignUp;
        document.getElementById('authPassword').autocomplete = isSignUp ? 'new-password' : 'current-password';
    }

    authToggle.addEventListener('click', () => {
        app.auth.toggleMode();
        updateAuthCopy();
    });
    window.addEventListener('blocktalk:auth-mode-changed', updateAuthCopy);
    updateAuthCopy();

    window.addEventListener('blocktalk:database-change', () => {
        if (!app.state.currentUser) return;
        syncCallView();
    });

    function initialsFor(name) {
        const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
        if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
        return (parts[0] || '?').slice(0, 2).toUpperCase();
    }

    const themeClassNames = ['theme-terminal', 'theme-cyberpunk', 'theme-light'];

    function applyTheme(theme) {
        const selectedTheme = ['terminal', 'cyberpunk', 'light'].includes(theme) ? theme : 'terminal';
        document.body.classList.remove(...themeClassNames);
        document.body.classList.add(`theme-${selectedTheme}`);
        return selectedTheme;
    }

    function currentProfile() {
        if (!app.state.currentUser) return app.createUserProfile();
        const database = app.readDatabase();
        return app.getUserProfile(database, app.state.currentUser.username);
    }

    function setProfilePicture(url, username) {
        const initials = initialsFor(username || '?');
        profilePicture.style.backgroundImage = '';
        profilePicture.classList.remove('has-image');
        profilePicture.textContent = initials;
        profilePicture.setAttribute('aria-label', `Profile picture for ${username || 'guest'}`);
        if (!url) return true;

        try {
            if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(url) &&
                url.length <= MAX_IMAGE_DATA_URL_LENGTH) {
                profilePicture.style.backgroundImage = `url("${url}")`;
                profilePicture.textContent = '';
                profilePicture.classList.add('has-image');
                return true;
            }
            const imageUrl = new URL(url, window.location.href);
            if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') return false;
            profilePicture.style.backgroundImage = `url("${imageUrl.href}")`;
            profilePicture.textContent = '';
            profilePicture.classList.add('has-image');
            return true;
        } catch (error) {
            return false;
        }
    }

    function syncUserPreferences() {
        const username = app.state.currentUser?.username;
        if (!username) {
            applyTheme('terminal');
            setProfilePicture('', 'guest');
            return;
        }

        const profile = currentProfile();
        applyTheme(profile.theme);
        setProfilePicture(profile.profilePictureUrl, username);
    }

    function openSettings() {
        const profile = currentProfile();
        profilePictureSelectionGeneration += 1;
        const isEmbeddedPicture = /^data:image\/(webp|jpeg|png);base64,/.test(profile.profilePictureUrl);
        settingsPfpUrl.value = isEmbeddedPicture ? '' : profile.profilePictureUrl || '';
        pendingProfilePictureDataUrl = isEmbeddedPicture ? profile.profilePictureUrl : '';
        profilePictureProcessing = false;
        document.getElementById('profilePictureDropzoneText').textContent =
            isEmbeddedPicture ? 'Current picture will be kept (drop a replacement here)' :
                'Drop a picture here or browse (WebP/JPEG/PNG, max 160 KB)';
        settingsTheme.value = profile.theme || 'terminal';
        settingsStatus.textContent = '';
        applyTheme(settingsTheme.value);
        settingsModal.classList.remove('hidden');
        settingsPfpUrl.focus();
    }

    function closeSettings() {
        syncUserPreferences();
        settingsModal.classList.add('hidden');
        settingsButton.focus();
    }

    async function saveSettings() {
        if (!app.state.currentUser) return;
        if (profilePictureProcessing) {
            settingsStatus.textContent = 'Wait for the profile picture compression to finish.';
            return;
        }

        const rawUrl = settingsPfpUrl.value.trim();
        let profilePictureUrl = '';
        if (pendingProfilePictureDataUrl) {
            profilePictureUrl = pendingProfilePictureDataUrl;
        } else if (rawUrl) {
            try {
                const parsedUrl = new URL(rawUrl, window.location.href);
                if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('Unsupported URL');
                profilePictureUrl = parsedUrl.href;
            } catch (error) {
                settingsStatus.textContent = 'Enter a valid HTTP or HTTPS image URL.';
                return;
            }
        }

        try {
            const theme = applyTheme(settingsTheme.value);
            await app.updateProfile({ profilePictureUrl, theme });
            syncUserPreferences();
            settingsStatus.textContent = 'Settings saved.';
        } catch (error) {
            settingsStatus.textContent = error.message;
        }
    }

    settingsButton.addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-save').addEventListener('click', saveSettings);
    const profilePictureFile = document.getElementById('settings-pfp-file');
    const profilePictureDropzone = document.getElementById('profilePictureDropzone');
    async function setPendingProfilePicture(file) {
        const generation = ++profilePictureSelectionGeneration;
        profilePictureProcessing = true;
        settingsStatus.textContent = 'Compressing profile picture...';
        try {
            const picture = await compressImageFile(file, 160 * 1024, 512);
            if (generation !== profilePictureSelectionGeneration) return;
            pendingProfilePictureDataUrl = picture.dataUrl;
            settingsPfpUrl.value = '';
            document.getElementById('profilePictureDropzoneText').textContent = `${file.name} is ready (compressed).`;
            settingsStatus.textContent = '';
        } catch (error) {
            if (generation === profilePictureSelectionGeneration) settingsStatus.textContent = error.message;
        } finally {
            if (generation === profilePictureSelectionGeneration) profilePictureProcessing = false;
        }
    }
    profilePictureFile.addEventListener('change', () => {
        const [file] = profilePictureFile.files || [];
        if (file) setPendingProfilePicture(file);
        profilePictureFile.value = '';
    });
    settingsPfpUrl.addEventListener('input', () => {
        profilePictureSelectionGeneration += 1;
        profilePictureProcessing = false;
        pendingProfilePictureDataUrl = '';
    });
    ['dragenter', 'dragover'].forEach(type => profilePictureDropzone.addEventListener(type, event => {
        event.preventDefault();
        profilePictureDropzone.classList.add('dragging');
    }));
    ['dragleave', 'drop'].forEach(type => profilePictureDropzone.addEventListener(type, event => {
        event.preventDefault();
        profilePictureDropzone.classList.remove('dragging');
    }));
    profilePictureDropzone.addEventListener('drop', event => {
        const [file] = event.dataTransfer?.files || [];
        if (file) setPendingProfilePicture(file);
    });
    settingsTheme.addEventListener('change', () => applyTheme(settingsTheme.value));
    settingsModal.addEventListener('click', event => {
        if (event.target === settingsModal) closeSettings();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
    });

    const emojiPicker = document.getElementById('emojiPicker');
    commonEmojis.forEach(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'emoji-choice';
        button.textContent = emoji;
        button.setAttribute('aria-label', `Insert ${emoji}`);
        button.addEventListener('click', () => {
            const input = document.getElementById('messageInput');
            const start = input.selectionStart;
            const end = input.selectionEnd;
            input.setRangeText(emoji, start, end, 'end');
            input.focus();
            emojiPicker.classList.add('hidden');
        });
        emojiPicker.appendChild(button);
    });
    document.getElementById('emojiPickerButton').addEventListener('click', () => {
        emojiPicker.classList.toggle('hidden');
    });
    document.getElementById('attachButton').addEventListener('click', () => {
        document.getElementById('attachmentInput').click();
    });
    document.getElementById('attachmentInput').addEventListener('change', async event => {
        const files = [...(event.target.files || [])];
        event.target.value = '';
        await sendImageFiles(files);
    });

    async function sendImageFiles(files) {
        if (!files.length) return;
        const target = activeConversationToken();
        if (!target) {
            setMediaStatus('Choose a direct conversation or server before attaching an image.');
            return;
        }
        for (const file of files) {
            try {
                setMediaStatus(`Compressing ${file.name}...`);
                const image = await compressImageFile(file);
                if (target !== activeConversationToken()) {
                    throw new Error('The selected conversation changed; the image was not sent.');
                }
                await sendDirectMessage({ kind: 'image', ...image });
            } catch (error) {
                setMediaStatus(error.message);
                return;
            }
        }
    }

    const recordVoiceButton = document.getElementById('recordVoiceButton');
    recordVoiceButton.addEventListener('click', async () => {
        if (voiceRecorder?.state === 'recording') {
            voiceRecorder.stop();
            recordVoiceButton.disabled = true;
            recordVoiceButton.textContent = 'Saving...';
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== 'function') {
            setMediaStatus('Voice snippets are unavailable in this browser. Use HTTPS and a supported browser.');
            return;
        }
        if (!app.state.currentConversation && !app.state.currentServer) {
            setMediaStatus('Open a direct conversation or server before recording.');
            return;
        }
        const target = activeConversationToken();
        try {
            recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (target !== activeConversationToken()) {
                recordingStream.getTracks().forEach(track => track.stop());
                recordingStream = null;
                setMediaStatus('The selected conversation changed; recording was cancelled.');
                return;
            }
            voiceRecordingTarget = target;
            const mimeType = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus',
                'audio/mp4'
            ].find(type => window.MediaRecorder.isTypeSupported(type));
            voiceRecorder = mimeType
                ? new window.MediaRecorder(recordingStream, { mimeType, audioBitsPerSecond: 64000 })
                : new window.MediaRecorder(recordingStream, { audioBitsPerSecond: 64000 });
            voiceChunks = [];
            voiceRecorder.addEventListener('dataavailable', event => {
                if (event.data?.size) voiceChunks.push(event.data);
            });
            voiceRecorder.addEventListener('error', () => {
                setMediaStatus('The voice recording failed.');
                if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
            }, { once: true });
            voiceRecorder.addEventListener('stop', async () => {
                clearTimeout(voiceRecordingTimer);
                recordingStream?.getTracks().forEach(track => track.stop());
                recordingStream = null;
                const selectedRecorder = voiceRecorder;
                voiceRecorder = null;
                const recordedTarget = voiceRecordingTarget;
                voiceRecordingTarget = null;
                recordVoiceButton.disabled = false;
                recordVoiceButton.textContent = 'Record';
                try {
                    if (recordedTarget !== activeConversationToken()) {
                        throw new Error('The selected conversation changed; the recording was not sent.');
                    }
                    const type = selectedRecorder?.mimeType?.split(';')[0] || 'audio/webm';
                    if (!/^audio\/(webm|mp4|ogg)$/.test(type)) throw new Error('This browser produced an unsupported audio format.');
                    const blob = new Blob(voiceChunks, { type });
                    voiceChunks = [];
                    if (!blob.size) throw new Error('The voice recording was empty.');
                    if (blob.size > 180 * 1024) throw new Error('Voice snippets must be 20 seconds or less and under 180 KB.');
                    const dataUrl = await readFileAsDataUrl(blob);
                    validateAttachment({ kind: 'voice', dataUrl, name: 'Voice snippet' });
                    await sendDirectMessage({ kind: 'voice', dataUrl, name: 'Voice snippet' });
                } catch (error) {
                    setMediaStatus(error.message);
                }
            }, { once: true });
            voiceRecorder.start(250);
            recordVoiceButton.textContent = 'Stop (20s max)';
            setMediaStatus('Recording voice snippet…');
            voiceRecordingTimer = window.setTimeout(() => {
                if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
            }, 20000);
        } catch (error) {
            recordingStream?.getTracks().forEach(track => track.stop());
            recordingStream = null;
            voiceRecorder = null;
            voiceRecordingTarget = null;
            setMediaStatus(`Could not start recording: ${error.message}`);
        }
    });

    function handleMediaDrop(event) {
        event.preventDefault();
        event.currentTarget.classList.remove('dragging');
        const files = [...(event.dataTransfer?.files || [])];
        if (files.length) sendImageFiles(files.filter(file => file.type.startsWith('image/')));
    }
    const mediaDropTargets = [document.getElementById('messageLog'), document.querySelector('.input-frame')];
    mediaDropTargets.forEach(target => {
        ['dragenter', 'dragover'].forEach(type => target.addEventListener(type, event => {
            if (![...(event.dataTransfer?.items || [])].some(item => item.kind === 'file')) return;
            event.preventDefault();
            target.classList.add('dragging');
        }));
        ['dragleave', 'drop'].forEach(type => target.addEventListener(type, event => {
            event.preventDefault();
            target.classList.remove('dragging');
        }));
        target.addEventListener('drop', handleMediaDrop);
    });

    document.getElementById('createServerButton').addEventListener('click', createPrivateServer);
    document.getElementById('joinServerButton').addEventListener('click', joinPrivateServer);
    document.getElementById('serverInviteInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') joinPrivateServer();
    });
    document.getElementById('copyServerInvite').addEventListener('click', async () => {
        const code = document.getElementById('serverInviteCode').textContent;
        try {
            await navigator.clipboard.writeText(code);
            document.getElementById('serverStatus').textContent = 'Invite code copied.';
        } catch (error) {
            document.getElementById('serverStatus').textContent =
                'Clipboard access was blocked. Select and copy the invite code manually.';
        }
    });

    const originalShowApp = app.showApp;
    app.showApp = function(...args) {
        const result = originalShowApp.apply(this, args);
        syncUserPreferences();
        return result;
    };
    syncUserPreferences();

    function isBlocked(database, firstUser, secondUser) {
        return app.getUserProfile(database, firstUser).blockedUsers.includes(secondUser) ||
            app.getUserProfile(database, secondUser).blockedUsers.includes(firstUser);
    }

    function setCallAvatar(element, initialsElement, username, imageUrl) {
        initialsElement.textContent = initialsFor(username);
        element.style.backgroundImage = '';
        element.classList.remove('has-image');
        if (!imageUrl) return;
        try {
            if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(imageUrl) &&
                imageUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
                element.style.backgroundImage = `url("${imageUrl}")`;
                element.classList.add('has-image');
                return;
            }
            const url = new URL(imageUrl, window.location.href);
            if (!['http:', 'https:'].includes(url.protocol)) return;
            element.style.backgroundImage = `url("${url.href}")`;
            element.classList.add('has-image');
        } catch (error) {
            // Keep the initials visible for malformed avatar URLs.
        }
    }

    function setProfileModalAvatar(element, username, imageUrl) {
        element.textContent = initialsFor(username);
        element.style.backgroundImage = '';
        element.classList.remove('has-image');
        if (!imageUrl) return;
        if ((/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(imageUrl) &&
                imageUrl.length <= MAX_IMAGE_DATA_URL_LENGTH)) {
            element.textContent = '';
            element.style.backgroundImage = `url("${imageUrl}")`;
            element.classList.add('has-image');
            return;
        }
        try {
            const url = new URL(imageUrl, window.location.href);
            if (!['http:', 'https:'].includes(url.protocol)) return;
            element.textContent = '';
            element.style.backgroundImage = `url("${url.href}")`;
            element.classList.add('has-image');
        } catch (error) {
            return;
        }
    }

    async function readVerifiedBadges(username, publicKey) {
        const ownerPub = await app.lookupUserPub(OWNER_USERNAME);
        if (!ownerPub) return [];
        const records = await app.readGunNode(
            gun.get('blocktalk-v1').get('badges').get(publicKey)
        );
        const sea = app.getGunSea();
        const verifiedBadges = new Set();
        for (const envelope of Object.values(records || {})) {
            if (!envelope || typeof envelope !== 'object' || typeof envelope.signature !== 'string') continue;
            try {
                const signedPayload = await sea.verify(envelope.signature, ownerPub);
                if (typeof signedPayload !== 'string') continue;
                const payload = JSON.parse(signedPayload);
                if (payload.recipientPub !== publicKey || payload.issuerPub !== ownerPub ||
                    payload.recipient !== username ||
                    !['met-owner', 'owner-friend'].includes(payload.badge) ||
                    typeof payload.id !== 'string' || !Number.isFinite(payload.timestamp)) continue;
                verifiedBadges.add(payload.badge);
            } catch (error) {
                console.warn(`Ignoring an invalid owner badge for ${username}:`, error);
            }
        }
        return [...verifiedBadges];
    }

    function appendBadge(container, label, styleName) {
        const badge = document.createElement('span');
        badge.className = `profile-badge ${styleName}`;
        badge.textContent = label;
        container.appendChild(badge);
    }

    async function openProfile(username) {
        if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return;
        const modal = document.getElementById('profileModal');
        const title = document.getElementById('profileModalTitle');
        const badges = document.getElementById('profileModalBadges');
        const status = document.getElementById('profileModalStatus');
        const ownerTools = document.getElementById('ownerBadgeTools');
        const generation = ++profileModalGeneration;
        badgeTarget = null;
        title.textContent = `@${username}`;
        badges.replaceChildren();
        status.textContent = 'Loading public profile…';
        ownerTools.classList.toggle('hidden', app.state.currentUser?.username !== OWNER_USERNAME);
        document.getElementById('badgeTargetStatus').textContent = '';
        document.getElementById('badgeTargetUsername').value = '';
        document.getElementById('awardBadgeButton').disabled = true;
        setProfileModalAvatar(document.getElementById('profileModalPicture'), username, '');
        modal.classList.remove('hidden');
        try {
            const publicKey = await app.lookupUserPub(username);
            if (!publicKey) throw new Error('No registered account was found for that username.');
            const profile = await app.readProfileByPub(publicKey);
            if (generation !== profileModalGeneration) return;
            setProfileModalAvatar(document.getElementById('profileModalPicture'), username, profile.profilePictureUrl);
            if (profile.accountCreatedAt > 0 && profile.accountCreatedAt < FOUNDER_BADGE_CUTOFF) {
                appendBadge(badges, 'Early OG · Joined before 2027', 'founder-badge');
            }
            if (username === OWNER_USERNAME) appendBadge(badges, 'BlockTalk Owner', 'owner-badge');
            let claims = [];
            let badgeError = '';
            try {
                claims = await readVerifiedBadges(username, publicKey);
            } catch (error) {
                badgeError = `Owner-issued badges could not be verified: ${error.message}`;
            }
            if (generation !== profileModalGeneration) return;
            if (claims.includes('met-owner')) appendBadge(badges, 'Met the Owner', 'met-owner-badge');
            if (claims.includes('owner-friend')) appendBadge(badges, "Owner's Friend", 'friend-badge');
            if (!badges.childElementCount) {
                const noBadges = document.createElement('span');
                noBadges.className = 'profile-no-badges';
                noBadges.textContent = 'No badges yet';
                badges.appendChild(noBadges);
            }
            status.textContent = badgeError;
        } catch (error) {
            if (generation === profileModalGeneration) status.textContent = error.message;
        }
    }

    document.getElementById('my-pfp').addEventListener('click', () => {
        const username = app.state.currentUser?.username;
        if (username) openProfile(username);
    });
    document.getElementById('my-pfp').addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        const username = app.state.currentUser?.username;
        if (username) openProfile(username);
    });
    document.addEventListener('click', event => {
        const target = event.target.closest('[data-profile-username]');
        if (target) openProfile(target.dataset.profileUsername);
    });
    document.getElementById('profileModalClose').addEventListener('click', () => {
        profileModalGeneration += 1;
        document.getElementById('profileModal').classList.add('hidden');
    });
    document.getElementById('profileModal').addEventListener('click', event => {
        if (event.target === event.currentTarget) {
            profileModalGeneration += 1;
            event.currentTarget.classList.add('hidden');
        }
    });
    document.getElementById('findBadgeTarget').addEventListener('click', async () => {
        const input = document.getElementById('badgeTargetUsername');
        const status = document.getElementById('badgeTargetStatus');
        const button = document.getElementById('awardBadgeButton');
        button.disabled = true;
        badgeTarget = null;
        const username = input.value.trim();
        try {
            const publicKey = await app.lookupUserPub(username);
            if (!publicKey) throw new Error('That username has not signed up for BlockTalk.');
            if (input.value.trim() !== username) return;
            badgeTarget = { username, publicKey };
            status.textContent = `Found @${username}. Choose a badge and award it.`;
            button.disabled = false;
        } catch (error) {
            if (input.value.trim() !== username) return;
            status.textContent = error.message;
        }
    });
    document.getElementById('badgeTargetUsername').addEventListener('input', () => {
        badgeTarget = null;
        document.getElementById('awardBadgeButton').disabled = true;
        document.getElementById('badgeTargetStatus').textContent = '';
    });
    document.getElementById('badgeTargetUsername').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        document.getElementById('findBadgeTarget').click();
    });
    document.getElementById('awardBadgeButton').addEventListener('click', async () => {
        const status = document.getElementById('badgeTargetStatus');
        const button = document.getElementById('awardBadgeButton');
        if (app.state.currentUser?.username !== OWNER_USERNAME || !badgeTarget) {
            status.textContent = 'Only the ItsTerminal4404 account can award these badges.';
            return;
        }
        button.disabled = true;
        try {
            const pair = app.gunUser?._?.sea;
            const ownerPub = await app.lookupUserPub(OWNER_USERNAME);
            if (!pair?.pub || pair.pub !== ownerPub) throw new Error('The owner account key could not be verified.');
            const payload = {
                id: window.crypto.randomUUID(),
                badge: document.getElementById('badgeType').value,
                recipientPub: badgeTarget.publicKey,
                recipient: badgeTarget.username,
                issuerPub: ownerPub,
                timestamp: Date.now()
            };
            const signature = await app.getGunSea().sign(JSON.stringify(payload), pair);
            if (typeof signature !== 'string') throw new Error('The badge award could not be signed.');
            await app.writeGunNode(
                gun.get('blocktalk-v1').get('badges').get(badgeTarget.publicKey).get(payload.id),
                { signature }
            );
            status.textContent = `Awarded the ${payload.badge === 'met-owner' ? 'Met the Owner' : "Owner's Friend"} badge to @${badgeTarget.username}.`;
            if (document.getElementById('profileModalTitle').textContent === `@${badgeTarget.username}`) {
                await openProfile(badgeTarget.username);
            }
        } catch (error) {
            status.textContent = `Could not award the badge: ${error.message}`;
        } finally {
            button.disabled = !badgeTarget;
        }
    });

    function serializeDescription(description) {
        if (typeof description.toJSON === 'function') return description.toJSON();
        return { type: description.type, sdp: description.sdp };
    }

    function serializeCandidate(candidate) {
        if (typeof candidate.toJSON === 'function') return candidate.toJSON();
        return {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment
        };
    }

    function setCallAvatar(element, initialsElement, username, imageUrl) {
        initialsElement.textContent = initialsFor(username);
        element.style.backgroundImage = '';
        element.classList.remove('has-image');
        if (!imageUrl) return;
        try {
            if (/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(imageUrl) &&
                imageUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
                element.style.backgroundImage = `url("${imageUrl}")`;
                element.classList.add('has-image');
                return;
            }
            const url = new URL(imageUrl, window.location.href);
            if (!['http:', 'https:'].includes(url.protocol)) return;
            element.style.backgroundImage = `url("${url.href}")`;
            element.classList.add('has-image');
        } catch (error) {
            // Keep initials visible if a profile contains a malformed URL.
        }
    }

    function monitorVoice(stream, avatar, mutedCheck = () => false) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        try {
            const context = new AudioContextClass();
            context.resume().catch(() => {});
            const analyser = context.createAnalyser();
            analyser.fftSize = 256;
            context.createMediaStreamSource(stream).connect(analyser);
            const samples = new Uint8Array(analyser.fftSize);
            const meter = { context, frameId: 0 };
            const sampleVoice = () => {
                if (!voiceMeters.has(meter)) return;
                analyser.getByteTimeDomainData(samples);
                let energy = 0;
                for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
                    const amplitude = (samples[sampleIndex] - 128) / 128;
                    energy += amplitude * amplitude;
                }
                avatar.classList.toggle('voice-active-glowing', !mutedCheck() &&
                    Math.sqrt(energy / samples.length) > 0.035);
                meter.frameId = requestAnimationFrame(sampleVoice);
            };
            voiceMeters.add(meter);
            sampleVoice();
        } catch (error) {
            avatar.classList.remove('voice-active-glowing');
        }
    }

    function createPeerConnection(callId, peer) {
        //notes Initialize the WebRTC peer connection here; its offer, answer, and ICE exchange use the encrypted Gun signaling room.
        const connection = new RTCPeerConnection({ iceServers });
        connection.addTransceiver('video', { direction: 'sendrecv' });
        remoteStream = new MediaStream();
        connection.onicecandidate = event => {
            if (!event.candidate || activeCall?.callId !== callId) return;
            if (!activeCall.signalReady) {
                pendingIceCandidates.push(serializeCandidate(event.candidate));
                return;
            }
            publishCallSignal('candidate', callId, {
                candidate: serializeCandidate(event.candidate)
            }).catch(error => {
                if (activeCall?.callId === callId) {
                    callAlert.textContent = `TERMINAL: Could not send a network candidate. ${error.message}`;
                }
            });
        };
        connection.ontrack = event => {
            const stream = event.streams[0];
            if (stream) {
                event.track.kind === 'audio' ? remoteAudio.srcObject = stream : remoteScreenPreview.srcObject = stream;
            } else if (!remoteStream.getTracks().some(track => track.id === event.track.id)) {
                remoteStream.addTrack(event.track);
                remoteAudio.srcObject = remoteStream;
                remoteScreenPreview.srcObject = remoteStream;
            }
            if (event.track.kind === 'audio') {
                monitorVoice(event.streams[0] || remoteStream, remoteCallPfp);
            } else {
                remoteScreenPreview.classList.remove('hidden');
                event.track.addEventListener('ended', () => remoteScreenPreview.classList.add('hidden'), { once: true });
            }
        };
        connection.onconnectionstatechange = () => {
            if (activeCall?.callId !== callId) return;
            if (connection.connectionState === 'connected') {
                activeCall.status = 'connected';
                callStatus.textContent = `Connected with @${peer}`;
                clearTimeout(callTimer);
                syncCallView();
            } else if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
                finishCall(true);
            }
        };
        return connection;
    }

    function addLocalTracks(connection) {
        localStream.getAudioTracks().forEach(track => connection.addTrack(track, localStream));
        videoSender = connection.getSenders().find(sender => sender.track?.kind === 'video') ||
            connection.getTransceivers().find(transceiver => transceiver.receiver.track.kind === 'video')?.sender;
    }

    async function flushIceCandidates() {
        while (pendingIceCandidates.length && activeCall?.signalReady) {
            const candidate = pendingIceCandidates.shift();
            try {
                await publishCallSignal('candidate', activeCall.callId, { candidate });
            } catch (error) {
                callAlert.textContent = `TERMINAL: Could not send a network candidate. ${error.message}`;
                break;
            }
        }
    }

    async function flushRemoteIceCandidates(callId) {
        const candidates = pendingRemoteIceCandidates.get(callId) || [];
        pendingRemoteIceCandidates.delete(callId);
        while (candidates.length && peerConnection?.remoteDescription) {
            const candidate = candidates.shift();
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    function showIncomingCall(packet) {
        incomingCallList.replaceChildren();
        incomingCalls.forEach(invitation => {
            const card = document.createElement('section');
            card.className = 'incoming-call-card';
            const details = document.createElement('div');
            details.className = 'incoming-call-details';
            const title = document.createElement('strong');
            title.textContent = `${invitation.caller} is calling`;
            const hint = document.createElement('span');
            hint.textContent = 'Incoming voice invitation';
            details.append(title, hint);
            const actions = document.createElement('div');
            actions.className = 'incoming-call-actions';
            const answer = document.createElement('button');
            answer.type = 'button';
            answer.className = 'incoming-answer-button';
            answer.textContent = 'Answer';
            answer.addEventListener('click', () => answerCall(invitation.callId));
            const decline = document.createElement('button');
            decline.type = 'button';
            decline.className = 'incoming-decline-button';
            decline.textContent = 'Decline';
            decline.addEventListener('click', () => declineCall(invitation.callId));
            actions.append(answer, decline);
            card.append(details, actions);
            incomingCallList.appendChild(card);
        });
        if (!packet && incomingCalls.size === 0) incomingCallList.replaceChildren();
    }

    function syncCallView() {
        const username = app.state.currentUser?.username;
        if (!username) {
            incomingCalls.clear();
            incomingCallList.replaceChildren();
            callPanel.classList.add('hidden');
            document.getElementById('mainChatContainer').classList.remove('has-active-call');
            return;
        }
        showIncomingCall();
        if (activeCall) {
            const database = app.readDatabase();
            const localProfile = app.getUserProfile(database, username);
            const peerProfile = app.getUserProfile(database, activeCall.peer);
            callPanel.classList.remove('hidden');
            document.getElementById('mainChatContainer').classList.add('has-active-call');
            callTitle.textContent = `Voice channel · @${activeCall.peer}`;
            if (activeCall.status === 'ringing') callStatus.textContent = `Ringing @${activeCall.peer}...`;
            else if (activeCall.status === 'preparing') callStatus.textContent = 'Requesting microphone and connecting...';
            else if (activeCall.status === 'connecting') callStatus.textContent = `Connecting to @${activeCall.peer}...`;
            else if (activeCall.status === 'connected') callStatus.textContent = `Connected with @${activeCall.peer}`;
            callStatus.classList.toggle('is-ringing', activeCall.status === 'ringing');
            localCallName.textContent = `${username} (you)`;
            remoteCallName.textContent = activeCall.peer;
            setCallAvatar(localCallPfp, localCallInitials, username, localProfile.profilePictureUrl);
            setCallAvatar(remoteCallPfp, remoteCallInitials, activeCall.peer, peerProfile.profilePictureUrl);
            document.getElementById('call-live-indicator').classList.toggle('is-ringing', activeCall.status === 'ringing');
        } else {
            callPanel.classList.add('hidden');
            document.getElementById('mainChatContainer').classList.remove('has-active-call');
            callStatus.classList.remove('is-ringing');
        }
        const database = app.readDatabase();
        const profile = app.getUserProfile(database, username);
        const selected = app.state.currentConversation;
        const canCall = selected && profile.friends.some(friend => friend.username === selected) &&
            !isBlocked(database, username, selected) &&
            (!activeCall || (activeCall.peer === selected && activeCall.role === 'caller' &&
                activeCall.status === 'ringing')) &&
            app.directMessageReady && activeGunPeer === selected && Boolean(activeGunKey);
        callButton.disabled = !canCall;
        callButton.textContent = activeCall ? (activeCall.status === 'ringing' ? 'Cancel Call' : 'In Call') : 'Call';
        muteButton.disabled = !localStream;
        cameraButton.disabled = !peerConnection;
        shareButton.disabled = !peerConnection;
    }

    async function startCall() {
        const caller = app.state.currentUser?.username;
        const recipient = app.state.currentConversation;
        if (!caller || !recipient) return;
        if (!app.directMessageReady || activeGunPeer !== recipient || !activeGunKey || !activeGunSignalingNode) {
            callAlert.textContent = 'TERMINAL: Unlock this friend’s encrypted chat before starting a call.';
            return;
        }
        const database = app.readDatabase();
        const callerProfile = app.getUserProfile(database, caller);
        if (isBlocked(database, caller, recipient) ||
            !callerProfile.friends.some(friend => friend.username === recipient)) {
            callAlert.textContent = 'TERMINAL: This contact cannot receive a call.';
            return;
        }

        const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        activeCall = { callId, peer: recipient, role: 'caller', status: 'preparing', signalReady: false };
        let signalingAttempted = false;
        pendingIceCandidates.length = 0;
        callAlert.textContent = '';
        syncCallView();
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable');
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            peerConnection = createPeerConnection(callId, recipient);
            addLocalTracks(peerConnection);
            monitorVoice(localStream, localCallPfp, () => isMuted);
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            activeCall.status = 'ringing';
            syncCallView();
            signalingAttempted = true;
            await publishCallSignal('offer', callId, {
                offer: serializeDescription(peerConnection.localDescription)
            });
            if (!activeCall || activeCall.callId !== callId) return;
            activeCall.signalReady = true;
            await flushIceCandidates();
            callTimer = setTimeout(() => {
                callAlert.textContent = `TERMINAL: @${recipient} did not answer.`;
                finishCall(true);
            }, 45000);
        } catch (error) {
            const message = error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError'
                ? 'Microphone access was blocked. Allow permission to place a call.'
                : error.message || 'The call could not be started.';
            callAlert.textContent = `TERMINAL: ${message}`;
            finishCall(signalingAttempted);
        }
    }

    async function answerCall(callId) {
        const invitation = incomingCalls.get(callId);
        const username = app.state.currentUser?.username;
        if (!invitation || !username || !activeGunKey ||
            activeGunPeer !== invitation.caller || !activeGunSignalingNode || activeCall) return;
        const database = app.readDatabase();
        const profile = app.getUserProfile(database, username);
        if (isBlocked(database, invitation.caller, username) ||
            !profile.friends.some(friend => friend.username === invitation.caller)) {
            declineCall(callId);
            return;
        }

        incomingCalls.delete(callId);
        activeCall = { callId, peer: invitation.caller, role: 'recipient', status: 'connecting', signalReady: false };
        pendingIceCandidates.length = 0;
        syncCallView();
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable');
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            peerConnection = createPeerConnection(callId, invitation.caller);
            addLocalTracks(peerConnection);
            monitorVoice(localStream, localCallPfp, () => isMuted);
            await peerConnection.setRemoteDescription(new RTCSessionDescription(invitation.offer));
            await flushRemoteIceCandidates(callId);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            await publishCallSignal('answer', callId, {
                answer: serializeDescription(peerConnection.localDescription)
            });
            if (!activeCall || activeCall.callId !== callId) return;
            activeCall.signalReady = true;
            await flushIceCandidates();
            callTimer = setTimeout(() => {
                callAlert.textContent = 'TERMINAL: The WebRTC connection timed out.';
                finishCall(true);
            }, 45000);
            syncCallView();
        } catch (error) {
            const message = error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError'
                ? 'Microphone access was blocked. Allow permission to answer.'
                : error.message || 'The call could not be answered.';
            callAlert.textContent = `TERMINAL: ${message}`;
            try {
                await publishCallSignal('decline', callId);
            } catch (signalError) {
                callAlert.textContent += ` ${signalError.message}`;
            }
            finishCall(false);
        }
    }

    function declineCall(callId) {
        publishCallSignal('decline', callId).catch(error => {
            callAlert.textContent = `TERMINAL: Could not decline the call. ${error.message}`;
        });
        incomingCalls.delete(callId);
        syncCallView();
    }

    function finishCall(notifyPeer) {
        const call = activeCall;
        clearTimeout(callTimer);
        callTimer = 0;
        if (notifyPeer && call) {
            const signalType = call.role === 'caller' && call.status === 'ringing' ? 'decline' : 'end';
            publishCallSignal(signalType, call.callId, {}, true).catch(error => {
                callAlert.textContent = `TERMINAL: Could not notify @${call.peer} that the call ended. ${error.message}`;
            });
        }
        activeCall = null;
        pendingIceCandidates.length = 0;
        pendingRemoteIceCandidates.clear();
        voiceMeters.forEach(meter => {
            cancelAnimationFrame(meter.frameId);
            meter.context.close().catch(() => {});
        });
        voiceMeters.clear();
        localCallPfp.classList.remove('voice-active-glowing');
        remoteCallPfp.classList.remove('voice-active-glowing');
        if (peerConnection) peerConnection.close();
        peerConnection = null;
        videoSender = null;
        if (localStream) localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        if (screenStream) screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
        if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
        remoteStream = null;
        sharePreview.srcObject = null;
        remoteScreenPreview.srcObject = null;
        remoteAudio.srcObject = null;
        sharePreview.classList.add('hidden');
        remoteScreenPreview.classList.add('hidden');
        shareButton.textContent = 'Share Screen';
        shareButton.setAttribute('aria-pressed', 'false');
        cameraButton.textContent = 'Camera';
        cameraButton.setAttribute('aria-pressed', 'false');
        muteButton.textContent = 'Mute';
        muteButton.setAttribute('aria-pressed', 'false');
        isMuted = false;
        syncCallView();
    }

    async function toggleScreenShare() {
        if (screenStream) {
            const tracks = screenStream.getTracks();
            for (const track of tracks) {
                if (track.kind === 'video' && videoSender) await videoSender.replaceTrack(null);
                track.stop();
            }
            screenStream = null;
            sharePreview.srcObject = null;
            sharePreview.classList.add('hidden');
            shareButton.textContent = 'Share Screen';
            shareButton.setAttribute('aria-pressed', 'false');
            return;
        }
        if (!activeCall || !peerConnection || !navigator.mediaDevices?.getDisplayMedia) {
            callAlert.textContent = 'TERMINAL: Start a connected call before sharing your screen.';
            return;
        }
        try {
            if (cameraStream) await stopCamera();
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const videoTrack = screenStream.getVideoTracks()[0];
            if (!videoTrack || !videoSender) throw new Error('Video sender unavailable');
            await videoSender.replaceTrack(videoTrack);
            sharePreview.srcObject = screenStream;
            sharePreview.classList.remove('hidden');
            shareButton.textContent = 'Stop Share';
            shareButton.setAttribute('aria-pressed', 'true');
            videoTrack.addEventListener('ended', () => toggleScreenShare(), { once: true });
        } catch (error) {
            callAlert.textContent = 'TERMINAL: Screen sharing was cancelled or could not start.';
            if (screenStream) screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
        }
    }

    async function stopCamera() {
        if (videoSender) await videoSender.replaceTrack(null);
        if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
        sharePreview.srcObject = null;
        sharePreview.classList.add('hidden');
        cameraButton.textContent = 'Camera';
        cameraButton.setAttribute('aria-pressed', 'false');
    }

    async function toggleCamera() {
        if (cameraStream) {
            await stopCamera();
            return;
        }
        if (!activeCall || !peerConnection || !videoSender || !navigator.mediaDevices?.getUserMedia) {
            callAlert.textContent = 'TERMINAL: Start a call before enabling your camera.';
            return;
        }
        if (screenStream) {
            callAlert.textContent = 'TERMINAL: Stop screen sharing before enabling your camera.';
            return;
        }
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
            const videoTrack = cameraStream.getVideoTracks()[0];
            if (!videoTrack) throw new Error('Camera track unavailable');
            await videoSender.replaceTrack(videoTrack);
            sharePreview.srcObject = cameraStream;
            sharePreview.classList.remove('hidden');
            cameraButton.textContent = 'Stop Camera';
            cameraButton.setAttribute('aria-pressed', 'true');
            videoTrack.addEventListener('ended', () => stopCamera(), { once: true });
        } catch (error) {
            callAlert.textContent = 'TERMINAL: Camera access was blocked or could not start.';
            if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
            cameraStream = null;
        }
    }

    callButton.addEventListener('click', () => {
        if (activeCall?.status === 'ringing') finishCall(true);
        else startCall();
    });
    document.getElementById('endCallButton').addEventListener('click', () => finishCall(true));
    muteButton.addEventListener('click', () => {
        if (!localStream) return;
        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(track => { track.enabled = !isMuted; });
        muteButton.textContent = isMuted ? 'Unmute' : 'Mute';
        muteButton.setAttribute('aria-pressed', String(isMuted));
        if (isMuted) localCallPfp.classList.remove('voice-active-glowing');
    });
    cameraButton.addEventListener('click', toggleCamera);
    shareButton.addEventListener('click', toggleScreenShare);

    const updateCallAvailability = () => syncCallView();
    const originalSelectConversation = app.selectConversation;
    app.selectConversation = function(...args) {
        const result = originalSelectConversation.apply(this, args);
        if (activeServer && !app.state.currentServer) closeActiveServer();
        updateCallAvailability();
        return result;
    };
    const originalLogout = app.logout;
    app.logout = async function(...args) {
        if (activeCall) finishCall(true);
        closeGunConversation();
        closeActiveServer();
        if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
        clearTimeout(voiceRecordingTimer);
        recordingStream?.getTracks().forEach(track => track.stop());
        recordingStream = null;
        app.directMessageCache = Object.create(null);
        app.directMessageReady = false;
        incomingCalls.clear();
        document.getElementById('profileModal').classList.add('hidden');
        const result = await originalLogout.apply(this, args);
        syncCallView();
        return result;
    };
    syncCallView();
    window.addEventListener('blocktalk:authenticated', () => {
        syncUserPreferences();
        renderServerList();
    });
});