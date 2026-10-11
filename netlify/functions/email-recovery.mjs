import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomBytes,
    randomInt,
    timingSafeEqual
} from 'node:crypto';
import { createRequire } from 'node:module';
import { getStore } from '@netlify/blobs';

const require = createRequire(import.meta.url);
const SEA = require('gun/sea');
let recoveryStore = null;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_DELAY_MS = 60 * 1000;
const CODE_MAX_SENDS_PER_HOUR = 5;
const CODE_MAX_ATTEMPTS = 5;

function getRecoveryStore() {
    if (!recoveryStore) recoveryStore = getStore('blocktalk-email-recovery-v1');
    return recoveryStore;
}

function response(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' }
    });
}

function normalizeUsername(username) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
        throw new Error('Enter a valid BlockTalk username.');
    }
    return username.toLowerCase();
}

function normalizeEmail(email) {
    if (typeof email !== 'string' || email.length > 254) throw new Error('Enter a valid email address.');
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid email address.');
    return normalized;
}

function requiredEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Email recovery is not configured: ${name} is missing.`);
    return value;
}

function recoveryKey() {
    const key = Buffer.from(requiredEnv('RECOVERY_ENCRYPTION_KEY'), 'base64');
    if (key.length !== 32) throw new Error('RECOVERY_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
    return key;
}

function secretHash(value) {
    const key = createHmac('sha256', recoveryKey()).update('blocktalk-email-recovery-challenge-v1').digest();
    return createHmac('sha256', key).update(value).digest('hex');
}

function encryptJSON(value) {
    const iv = randomBytes(12);
    const key = createHmac('sha256', recoveryKey()).update('blocktalk-email-recovery-encryption-v1').digest();
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final()
    ]);
    return {
        version: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

function decryptJSON(envelope) {
    if (!envelope || envelope.version !== 1) throw new Error('Recovery record has an unsupported format.');
    const key = createHmac('sha256', recoveryKey()).update('blocktalk-email-recovery-encryption-v1').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
}

async function getJSON(key) {
    const value = await getRecoveryStore().get(key);
    if (value === null) return null;
    try {
        return JSON.parse(value);
    } catch (error) {
        throw new Error(`Stored recovery data is invalid: ${error.message}`);
    }
}

async function setJSON(key, value) {
    await getRecoveryStore().set(key, JSON.stringify(value));
}

async function sendEmail(email, code, purpose) {
    const apiKey = requiredEnv('BIRD_API_KEY');
    const from = requiredEnv('RECOVERY_FROM_EMAIL');
    const region = /^bk_(us1|eu1)_/.exec(apiKey)?.[1];
    if (!region) {
        throw new Error('BIRD_API_KEY must be a Bird API key beginning with bk_us1_ or bk_eu1_.');
    }
    const subject = purpose === 'reset'
        ? 'Reset your BlockTalk password'
        : 'Verify your BlockTalk recovery email';
    const text = `Your BlockTalk verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this message.`;
    const result = await fetch(`https://${region}.platform.bird.com/v1/email/messages`, {
        method: 'POST',
        headers: {
            authorization: `AccessKey ${apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            from: { email: from, name: 'BlockTalk' },
            to: [email],
            subject,
            text,
            category: 'transactional'
        })
    });
    if (!result.ok) {
        const detail = await result.text();
        console.error('Bird rejected a recovery email:', result.status, detail);
        throw new Error('The verification email could not be sent. Check the email service configuration and try again.');
    }
}

async function createChallenge(key, email, purpose) {
    const now = Date.now();
    const emailRateKey = `email-rate:${createHash('sha256').update(email).digest('hex')}`;
    const emailRate = await getJSON(emailRateKey);
    const emailSendCount = emailRate?.windowStartedAt && now - emailRate.windowStartedAt < 60 * 60 * 1000
        ? emailRate.sendCount + 1
        : 1;
    if (emailRate?.lastSentAt && now - emailRate.lastSentAt < CODE_RESEND_DELAY_MS) {
        throw new Error('Wait a minute before requesting another code.');
    }
    if (emailSendCount > CODE_MAX_SENDS_PER_HOUR) throw new Error('Too many codes requested. Try again in an hour.');
    const previous = await getJSON(key);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challenge = {
        codeHash: secretHash(`${key}:${code}`),
        createdAt: now,
        expiresAt: now + CHALLENGE_TTL_MS,
        attempts: 0,
        lastSentAt: now,
        windowStartedAt: previous?.windowStartedAt || now,
        sendCount: (previous?.sendCount || 0) + 1,
        purpose
    };
    await setJSON(key, challenge);
    try {
        await sendEmail(email, code, purpose);
        await setJSON(emailRateKey, {
            lastSentAt: now,
            windowStartedAt: emailSendCount === 1 ? now : emailRate.windowStartedAt,
            sendCount: emailSendCount
        });
    } catch (error) {
        await getRecoveryStore().delete(key);
        throw error;
    }
}

async function verifyChallenge(key, code, purpose) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        throw new Error('Enter the six-digit code from your email.');
    }
    const challenge = await getJSON(key);
    if (!challenge || challenge.purpose !== purpose || challenge.expiresAt <= Date.now()) {
        throw new Error('That code is invalid or expired. Request a new one.');
    }
    if (challenge.attempts >= CODE_MAX_ATTEMPTS) {
        throw new Error('Too many incorrect attempts. Request a new code.');
    }
    challenge.attempts += 1;
    await setJSON(key, challenge);
    const actual = secretHash(`${key}:${code}`);
    const expected = Buffer.from(challenge.codeHash, 'hex');
    const provided = Buffer.from(actual, 'hex');
    if (expected.length !== provided.length || !timingSafeEqual(provided, expected)) {
        throw new Error('That code is invalid or expired. Request a new one.');
    }
    return challenge;
}

async function handleSendCode(body) {
    if (body.purpose === 'signup') {
        const email = normalizeEmail(body.email);
        await createChallenge(`signup:${createHash('sha256').update(email).digest('hex')}`, email, 'signup');
        return response(200, { ok: true, message: 'If the address can receive mail, a verification code is on its way.' });
    }
    if (body.purpose === 'setup') {
        const username = normalizeUsername(body.username);
        const email = normalizeEmail(body.email);
        await createChallenge(`setup:${username}`, email, 'setup');
        return response(200, { ok: true, message: 'A verification code is on its way.' });
    }
    throw new Error('Unsupported recovery code request.');
}

async function handleVerifyCode(body) {
    const email = normalizeEmail(body.email);
    const code = typeof body.code === 'string' ? body.code : '';
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit code from your email.');
    const key = body.purpose === 'signup'
        ? `signup:${createHash('sha256').update(email).digest('hex')}`
        : body.purpose === 'setup'
            ? `setup:${normalizeUsername(body.username)}`
            : '';
    if (!key) throw new Error('Unsupported verification request.');
    const challenge = await verifyChallenge(key, code, body.purpose);
    challenge.verifiedAt = Date.now();
    await setJSON(key, challenge);
    return response(200, { ok: true, message: 'Email verified. Continue to create your account.' });
}

async function handleEnroll(body) {
    const { payload, signature, pair, code, purpose } = body;
    if (!payload || typeof payload !== 'object') throw new Error('Recovery enrollment details are missing.');
    const username = normalizeUsername(payload.username);
    const email = normalizeEmail(payload.email);
    if (typeof payload.pub !== 'string' || !Number.isFinite(payload.timestamp) ||
        Math.abs(Date.now() - payload.timestamp) > 5 * 60 * 1000 ||
        !pair || pair.pub !== payload.pub || typeof pair.priv !== 'string' ||
        typeof pair.epub !== 'string' || typeof pair.epriv !== 'string' ||
        typeof signature !== 'string') {
        throw new Error('Recovery enrollment could not be validated.');
    }
    const challengeKey = purpose === 'signup'
        ? `signup:${createHash('sha256').update(email).digest('hex')}`
        : purpose === 'setup'
            ? `setup:${username}`
            : '';
    if (!challengeKey) throw new Error('Unsupported recovery enrollment.');
    const challenge = await verifyChallenge(challengeKey, code, purpose);
    if (!challenge.verifiedAt || challenge.verifiedAt > Date.now() ||
        Date.now() - challenge.verifiedAt > CHALLENGE_TTL_MS) {
        throw new Error('Verify your email code before enabling recovery.');
    }
    const verified = await SEA.verify(signature, payload.pub);
    if (!verified || typeof verified !== 'object' ||
        verified.username !== payload.username || verified.email !== payload.email ||
        verified.pub !== payload.pub || verified.timestamp !== payload.timestamp) {
        throw new Error('Recovery enrollment signature is invalid.');
    }
    const keyProof = await SEA.sign(JSON.stringify(payload), pair);
    const verifiedKeyProof = await SEA.verify(keyProof, payload.pub);
    if (!verifiedKeyProof || typeof verifiedKeyProof !== 'object' ||
        verifiedKeyProof.username !== payload.username || verifiedKeyProof.email !== payload.email ||
        verifiedKeyProof.pub !== payload.pub || verifiedKeyProof.timestamp !== payload.timestamp) {
        throw new Error('The recovery key pair does not match the account public key.');
    }
    const probePair = await SEA.pair();
    const expectedSecret = await SEA.secret(probePair.epub, pair);
    const actualSecret = await SEA.secret(pair.epub, probePair);
    if (!expectedSecret || expectedSecret !== actualSecret) {
        throw new Error('The recovery encryption keys are invalid.');
    }
    const accountKey = `account:${username}`;
    const existingEnvelope = await getJSON(accountKey);
    if (existingEnvelope) {
        const existing = decryptJSON(existingEnvelope);
        if (existing.pub !== payload.pub) throw new Error('Recovery is already linked to a different account key.');
    }
    await setJSON(accountKey, encryptJSON({
        username: payload.username,
        email,
        pub: payload.pub,
        pair
    }));
    await getRecoveryStore().delete(challengeKey);
    return response(200, { ok: true, message: 'Email recovery is now enabled for this account.' });
}

async function handleRequestReset(body) {
    const username = normalizeUsername(body.username);
    const envelope = await getJSON(`account:${username}`);
    if (envelope) {
        const account = decryptJSON(envelope);
        await createChallenge(`reset:${username}`, account.email, 'reset');
    }
    return response(200, {
        ok: true,
        message: 'If this account has email recovery enabled, a reset code is on its way.'
    });
}

async function handleCompleteReset(body) {
    const username = normalizeUsername(body.username);
    const code = typeof body.code === 'string' ? body.code : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit code from your email.');
    if (newPassword.length < 12) throw new Error('Use a new password with at least 12 characters.');
    const key = `reset:${username}`;
    const challenge = await verifyChallenge(key, code, 'reset');
    const envelope = await getJSON(`account:${username}`);
    if (!envelope) throw new Error('Recovery is not enabled for this account.');
    const account = decryptJSON(envelope);
    if (challenge.attempts > CODE_MAX_ATTEMPTS) throw new Error('Too many incorrect attempts.');
    await getRecoveryStore().delete(key);
    return response(200, { ok: true, pair: account.pair, username: account.username });
}

export default async function emailRecovery(request) {
    if (request.method !== 'POST') return response(405, { error: 'Use POST for recovery requests.' });
    let body;
    try {
        if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
            return response(415, { error: 'Send a JSON request.' });
        }
        const contentLength = Number(request.headers.get('content-length') || 0);
        if (contentLength > 25000) return response(413, { error: 'Recovery request is too large.' });
        const text = await request.text();
        if (Buffer.byteLength(text, 'utf8') > 25000) return response(413, { error: 'Recovery request is too large.' });
        body = JSON.parse(text);
    } catch {
        return response(400, { error: 'Request body must be valid JSON.' });
    }
    try {
        switch (body.action) {
            case 'send-code':
                return await handleSendCode(body);
            case 'verify-code':
                return await handleVerifyCode(body);
            case 'enroll':
                return await handleEnroll(body);
            case 'request-reset':
                return await handleRequestReset(body);
            case 'complete-reset':
                return await handleCompleteReset(body);
            default:
                return response(400, { error: 'Unsupported recovery action.' });
        }
    } catch (error) {
        const status = /Too many|Wait a minute/.test(error.message) ? 429 : 400;
        console.error('BlockTalk email recovery request failed:', error);
        return response(status, { error: error.message || 'Email recovery request failed.' });
    }
}
