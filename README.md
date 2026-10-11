# BlockTalk

The MIT License for this project is in [LICENSE](./LICENSE).

BlockTalk is a static browser chat app. Gun SEA handles account registration
and sign-in; account profiles, friend requests, presence, encrypted direct
messages, invite-code group servers, and encrypted WebRTC call signaling
synchronize through a public GunDB relay. The browser app uses no Node.js API
or Socket.IO server, so no application server process is required.

## Run locally or deploy

Serve the repository root as static files, for example with
`python -m http.server 8000`, then open `http://localhost:8000`. Netlify can
publish the repository root directly. Installable PWA features and microphone
access require HTTPS in production (localhost is allowed for local development).
The current official deployment is `https://webblocktalk.netlify.app/`.

Gun identities are separate from the former Node-server accounts. Existing
server accounts are not migrated; users must create a new Gun account. Gun
passwords cannot be reset by BlockTalk, so users must keep them safe. Accounts
are associated with the configured relay's Gun alias directory; changing or
losing access to that relay can affect account discovery and availability.

## Install and offline behavior

Serve BlockTalk over HTTPS (or localhost during development), then use the
browser's install option to add it to a home screen or application launcher.
The service worker caches the app shell files so the interface can reopen
offline after its first successful load. Authentication, profile/friend sync,
and calls still require a network connection; the third-party Gun client is
loaded from a CDN and is not cached for offline use. Encrypted outgoing
messages are queued in this device's localStorage while offline and submitted
sequentially after the browser reports that it is online. The queue is removed
only after Gun acknowledges each write; queued messages are not available on
other devices until they have synchronized.
If you change the shell asset list or caching behavior, increment the cache
version in `sw.js` so installed clients receive the updated shell.

## Attachments, profile pictures, and emoji

Messages support the emoji picker, compressed image attachments, and short
voice snippets. Images are resized/compressed in the browser to at most 256 KB;
voice clips are limited to 20 seconds and 180 KB. Attachment data is encoded
as a base64 data URL, encrypted with the conversation key, and stored directly
in Gun. Profile pictures can be dropped into Settings or selected from disk;
they are compressed to at most 160 KB and stored as public profile data. Media
is not uploaded to a separate file host. Large attachments may exceed limits
or be rejected by community relays, which do not guarantee storage.

## Private servers

Create a server to generate a random 32-character invite code, or join one by
pasting its code. The code derives the room identifier and encryption key, so
only people with the code can locate and decrypt its messages. Messages and
media in a server are encrypted locally before they reach Gun. The joined
server list and invite codes are saved in the current browser's localStorage;
they do not automatically sync to other devices. Anyone who obtains an invite
code can read and post in that server, and this client currently has no
moderation, removal, or invite-revocation controls. Server metadata and message
sender/timestamp information are not encrypted. Server posts are signed by the
sender's Gun account so clients can reject username impersonation.

## Public profile badges

Profiles show an Early OG badge when the account was newly registered before
January 1, 2027, and the BlockTalk Owner badge for the exact
`ItsTerminal4404` account. The owner can look up registered usernames and
award the signed "Met the Owner" or "Owner's Friend" badge. Those owner-issued
badge claims are cryptographically verified by clients. Profiles and badges
are public Gun data. Accounts created before account creation timestamps were
added may not have a verifiable join date and will not automatically receive
the Early OG badge. The date is a public profile value, so the Early OG badge
is a cosmetic client-side marker rather than an independently audited
registration record.

## Direct-message privacy

Both participants must use the same unique, strong passphrase for each
conversation. Exchange it through a separate trusted channel and enter it once
on each device. BlockTalk can remember it in that browser's localStorage for
future visits; saved keys do not sync between devices and are not sent to the
app server or Gun relay. Because localStorage is accessible to scripts running
on the app's origin and to anyone with access to the browser profile, only
remember keys on trusted devices. Use the "Forget saved key" control to remove
the local copy. Losing the passphrase means old ciphertext cannot be decrypted.

The relay stores encrypted message and call contents, but sender, recipient,
call type, call ID, timestamps, public profile settings, friendship metadata,
and signed friend-request events are visible to relay operators. Signed events
let clients reject forged event contents but do not prevent public relay
operators from observing or withholding events. Public relays are community
infrastructure and provide no availability or durability guarantee. The
conversation passphrase must still be shared separately and remembered on
each device independently.
