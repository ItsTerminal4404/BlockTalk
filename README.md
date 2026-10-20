# BlockTalk

The MIT License for this project is in [LICENSE](./LICENSE).

BlockTalk is a static browser chat app. Gun SEA handles account registration
and key-based sign-in; account profiles, friend requests, presence, encrypted direct
messages, invite-code group servers, and encrypted WebRTC call signaling
synchronize through a public GunDB relay. Chat uses static browser files.

## Run locally or deploy

Serve the repository root as static files, for example with
`python -m http.server 8000`, then open `http://localhost:8000/index.html`. The
single-page entry point contains the welcome, sign-up, sign-in, and application
views. New users receive an access key when they sign up; existing users sign in
with that key. Netlify,
GitHub Pages, Cloudflare Pages, or any other static host can serve the app.
Installable PWA features and microphone access require HTTPS in production
(localhost is allowed for local development).

The interface theme can be changed in Settings between the original Terminal
look, light or dark rounded **Blocky & Bubbly** looks, and a low-contrast
**Secure & Incognito** look. These are visual preferences only; the incognito
theme does not change network, account, or privacy behavior.

## Minecraft skin and cape editor

The authenticated **Skin Editor** tab includes a client-only pixel editor for
standard 64×64 Minecraft skins and transparent 64×32 capes. Importing, drawing,
and exporting happen in the browser; files are never uploaded. Exported PNGs
can be used with compatible Eaglercraft skin or cape upload tools.

Typing `@tellmeajoke` in a direct conversation or private server displays one
of 1,000 local preset jokes. The joke command and response stay on the current
device and are not sent to Gun.

## Owner moderation and profile pictures

The `itsterminal4404` owner account has signed moderation controls in user
profiles. It can issue permanent bans, one-hour, 24-hour, or seven-day bans,
and unban accounts. Clients verify the owner's Gun SEA signature before
allowing an account into the app; temporary bans stop applying after their
expiration. This is client-enforced moderation, not a replacement for
controlling the Gun relays themselves.

Profile pictures can be selected or dropped up to 10 MB. Before saving, the
image is cropped inside a circular, draggable preview with zoom controls.
Only the compressed square crop is stored in the public profile.

## Games

The **Games** tab contains ten small browser games for quiet downtime during a
voice call. Pop Its, Color Ring Sort, Quick Tap, Memory Match, and Higher or
Lower are solo games. Tic-Tac-Toe, Connect Four, Reaction Duel, Dots & Boxes,
and Nim Duel are two-player pass-and-play games. Game interactions alternate
between two local pop sound effects; game state and sounds stay in the current
page and are not sent to Gun or shared with other users.

Gun identities are separate from the former Node-server accounts. Existing
server accounts are not migrated; users must create a new Gun account. Sign-up
and sign-in do not require an email address or password. New accounts receive a
random 32-character access key; save it somewhere safe because it is the only
way to sign in. Existing accounts with an enrolled key can also sign in with
that key. Accounts are associated with the
configured relay's Gun alias directory; changing or losing access to that
relay can affect account discovery and availability.

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
Message sent and received sounds play for successfully delivered and newly
received chat messages. The call ringtone loops while a direct call is ringing
and stops when it is answered, declined, cancelled, or times out. Audio playback
may require the browser to have received a prior user interaction. Sent and
received sounds can be controlled separately, and ringtone playback and volume
can be adjusted in Settings. These audio preferences are saved in the current
browser and do not sync between devices.

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
sender's Gun account so clients can reject username impersonation. Server
voice-call host and live-call status metadata are also visible on the relay.

Members can start an opt-in server voice call. Other members must select
**Join Server Call** before their microphone or incoming call audio is
connected. Joined participants connect directly to one another; server voice
currently supports audio only. A direct-message call and a server call cannot
be active at the same time.

Account Settings lets members add a public bio of up to 500 characters. It is
shown on their profile alongside their badges.

## Public badges and chat titles

Profiles show an Early OG badge when the account was newly registered before
January 1, 2027, and the BlockTalk Owner badge for the exact
`itsterminal4404` account. In addition, the owner can award 30 collectible
badges and 26 chat titles from a profile's owner tools, as well as special
badges such as Beta Tester for people who help test the app. These awards are
issued only by `itsterminal4404`; collectible badges and titles are not
automatically unlocked by activity or gameplay. A user's most recently
awarded title appears beside their name in DM and server text messages and on
their profile. `ItsTerminal4404` is no longer the owner account. Owner awards
are signed and verified against the owner's Gun account key. Profiles, badges,
and titles are public Gun data. Accounts
created before account creation timestamps were added may not have a
verifiable join date and will not automatically receive the Early OG badge.
The date is a public profile value, so the Early OG badge is a cosmetic
client-side marker rather than an independently audited registration record.

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
