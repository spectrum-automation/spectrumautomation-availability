# Meeting Availability

A small shared calendar for finding a meeting time. Everyone opens the same link, highlights when
they're free, and sees everyone else's availability update live.

## Run

Requires Node.js 18 or later. There are no npm dependencies.

```sh
npm start            # or: node server.js
```

Then open <http://localhost:3000>.

| Variable   | Default    | Purpose                                 |
|------------|------------|-----------------------------------------|
| `PORT`     | `3000`     | Port to listen on                       |
| `HOST`     | `0.0.0.0`  | Interface to bind                       |
| `DATA_DIR` | `./data`   | Where events are stored (one JSON file each) |

## Use

1. Click **Create event**, choose a date range, hours and slot length. A password such as
   `maple-otter-crisp-42` is filled in for you; click **Generate** for another, type your own, or
   clear it to let anyone with the link in.
2. Click **Copy share link** and send it to everyone. If you set a password, send it separately
   (for example, link by email and password by Teams).
3. Each person enters their name, picks a brush — **Available**, **Preferred**, **Not available** or
   **Erase** — and clicks and drags to mark slots. Starting a drag on a slot already marked with the
   current brush clears it instead.
4. **Group availability** shades each slot by how many people can attend (available or preferred),
   with a gold dot where someone prefers it. Hover a slot to see who prefers, is available, is not
   available, or hasn't answered. **Best times** lists the slots the most people can attend, ranked by
   how many prefer them. Changes appear for everyone straight away.

## How it works

- `public/` is the front end (plain HTML, CSS and JavaScript).
- `server.js` serves `public/`, stores events in `DATA_DIR`, and exposes a small API:

  | Method   | Path                                 | Purpose                          |
  |----------|--------------------------------------|----------------------------------|
  | `POST`   | `/api/events`                        | Create an event                  |
  | `GET`    | `/api/events/:id`                    | Get an event and all responses   |
  | `POST`   | `/api/events/:id/unlock`             | Check the password, set access cookie |
  | `GET`    | `/api/events/:id/stream`             | Live updates (Server-Sent Events)|
  | `PUT`    | `/api/events/:id/people/:name`       | Save one person's availability   |
  | `DELETE` | `/api/events/:id/people/:name`       | Remove one person                |

- Each save only touches one person's row, so people editing at the same time don't overwrite
  each other.
- A person's availability is stored as two bits per slot (0 unmarked, 1 available, 2 preferred,
  3 not available), base64url encoded. Events saved by the earlier one-bit version are upgraded
  automatically when loaded, with their free slots becoming "available".

## Hosting

Production runs on Azure App Service (Windows) and deploys from GitHub Actions on every push to
`main`. See [DEPLOY.md](DEPLOY.md) for the setup.

Elsewhere, run it as a long-lived process (a Windows service via NSSM, `pm2`, systemd, or a container) and back
up `DATA_DIR`. To put it behind a reverse proxy:

- **Response buffering must be off** for `/api/events/*/stream`, or live updates will be delayed.
  nginx honours the `X-Accel-Buffering: no` header the server sends. For IIS with ARR, set
  `responseBufferLimit="0"` on the proxy rule.
- To host under a sub-path (for example `/availability/`), have the proxy strip that prefix before
  forwarding. The front end uses relative URLs, so it works under any path.

## Notes

- **Passwords** are a basic shared secret per event, not user accounts. Only a salted scrypt hash
  is stored. Entering the password sets an HttpOnly cookie that keeps that browser unlocked for
  30 days, and every read, save and live-update connection checks it. Wrong guesses are delayed by
  a second. Anyone who has the password can add, change or remove any response.
- Events created without a password are open to anyone with the link. Event IDs are random and
  unguessable, but treat links as you would any shared document link.
- Serve it over HTTPS in production so passwords and cookies aren't sent in plain text. The cookie
  is marked `Secure` automatically when the proxy sends `X-Forwarded-Proto: https`.
- Times are shown in the organiser's time zone and are not converted for each viewer.
- Events are never deleted automatically; remove old files from `DATA_DIR` if needed.
