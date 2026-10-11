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
    let socket = null;
    let registeredUser = null;
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
    let activeCall = null;
    const incomingCalls = new Map();
    let peerConnection = null;
    let videoSender = null;
    let remoteStream = null;
    let callTimer = 0;
    const voiceMeters = new Set();
    let screenStream = null;
    let cameraStream = null;
    let isMuted = false;
    const pendingIceCandidates = [];
    const pendingRemoteIceCandidates = new Map();
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const gunRelays = ['https://peer.ooo/gun'];

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
                typeof packet.message !== 'string' || packet.message.length > 24000 ||
                !Number.isFinite(packet.timestamp)) return;
            const messages = app.directMessageCache[peerId];
            if (messages.some(message => message.id === messageId) || pendingGunMessageIds.has(messageId)) return;
            pendingGunMessageIds.add(messageId);
            try {
                const content = await decryptDirectMessage(packet.message, key, packet.sender, packet.timestamp);
                if (generation !== gunObserverGeneration || activeGunPeer !== peerId) return;
                messages.push({
                    id: messageId,
                    sender: packet.sender,
                    content,
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
        //notes Replace the former socket.on incoming-call/answer/candidate listeners with this authenticated Gun signaling stream.
        signalingObserver.on((packet, signalId) => {
            receiveCallSignal(packet, signalId, generation, peerId, key)
                .catch(error => {
                    callAlert.textContent = `TERMINAL: Could not process call signaling. ${error.message}`;
                });
        });
        return { savedLocally, saveError };
    }

    async function sendDirectMessage(content) {
        const peerId = app.state.currentConversation;
        if (!content.trim() || !peerId) return;
        if (activeGunPeer !== peerId || !activeGunRoom || !activeGunKey) {
            document.getElementById('direct-message-key-status').textContent =
                'Unlock this conversation with its shared passphrase before sending.';
            return;
        }
        const text = content.trim();
        if (text.length > 2000) return;
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
            if (generation !== gunObserverGeneration || peerId !== app.state.currentConversation) return;
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('The Gun relays did not confirm the message.')), 15000);
                room.set(packet, acknowledgement => {
                    clearTimeout(timeout);
                    if (acknowledgement?.err) reject(new Error('The message could not be saved to the Gun relays.'));
                    else resolve();
                });
            });
            document.getElementById('messageInput').value = '';
            document.getElementById('direct-message-key-status').textContent =
                'Encrypted message submitted to Gun. Remote sync may take time; relays can see sender and timestamp, not text.';
        } catch (error) {
            document.getElementById('direct-message-key-status').textContent = error.message;
        }
    }

    app.directMessages = { openConversation: openGunConversation, sendMessage: sendDirectMessage };
    app.closeDirectMessage = closeGunConversation;
    app.directMessageReady = false;
    try {
        if (typeof window.Gun !== 'function') throw new Error('GunDB client script did not load.');
        gun = window.Gun({ peers: gunRelays, axe: false });
    } catch (error) {
        document.getElementById('direct-message-key-status').textContent = error.message;
    }

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
        document.getElementById('emailLabel').textContent = `${mode} Email`;
        document.getElementById('passwordLabel').textContent = `${mode} Password`;
        document.getElementById('confirmPasswordLabel').textContent = `${mode} Confirm Password`;
        document.getElementById('authUsername').placeholder = isSignUp ? 'Choose a username' : 'Enter your username';
        document.getElementById('auth-email').placeholder = isSignUp ? 'Enter your email' : 'Enter your account email';
        document.getElementById('authPassword').placeholder = isSignUp ? 'Create a password' : 'Enter your password';
        document.getElementById('authConfirmPassword').placeholder = 'Confirm password';
        document.getElementById('auth-email').required = isSignUp;
        document.getElementById('authConfirmPassword').required = isSignUp;
    }

    authToggle.addEventListener('click', () => {
        app.auth.toggleMode();
        updateAuthCopy();
    });
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
        settingsPfpUrl.value = profile.profilePictureUrl || '';
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

        const rawUrl = settingsPfpUrl.value.trim();
        let profilePictureUrl = '';
        if (rawUrl) {
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
            await app.apiRequest('/api/profile', {
                method: 'PATCH',
                body: JSON.stringify({ profilePictureUrl, theme })
            });
            await app.refreshAndRender();
            syncUserPreferences();
            settingsStatus.textContent = 'Settings saved.';
        } catch (error) {
            settingsStatus.textContent = error.message;
        }
    }

    settingsButton.addEventListener('click', openSettings);
    document.getElementById('settings-close').addEventListener('click', closeSettings);
    document.getElementById('settings-save').addEventListener('click', saveSettings);
    settingsTheme.addEventListener('change', () => applyTheme(settingsTheme.value));
    settingsModal.addEventListener('click', event => {
        if (event.target === settingsModal) closeSettings();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
    });

    const originalShowApp = app.showApp;
    app.showApp = function(...args) {
        const result = originalShowApp.apply(this, args);
        syncUserPreferences();
        ensureSignalingConnection();
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
            const url = new URL(imageUrl, window.location.href);
            if (!['http:', 'https:'].includes(url.protocol)) return;
            element.style.backgroundImage = `url("${url.href}")`;
            element.classList.add('has-image');
        } catch (error) {
            // Keep the initials visible for malformed avatar URLs.
        }
    }

    function ensureSignalingConnection() {
        const username = app.state.currentUser?.username;
        if (!username || typeof window.io !== 'function') return;
        if (!socket) {
            const signalingURL = window.BLOCKTALK_SIGNALING_URL || window.location.origin;
            socket = window.io(signalingURL, { autoConnect: true });
            bindSignalingEvents();
        }
        if (socket.connected && app.sessionToken) registerSocketUser(username);
    }

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

    function registerSocketUser(username) {
        if (!socket?.connected || !app.sessionToken || !username || registeredUser === username) return;
        socket.emit('register-user', { token: app.sessionToken }, response => {
            if (!response?.ok) {
                callAlert.textContent = 'TERMINAL: Signaling registration failed. Refresh and sign in again.';
                return;
            }
            registeredUser = username;
            syncCallView();
        });
    }

    function bindSignalingEvents() {
        socket.on('connect', () => {
            registeredUser = null;
            if (app.sessionToken) registerSocketUser(app.state.currentUser?.username);
        });
        socket.on('data-updated', async () => {
            if (!app.state.isAuthenticated) return;
            try {
                await app.refreshAndRender();
                if (activeGunPeer && app.state.currentConversation !== activeGunPeer) {
                    app.selectConversation(null);
                }
                syncUserPreferences();
            } catch (error) {
                callAlert.textContent = `TERMINAL: Could not refresh chat data. ${error.message}`;
            }
        });
        socket.on('disconnect', () => {
            registeredUser = null;
            syncCallView();
        });
        socket.on('connect_error', () => {
            callAlert.textContent = 'TERMINAL: Account service connection is unavailable.';
            syncCallView();
        });
    }

    function setCallAvatar(element, initialsElement, username, imageUrl) {
        initialsElement.textContent = initialsFor(username);
        element.style.backgroundImage = '';
        element.classList.remove('has-image');
        if (!imageUrl) return;
        try {
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
        updateCallAvailability();
        return result;
    };
    const originalLogout = app.logout;
    app.logout = async function(...args) {
        if (activeCall) finishCall(true);
        closeGunConversation();
        app.directMessageCache = Object.create(null);
        app.directMessageReady = false;
        incomingCalls.clear();
        if (socket) {
            socket.disconnect();
            socket = null;
            registeredUser = null;
        }
        const result = await originalLogout.apply(this, args);
        syncCallView();
        return result;
    };
    syncCallView();
    window.addEventListener('blocktalk:authenticated', () => {
        syncUserPreferences();
        ensureSignalingConnection();
    });
    if (app.state.isAuthenticated) ensureSignalingConnection();
});