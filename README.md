# BlockTalk

BlockTalk is a browser chat app served by a Node.js/Socket.IO server. Accounts,
friend requests, and settings use the server. Direct messages are encrypted in
the browser with AES-GCM and synchronized through public GunDB relays.
WebRTC call setup (offers, answers, and ICE candidates) is also encrypted in
the browser and synchronized through the selected conversation's GunDB relay.

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000` on each device. Devices must be able to reach the
same running server; `localhost` on one device is not reachable from another.
For access over a network, bind the server to a reachable host and open the
server's port through the network firewall.

The server stores data in `data/blocktalk.json` by default. Set
`BLOCKTALK_DATA_FILE` to use another path. Keep this file on private,
persistent storage and back it up. Deployments using ephemeral filesystems
must attach persistent storage or configure an external shared data store.
The JSON store is intended for a single server instance; multiple instances
need a shared database and session store.
Use HTTPS when making the app available beyond a trusted local network.

Accounts and conversations previously saved only in browser local storage are
not automatically uploaded. Users need to create accounts on the server and
add each other as friends there.

## Install and offline behavior

Serve BlockTalk over HTTPS (or localhost during development), then use the
browser's install option to add it to a home screen or application launcher.
The service worker caches the app shell files so the interface can reopen
offline after its first successful load. Login, Gun relay synchronization,
Socket.IO updates, and calls still require a network connection; the
third-party Gun client is loaded from a CDN and is not cached for offline use.
If you change the shell asset list or caching behavior, increment the cache
version in `sw.js` so installed clients receive the updated shell.

## Direct-message privacy

Both participants must use the same unique, strong passphrase for each
conversation. Exchange it through a separate trusted channel and enter it once
on each device. BlockTalk can remember it in that browser's localStorage for
future visits; saved keys do not sync between devices and are not sent to the
app server or Gun relay. Because localStorage is accessible to scripts running
on the app's origin and to anyone with access to the browser profile, only
remember keys on trusted devices. Use the "Forget saved key" control to remove
the local copy. Losing the passphrase means old ciphertext cannot be decrypted.

Gun relays store ciphertext, but sender, recipient, call type, call ID, and
timestamp metadata remain visible to relay operators. Public relays are
community infrastructure and provide no availability or durability guarantee.
Socket.IO remains in use for account registration and application data-change
notifications; call signaling no longer uses Socket.IO.
