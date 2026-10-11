# BlockTalk

BlockTalk is a browser chat app served by a Node.js/Socket.IO server. Accounts,
friend requests, settings, and direct messages are stored on that server, so
users can sign in and continue conversations from another device.

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
