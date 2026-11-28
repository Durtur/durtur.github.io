# Scry — host app

A small Electron app for showing images to other people's screens, peer-to-peer (WebRTC via PeerJS).
Built for tabletop games: the GM drops in maps and handouts, and players watch on their phones or laptops.

Viewers open `https://www.ogreforge.me/scry/?id=<session-id>` by scanning the QR code or using the copied link.
That page lives in `../scry/`. It shows only the image the host is presenting and always follows the host.
Images go straight from this app to the viewers. The PeerJS cloud server is only used for signalling.

```sh
npm install
npm start
```

- Drop, paste (Ctrl+V) or add images. The selected image is "Live", and that's what every viewer sees.
- The session code is kept between launches, so a printed or pinned QR code keeps working. **New code** rotates it.
- Images larger than 8 MB or 4096 px are re-encoded to WebP before sending.
- To test against a local copy of the viewer page, serve the repo root on port 8080 and run `npm run start:local`.
- The app loads `../scry/panzoom.js` and `../scry/scry.css`, so it expects to sit next to `scry/` in this repo.

Message protocol (host → viewer): `hello {name}`, `list {items, focus}`, `img {id, name, mime, w, h, data}`, `focus {id}`, `bye`.
Viewer → host: `hi {have: [ids]}`, so a reconnecting viewer isn't sent images it already has.
All images are sent up front, so switching what's presented is instant.
