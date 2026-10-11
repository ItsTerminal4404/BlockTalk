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
        document.getElementById('authConfirmPassword').required = isSignUp;
    }

    authToggle.addEventListener('click', () => {
        app.auth.toggleMode();
        updateAuthCopy();
    });
    updateAuthCopy();

    window.addEventListener('storage', event => {
        if (event.key !== app.databaseKey || !app.state.currentUser) return;

        const previousFriends = new Set(app.state.friends.map(friend => friend.username));
        const selectedConversation = app.state.currentConversation;
        app.loadUserData();
        syncUserPreferences();
        app.renderFriendsList();
        app.renderDMList();

        if (selectedConversation && !app.state.friends.some(friend => friend.username === selectedConversation)) {
            app.state.currentConversation = null;
        }

        const newlyAddedFriend = app.state.friends.find(friend => !previousFriends.has(friend.username));
        if (!selectedConversation && newlyAddedFriend) {
            app.selectConversation(newlyAddedFriend.username);
        } else {
            app.renderChatArea();
        }
        syncCallView();
    });
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

    function saveSettings() {
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

        const database = app.readDatabase();
        const profile = app.getUserProfile(database, app.state.currentUser.username);
        profile.email = app.state.currentUser.email || profile.email;
        profile.profilePictureUrl = profilePictureUrl;
        profile.theme = applyTheme(settingsTheme.value);
        app.writeDatabase(database);
        setProfilePicture(profilePictureUrl, app.state.currentUser.username);
        settingsStatus.textContent = 'Settings saved.';
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
        if (socket.connected) registerSocketUser(username);
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
        if (!socket?.connected || !username || registeredUser === username) return;
        socket.emit('register-user', { userId: username }, response => {
            if (!response?.ok) {
                callAlert.textContent = 'TERMINAL: Signaling registration failed. Refresh and sign in again.';
                return;
            }
            registeredUser = username;
            syncCallView();
        });
    }

    function emitSignal(event, payload) {
        return new Promise(resolve => {
            if (!socket?.connected) {
                resolve({ ok: false, error: 'Signaling server is disconnected' });
                return;
            }
            socket.emit(event, payload, response => resolve(response || { ok: false, error: 'No server response' }));
        });
    }

    function bindSignalingEvents() {
        socket.on('connect', () => {
            registeredUser = null;
            registerSocketUser(app.state.currentUser?.username);
        });
        socket.on('disconnect', () => {
            registeredUser = null;
            if (activeCall) {
                callAlert.textContent = 'TERMINAL: Signaling disconnected. The call has ended.';
                finishCall(false);
            }
            incomingCalls.clear();
            syncCallView();
        });
        socket.on('connect_error', () => {
            callAlert.textContent = 'TERMINAL: Signaling server is unavailable. Calls cannot start.';
            syncCallView();
        });
        socket.on('incoming-call', packet => {
            const caller = packet?.caller;
            const username = app.state.currentUser?.username;
            if (!username || typeof caller !== 'string' || !packet.offer ||
                incomingCalls.has(packet.callId) || activeCall) return;
            const database = app.readDatabase();
            const profile = app.getUserProfile(database, username);
            if (isBlocked(database, caller, username) ||
                !profile.friends.some(friend => friend.username === caller)) {
                socket.emit('decline-call', { callId: packet.callId });
                return;
            }
            incomingCalls.set(packet.callId, { callId: packet.callId, caller, offer: packet.offer });
            callAlert.textContent = '';
            syncCallView();
        });
        socket.on('call-accepted', async packet => {
            if (!activeCall || activeCall.callId !== packet?.callId || activeCall.role !== 'caller') return;
            try {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(packet.answer));
                await flushRemoteIceCandidates(packet.callId);
                if (activeCall.status !== 'connected') activeCall.status = 'connecting';
                syncCallView();
            } catch (error) {
                callAlert.textContent = 'TERMINAL: Could not complete the WebRTC handshake.';
                finishCall(true);
            }
        });
        socket.on('call-declined', packet => {
            if (activeCall?.callId !== packet?.callId) return;
            callAlert.textContent = `TERMINAL: @${activeCall.peer} declined the call.`;
            finishCall(false);
        });
        socket.on('call-ended', packet => {
            if (activeCall?.callId !== packet?.callId) return;
            callStatus.textContent = 'The other participant disconnected.';
            finishCall(false);
        });
        socket.on('call-unavailable', packet => {
            if (activeCall?.callId !== packet?.callId) return;
            callAlert.textContent = `TERMINAL: @${packet.userId} is not connected.`;
            finishCall(false);
        });
        socket.on('ice-candidate', async packet => {
            if (!packet?.candidate) return;
            const isCurrentCall = activeCall?.callId === packet.callId;
            if (!isCurrentCall && !incomingCalls.has(packet.callId)) return;
            if (!isCurrentCall || !peerConnection?.remoteDescription) {
                const candidates = pendingRemoteIceCandidates.get(packet.callId) || [];
                candidates.push(packet.candidate);
                pendingRemoteIceCandidates.set(packet.callId, candidates);
                return;
            }
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(packet.candidate));
            } catch (error) {
                callAlert.textContent = 'TERMINAL: A network route candidate could not be added.';
            }
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
        const connection = new RTCPeerConnection({ iceServers });
        connection.addTransceiver('video', { direction: 'sendrecv' });
        remoteStream = new MediaStream();
        connection.onicecandidate = event => {
            if (!event.candidate || activeCall?.callId !== callId) return;
            if (!activeCall.signalReady) {
                pendingIceCandidates.push(serializeCandidate(event.candidate));
                return;
            }
            emitSignal('ice-candidate', { callId, candidate: serializeCandidate(event.candidate) });
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
            const response = await emitSignal('ice-candidate', { callId: activeCall.callId, candidate });
            if (!response.ok) break;
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
            !isBlocked(database, username, selected) && !activeCall && socket?.connected && registeredUser === username;
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
        ensureSignalingConnection();
        if (!socket?.connected || registeredUser !== caller) {
            callAlert.textContent = 'TERMINAL: Connecting to the signaling server. Try again in a moment.';
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
            const response = await emitSignal('call-user', {
                to: recipient,
                callId,
                offer: serializeDescription(peerConnection.localDescription)
            });
            if (!response.ok) throw new Error(response.error || 'Call could not be sent');
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
            finishCall(false);
        }
    }

    async function answerCall(callId) {
        const invitation = incomingCalls.get(callId);
        const username = app.state.currentUser?.username;
        if (!invitation || !username || !socket?.connected || activeCall) return;
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
            const response = await emitSignal('accept-call', {
                callId,
                answer: serializeDescription(peerConnection.localDescription)
            });
            if (!response.ok) throw new Error(response.error || 'Call could not be accepted');
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
            socket.emit('decline-call', { callId });
            finishCall(false);
        }
    }

    function declineCall(callId) {
        if (socket?.connected) socket.emit('decline-call', { callId });
        incomingCalls.delete(callId);
        syncCallView();
    }

    function finishCall(notifyPeer) {
        const call = activeCall;
        clearTimeout(callTimer);
        callTimer = 0;
        if (notifyPeer && call && socket?.connected) socket.emit('end-call', { callId: call.callId });
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
    app.logout = function(...args) {
        if (activeCall) finishCall(true);
        incomingCalls.clear();
        if (socket) {
            socket.disconnect();
            socket = null;
            registeredUser = null;
        }
        const result = originalLogout.apply(this, args);
        syncCallView();
        return result;
    };
    syncCallView();
    if (app.state.isAuthenticated) ensureSignalingConnection();
});