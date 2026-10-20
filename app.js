document.addEventListener('DOMContentLoaded', () => {
    const app = window.BlockTalk;
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
    const seenServerVoiceSignalIds = new Set();
    const MAX_DIRECT_PACKET_LENGTH = 900000;
    const MAX_RENDERED_SERVER_MESSAGES = 500;
    const MAX_IMAGE_DATA_URL_LENGTH = 500000;
    const MAX_VOICE_DATA_URL_LENGTH = 260000;
    const OWNER_USERNAME = 'itsterminal4404';
    const FOUNDER_BADGE_CUTOFF = Date.UTC(2027, 0, 1);
    const assetUrl = asset => new URL(asset, document.baseURI).toString();
    const messageSentAudio = new Audio(assetUrl('BlockTalk_Message_Sent.wav'));
    const messageReceivedAudio = new Audio(assetUrl('Message_Recived_BlockTalk.wav'));
    const callRingtoneAudio = new Audio(assetUrl('BlockTalk Ringtone.mp3'));
    const AUDIO_PREFERENCES_KEY = 'blocktalk:audio-preferences-v1';
    const defaultAudioPreferences = {
        sentMessageSound: true,
        receivedMessageSound: true,
        callRingtone: true,
        ringtoneVolume: 0.7
    };
    let audioPreferences = { ...defaultAudioPreferences };
    let ringtoneRequested = false;
    [messageSentAudio, messageReceivedAudio, callRingtoneAudio].forEach(audio => {
        audio.preload = 'auto';
    });

    async function writeModerationAction(action) {
        const status = document.getElementById('moderationStatus');
        const banButton = document.getElementById('banUserButton');
        const unbanButton = document.getElementById('unbanUserButton');
        if (app.state.currentUser?.username !== OWNER_USERNAME || !badgeTarget ||
            badgeTarget.username === OWNER_USERNAME) {
            status.textContent = `Only ${OWNER_USERNAME} can moderate other accounts.`;
            return;
        }
        banButton.disabled = true;
        unbanButton.disabled = true;
        try {
            const pair = app.gunUser?._?.sea;
            const ownerPub = await app.lookupUserPub(OWNER_USERNAME);
            if (!pair?.pub || pair.pub !== ownerPub) throw new Error('The owner account key could not be verified.');
            const duration = document.getElementById('moderationDuration').value;
            const expiresAt = action === 'ban'
                ? (duration === 'permanent' ? 0 : Date.now() + Number(duration))
                : 0;
            const payload = {
                action,
                target: badgeTarget.username,
                targetPub: badgeTarget.publicKey,
                issuer: OWNER_USERNAME,
                issuerPub: ownerPub,
                issuedAt: Date.now(),
                expiresAt
            };
            const signature = await app.getGunSea().sign(JSON.stringify(payload), pair);
            if (typeof signature !== 'string') throw new Error('The moderation action could not be signed.');
            await app.writeGunNode(
                gun.get('blocktalk-v1').get('moderation').get('bans').get(badgeTarget.publicKey),
                { payload, signature }
            );
            status.textContent = action === 'ban'
                ? (expiresAt ? `@${badgeTarget.username} is banned until ${new Date(expiresAt).toLocaleString()}.` : `@${badgeTarget.username} is permanently banned.`)
                : `@${badgeTarget.username} is unbanned.`;
        } catch (error) {
            status.textContent = `Could not update moderation: ${error.message}`;
        } finally {
            banButton.disabled = !badgeTarget || badgeTarget.username === OWNER_USERNAME;
            unbanButton.disabled = !badgeTarget || badgeTarget.username === OWNER_USERNAME;
        }
    }
    document.getElementById('banUserButton').addEventListener('click', () => writeModerationAction('ban'));
    document.getElementById('unbanUserButton').addEventListener('click', () => writeModerationAction('unban'));

    function initializeGames() {
        const board = document.getElementById('gameBoard');
        const choices = [...document.querySelectorAll('.game-choice')];
        if (!board || !choices.length) return;
        let activeGame = 'pop';
        let tapTimer = 0;
        let tapInterval = 0;
        let memoryTimeout = 0;

        const clearGameTimers = () => {
            clearTimeout(tapTimer);
            clearInterval(tapInterval);
            clearTimeout(memoryTimeout);
        };

        const frame = (title, help, score, content) => `
            <div class="game-board-header">
                <div>
                    <h2 class="game-board-title">${title}</h2>
                    <p class="game-board-help">${help}</p>
                </div>
                <span class="game-score">${score}</span>
            </div>
            ${content}
        `;

        const renderPop = () => {
            let popped = 0;
            const total = 24;
            board.innerHTML = frame(
                'Pop Its',
                'Pop every bubble before your call gets interesting again.',
                '<span id="popScore">0</span> / 24',
                `<div class="pop-grid">${Array.from({ length: total }, (_, index) =>
                    `<button type="button" class="pop-bubble" data-pop-index="${index}" aria-label="Pop bubble ${index + 1}"></button>`
                ).join('')}</div>
                <p class="game-status" id="popStatus">Ready when you are.</p>
                <button type="button" class="game-action" id="popReset">Reset board</button>`
            );
            board.querySelectorAll('.pop-bubble').forEach(bubble => {
                bubble.addEventListener('click', () => {
                    if (bubble.classList.contains('popped')) return;
                    bubble.classList.add('popped');
                    popped += 1;
                    board.querySelector('#popScore').textContent = popped;
                    if (popped === total) board.querySelector('#popStatus').textContent = 'Board cleared. Nice and satisfying.';
                });
            });
            board.querySelector('#popReset').addEventListener('click', renderPop);
        };

        const renderSort = () => {
            const tubes = [
                ['red', 'yellow', 'green'],
                ['purple', 'red', 'yellow'],
                ['green', 'purple', 'red'],
                ['yellow', 'green', 'purple'],
                []
            ];
            let selected = -1;
            const colors = { red: 'red', yellow: 'yellow', green: 'green', purple: 'purple' };
            const isSolved = () => tubes.every(tube => tube.length === 0 || (tube.length === 3 && tube.every(color => color === tube[0])));
            const render = () => {
                board.innerHTML = frame(
                    'Color Ring Sort',
                    'Tap a tube, then tap another tube to move its top ring. Match three of each color.',
                    '5 tubes',
                    `<div class="sort-board">${tubes.map((tube, index) => `
                        <button type="button" class="sort-tube${selected === index ? ' selected' : ''}" data-tube="${index}" aria-label="Tube ${index + 1}">
                            ${tube.map(color => `<span class="sort-ring ${colors[color]}"></span>`).join('')}
                        </button>`).join('')}</div>
                        <p class="game-status" id="sortStatus">${isSolved() ? 'Sorted! Try a new mix.' : 'Choose a source tube.'}</p>
                        <button type="button" class="game-action" id="sortReset">New mix</button>`
                );
                board.querySelectorAll('.sort-tube').forEach(tube => tube.addEventListener('click', () => {
                    const destination = Number(tube.dataset.tube);
                    if (selected === -1) {
                        if (tubes[destination].length) selected = destination;
                    } else if (selected === destination) {
                        selected = -1;
                    } else {
                        const source = tubes[selected];
                        const target = tubes[destination];
                        const color = source[source.length - 1];
                        if (color && target.length < 3 && (!target.length || target[target.length - 1] === color)) {
                            target.push(source.pop());
                        }

                        selected = -1;
                    }
                    render();
                }));
                board.querySelector('#sortReset').addEventListener('click', renderSort);
            };
            render();
        };

        const renderTap = () => {
            let score = 0;
            let remaining = 10;
            let running = false;
            board.innerHTML = frame(
                'Quick Tap',
                'Start the round, then tap the button as many times as possible in ten seconds.',
                '<span id="tapScore">0</span> taps',
                `<button type="button" class="tap-target" id="tapTarget">Start</button>
                <p class="game-status" id="tapStatus">Ten seconds on the clock.</p>`
            );
            const target = board.querySelector('#tapTarget');
            const status = board.querySelector('#tapStatus');
            const scoreElement = board.querySelector('#tapScore');
            target.addEventListener('click', () => {
                if (!running) {
                    running = true;
                    target.textContent = 'Tap!';
                    tapInterval = window.setInterval(() => {
                        remaining -= 1;
                        status.textContent = `${remaining}s remaining`;
                        if (remaining <= 0) {
                            clearGameTimers();
                            running = false;
                            target.disabled = true;
                            target.textContent = 'Done';
                            status.textContent = `Time! You got ${score} taps.`;
                        }
                    }, 1000);
                    return;
                }
                score += 1;
                scoreElement.textContent = score;
            });
        };

        const renderMemory = () => {
            const symbols = ['★', '★', '☀', '☀', '♣', '♣', '◆', '◆', '♥', '♥', '♫', '♫']
                .sort(() => Math.random() - 0.5);
            let flipped = [];
            let matched = 0;
            let locked = false;
            board.innerHTML = frame(
                'Memory Match',
                'Reveal two cards at a time and find all six pairs.',
                '<span id="memoryScore">0</span> / 6 pairs',
                `<div class="memory-grid">${symbols.map((_, index) =>
                    `<button type="button" class="memory-card" data-memory-index="${index}" aria-label="Hidden card ${index + 1}">?</button>`
                ).join('')}</div>
                <p class="game-status" id="memoryStatus">Find a matching pair.</p>
                <button type="button" class="game-action" id="memoryReset">Shuffle again</button>`
            );
            const cards = [...board.querySelectorAll('.memory-card')];
            cards.forEach((card, index) => card.addEventListener('click', () => {
                if (locked || flipped.includes(index) || card.classList.contains('matched')) return;
                card.textContent = symbols[index];
                card.classList.add('flipped');
                flipped.push(index);
                if (flipped.length < 2) return;
                locked = true;
                const [first, second] = flipped;
                if (symbols[first] === symbols[second]) {
                    cards[first].classList.add('matched');
                    cards[second].classList.add('matched');
                    matched += 1;
                    board.querySelector('#memoryScore').textContent = matched;
                    flipped = [];
                    locked = false;
                    if (matched === 6) board.querySelector('#memoryStatus').textContent = 'All matched. Great recall.';
                } else {
                    memoryTimeout = window.setTimeout(() => {
                        cards[first].textContent = '?';
                        cards[second].textContent = '?';
                        cards[first].classList.remove('flipped');
                        cards[second].classList.remove('flipped');
                        flipped = [];
                        locked = false;
                    }, 650);
                }
            }));
            board.querySelector('#memoryReset').addEventListener('click', renderMemory);
        };

        const renderHigher = () => {
            let current = Math.floor(Math.random() * 13) + 1;
            let streak = 0;
            const nextCard = direction => {
                const next = Math.floor(Math.random() * 13) + 1;
                const correct = direction === 'higher' ? next >= current : next <= current;
                streak = correct ? streak + 1 : 0;
                current = next;
                render();
                board.querySelector('#higherStatus').textContent = correct
                    ? `Correct! Streak: ${streak}.`
                    : `Not quite. Your streak reset to zero.`;
            };
            const render = () => {
                board.innerHTML = frame(
                    'Higher or Lower',
                    'Will the next card be higher or lower? Equal cards count as a win.',
                    `streak: <span id="higherScore">${streak}</span>`,
                    `<div class="higher-card">Current number<span class="higher-number">${current}</span></div>
                    <div class="higher-actions">
                        <button type="button" class="game-action" data-higher="higher">Higher</button>
                        <button type="button" class="game-action" data-higher="lower">Lower</button>
                    </div>
                    <p class="game-status" id="higherStatus">Make your call.</p>`
                );
                board.querySelectorAll('[data-higher]').forEach(button =>
                    button.addEventListener('click', () => nextCard(button.dataset.higher))
                );
            };
            render();
        };

        const renderTic = () => {
            let cells = Array(9).fill('');
            let player = 'X';
            let winner = '';
            const wins = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
            const render = () => {
                winner = wins.find(line => line.every(index => cells[index] === player)) ? player : winner;
                const winningLine = wins.find(line => line.every(index => cells[index] && cells[index] === cells[line[0]]));
                const status = winner ? `Player ${winner} wins!` : cells.every(Boolean) ? 'Draw game.' : `Player ${player}'s turn`;
                board.innerHTML = frame('Tic-Tac-Toe', 'Take turns placing your mark. First to get three in a row wins.', '2 players',
                    `<div class="tic-grid">${cells.map((cell, index) => `<button type="button" class="tic-cell ${cell.toLowerCase()}" data-tic="${index}">${cell}</button>`).join('')}</div>
                    <p class="game-status">${status}</p><button type="button" class="game-action" id="ticReset">New game</button>`);
                board.querySelectorAll('[data-tic]').forEach(cell => cell.addEventListener('click', () => {
                    const index = Number(cell.dataset.tic);
                    if (cells[index] || winner || cells.every(Boolean)) return;
                    cells[index] = player;
                    const hasWon = wins.some(line => line.every(position => cells[position] === player));
                    if (hasWon) winner = player;
                    else player = player === 'X' ? 'O' : 'X';
                    render();
                }));
                board.querySelector('#ticReset').addEventListener('click', renderTic);
            };
            render();
        };

        const renderConnect = () => {
            let grid = Array(42).fill('');
            let player = 'R';
            let winner = '';
            const getWinner = () => {
                for (let row = 0; row < 6; row++) for (let column = 0; column < 7; column++) {
                    const index = row * 7 + column;
                    if (!grid[index]) continue;
                    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
                        if ([1, 2, 3].every(step => grid[(row + dr * step) * 7 + column + dc * step] === grid[index])) return grid[index];
                    }
                }
                return '';
            };
            const render = () => {
                const status = winner ? `Player ${winner === 'R' ? 'Red' : 'Gold'} wins!` : grid.every(Boolean) ? 'Draw game.' : `Player ${player === 'R' ? 'Red' : 'Gold'}'s turn`;
                board.innerHTML = frame('Connect Four', 'Drop your pieces into a column. Connect four before your opponent.', '2 players',
                    `<div class="connect-grid">${grid.map((cell, index) => `<button type="button" class="connect-cell ${cell.toLowerCase()}" data-connect="${index}" aria-label="Column ${index % 7 + 1}">${cell ? '●' : ''}</button>`).join('')}</div>
                    <p class="game-status">${status}</p><button type="button" class="game-action" id="connectReset">New game</button>`);
                board.querySelectorAll('[data-connect]').forEach(cell => cell.addEventListener('click', () => {
                    const column = Number(cell.dataset.connect) % 7;
                    if (winner) return;
                    for (let row = 5; row >= 0; row--) {
                        const index = row * 7 + column;
                        if (!grid[index]) {
                            grid[index] = player;
                            winner = getWinner();
                            if (!winner) player = player === 'R' ? 'G' : 'R';
                            render();
                            return;
                        }
                    }
                }));
                board.querySelector('#connectReset').addEventListener('click', renderConnect);
            };
            render();
        };

        const renderReaction = () => {
            let round = 0;
            let scores = [0, 0];
            let ready = false;
            let prompt = false;
            const render = () => {
                board.innerHTML = frame('Reaction Duel', 'Players take turns pressing ready. When GO appears, tap your button first.', `${scores[0]} — ${scores[1]}`,
                    `<div class="reaction-panel"><p class="reaction-message" id="reactionMessage">${prompt ? 'GO!' : ready ? 'Get ready…' : 'Player 1 starts'}</p>
                    <div class="reaction-actions"><button type="button" class="game-action" data-reaction="0">Player 1</button><button type="button" class="game-action" data-reaction="1">Player 2</button></div></div>
                    <p class="game-status">${round ? `Round ${round}` : 'Press either button to begin.'}</p><button type="button" class="game-action" id="reactionReset">Reset score</button>`);
                board.querySelectorAll('[data-reaction]').forEach(button => button.addEventListener('click', () => {
                    const index = Number(button.dataset.reaction);
                    if (prompt) {
                        scores[index] += 1;
                        round += 1;
                        ready = false;
                        prompt = false;
                        clearGameTimers();
                        render();
                    } else if (!ready) {
                        ready = true;
                        render();
                        tapTimer = window.setTimeout(() => {
                            prompt = true;
                            render();
                        }, 1000 + Math.random() * 2500);
                    }
                }));
                board.querySelector('#reactionReset').addEventListener('click', renderReaction);
            };
            render();
        };

        const renderDots = () => {
            let edges = new Set();
            let claimedBoxes = new Set();
            let scores = [0, 0];
            let player = 0;
            const edgeKey = (row, column, horizontal) => `${row}-${column}-${horizontal ? 'h' : 'v'}`;
            const boxes = [[0, 0], [0, 1], [1, 0], [1, 1]];
            const isBoxClaimed = (row, column) => [
                edgeKey(row, column, true), edgeKey(row + 1, column, true),
                edgeKey(row, column, false), edgeKey(row, column + 1, false)
            ].every(edge => edges.has(edge));
            const render = () => {
                const claimed = claimedBoxes.size;
                board.innerHTML = frame('Dots & Boxes', 'Take turns drawing an edge. Completing a box earns a point and another turn.', `${scores[0]} — ${scores[1]}`,
                    `<div class="dots-board">${Array.from({ length: 9 }, (_, index) => `<span class="dot-point">${index % 3 === 0 || index % 3 === 1 || index % 3 === 2 ? '•' : ''}</span>`).join('')}
                    ${[0, 1, 2].map(row => [0, 1].map(column => `<button type="button" class="dot-edge dot-h ${edges.has(edgeKey(row, column, true)) ? 'used' : ''}" style="--row:${row};--column:${column}" data-dot="${edgeKey(row, column, true)}"></button>`).join('')).join('')}
                    ${[0, 1].map(row => [0, 1, 2].map(column => `<button type="button" class="dot-edge dot-v ${edges.has(edgeKey(row, column, false)) ? 'used' : ''}" style="--row:${row};--column:${column}" data-dot="${edgeKey(row, column, false)}"></button>`).join('')).join('')}
                    </div><p class="game-status">${claimed === 4 ? `Player ${scores[0] > scores[1] ? 1 : 2} wins!` : `Player ${player + 1}'s turn`}</p>
                    <button type="button" class="game-action" id="dotsReset">New game</button>`);
                board.querySelectorAll('[data-dot]').forEach(button => button.addEventListener('click', () => {
                    if (edges.has(button.dataset.dot) || claimed === 4) return;
                    edges.add(button.dataset.dot);
                    const completedNow = boxes
                        .map(([row, column]) => [row, column, `${row}-${column}`])
                        .filter(([row, column, key]) => isBoxClaimed(row, column) && !claimedBoxes.has(key));
                    completedNow.forEach(([, , key]) => claimedBoxes.add(key));
                    const completed = completedNow.length > 0;
                    if (completed) scores[player] += 1;
                    else player = player ? 0 : 1;
                    render();
                }));
                board.querySelector('#dotsReset').addEventListener('click', renderDots);
            };
            render();
        };

        const renderNim = () => {
            let tokens = 15;
            let player = 0;
            const take = amount => {
                tokens -= amount;
                if (!tokens) {
                    board.querySelector('#nimStatus').textContent = `Player ${player + 1} wins!`;
                    board.querySelectorAll('[data-nim]').forEach(button => { button.disabled = true; });
                    return;
                }
                player = player ? 0 : 1;
                render();
            };
            const render = () => {
                board.innerHTML = frame('Nim Duel', 'Take one to three tokens. Whoever takes the last token wins.', `${tokens} tokens`,
                    `<div class="nim-tokens">${Array.from({ length: tokens }, () => '<span>●</span>').join('')}</div>
                    <div class="nim-actions">${[1, 2, 3].map(amount => `<button type="button" class="game-action" data-nim="${amount}" ${amount > tokens ? 'disabled' : ''}>Take ${amount}</button>`).join('')}</div>
                    <p class="game-status" id="nimStatus">Player ${player + 1}'s turn.</p><button type="button" class="game-action" id="nimReset">New game</button>`);
                board.querySelectorAll('[data-nim]').forEach(button => button.addEventListener('click', () => take(Number(button.dataset.nim))));
                board.querySelector('#nimReset').addEventListener('click', renderNim);
            };
            render();
        };

        const renderGame = game => {
            clearGameTimers();
            activeGame = game;
            choices.forEach(choice => choice.classList.toggle('active', choice.dataset.game === game));
            ({ pop: renderPop, sort: renderSort, tap: renderTap, memory: renderMemory, higher: renderHigher,
                tic: renderTic, connect: renderConnect, reaction: renderReaction, dots: renderDots, nim: renderNim }[game] || renderPop)();
        };

        choices.forEach(choice => choice.addEventListener('click', () => renderGame(choice.dataset.game)));
        renderGame(activeGame);
    }

    const OWNER_BADGE_CATALOG = [
        { id: 'welcome-wagon', name: 'Welcome Wagon', category: 'Community & Status' },
        { id: 'community-pillar', name: 'Community Pillar', category: 'Community & Status' },
        { id: 'server-regular', name: 'Server Regular', category: 'Community & Status' },
        { id: 'bridge-builder', name: 'Bridge Builder', category: 'Community & Status' },
        { id: 'good-neighbor', name: 'Good Neighbor', category: 'Community & Status' },
        { id: 'daily-spark', name: 'Daily Spark', category: 'Activity & Engagement' },
        { id: 'conversation-starter', name: 'Conversation Starter', category: 'Activity & Engagement' },
        { id: 'streak-keeper', name: 'Streak Keeper', category: 'Activity & Engagement' },
        { id: 'helpful-hand', name: 'Helpful Hand', category: 'Activity & Engagement' },
        { id: 'marathon-chatter', name: 'Marathon Chatter', category: 'Activity & Engagement' },
        { id: 'soundcheck', name: 'Soundcheck', category: 'Music & Audio' },
        { id: 'voice-vibes', name: 'Voice Vibes', category: 'Music & Audio' },
        { id: 'mixtape-maker', name: 'Mixtape Maker', category: 'Music & Audio' },
        { id: 'audio-aficionado', name: 'Audio Aficionado', category: 'Music & Audio' },
        { id: 'high-score', name: 'High Score', category: 'Gaming & Mini-Games' },
        { id: 'gg-champion', name: 'GG Champion', category: 'Gaming & Mini-Games' },
        { id: 'puzzle-solver', name: 'Puzzle Solver', category: 'Gaming & Mini-Games' },
        { id: 'streak-winner', name: 'Streak Winner', category: 'Gaming & Mini-Games' },
        { id: 'party-player', name: 'Party Player', category: 'Gaming & Mini-Games' },
        { id: 'bug-spotter', name: 'Bug Spotter', category: 'Technical & Support' },
        { id: 'fix-it-friend', name: 'Fix-It Friend', category: 'Technical & Support' },
        { id: 'code-whisperer', name: 'Code Whisperer', category: 'Technical & Support' },
        { id: 'test-pilot', name: 'Test Pilot', category: 'Technical & Support' },
        { id: 'knowledge-base', name: 'Knowledge Base', category: 'Technical & Support' },
        { id: 'meme-machine', name: 'Meme Machine', category: 'Fun & Social Quirks' },
        { id: 'emoji-enthusiast', name: 'Emoji Enthusiast', category: 'Fun & Social Quirks' },
        { id: 'night-owl', name: 'Night Owl', category: 'Fun & Social Quirks' },
        { id: 'early-bird', name: 'Early Bird', category: 'Fun & Social Quirks' },
        { id: 'chaos-coordinator', name: 'Chaos Coordinator', category: 'Fun & Social Quirks' },
        { id: 'good-sport', name: 'Good Sport', category: 'Fun & Social Quirks' }
    ];
    const OWNER_TITLE_CATALOG = [
        { id: 'server-founder', name: 'Server Founder', category: 'Administration & Authority' },
        { id: 'community-guardian', name: 'Community Guardian', category: 'Administration & Authority' },
        { id: 'trusted-moderator', name: 'Trusted Moderator', category: 'Administration & Authority' },
        { id: 'event-organizer', name: 'Event Organizer', category: 'Administration & Authority' },
        { id: 'support-lead', name: 'Support Lead', category: 'Administration & Authority' },
        { id: 'owners-choice', name: "Owner's Choice", category: 'Administration & Authority' },
        { id: 'tactician', name: 'Tactician', category: 'Skill & Strategy' },
        { id: 'strategist', name: 'Strategist', category: 'Skill & Strategy' },
        { id: 'clutch-player', name: 'Clutch Player', category: 'Skill & Strategy' },
        { id: 'quick-thinker', name: 'Quick Thinker', category: 'Skill & Strategy' },
        { id: 'puzzle-master', name: 'Puzzle Master', category: 'Skill & Strategy' },
        { id: 'mvp', name: 'MVP', category: 'Skill & Strategy' },
        { id: 'friendly-face', name: 'Friendly Face', category: 'Social & Persona' },
        { id: 'conversation-starter', name: 'Conversation Starter', category: 'Social & Persona' },
        { id: 'welcoming-voice', name: 'Welcoming Voice', category: 'Social & Persona' },
        { id: 'community-guide', name: 'Community Guide', category: 'Social & Persona' },
        { id: 'good-listener', name: 'Good Listener', category: 'Social & Persona' },
        { id: 'hype-person', name: 'Hype Person', category: 'Social & Persona' },
        { id: 'peacekeeper', name: 'Peacekeeper', category: 'Social & Persona' },
        { id: 'certified-goofball', name: 'Certified Goofball', category: 'Fun & Playful Statuses' },
        { id: 'night-owl', name: 'Night Owl', category: 'Fun & Playful Statuses' },
        { id: 'emoji-wizard', name: 'Emoji Wizard', category: 'Fun & Playful Statuses' },
        { id: 'chaos-gremlin', name: 'Chaos Gremlin', category: 'Fun & Playful Statuses' },
        { id: 'snack-break', name: 'Snack Break', category: 'Fun & Playful Statuses' },
        { id: 'afk-legend', name: 'AFK Legend', category: 'Fun & Playful Statuses' },
        { id: 'main-character', name: 'Main Character', category: 'Fun & Playful Statuses' }
    ];
    const SPECIAL_OWNER_BADGES = [
        { id: 'met-owner', name: 'Met the Owner', style: 'met-owner-badge' },
        { id: 'owner-friend', name: "Owner's Friend", style: 'friend-badge' },
        { id: 'beta-tester', name: 'Beta Tester', style: 'beta-tester-badge' }
    ];
    const ownerAwardCache = new Map();
    const renderedTitleCache = new Map();
    const RENDERED_TITLE_CACHE_TTL = 60000;
    let chatTitleRenderGeneration = 0;
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
    let activeServerVoiceObserver = null;
    let activeServerVoiceSignalObserver = null;
    let activeServerVoiceState = null;
    let serverVoiceExpiryTimer = 0;
    let serverCall = null;
    let serverCallHeartbeat = 0;
    let serverCallJoinTimer = 0;
    let recordingStream = null;
    let voiceRecorder = null;
    let voiceChunks = [];
    let voiceRecordingTimer = 0;
    let voiceRecordingTarget = null;
    let pendingProfilePictureDataUrl = '';
    let profilePictureProcessing = false;
    let profilePictureSelectionGeneration = 0;
    let profilePictureCropState = null;
    let profileModalGeneration = 0;
    let badgeTarget = null;
    let isMuted = false;
    const pendingIceCandidates = [];
    const pendingRemoteIceCandidates = new Map();
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const gunRelays = [
        'wss://relay.peer.ooo/gun',
        'https://relay.peer.ooo/gun',
        'https://peer.wallie.io/gun'
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

    function playMessageSound(audio, description, enabled) {
        if (!enabled) return;
        audio.currentTime = 0;
        audio.play().catch(error => {
            console.warn(`BlockTalk could not play the ${description} sound:`, error);
        });
    }

    function startCallRingtone() {
        if (!audioPreferences.callRingtone || ringtoneRequested) return;
        ringtoneRequested = true;
        callRingtoneAudio.currentTime = 0;
        callRingtoneAudio.loop = true;
        callRingtoneAudio.volume = audioPreferences.ringtoneVolume;
        callRingtoneAudio.play().catch(error => {
            ringtoneRequested = false;
            console.warn('BlockTalk could not play the call ringtone:', error);
        });
    }

    function stopCallRingtone() {
        ringtoneRequested = false;
        callRingtoneAudio.pause();
        callRingtoneAudio.currentTime = 0;
    }

    function loadAudioPreferences() {
        let stored;
        try {
            stored = window.localStorage.getItem(AUDIO_PREFERENCES_KEY);
        } catch (error) {
            console.warn('Could not access saved BlockTalk audio preferences:', error);
            return { ...defaultAudioPreferences };
        }
        if (stored === null) return { ...defaultAudioPreferences };
        try {
            const parsed = JSON.parse(stored);
            if (typeof parsed.sentMessageSound !== 'boolean' ||
                typeof parsed.receivedMessageSound !== 'boolean' ||
                typeof parsed.callRingtone !== 'boolean' ||
                !Number.isFinite(parsed.ringtoneVolume) ||
                parsed.ringtoneVolume < 0 || parsed.ringtoneVolume > 1) {
                throw new Error('Saved audio preferences have invalid values.');
            }
            return {
                sentMessageSound: parsed.sentMessageSound,
                receivedMessageSound: parsed.receivedMessageSound,
                callRingtone: parsed.callRingtone,
                ringtoneVolume: parsed.ringtoneVolume
            };
        } catch (error) {
            console.warn('Could not load BlockTalk audio preferences:', error);
            return { ...defaultAudioPreferences };
        }
    }

    function syncAudioPreferenceControls() {
        document.getElementById('settings-sent-message-sound').checked = audioPreferences.sentMessageSound;
        document.getElementById('settings-received-message-sound').checked = audioPreferences.receivedMessageSound;
        document.getElementById('settings-call-ringtone').checked = audioPreferences.callRingtone;
        const volumeControl = document.getElementById('settings-ringtone-volume');
        volumeControl.value = String(Math.round(audioPreferences.ringtoneVolume * 100));
        document.getElementById('settings-ringtone-volume-value').textContent = `${volumeControl.value}%`;
    }

    function saveAudioPreferences() {
        const volume = Number(document.getElementById('settings-ringtone-volume').value);
        if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
            throw new Error('Choose a ringtone volume from 0% to 100%.');
        }
        const nextPreferences = {
            sentMessageSound: document.getElementById('settings-sent-message-sound').checked,
            receivedMessageSound: document.getElementById('settings-received-message-sound').checked,
            callRingtone: document.getElementById('settings-call-ringtone').checked,
            ringtoneVolume: volume / 100
        };
        window.localStorage.setItem(AUDIO_PREFERENCES_KEY, JSON.stringify(nextPreferences));
        audioPreferences = nextPreferences;
        callRingtoneAudio.volume = audioPreferences.ringtoneVolume;
        if (!audioPreferences.callRingtone) stopCallRingtone();
        syncCallView();
    }

    audioPreferences = loadAudioPreferences();
    callRingtoneAudio.volume = audioPreferences.ringtoneVolume;

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
            { name: 'AES-GCM', iv, additionalData: packet.serverId
                ? new TextEncoder().encode(JSON.stringify([
                    packet.serverId, packet.sender, packet.recipient, packet.callId, packet.type, packet.timestamp
                ]))
                : callSignalMetadata(packet) },
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
                additionalData: packet.serverId
                    ? new TextEncoder().encode(JSON.stringify([
                        packet.serverId, packet.sender, packet.recipient, packet.callId, packet.type, packet.timestamp
                    ]))
                    : callSignalMetadata(packet)
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

    function removeIncomingCall(callId) {
        const invitation = incomingCalls.get(callId);
        if (!invitation) return false;
        clearTimeout(invitation.ringTimeout);
        incomingCalls.delete(callId);
        return true;
    }

    function clearIncomingCalls() {
        incomingCalls.forEach(invitation => clearTimeout(invitation.ringTimeout));
        incomingCalls.clear();
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
                incomingCalls.has(packet.callId) || activeCall || serverCall) return;
            const database = app.readDatabase();
            const profile = app.getUserProfile(database, username);
            if (isBlocked(database, peerId, username) ||
                !profile.friends.some(friend => friend.username === peerId)) return;
            const invitation = {
                callId: packet.callId,
                caller: peerId,
                offer: payload.offer,
                ringTimeout: 0
            };
            incomingCalls.set(packet.callId, invitation);
            invitation.ringTimeout = window.setTimeout(() => {
                if (incomingCalls.get(packet.callId) !== invitation) return;
                incomingCalls.delete(packet.callId);
                syncCallView();
            }, 45000);
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
            } else if (removeIncomingCall(packet.callId)) {
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

        const messageNotificationCutoff = Date.now() - 5000;
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
                if (packet.sender !== username && packet.timestamp >= messageNotificationCutoff) {
                    playMessageSound(messageReceivedAudio, 'message received', audioPreferences.receivedMessageSound);
                }
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

    function showPresetJoke(content) {
        if (typeof content !== 'string' || content.trim().toLowerCase() !== '@tellmeajoke') return false;
        const jokes = window.BlockTalkPresetJokes;
        if (!Array.isArray(jokes) || jokes.length !== 1000) {
            setMediaStatus('The local joke bank is unavailable. Refresh the app and try again.');
            return true;
        }
        const conversationKey = activeServer
            ? `server:${activeServer.id}`
            : app.state.currentConversation;
        if (!conversationKey) {
            setMediaStatus('Choose a direct conversation or server before asking for a joke.');
            return true;
        }
        const randomBytes = new Uint32Array(1);
        window.crypto.getRandomValues(randomBytes);
        const messages = app.state.messages[conversationKey] || (app.state.messages[conversationKey] = []);
        messages.push({
            id: `local-joke-${Date.now()}-${randomBytes[0]}`,
            sender: 'BlockTalk',
            content: jokes[randomBytes[0] % jokes.length],
            timestamp: Date.now(),
            status: 'read'
        });
        app.renderMessages();
        document.getElementById('messageInput').value = '';
        return true;
    }

    async function sendDirectMessage(content) {
        if (showPresetJoke(content)) return;
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
            playMessageSound(messageSentAudio, 'message sent', audioPreferences.sentMessageSound);
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
        if (activeServerVoiceObserver) activeServerVoiceObserver.off();
        activeServerVoiceObserver = null;
        if (activeServerVoiceSignalObserver) activeServerVoiceSignalObserver.off();
        activeServerVoiceSignalObserver = null;
        clearTimeout(serverVoiceExpiryTimer);
        serverVoiceExpiryTimer = 0;
        if (serverCall) leaveServerCall(true);
        activeServerVoiceState = null;
        activeServerGeneration += 1;
        if (activeServerObserver) activeServerObserver.off();
        activeServerObserver = null;
        activeServer = null;
        activeServerKey = null;
        app.serverMessagesReady = false;
    }

    function serverVoiceStatePayload(server, callId, host, updatedAt) {
        return { serverId: server.id, callId, host, updatedAt };
    }

    function signedServerVoiceState(payload) {
        return JSON.stringify([payload.serverId, payload.callId, payload.host, payload.updatedAt]);
    }

    async function writeServerVoiceState(callId, host) {
        const server = activeServer;
        const pair = app.gunUser?._?.sea;
        if (!server || !pair?.pub) throw new Error('Sign in again before starting a server call.');
        const payload = serverVoiceStatePayload(server, callId, host, Date.now());
        const signature = await app.getGunSea().sign(signedServerVoiceState(payload), pair);
        if (typeof signature !== 'string') throw new Error('Could not sign the server-call status.');
        if (activeServer?.id !== server.id ||
            serverCall?.serverId !== server.id || serverCall.callId !== callId) {
            throw new Error('The server call ended before its status could be published.');
        }
        await app.writeGunNode(gun.get(server.id).get('voice').get('state'), { payload, signature });
    }

    async function publishServerVoiceSignal(type, callId, recipient, payload = {}) {
        const server = activeServer;
        const sender = app.state.currentUser?.username;
        const pair = app.gunUser?._?.sea;
        if (!server || !activeServerKey || !sender || !pair?.pub) {
            throw new Error('Open a private server before using its voice channel.');
        }
        const packet = {
            id: window.crypto.randomUUID(),
            serverId: server.id,
            sender,
            senderPub: pair.pub,
            recipient,
            callId,
            type,
            timestamp: Date.now()
        };
        packet.ciphertext = await encryptCallSignal(payload, packet, activeServerKey);
        const signedPayload = JSON.stringify([
            packet.serverId, packet.sender, packet.senderPub, packet.recipient,
            packet.callId, packet.type, packet.timestamp, packet.ciphertext
        ]);
        packet.signature = await app.getGunSea().sign(signedPayload, pair);
        if (typeof packet.signature !== 'string') throw new Error('Could not sign the server-call signal.');
        await app.writeGunNode(
            gun.get(server.id).get('voice').get('signals').get(packet.id),
            packet
        );
    }

    async function verifyServerVoiceEnvelope(packet, server) {
        const maxSignalAge = 24 * 60 * 60 * 1000;
        if (!packet || packet.serverId !== server.id ||
            typeof packet.id !== 'string' || packet.id.length > 100 ||
            typeof packet.sender !== 'string' ||
            !/^[a-zA-Z0-9_.-]{3,32}$/.test(packet.sender) ||
            typeof packet.senderPub !== 'string' ||
            typeof packet.signature !== 'string' ||
            typeof packet.ciphertext !== 'string' || packet.ciphertext.length > 300000 ||
            typeof packet.recipient !== 'string' ||
            (packet.recipient !== '*' && !/^[a-zA-Z0-9_.-]{3,32}$/.test(packet.recipient)) ||
            typeof packet.callId !== 'string' || !/^call-[a-zA-Z0-9_-]{8,100}$/.test(packet.callId) ||
            typeof packet.type !== 'string' ||
            !Number.isFinite(packet.timestamp) ||
            packet.timestamp > Date.now() + 30000 ||
            Date.now() - packet.timestamp > maxSignalAge) return false;
        const expectedPub = await app.lookupUserPub(packet.sender);
        if (!expectedPub || expectedPub !== packet.senderPub) return false;
        const signedPayload = JSON.stringify([
            packet.serverId, packet.sender, packet.senderPub, packet.recipient,
            packet.callId, packet.type, packet.timestamp, packet.ciphertext
        ]);
        return await app.getGunSea().verify(packet.signature, packet.senderPub) === signedPayload;
    }

    async function acceptServerVoiceState(envelope, server) {
        if (!envelope) {
            clearTimeout(serverVoiceExpiryTimer);
            serverVoiceExpiryTimer = 0;
            activeServerVoiceState = null;
            if (serverCall?.serverId === server.id) closeServerCallLocally();
            syncCallView();
            return;
        }
        const payload = envelope.payload;
        if (!payload || payload.serverId !== server.id ||
            typeof payload.callId !== 'string' || !/^call-[a-zA-Z0-9_-]{8,80}$/.test(payload.callId) ||
            typeof payload.host !== 'string' ||
            !/^[a-zA-Z0-9_.-]{3,32}$/.test(payload.host) ||
            !Number.isFinite(payload.updatedAt) ||
            payload.updatedAt > Date.now() + 30000 ||
            Date.now() - payload.updatedAt > 75000 ||
            typeof envelope.signature !== 'string') return;
        const hostPub = await app.lookupUserPub(payload.host);
        if (!hostPub) return;
        const verified = await app.getGunSea().verify(envelope.signature, hostPub);
        if (verified !== signedServerVoiceState(payload)) return;
        if (activeServerVoiceState?.serverId === server.id &&
            activeServerVoiceState.updatedAt > payload.updatedAt) return;
        activeServerVoiceState = payload;
        clearTimeout(serverVoiceExpiryTimer);
        serverVoiceExpiryTimer = setTimeout(() => {
            if (activeServerVoiceState?.callId !== payload.callId ||
                Date.now() - payload.updatedAt <= 75000) return;
            activeServerVoiceState = null;
            if (serverCall?.callId === payload.callId) closeServerCallLocally();
            syncCallView();
        }, Math.max(0, payload.updatedAt + 75000 - Date.now()));
        if (serverCall && (serverCall.serverId !== server.id || serverCall.callId !== payload.callId)) {
            closeServerCallLocally();
        }
        syncCallView();
    }

    function closeServerPeer(username) {
        const peer = serverCall?.peers.get(username);
        if (!peer) return;
        peer.connection.close();
        peer.audio.remove();
        serverCall.peers.delete(username);
        const pending = serverCall.pendingCandidates.get(username);
        if (pending) serverCall.pendingCandidates.delete(username);
        syncServerCallParticipants();
    }

    function closeServerCallLocally() {
        clearInterval(serverCallHeartbeat);
        serverCallHeartbeat = 0;
        clearTimeout(serverCallJoinTimer);
        serverCallJoinTimer = 0;
        if (!serverCall) return;
        serverCall.peers.forEach(peer => {
            peer.connection.close();
            peer.audio.remove();
        });
        serverCall.peers.clear();
        serverCall.pendingCandidates.clear();
        serverCall.pendingOffers.clear();
        if (serverCall.stream) serverCall.stream.getTracks().forEach(track => track.stop());
        serverCall = null;
        localStream = null;
        voiceMeters.forEach(meter => {
            cancelAnimationFrame(meter.frameId);
            meter.context.close().catch(() => {});
        });
        voiceMeters.clear();
        localCallPfp.classList.remove('voice-active-glowing');
        remoteAudio.srcObject = null;
        muteButton.disabled = true;
        muteButton.textContent = 'Mute';
        muteButton.setAttribute('aria-pressed', 'false');
        isMuted = false;
        syncServerCallParticipants();
        syncCallView();
    }

    function syncServerCallParticipants() {
        const container = document.getElementById('serverCallParticipants');
        if (!container) return;
        container.replaceChildren();
        if (!serverCall) return;
        const names = [...serverCall.members].filter(Boolean);
        names.forEach(username => {
            const participant = document.createElement('span');
            participant.className = 'server-call-participant';
            participant.textContent = `@${username}`;
            container.appendChild(participant);
        });
    }

    async function createServerCallPeer(username, offerer) {
        if (!serverCall || serverCall.peers.has(username)) return;
        const call = serverCall;
        const connection = new RTCPeerConnection({ iceServers });
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.dataset.peer = username;
        callPanel.appendChild(audio);
        const peer = { connection, audio, signalReady: false, outgoingCandidates: [] };
        call.peers.set(username, peer);
        call.stream.getAudioTracks().forEach(track => connection.addTrack(track, call.stream));
        connection.ontrack = event => {
            if (serverCall !== call || !call.peers.has(username)) return;
            audio.srcObject = event.streams[0] || new MediaStream([event.track]);
            audio.play().catch(() => {
                callAlert.textContent = 'TERMINAL: Click the page to allow server-call audio playback.';
            });
        };
        connection.onicecandidate = event => {
            if (!event.candidate || serverCall !== call) return;
            const candidate = serializeCandidate(event.candidate);
            if (!peer.signalReady) {
                peer.outgoingCandidates.push(candidate);
                return;
            }
            publishServerVoiceSignal('candidate', call.callId, username, { candidate }).catch(error => {
                callAlert.textContent = `TERMINAL: Could not send a server-call network candidate. ${error.message}`;
            });
        };
        connection.onconnectionstatechange = () => {
            if (serverCall !== call) return;
            if (connection.connectionState === 'connected') {
                clearTimeout(serverCallJoinTimer);
                serverCallJoinTimer = 0;
            }
            if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
                closeServerPeer(username);
            } else {
                syncCallView();
            }
        };
        if (offerer) {
            const offer = await connection.createOffer();
            await connection.setLocalDescription(offer);
            await publishServerVoiceSignal('offer', call.callId, username, {
                offer: serializeDescription(connection.localDescription)
            });
            peer.signalReady = true;
            await flushServerPeerCandidates(username, peer);
        }
        syncServerCallParticipants();
    }

    async function flushServerPeerCandidates(username, peer) {
        const call = serverCall;
        if (!call) return;
        const candidates = peer.outgoingCandidates.splice(0);
        for (const candidate of candidates) {
            await publishServerVoiceSignal('candidate', call.callId, username, { candidate });
        }
    }

    async function acceptServerOffer(packet, payload) {
        const username = app.state.currentUser?.username;
        const call = serverCall;
        if (!call || !username || !validCallDescription(payload?.offer, 'offer')) return;
        await createServerCallPeer(packet.sender, false);
        const peer = call.peers.get(packet.sender);
        if (!peer || serverCall !== call) return;
        await peer.connection.setRemoteDescription(new RTCSessionDescription(payload.offer));
        if (serverCall !== call) return;
        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        await publishServerVoiceSignal('answer', packet.callId, packet.sender, {
            answer: serializeDescription(peer.connection.localDescription)
        });
        peer.signalReady = true;
        await flushServerPeerCandidates(packet.sender, peer);
        const candidates = call.pendingCandidates.get(packet.sender) || [];
        call.pendingCandidates.delete(packet.sender);
        for (const candidate of candidates) {
            await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    async function acceptPendingServerOffers() {
        if (!serverCall) return;
        for (const [peerName, pending] of serverCall.pendingOffers) {
            if (!serverCall.members.has(peerName)) continue;
            serverCall.pendingOffers.delete(peerName);
            await acceptServerOffer(pending.packet, pending.payload);
        }
    }

    async function handleServerVoiceSignal(packet, server) {
        const username = app.state.currentUser?.username;
        const call = serverCall;
        const allowedTypes = new Set([
            'join', 'member-joined', 'member-list', 'offer', 'answer', 'candidate', 'leave', 'end'
        ]);
        if (!username || !call || call.serverId !== server.id ||
            packet.callId !== call.callId ||
            (packet.recipient !== username && packet.recipient !== '*') ||
            !allowedTypes.has(packet.type) ||
            !await verifyServerVoiceEnvelope(packet, server)) return;
        if (serverCall !== call) return;
        let payload;
        try {
            payload = await decryptCallSignal(packet.ciphertext, packet, activeServerKey);
        } catch (error) {
            return;
        }
        if (serverCall !== call) return;
        if (packet.type === 'join' && packet.recipient === call.host && call.host === username) {
            call.members.add(packet.sender);
            await createServerCallPeer(packet.sender, true);
            if (serverCall !== call) return;
            await publishServerVoiceSignal('member-list', call.callId, packet.sender, {
                usernames: [...call.members].filter(member => member !== packet.sender)
            });
            if (serverCall !== call) return;
            await publishServerVoiceSignal('member-joined', call.callId, '*', {
                username: packet.sender
            });
        } else if (packet.type === 'member-joined' && packet.sender === call.host &&
            typeof payload?.username === 'string' &&
            /^[a-zA-Z0-9_.-]{3,32}$/.test(payload.username)) {
            call.members.add(payload.username);
            if (payload.username !== username) await createServerCallPeer(payload.username, true);
            if (serverCall !== call) return;
            await acceptPendingServerOffers();
            syncServerCallParticipants();
        } else if (packet.type === 'member-list' && packet.sender === call.host &&
            Array.isArray(payload?.usernames) &&
            payload.usernames.every(member => typeof member === 'string' &&
                /^[a-zA-Z0-9_.-]{3,32}$/.test(member))) {
            payload.usernames.forEach(member => call.members.add(member));
            await acceptPendingServerOffers();
            syncServerCallParticipants();
        } else if (packet.type === 'offer' && packet.sender !== username &&
            validCallDescription(payload?.offer, 'offer')) {
            if (call.members.has(packet.sender)) {
                await acceptServerOffer(packet, payload);
            } else if (call.pendingOffers.size < 16) {
                call.pendingOffers.set(packet.sender, { packet, payload });
            }
        } else if (packet.type === 'answer' && call.members.has(packet.sender) &&
            validCallDescription(payload?.answer, 'answer')) {
            const peer = call.peers.get(packet.sender);
            if (!peer) return;
            await peer.connection.setRemoteDescription(new RTCSessionDescription(payload.answer));
            if (serverCall !== call) return;
            peer.signalReady = true;
            await flushServerPeerCandidates(packet.sender, peer);
            const candidates = call.pendingCandidates.get(packet.sender) || [];
            call.pendingCandidates.delete(packet.sender);
            for (const candidate of candidates) {
                await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } else if (packet.type === 'candidate' && call.members.has(packet.sender) &&
            validIceCandidate(payload?.candidate)) {
            const peer = call.peers.get(packet.sender);
            if (peer?.connection.remoteDescription) {
                await peer.connection.addIceCandidate(new RTCIceCandidate(payload.candidate));
            } else {
                const candidates = call.pendingCandidates.get(packet.sender) || [];
                if (candidates.length < 128) candidates.push(payload.candidate);
                call.pendingCandidates.set(packet.sender, candidates);
            }
        } else if (packet.type === 'leave') {
            call.members.delete(packet.sender);
            call.pendingOffers.delete(packet.sender);
            closeServerPeer(packet.sender);
            syncServerCallParticipants();
        } else if (packet.type === 'end' && packet.sender === call.host) {
            closeServerCallLocally();
        }
    }

    async function startOrJoinServerCall() {
        const server = activeServer;
        const username = app.state.currentUser?.username;
        if (!server || !username || !activeServerKey) return;
        if (activeCall) {
            callAlert.textContent = 'TERMINAL: End your direct-message call before joining a server call.';
            return;
        }
        if (serverCall?.serverId === server.id) {
            await leaveServerCall(true);
            return;
        }
        const state = activeServerVoiceState;
        const isHost = !state || Date.now() - state.updatedAt > 75000;
        const callId = isHost ? `call-${Date.now()}-${window.crypto.randomUUID()}` : state.callId;
        serverCall = {
            serverId: server.id,
            callId,
            host: isHost ? username : state.host,
            stream: null,
            members: new Set([username, ...(isHost ? [] : [state.host])]),
            peers: new Map(),
            pendingCandidates: new Map(),
            pendingOffers: new Map()
        };
        const call = serverCall;
        syncCallView();
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable');
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            if (serverCall !== call || activeServer?.id !== server.id) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            if (!isHost && activeServerVoiceState?.callId !== callId) {
                stream.getTracks().forEach(track => track.stop());
                closeServerCallLocally();
                return;
            }
            call.stream = stream;
            localStream = stream;
            monitorVoice(localStream, localCallPfp, () => isMuted);
            muteButton.disabled = false;
            if (isHost) {
                await writeServerVoiceState(callId, username);
                if (serverCall !== call || activeServer?.id !== server.id) return;
                activeServerVoiceState = { serverId: server.id, callId, host: username, updatedAt: Date.now() };
                clearInterval(serverCallHeartbeat);
                serverCallHeartbeat = setInterval(() => {
                    writeServerVoiceState(callId, username).catch(error => {
                        callAlert.textContent = `TERMINAL: Server call status could not be refreshed. ${error.message}`;
                        closeServerCallLocally();
                    });
                }, 25000);
            } else {
                await publishServerVoiceSignal('join', callId, state.host);
                serverCallJoinTimer = setTimeout(() => {
                    if (serverCall !== call) return;
                    callAlert.textContent = 'TERMINAL: No one in the server call responded. Try joining again.';
                    leaveServerCall(true);
                }, 45000);
            }
            if (serverCall !== call) return;
            syncCallView();
        } catch (error) {
            callAlert.textContent = `TERMINAL: Could not join the server call. ${error.message}`;
            closeServerCallLocally();
        }
    }

    async function leaveServerCall(notify) {
        const call = serverCall;
        if (!call) return;
        const username = app.state.currentUser?.username;
        if (notify && activeServer?.id === call.serverId && activeServerKey) {
            if (call.host === username) {
                publishServerVoiceSignal('end', call.callId, '*').catch(() => {});
                app.gun.get(call.serverId).get('voice').get('state').put(null);
                activeServerVoiceState = null;
            } else {
                for (const peerName of call.members) {
                    if (peerName === username) continue;
                    publishServerVoiceSignal('leave', call.callId, peerName).catch(() => {});
                }
            }
        }
        closeServerCallLocally();
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
            const voiceNode = gun.get(server.id).get('voice');
            activeServerVoiceObserver = voiceNode.get('state');
            activeServerVoiceObserver.on(envelope => {
                if (generation !== activeServerGeneration || activeServer?.id !== server.id) return;
                acceptServerVoiceState(envelope, server).catch(error => {
                    console.warn('Could not verify server voice-channel state:', error);
                });
            });
            activeServerVoiceSignalObserver = voiceNode.get('signals').map();
            activeServerVoiceSignalObserver.on((packet, signalId) => {
                if (generation !== activeServerGeneration || activeServer?.id !== server.id ||
                    !packet || packet.id !== signalId || !serverCall ||
                    packet.callId !== serverCall.callId ||
                    seenServerVoiceSignalIds.has(signalId)) return;
                seenServerVoiceSignalIds.add(signalId);
                if (seenServerVoiceSignalIds.size > 2048) {
                    seenServerVoiceSignalIds.delete(seenServerVoiceSignalIds.values().next().value);
                }
                handleServerVoiceSignal(packet, server).catch(error => {
                    callAlert.textContent = `TERMINAL: Could not process a server-call signal. ${error.message}`;
                });
            });
            const messageNotificationCutoff = Date.now() - 5000;
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
                    if (packet.sender !== app.state.currentUser?.username &&
                        packet.timestamp >= messageNotificationCutoff) {
                        playMessageSound(messageReceivedAudio, 'message received', audioPreferences.receivedMessageSound);
                    }
                } catch (error) {
                    setMediaStatus('A server message could not be decrypted. Confirm the invite code is correct.');
                }
            });
            app.serverMessagesReady = true;
            app.renderChatArea();
            syncCallView();
            document.getElementById('serverStatus').textContent = `Connected to ${server.name}.`;
        } catch (error) {
            if (generation !== activeServerGeneration) return;
            document.getElementById('serverStatus').textContent = `Could not open this server: ${error.message}`;
        }
    }

    async function sendServerMessage(content) {
        if (showPresetJoke(content)) return;
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
            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('The Gun relay did not confirm the server message.')), 15000);
                    gun.get(server.id).get('messages').set(packet, acknowledgement => {
                        clearTimeout(timeout);
                        if (acknowledgement?.err) reject(new Error(`Gun relay error: ${String(acknowledgement.err)}`));
                        else resolve();
                    });
                });
            } catch (error) {
                try {
                    queueEncryptedMessage(server.id, packet);
                    document.getElementById('messageInput').value = '';
                    setMediaStatus(`The server relay did not accept the message (${error.message}). It is saved on this device; reconnect or reload to retry.`);
                    return;
                } catch (queueError) {
                    setMediaStatus(`The server relay did not accept the message (${error.message}); it could not be queued: ${queueError.message}`);
                    return;
                }
            }
            if (activeServer?.id === server.id) setMediaStatus('');
            document.getElementById('messageInput').value = '';
            playMessageSound(messageSentAudio, 'message sent', audioPreferences.sentMessageSound);
        } catch (error) {
            setMediaStatus(`Could not prepare the server message: ${error.message}`);
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

    window.addEventListener('blocktalk:database-change', () => {
        if (!app.state.currentUser) return;
        syncCallView();
    });

    function initialsFor(name) {
        const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
        if (parts.length > 1) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
        return (parts[0] || '?').slice(0, 2).toUpperCase();
    }

    const themeClassNames = ['theme-terminal', 'theme-blocky', 'theme-incognito', 'theme-cyberpunk', 'theme-light'];

    function applyTheme(theme) {
        const selectedTheme = ['terminal', 'blocky', 'incognito', 'cyberpunk', 'light'].includes(theme) ? theme : 'terminal';
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
        document.getElementById('settings-bio').value = profile.bio;
        pendingProfilePictureDataUrl = isEmbeddedPicture ? profile.profilePictureUrl : '';
        profilePictureCropState?.bitmap?.close?.();
        profilePictureCropState = null;
        document.getElementById('profilePictureCrop').classList.add('hidden');
        profilePictureProcessing = false;
        document.getElementById('profilePictureDropzoneText').textContent =
            isEmbeddedPicture ? 'Current picture will be kept (drop a replacement here)' :
                'Drop a picture here or browse (PNG/JPEG/WebP, up to 10 MB)';
        settingsTheme.value = profile.theme || 'terminal';
        syncAudioPreferenceControls();
        settingsStatus.textContent = '';
        applyTheme(settingsTheme.value);
        settingsModal.classList.remove('hidden');
        settingsPfpUrl.focus();
    }

    function closeSettings() {
        profilePictureCropState?.bitmap?.close?.();
        profilePictureCropState = null;
        document.getElementById('profilePictureCrop').classList.add('hidden');
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
        if (profilePictureCropState) {
            try {
                profilePictureUrl = await createCroppedProfilePicture();
            } catch (error) {
                settingsStatus.textContent = error.message;
                return;
            }
        } else if (pendingProfilePictureDataUrl) {
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
            const bio = document.getElementById('settings-bio').value.trim();
            if (bio.length > 500) {
                settingsStatus.textContent = 'Bios must be 500 characters or fewer.';
                return;
            }
            saveAudioPreferences();
            await app.updateProfile({ bio, profilePictureUrl, theme });
            profilePictureCropState?.bitmap?.close?.();
            profilePictureCropState = null;
            document.getElementById('profilePictureCrop').classList.add('hidden');
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
        settingsStatus.textContent = 'Preparing profile picture crop...';
        try {
            if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) {
                throw new Error('Choose an image up to 10 MB.');
            }
            if (typeof window.createImageBitmap !== 'function') {
                throw new Error('This browser cannot safely prepare profile pictures.');
            }
            const bitmap = await window.createImageBitmap(file);
            if (generation !== profilePictureSelectionGeneration) {
                bitmap.close();
                return;
            }
            profilePictureCropState = {
                bitmap,
                zoom: 1,
                offsetX: 0,
                offsetY: 0,
                fileName: file.name
            };
            renderProfilePictureCrop();
            document.getElementById('profilePictureCrop').classList.remove('hidden');
            settingsPfpUrl.value = '';
            pendingProfilePictureDataUrl = '';
            document.getElementById('profilePictureDropzoneText').textContent = `${file.name} is ready to crop.`;
            settingsStatus.textContent = '';
        } catch (error) {
            if (generation === profilePictureSelectionGeneration) settingsStatus.textContent = error.message;
        } finally {
            if (generation === profilePictureSelectionGeneration) profilePictureProcessing = false;
        }
    }

    function renderProfilePictureCrop() {
        const state = profilePictureCropState;
        const canvas = document.getElementById('profilePictureCropCanvas');
        if (!state || !canvas) return;
        const context = canvas.getContext('2d');
        const side = Math.min(state.bitmap.width, state.bitmap.height) / state.zoom;
        const centerX = state.bitmap.width / 2 + state.offsetX;
        const centerY = state.bitmap.height / 2 + state.offsetY;
        const sourceX = Math.max(0, Math.min(state.bitmap.width - side, centerX - side / 2));
        const sourceY = Math.max(0, Math.min(state.bitmap.height - side, centerY - side / 2));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(state.bitmap, sourceX, sourceY, side, side, 0, 0, canvas.width, canvas.height);
    }

    async function createCroppedProfilePicture() {
        const state = profilePictureCropState;
        if (!state) return '';
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const context = canvas.getContext('2d');
        const side = Math.min(state.bitmap.width, state.bitmap.height) / state.zoom;
        const centerX = state.bitmap.width / 2 + state.offsetX;
        const centerY = state.bitmap.height / 2 + state.offsetY;
        const sourceX = Math.max(0, Math.min(state.bitmap.width - side, centerX - side / 2));
        const sourceY = Math.max(0, Math.min(state.bitmap.height - side, centerY - side / 2));
        context.drawImage(state.bitmap, sourceX, sourceY, side, side, 0, 0, 512, 512);
        for (let quality = 0.86; quality >= 0.35; quality -= 0.08) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
            if (!blob) throw new Error('The browser could not create the cropped picture.');
            if (blob.size <= 320 * 1024) return readFileAsDataUrl(blob);
        }
        throw new Error('The cropped profile picture is still too large. Try a simpler image.');
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
        profilePictureCropState?.bitmap?.close?.();
        profilePictureCropState = null;
        document.getElementById('profilePictureCrop').classList.add('hidden');
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
    const profilePictureCropCanvas = document.getElementById('profilePictureCropCanvas');
    const profilePictureZoom = document.getElementById('profilePictureZoom');
    const resetProfilePictureCrop = document.getElementById('resetProfilePictureCrop');
    let cropPointer = null;
    profilePictureZoom.addEventListener('input', () => {
        if (!profilePictureCropState) return;
        profilePictureCropState.zoom = Number(profilePictureZoom.value);
        renderProfilePictureCrop();
    });
    resetProfilePictureCrop.addEventListener('click', () => {
        if (!profilePictureCropState) return;
        profilePictureCropState.zoom = 1;
        profilePictureCropState.offsetX = 0;
        profilePictureCropState.offsetY = 0;
        profilePictureZoom.value = '1';
        renderProfilePictureCrop();
    });
    profilePictureCropCanvas.addEventListener('pointerdown', event => {
        if (!profilePictureCropState) return;
        cropPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        profilePictureCropCanvas.setPointerCapture(event.pointerId);
    });
    profilePictureCropCanvas.addEventListener('pointermove', event => {
        if (!profilePictureCropState || !cropPointer || cropPointer.id !== event.pointerId) return;
        const scale = profilePictureCropState.bitmap.width / profilePictureCropCanvas.clientWidth;
        profilePictureCropState.offsetX -= (event.clientX - cropPointer.x) * scale / profilePictureCropState.zoom;
        profilePictureCropState.offsetY -= (event.clientY - cropPointer.y) * scale / profilePictureCropState.zoom;
        cropPointer.x = event.clientX;
        cropPointer.y = event.clientY;
        renderProfilePictureCrop();
    });
    ['pointerup', 'pointercancel'].forEach(type => profilePictureCropCanvas.addEventListener(type, () => {
        cropPointer = null;
    }));
    settingsTheme.addEventListener('change', () => applyTheme(settingsTheme.value));
    document.getElementById('settings-ringtone-volume').addEventListener('input', event => {
        document.getElementById('settings-ringtone-volume-value').textContent = `${event.currentTarget.value}%`;
    });
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
    const emojiPickerButton = document.getElementById('emojiPickerButton');
    emojiPickerButton.addEventListener('click', () => {
        const isOpen = emojiPicker.classList.toggle('hidden') === false;
        emojiPickerButton.setAttribute('aria-expanded', String(isOpen));
    });
    document.addEventListener('click', event => {
        if (emojiPicker.classList.contains('hidden') ||
            emojiPicker.contains(event.target) ||
            emojiPickerButton.contains(event.target)) return;
        emojiPicker.classList.add('hidden');
        emojiPickerButton.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || emojiPicker.classList.contains('hidden')) return;
        emojiPicker.classList.add('hidden');
        emojiPickerButton.setAttribute('aria-expanded', 'false');
        emojiPickerButton.focus();
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

    function findOwnerAward(kind, id) {
        if (kind === 'badge') {
            return OWNER_BADGE_CATALOG.find(award => award.id === id) ||
                SPECIAL_OWNER_BADGES.find(award => award.id === id);
        }
        if (kind === 'title') return OWNER_TITLE_CATALOG.find(award => award.id === id);
        return null;
    }

    async function readVerifiedOwnerAwards(username, publicKey, refresh = false) {
        const cached = ownerAwardCache.get(publicKey);
        if (!refresh && cached && cached.expiresAt > Date.now()) return cached.awards;
        const ownerPub = await app.lookupUserPub(OWNER_USERNAME);
        if (!ownerPub) return [];
        const records = await app.readGunNode(
            gun.get('blocktalk-v1').get('badges').get(publicKey)
        );
        const sea = app.getGunSea();
        const verifiedAwards = new Map();
        for (const envelope of Object.values(records || {})) {
            if (!envelope || typeof envelope !== 'object' || typeof envelope.signature !== 'string') continue;
            try {
                const signedPayload = await sea.verify(envelope.signature, ownerPub);
                if (typeof signedPayload !== 'string') continue;
                const payload = JSON.parse(signedPayload);
                const kind = payload.kind || 'badge';
                const awardId = payload.awardId || payload.badge;
                if (payload.recipientPub !== publicKey || payload.issuerPub !== ownerPub ||
                    payload.recipient !== username ||
                    typeof payload.id !== 'string' ||
                    !Number.isFinite(payload.timestamp) ||
                    !findOwnerAward(kind, awardId)) continue;
                const key = `${kind}:${awardId}`;
                const existing = verifiedAwards.get(key);
                if (!existing || payload.timestamp > existing.timestamp) {
                    verifiedAwards.set(key, { kind, id: awardId, timestamp: payload.timestamp });
                }
            } catch (error) {
                console.warn(`Ignoring an invalid owner award for ${username}:`, error);
            }
        }
        const awards = [...verifiedAwards.values()];
        ownerAwardCache.set(publicKey, { awards, expiresAt: Date.now() + 60000 });
        return awards;
    }

    async function readCurrentChatTitle(username) {
        const publicKey = await app.lookupUserPub(username);
        if (!publicKey) return '';
        const awards = await readVerifiedOwnerAwards(username, publicKey);
        const title = awards
            .filter(award => award.kind === 'title')
            .sort((left, right) => right.timestamp - left.timestamp)[0];
        return title ? findOwnerAward('title', title.id).name : '';
    }

    function renderAwardedTitles() {
        const generation = ++chatTitleRenderGeneration;
        const senders = [...document.querySelectorAll('#messageLog .message-sender[data-profile-username]')];
        senders.forEach(sender => {
            const username = sender.dataset.profileUsername;
            const cachedTitle = renderedTitleCache.get(username);
            if (cachedTitle && cachedTitle.expiresAt <= Date.now()) renderedTitleCache.delete(username);
            const title = cachedTitle?.expiresAt > Date.now() ? cachedTitle.title : '';
            const previous = sender.nextElementSibling;
            if (previous?.classList.contains('chat-title-tag')) previous.remove();
            if (title) {
                const titleElement = document.createElement('span');
                titleElement.className = 'chat-title-tag';
                titleElement.textContent = title;
                sender.after(titleElement);
            }
        });
        const sendersByUsername = new Map();
        senders.forEach(sender => {
            const username = sender.dataset.profileUsername;
            if (renderedTitleCache.get(username)?.expiresAt > Date.now()) return;
            if (!sendersByUsername.has(username)) sendersByUsername.set(username, []);
            sendersByUsername.get(username).push(sender);
        });
        const pending = [...sendersByUsername.entries()];
        const loadBatch = async start => {
            if (generation !== chatTitleRenderGeneration || start >= pending.length) return;
            const batch = pending.slice(start, start + 5);
            await Promise.all(batch.map(async ([username]) => {
                try {
                    const title = await readCurrentChatTitle(username);
                    renderedTitleCache.set(username, {
                        title,
                        expiresAt: Date.now() + RENDERED_TITLE_CACHE_TTL
                    });
                } catch (error) {
                    console.warn(`Could not load @${username}'s chat title:`, error);
                    renderedTitleCache.set(username, {
                        title: '',
                        expiresAt: Date.now() + RENDERED_TITLE_CACHE_TTL
                    });
                }
            }));
            if (generation !== chatTitleRenderGeneration) return;
            batch.forEach(([username, usernameSenders]) => {
                const title = renderedTitleCache.get(username)?.title;
                if (!title) return;
                usernameSenders.forEach(sender => {
                    if (!sender.isConnected) return;
                    const titleElement = document.createElement('span');
                    titleElement.className = 'chat-title-tag';
                    titleElement.textContent = title;
                    sender.after(titleElement);
                });
            });
            window.setTimeout(() => loadBatch(start + 5), 0);
        };
        loadBatch(0);
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
        const bio = document.getElementById('profileModalBio');
        const status = document.getElementById('profileModalStatus');
        const ownerTools = document.getElementById('ownerBadgeTools');
        const generation = ++profileModalGeneration;
        badgeTarget = null;
        title.textContent = `@${username}`;
        const profileChatTitle = document.getElementById('profileModalChatTitle');
        profileChatTitle.textContent = '';
        profileChatTitle.classList.add('hidden');
        badges.replaceChildren();
        bio.textContent = '';
        status.textContent = 'Loading public profile…';
        ownerTools.classList.toggle('hidden', app.state.currentUser?.username !== OWNER_USERNAME);
        document.getElementById('badgeTargetStatus').textContent = '';
        document.getElementById('badgeTargetUsername').value = '';
        document.getElementById('awardBadgeButton').disabled = true;
        document.getElementById('banUserButton').disabled = true;
        document.getElementById('unbanUserButton').disabled = true;
        document.getElementById('moderationStatus').textContent = '';
        setProfileModalAvatar(document.getElementById('profileModalPicture'), username, '');
        modal.classList.remove('hidden');
        try {
            const publicKey = await app.lookupUserPub(username);
            if (!publicKey) throw new Error('No registered account was found for that username.');
            badgeTarget = { username, publicKey };
            document.getElementById('banUserButton').disabled = username === OWNER_USERNAME;
            document.getElementById('unbanUserButton').disabled = username === OWNER_USERNAME;
            const profile = await app.readProfileByPub(publicKey);
            if (generation !== profileModalGeneration) return;
            setProfileModalAvatar(document.getElementById('profileModalPicture'), username, profile.profilePictureUrl);
            bio.textContent = profile.bio || 'No bio added yet.';
            if (profile.accountCreatedAt > 0 && profile.accountCreatedAt < FOUNDER_BADGE_CUTOFF) {
                appendBadge(badges, 'Early OG · Joined before 2027', 'founder-badge');
            }
            if (username === OWNER_USERNAME) appendBadge(badges, 'BlockTalk Owner', 'owner-badge');
            let claims = [];
            let badgeError = '';
            try {
                claims = await readVerifiedOwnerAwards(username, publicKey);
            } catch (error) {
                badgeError = `Owner-issued badges could not be verified: ${error.message}`;
            }
            if (generation !== profileModalGeneration) return;
            const badgeClaims = claims.filter(claim => claim.kind === 'badge');
            badgeClaims.forEach(claim => {
                const award = findOwnerAward('badge', claim.id);
                if (award) appendBadge(badges, award.name, award.style || 'collectable-badge');
            });
            const activeTitle = claims
                .filter(claim => claim.kind === 'title')
                .sort((left, right) => right.timestamp - left.timestamp)[0];
            const profileTitle = document.getElementById('profileModalChatTitle');
            profileTitle.textContent = activeTitle
                ? findOwnerAward('title', activeTitle.id).name
                : '';
            profileTitle.classList.toggle('hidden', !activeTitle);
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
            status.textContent = `Found @${username}. Choose a badge or title to award.`;
            button.disabled = false;
            document.getElementById('banUserButton').disabled = username === OWNER_USERNAME;
            document.getElementById('unbanUserButton').disabled = username === OWNER_USERNAME;
        } catch (error) {
            if (input.value.trim() !== username) return;
            status.textContent = error.message;
        }
    });
    document.getElementById('badgeTargetUsername').addEventListener('input', () => {
        badgeTarget = null;
        document.getElementById('awardBadgeButton').disabled = true;
        document.getElementById('banUserButton').disabled = true;
        document.getElementById('unbanUserButton').disabled = true;
        document.getElementById('badgeTargetStatus').textContent = '';
        document.getElementById('moderationStatus').textContent = '';
    });
    document.getElementById('badgeTargetUsername').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        document.getElementById('findBadgeTarget').click();
    });
    function populateOwnerAwards() {
        const kind = document.getElementById('ownerAwardType').value;
        const catalog = kind === 'title'
            ? OWNER_TITLE_CATALOG
            : [
                ...OWNER_BADGE_CATALOG,
                ...SPECIAL_OWNER_BADGES.map(award => ({
                    ...award,
                    category: 'Special Awards'
                }))
            ];
        const selection = document.getElementById('ownerAwardSelection');
        selection.replaceChildren();
        const grouped = new Map();
        catalog.forEach(award => {
            if (!grouped.has(award.category)) grouped.set(award.category, []);
            grouped.get(award.category).push(award);
        });
        grouped.forEach((awards, category) => {
            const group = document.createElement('optgroup');
            group.label = category;
            awards.forEach(award => {
                const option = document.createElement('option');
                option.value = award.id;
                option.textContent = award.name;
                group.appendChild(option);
            });
            selection.appendChild(group);
        });
    }
    populateOwnerAwards();
    document.getElementById('ownerAwardType').addEventListener('change', populateOwnerAwards);
    document.addEventListener('pointerdown', () => {
        if (incomingCalls.size > 0) startCallRingtone();
    });
    document.getElementById('awardBadgeButton').addEventListener('click', async () => {
        const status = document.getElementById('badgeTargetStatus');
        const button = document.getElementById('awardBadgeButton');
        if (app.state.currentUser?.username !== OWNER_USERNAME || !badgeTarget) {
            status.textContent = `Only the ${OWNER_USERNAME} account can award these badges.`;
            return;
        }
        button.disabled = true;
        try {
            const pair = app.gunUser?._?.sea;
            const ownerPub = await app.lookupUserPub(OWNER_USERNAME);
            if (!pair?.pub || pair.pub !== ownerPub) throw new Error('The owner account key could not be verified.');
            const kind = document.getElementById('ownerAwardType').value;
            const awardId = document.getElementById('ownerAwardSelection').value;
            const award = findOwnerAward(kind, awardId);
            if (!award) throw new Error('Select a valid badge or title to award.');
            const payload = {
                id: window.crypto.randomUUID(),
                kind,
                awardId,
                recipientPub: badgeTarget.publicKey,
                recipient: badgeTarget.username,
                issuerPub: ownerPub,
                timestamp: Date.now()
            };
            if (kind === 'badge') payload.badge = awardId;
            const signature = await app.getGunSea().sign(JSON.stringify(payload), pair);
            if (typeof signature !== 'string') throw new Error('The badge award could not be signed.');
            await app.writeGunNode(
                gun.get('blocktalk-v1').get('badges').get(badgeTarget.publicKey).get(payload.id),
                { signature }
            );
            ownerAwardCache.delete(badgeTarget.publicKey);
            renderedTitleCache.delete(badgeTarget.username);
            status.textContent = `Awarded ${kind === 'title' ? 'the title' : 'the badge'} "${award.name}" to @${badgeTarget.username}.`;
            app.renderMessages();
            if (document.getElementById('profileModalTitle').textContent === `@${badgeTarget.username}`) {
                await openProfile(badgeTarget.username);
            }
        } catch (error) {
            status.textContent = `Could not award the badge: ${error.message}`;
        } finally {
            button.disabled = !badgeTarget;
        }
    });

    const originalRenderMessages = app.renderMessages;
    app.renderMessages = function(...args) {
        const result = originalRenderMessages.apply(this, args);
        renderAwardedTitles();
        return result;
    };

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
            clearIncomingCalls();
            stopCallRingtone();
            incomingCallList.replaceChildren();
            callPanel.classList.add('hidden');
            document.getElementById('mainChatContainer').classList.remove('has-active-call');
            return;
        }
        showIncomingCall();
        if (activeCall?.status === 'ringing' || (!activeCall && incomingCalls.size > 0)) {
            startCallRingtone();
        } else {
            stopCallRingtone();
        }
        if (serverCall) {
            callPanel.classList.remove('hidden');
            document.getElementById('mainChatContainer').classList.add('has-active-call');
            callTitle.textContent = `Server voice · ${activeServer?.name || 'Private server'}`;
            callStatus.textContent = serverCall.host === username
                ? `You started the call · ${serverCall.peers.size + 1} joined`
                : `In the call hosted by @${serverCall.host} · ${serverCall.peers.size + 1} joined`;
            document.querySelector('.voice-participants').classList.add('hidden');
            document.getElementById('serverCallParticipants').classList.remove('hidden');
            localCallName.textContent = `${username} (you)`;
            setCallAvatar(localCallPfp, localCallInitials, username,
                app.getUserProfile(app.readDatabase(), username).profilePictureUrl);
            document.getElementById('call-live-indicator').classList.remove('is-ringing');
        } else if (activeCall) {
            document.querySelector('.voice-participants').classList.remove('hidden');
            document.getElementById('serverCallParticipants').classList.add('hidden');
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
            document.querySelector('.voice-participants').classList.remove('hidden');
            document.getElementById('serverCallParticipants').classList.add('hidden');
        }
        const database = app.readDatabase();
        const profile = app.getUserProfile(database, username);
        const selected = app.state.currentConversation;
        const inServer = Boolean(activeServer && app.state.currentServer?.id === activeServer.id);
        const canCallServer = inServer && app.serverMessagesReady && !activeCall;
        const canCall = selected && profile.friends.some(friend => friend.username === selected) &&
            !isBlocked(database, username, selected) &&
            !serverCall &&
            (!activeCall || (activeCall.peer === selected && activeCall.role === 'caller' &&
                activeCall.status === 'ringing')) &&
            app.directMessageReady && activeGunPeer === selected && Boolean(activeGunKey);
        callButton.disabled = inServer ? !canCallServer : !canCall;
        if (inServer) {
            const state = activeServerVoiceState;
            const stateIsLive = state && Date.now() - state.updatedAt <= 75000;
            callButton.textContent = serverCall ? 'Leave Server Call' : stateIsLive ? 'Join Server Call' : 'Start Server Call';
        } else {
            callButton.textContent = activeCall ? (activeCall.status === 'ringing' ? 'Cancel Call' : 'In Call') : 'Call';
        }
        muteButton.disabled = !localStream;
        cameraButton.disabled = serverCall ? true : !peerConnection;
        shareButton.disabled = serverCall ? true : !peerConnection;
    }

    async function startCall() {
        const caller = app.state.currentUser?.username;
        const recipient = app.state.currentConversation;
        if (!caller || !recipient) return;
        if (serverCall) {
            callAlert.textContent = 'TERMINAL: Leave the server call before starting a direct-message call.';
            return;
        }
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
            callTimer = setTimeout(() => {
                callAlert.textContent = `TERMINAL: @${recipient} did not answer.`;
                finishCall(true);
            }, 45000);
            activeCall.signalReady = true;
            await flushIceCandidates();
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
            activeGunPeer !== invitation.caller || !activeGunSignalingNode || activeCall || serverCall) return;
        const database = app.readDatabase();
        const profile = app.getUserProfile(database, username);
        if (isBlocked(database, invitation.caller, username) ||
            !profile.friends.some(friend => friend.username === invitation.caller)) {
            declineCall(callId);
            return;
        }

        removeIncomingCall(callId);
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
        removeIncomingCall(callId);
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
        if (activeServer && app.state.currentServer?.id === activeServer.id) startOrJoinServerCall();
        else if (activeCall?.status === 'ringing') finishCall(true);
        else startCall();
    });
    document.getElementById('endCallButton').addEventListener('click', () => {
        if (serverCall) leaveServerCall(true);
        else finishCall(true);
    });
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
    function initializeEditor() {
        const canvas = document.getElementById('editorCanvas');
        const typeSelect = document.getElementById('editorAssetType');
        const colorInput = document.getElementById('editorColor');
        const eraserButton = document.getElementById('editorEraser');
        const clearButton = document.getElementById('editorClear');
        const importInput = document.getElementById('editorImport');
        const downloadButton = document.getElementById('editorDownload');
        const status = document.getElementById('editorStatus');
        if (!canvas || !typeSelect || !colorInput || !eraserButton || !clearButton ||
            !importInput || !downloadButton || !status) return;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        let erasing = false;
        let painting = false;
        const clear = () => {
            context.clearRect(0, 0, canvas.width, canvas.height);
            status.textContent = 'Canvas cleared. Click or drag to paint.';
        };
        typeSelect.addEventListener('change', () => {
            canvas.height = typeSelect.value === 'cape' ? 32 : 64;
            clear();
            status.textContent = typeSelect.value === 'cape'
                ? 'Cape canvas ready: 64×32 transparent PNG.'
                : 'Skin canvas ready: standard 64×64 Minecraft layout.';
        });
        const paintAt = event => {
            const bounds = canvas.getBoundingClientRect();
            const x = Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width);
            const y = Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height);
            if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
            if (erasing) context.clearRect(x, y, 1, 1);
            else {
                context.fillStyle = colorInput.value;
                context.fillRect(x, y, 1, 1);
            }
        };
        eraserButton.addEventListener('click', () => {
            erasing = !erasing;
            eraserButton.textContent = `Eraser: ${erasing ? 'on' : 'off'}`;
            eraserButton.setAttribute('aria-pressed', String(erasing));
        });
        clearButton.addEventListener('click', clear);
        canvas.addEventListener('pointerdown', event => {
            painting = true;
            canvas.setPointerCapture(event.pointerId);
            paintAt(event);
        });
        canvas.addEventListener('pointermove', event => { if (painting) paintAt(event); });
        canvas.addEventListener('pointerup', () => { painting = false; });
        canvas.addEventListener('pointercancel', () => { painting = false; });
        importInput.addEventListener('change', () => {
            const file = importInput.files[0];
            if (!file) return;
            const image = new Image();
            image.onload = () => {
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.imageSmoothingEnabled = false;
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(image.src);
                status.textContent = `Imported ${file.name}; resized to ${canvas.width}×${canvas.height}.`;
            };
            image.onerror = () => {
                status.textContent = 'That file could not be read as a PNG.';
                URL.revokeObjectURL(image.src);
            };
            image.src = URL.createObjectURL(file);
            importInput.value = '';
        });
        downloadButton.addEventListener('click', () => {
            canvas.toBlob(blob => {
                if (!blob) {
                    status.textContent = 'Could not create the PNG download.';
                    return;
                }
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `blocktalk-${typeSelect.value}.png`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 0);
                status.textContent = `Downloaded ${typeSelect.value} PNG (${canvas.width}×${canvas.height}).`;
            }, 'image/png');
        });
    }

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
        clearIncomingCalls();
        stopCallRingtone();
        document.getElementById('profileModal').classList.add('hidden');
        const result = await originalLogout.apply(this, args);
        syncCallView();
        return result;
    };
    syncCallView();
    initializeGames();
    initializeEditor();
    window.addEventListener('blocktalk:authenticated', () => {
        syncUserPreferences();
        renderServerList();
    });
});