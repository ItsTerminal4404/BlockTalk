(() => {
    const mode = document.body.dataset.authMode;
    const isSignUp = mode === 'signup';
    const form = document.getElementById('authForm');
    const usernameInput = document.getElementById('username');
    const accessKeyInput = document.getElementById('accessKey');
    const submitButton = document.getElementById('submitButton');
    const error = document.getElementById('error');
    const keyPanel = document.getElementById('keyPanel');
    const generatedKey = document.getElementById('generatedKey');
    const copyButton = document.getElementById('copyKey');
    const continueButton = document.getElementById('continueButton');
    const peers = [
        'https://gun.rig.airfaas.com/gun',
        'https://peer.ooo/gun'
    ];

    const generateAccessKey = () => {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const values = new Uint32Array(32);
        crypto.getRandomValues(values);
        return Array.from(values, value => alphabet[value % alphabet.length]).join('');
    };

    const setError = message => {
        error.textContent = message;
    };

    const withTimeout = (action, message) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(message)), 20000);
        action(result => {
            clearTimeout(timeout);
            if (result?.err) reject(new Error(String(result.err)));
            else resolve(result);
        });
    });

    const authenticate = async (username, accessKey) => {
        const gun = Gun({ peers, axe: false });
        const user = gun.user();
        if (!user || typeof user.auth !== 'function' || typeof user.create !== 'function') {
            throw new Error('Authentication could not load. Refresh and try again.');
        }
        if (isSignUp) {
            await withTimeout(
                callback => user.create(username, accessKey, callback),
                'Account creation timed out. Check your connection and try again.'
            );
        }
        await withTimeout(
            callback => user.auth(username, accessKey, callback),
            'Sign-in timed out. Check your connection and try again.'
        );
        return accessKey;
    };

    form.addEventListener('submit', async event => {
        event.preventDefault();
        setError('');
        const username = usernameInput.value.trim();
        const accessKey = isSignUp ? generateAccessKey() : accessKeyInput.value.trim();
        if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
            setError('Username must be 3-32 letters, numbers, dots, dashes, or underscores.');
            return;
        }
        if (!isSignUp && !/^[a-zA-Z0-9]{32}$/.test(accessKey)) {
            setError('Enter your 32-character access key.');
            return;
        }
        submitButton.disabled = true;
        submitButton.textContent = isSignUp ? 'Creating account…' : 'Signing in…';
        try {
            const key = await authenticate(username, accessKey);
            sessionStorage.setItem('blocktalk:auth-handoff', JSON.stringify({
                username,
                accessKey: key
            }));
            if (isSignUp) {
                generatedKey.value = key;
                keyPanel.classList.add('show');
                form.querySelectorAll('input, button[type="submit"]').forEach(element => {
                    element.disabled = true;
                });
                continueButton.focus();
            } else {
                window.location.replace('index.html');
            }
        } catch (authError) {
            setError(authError.message);
            submitButton.disabled = false;
            submitButton.textContent = isSignUp ? 'Create account' : 'Sign in';
        }
    });

    copyButton?.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(generatedKey.value);
            copyButton.textContent = 'Copied';
        } catch {
            setError('Copy failed. Select and copy the key manually.');
        }
    });

    continueButton?.addEventListener('click', () => window.location.replace('index.html'));
})();
