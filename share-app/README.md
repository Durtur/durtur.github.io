# Ogreforge Share — host app

A small Electron app that shares images peer-to-peer (WebRTC via PeerJS).
Viewers open `https://www.ogreforge.me/share/?id=<session-id>` (the page lives in `../share/`)
by scanning the QR code or using the copied link. Images go straight from this app to the viewers;
the PeerJS cloud server is only used for signalling.

```sh
npm install
npm start
```

- Drop, paste (Ctrl+V) or add images. The selected image is "Live": viewers following the host see it.
- The session code is kept between launches so a printed or pinned QR code keeps working. **New code** rotates it.
- Images larger than 8 MB or 4096 px are re-encoded to WebP before sending.
- To test against a local copy of the viewer page, serve the repo root on port 8080 and run `npm run start:local`.

Message protocol (host → viewer): `hello {name}`, `list {items, focus}`, `img {id, name, mime, w, h, data}`, `focus {id}`, `bye`.
Viewer → host: `hi {have: [ids]}`, so a reconnecting viewer isn't sent images it already has.
