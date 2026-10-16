import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes
} from 'node:crypto';
import { createRequire } from 'node:module';
import { getStore } from '@netlify/blobs';

const require = createRequire(import.meta.url);
const SEA = require('gun/sea');
let recoveryStore = null;

function getRecoveryStore() {
    if (!recoveryStore) recoveryStore = getStore('blocktalk-recovery-v2');
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

function normalizeRecoveryKey(recoveryKey) {
    if (typeof recoveryKey !== 'string' || !/^[a-zA-Z0-9]{32}$/.test(recoveryKey)) {
        throw new Error('Enter a valid 32-character recovery key.');
    }
    return recoveryKey;
}

function hashRecoveryKey(recoveryKey) {
    return createHash('sha256')
        .update(`blocktalk-recovery-key-v2:${recoveryKey}`)
        .digest('hex');
}

function recoveryEncryptionKey(recoveryKey) {
    return createHash('sha256')
        .update(`blocktalk-recovery-encryption-v2:${recoveryKey}`)
        .digest();
}

function encryptJSON(value, recoveryKey) {
    const iv = randomBytes(12);
    const key = recoveryEncryptionKey(recoveryKey);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return {
        version: 2,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
    };
}

function decryptJSON(envelope, recoveryKey) {
    if (!envelope || envelope.version !== 2) throw new Error('Recovery record has an unsupported format.');
    const key = recoveryEncryptionKey(recoveryKey);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
    ]).toString('utf8'));
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

async function handleEnroll(body) {
    const recoveryKey = normalizeRecoveryKey(body.recoveryKey);
    const { payload, signature, pair } = body;
    if (!payload || typeof payload !== 'object') throw new Error('Recovery enrollment details are missing.');
    const username = normalizeUsername(payload.username);
    if (typeof payload.pub !== 'string' || !Number.isFinite(payload.timestamp) ||
        Math.abs(Date.now() - payload.timestamp) > 5 * 60 * 1000 ||
        !pair || pair.pub !== payload.pub || typeof pair.priv !== 'string' ||
        typeof pair.epub !== 'string' || typeof pair.epriv !== 'string' ||
        typeof signature !== 'string') {
        throw new Error('Recovery enrollment could not be validated.');
    }
    const verified = await SEA.verify(signature, payload.pub);
    if (!verified || typeof verified !== 'object' ||
        verified.username !== payload.username || verified.pub !== payload.pub ||
        verified.timestamp !== payload.timestamp) {
        throw new Error('Recovery enrollment signature is invalid.');
    }
    const accountKey = `account:${username}`;
    const existingEnvelope = await getJSON(accountKey);
    if (existingEnvelope) {
        if (existingEnvelope.pub !== payload.pub) {
            throw new Error('Recovery is already linked to a different account key.');
        }
    }
    await setJSON(accountKey, {
        username: payload.username,
        pub: payload.pub,
        recoveryKeyHash: hashRecoveryKey(recoveryKey),
        encryptedPair: encryptJSON(pair, recoveryKey)
    });
    return response(200, { ok: true, message: 'Recovery key saved. Store it somewhere safe.' });
}

async function handleCompleteReset(body) {
    const username = normalizeUsername(body.username);
    const recoveryKey = normalizeRecoveryKey(body.recoveryKey);
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (newPassword.length < 12) throw new Error('Use a new password with at least 12 characters.');
    const envelope = await getJSON(`account:${username}`);
    if (!envelope) throw new Error('Recovery is not enabled for this account.');
    if (envelope.recoveryKeyHash !== hashRecoveryKey(recoveryKey)) {
        throw new Error('That recovery key is invalid.');
    }
    const pair = decryptJSON(envelope.encryptedPair, recoveryKey);
    return response(200, { ok: true, pair, username: envelope.username });
}

export default async function recovery(request) {
    if (request.method !== 'POST') return response(405, { error: 'Use POST for recovery requests.' });
    let body;
    try {
        if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
            return response(415, { error: 'Send a JSON request.' });
        }
        const text = await request.text();
        if (Buffer.byteLength(text, 'utf8') > 25000) return response(413, { error: 'Recovery request is too large.' });
        body = JSON.parse(text);
    } catch {
        return response(400, { error: 'Request body must be valid JSON.' });
    }
    try {
        if (body.action === 'enroll') return await handleEnroll(body);
        if (body.action === 'complete-reset') return await handleCompleteReset(body);
        return response(400, { error: 'Unsupported recovery action.' });
    } catch (error) {
        console.error('BlockTalk recovery request failed:', error);
        return response(400, { error: error.message || 'Recovery request failed.' });
    }
}
